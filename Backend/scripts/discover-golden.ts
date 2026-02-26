/**
 * discover-golden.ts
 *
 * Ingests curated company list → searches for API docs → extracts endpoints.
 * Populates both `apis` (tier='verified') and `api_endpoints` tables.
 * Deduplicates against existing DB entries.
 *
 * Pipeline per company:
 *   1. Probe for OpenAPI spec at common URLs (free, structured)
 *   2. SearchAPI to find API reference page (not landing page)
 *   3. Firecrawl single-page scrape + LLM extraction
 *   4. Firecrawl crawl fallback (crawls doc site, aggregates endpoints)
 *
 * Usage:  cd Backend && pnpm run discover:golden
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
 * Optional env: FIRECRAWL_API_KEY, SEARCHAPI_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Target {
  name: string;
  domain: string;
}

interface Endpoint {
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  parameters: any[];
  responses: Record<string, any>;
  doc_url: string | null;
  section: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const result: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return result;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    result[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return result;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= concurrency) {
      await new Promise<void>(resolve => queue.push(resolve));
    }
    active++;
    try { return await fn(); }
    finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

// ─── Doc Discovery via SearchAPI ─────────────────────────────────────────────

async function findApiReferenceUrl(
  name: string,
  domain: string,
  searchApiKey: string,
): Promise<string | null> {
  const queries = [
    `"${name}" API reference endpoints site:${domain}`,
    `"${name}" API reference documentation endpoints`,
  ];

  for (const query of queries) {
    try {
      const { data } = await axios.get('https://www.searchapi.io/api/v1/search', {
        params: { engine: 'google', q: query, api_key: searchApiKey },
        timeout: 15000,
      });

      const results = data.organic_results ?? [];

      // Prioritize URLs that look like actual API reference pages
      const referencePatterns = /api-reference|\/reference|\/api\/|\/endpoints|\/rest-api|openapi|swagger/i;
      const docPatterns = /docs|developer|documentation/i;

      for (const r of results) {
        const url: string = r.link ?? '';
        if (!url) continue;
        if (/stackoverflow|reddit|youtube|twitter|medium\.com|blog/i.test(url)) continue;
        if (referencePatterns.test(url)) return url;
      }

      for (const r of results) {
        const url: string = r.link ?? '';
        if (!url) continue;
        if (/stackoverflow|reddit|youtube|twitter|medium\.com|blog/i.test(url)) continue;
        if (docPatterns.test(url)) return url;
      }

      if (results.length > 0 && results[0].link) return results[0].link;
    } catch (err: any) {
      const status = err?.response?.status;
      const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err?.message ?? '';
      const msg = typeof rawMsg === 'object' ? JSON.stringify(rawMsg) : rawMsg;
      if (status === 429 || status === 402 || status === 403) {
        console.error(`   🚨 SearchAPI LIMIT HIT (${status}): ${msg}`);
        console.error(`      ↳ You may need to upgrade your SearchAPI plan.`);
      } else {
        console.error(`   ⚠️  SearchAPI error for ${name}: [${status}] ${msg}`);
      }
    }
    await sleep(300);
  }

  return null;
}

// ─── Doc Probing (no SearchAPI needed) ───────────────────────────────────────

const OPENAPI_PATTERNS = [
  '/openapi.json', '/swagger.json', '/api/openapi.json',
  '/api/swagger.json', '/v1/openapi.json', '/docs/openapi.json',
  '/api/v1/openapi.json', '/api-docs/openapi.json',
];

const REFERENCE_PATTERNS = [
  '/api-reference', '/reference', '/docs/api-reference',
  '/docs/api', '/api/docs', '/developers/api', '/developer/reference',
  '/docs/rest-api', '/api', '/docs', '/developers', '/documentation',
];

async function probeUrl(url: string): Promise<boolean> {
  try {
    await axios.head(url, { timeout: 8000, maxRedirects: 3, validateStatus: s => s < 400 });
    return true;
  } catch { return false; }
}

async function probeDocUrl(domain: string): Promise<{ url: string; isSpec: boolean } | null> {
  const bases = [
    `https://${domain}`, `https://docs.${domain}`,
    `https://developer.${domain}`, `https://developers.${domain}`,
    `https://api.${domain}`,
  ];

  // Check for OpenAPI specs first (highest value)
  for (const base of bases) {
    for (const pattern of OPENAPI_PATTERNS) {
      try {
        const { data } = await axios.get(base + pattern, { timeout: 8000, maxRedirects: 3 });
        if (data?.paths || data?.openapi || data?.swagger) return { url: base + pattern, isSpec: true };
      } catch {}
      await sleep(50);
    }
  }

  // Then try reference pages (more likely to have endpoints than /docs landing)
  for (const base of bases) {
    for (const pattern of REFERENCE_PATTERNS) {
      if (await probeUrl(base + pattern)) return { url: base + pattern, isSpec: false };
      await sleep(50);
    }
  }

  return null;
}

// ─── Firecrawl single-page scrape + LLM ──────────────────────────────────────

async function scrapeAndExtract(
  name: string,
  docUrl: string,
  fcKey: string,
  orKey: string,
): Promise<{ endpoints: Endpoint[]; tldr: string | null } | null> {
  // Try with full rendering first, fall back to lightweight on 408
  for (const attempt of ['full', 'light'] as const) {
    const isLight = attempt === 'light';
    try {
      const { data } = await axios.post(
        'https://api.firecrawl.dev/v2/scrape',
        {
          url: docUrl,
          formats: ['markdown'],
          timeout: isLight ? 30000 : 45000,
          onlyMainContent: !isLight,
          ...(isLight ? { waitFor: 0 } : {}),
        },
        { headers: { Authorization: `Bearer ${fcKey}` }, timeout: isLight ? 45000 : 60000 },
      );

      if (!data.success) {
        const errMsg = typeof data.error === 'object' ? JSON.stringify(data.error) : (data.error ?? 'unknown');
        if (!isLight && /timeout/i.test(errMsg)) {
          console.error(`   ⚠️  Firecrawl timeout for ${name}, retrying lightweight...`);
          continue;
        }
        console.error(`   ⚠️  Firecrawl scrape failed for ${docUrl}: ${errMsg}`);
        return null;
      }
      const markdown: string = data.data?.markdown ?? '';
      if (markdown.length < 100) return null;

      return await extractFromMarkdown(name, markdown, docUrl, orKey);
    } catch (err: any) {
      const status = err?.response?.status;
      const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err?.message ?? '';
      const msg = typeof rawMsg === 'object' ? JSON.stringify(rawMsg) : rawMsg;

      if (status === 408 && !isLight) {
        console.error(`   ⚠️  Firecrawl 408 timeout for ${name}, retrying lightweight...`);
        continue;
      }
      if (status === 429 || status === 402 || status === 403) {
        console.error(`   🚨 Firecrawl LIMIT HIT (${status}): ${msg}`);
        console.error(`      ↳ You may need to upgrade your Firecrawl plan.`);
      } else {
        console.error(`   ⚠️  Firecrawl scrape error for ${name}: [${status}] ${msg}`);
      }
      return null;
    }
  }
  return null;
}

// ─── Firecrawl crawl fallback (multi-page) ───────────────────────────────────

async function crawlAndExtract(
  name: string,
  docUrl: string,
  fcKey: string,
  orKey: string,
): Promise<{ endpoints: Endpoint[]; tldr: string | null } | null> {
  try {
    // Start crawl job
    const { data: crawlData } = await axios.post(
      'https://api.firecrawl.dev/v2/crawl',
      {
        url: docUrl,
        limit: 15,
        maxDiscoveryDepth: 2,
        crawlEntireDomain: false,
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      },
      { headers: { Authorization: `Bearer ${fcKey}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );

    if (!crawlData.success && !crawlData.id) {
      console.error(`   ⚠️  Firecrawl crawl start failed for ${docUrl}`);
      return null;
    }

    const crawlId = crawlData.id;

    // Poll for completion (max 90s)
    let crawlResult: any = null;
    for (let i = 0; i < 18; i++) {
      await sleep(5000);
      try {
        const { data: statusData } = await axios.get(
          `https://api.firecrawl.dev/v2/crawl/${crawlId}`,
          { headers: { Authorization: `Bearer ${fcKey}` }, timeout: 15000 },
        );
        if (statusData.status === 'completed') {
          crawlResult = statusData;
          break;
        }
        if (statusData.status === 'failed') {
          console.error(`   ⚠️  Crawl failed for ${name}`);
          return null;
        }
      } catch {}
    }

    if (!crawlResult?.data || crawlResult.data.length === 0) return null;

    // Aggregate markdown from all crawled pages
    const allMarkdown = crawlResult.data
      .map((page: any) => {
        const md = page.markdown ?? '';
        const pageUrl = page.metadata?.sourceURL ?? '';
        return md.length > 50 ? `\n--- Page: ${pageUrl} ---\n${md}` : '';
      })
      .filter(Boolean)
      .join('\n');

    if (allMarkdown.length < 200) return null;

    console.log(`      📄 Crawled ${crawlResult.data.length} pages for ${name}`);

    return await extractFromMarkdown(name, allMarkdown, docUrl, orKey);
  } catch (err: any) {
    const status = err?.response?.status;
    const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err?.message ?? '';
    const msg = typeof rawMsg === 'object' ? JSON.stringify(rawMsg) : rawMsg;
    if (status === 429 || status === 402 || status === 403) {
      console.error(`   🚨 Firecrawl crawl LIMIT HIT (${status}): ${msg}`);
    } else {
      console.error(`   ⚠️  Firecrawl crawl error for ${name}: [${status}] ${msg}`);
    }
    return null;
  }
}

// ─── LLM Endpoint Extraction ─────────────────────────────────────────────────

async function extractFromMarkdown(
  name: string,
  markdown: string,
  docUrl: string,
  orKey: string,
): Promise<{ endpoints: Endpoint[]; tldr: string | null } | null> {
  // Use more context for crawled pages
  const truncated = markdown.slice(0, 30000);

  const prompt = `You are an API documentation parser. Extract ALL API endpoints from this documentation.

For each endpoint return a JSON object with:
- method: HTTP method (GET, POST, PUT, DELETE, PATCH)
- path: the endpoint path (e.g. /v1/payments/{id})
- summary: short name/title (e.g. "Create Payment")
- description: one-sentence description
- section: the category/group this endpoint belongs to (e.g. "Movies", "Payments", "Users")
- parameters: array of {name, type, required, description, in} objects
- responses: object with status codes as keys and {description} as values

Also generate a TLDR: exactly 2-3 sentences describing what this API does overall.

If the page is a landing page, guide, or blog with NO actual API endpoints listed, return {"tldr": null, "endpoints": []}.

Return ONLY valid JSON in this exact format, no markdown fences:
{"tldr": "...", "endpoints": [...]}

API: ${name}
Documentation:
${truncated}`;

  try {
    const { data: llmData } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8000,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' }, timeout: 60000 },
    );

    const raw = llmData.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());

    const endpoints: Endpoint[] = (parsed.endpoints ?? [])
      .filter((e: any) => e.method && e.path)
      .map((e: any) => ({
        method: e.method.toUpperCase(),
        path: e.path,
        summary: e.summary ?? null,
        description: e.description ?? null,
        parameters: Array.isArray(e.parameters) ? e.parameters : [],
        responses: e.responses && typeof e.responses === 'object' ? e.responses : {},
        doc_url: docUrl,
        section: e.section ?? null,
      }));

    return { endpoints, tldr: parsed.tldr ?? null };
  } catch (err: any) {
    const status = err?.response?.status;
    const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err?.message ?? '';
    const msg = typeof rawMsg === 'object' ? JSON.stringify(rawMsg) : rawMsg;
    if (status === 429 || status === 402 || status === 403) {
      console.error(`   🚨 OpenRouter LIMIT HIT (${status}): ${msg}`);
      console.error(`      ↳ You may need to upgrade your OpenRouter plan.`);
    } else {
      console.error(`   ⚠️  LLM extraction error for ${name}: [${status}] ${msg}`);
    }
    return null;
  }
}

// ─── OpenAPI Spec Parsing ────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

function resolveRef(spec: any, ref: string): any {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let current = spec;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return null;
    current = current[part];
  }
  return current ?? null;
}

function parseOpenApiSpec(spec: any, docUrl: string): { endpoints: Endpoint[]; tldr: string | null } {
  const paths = spec?.paths;
  if (!paths || typeof paths !== 'object') return { endpoints: [], tldr: null };

  const endpoints: Endpoint[] = [];

  for (const [epPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathParams: any[] = (pathItem as any).parameters ?? [];

    for (const [method, details] of Object.entries(pathItem as Record<string, any>)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;

      const mergedRaw = [...pathParams, ...(details.parameters ?? [])];
      const seen = new Set<string>();
      const params = mergedRaw
        .map((p: any) => p?.$ref ? resolveRef(spec, p.$ref) ?? p : p)
        .filter((p: any) => {
          if (!p?.name) return false;
          const key = `${p.in}:${p.name}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((p: any) => ({
          name: p.name,
          type: p.schema?.type ?? p.type ?? 'string',
          required: p.required ?? false,
          description: p.description ?? null,
          in: p.in ?? 'query',
        }));

      const responses: Record<string, any> = {};
      if (details.responses) {
        for (const [code, rawResp] of Object.entries(details.responses as Record<string, any>)) {
          const resp = rawResp?.$ref ? resolveRef(spec, rawResp.$ref) ?? rawResp : rawResp;
          responses[code] = { description: resp.description ?? null };
        }
      }

      const tag = Array.isArray(details.tags) && details.tags.length > 0 ? details.tags[0] : null;

      endpoints.push({
        method: method.toUpperCase(),
        path: epPath,
        summary: details.summary ?? details.operationId ?? null,
        description: details.description ?? null,
        parameters: params,
        responses,
        doc_url: docUrl,
        section: tag,
      });
    }
  }

  const info = spec?.info;
  const tldr = info?.description ?? info?.summary ?? null;

  return { endpoints, tldr };
}

// ─── DB Operations ───────────────────────────────────────────────────────────

async function upsertApi(
  supabase: SupabaseClient,
  domain: string,
  name: string,
  docUrl: string | null,
  tldr: string | null,
  endpointCount: number,
  logoToken: string,
) {
  const logo = logoToken ? `https://img.logo.dev/${domain}?token=${logoToken}&size=64&format=png` : null;

  const { error } = await supabase.from('apis').upsert({
    id: domain,
    title: name,
    website: `https://${domain}`,
    doc_url: docUrl,
    logo,
    tldr,
    tier: 'verified',
    scrape_status: endpointCount > 0 ? 'scraped' : 'not_found',
  }, { onConflict: 'id' });

  if (error) console.error(`   ❌ API upsert error for ${domain}: ${error.message}`);
}

async function saveEndpoints(supabase: SupabaseClient, apiId: string, endpoints: Endpoint[]) {
  if (endpoints.length === 0) return;

  // Deduplicate within batch to avoid ON CONFLICT errors
  const seen = new Set<string>();
  const uniqueRows = endpoints
    .map(ep => ({
      api_id: apiId,
      method: ep.method,
      path: ep.path,
      summary: ep.summary,
      description: ep.description,
      parameters: ep.parameters,
      responses: ep.responses,
      doc_url: ep.doc_url,
      section: ep.section,
    }))
    .filter(row => {
      const key = `${row.method}:${row.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const BATCH = 100;
  for (let i = 0; i < uniqueRows.length; i += BATCH) {
    const batch = uniqueRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('api_endpoints')
      .upsert(batch, { onConflict: 'api_id,method,path', ignoreDuplicates: false });
    if (error) console.error(`   ❌ Endpoint upsert error: ${error.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const orKey = env.OPENROUTER_API_KEY ?? '';
  const fcKey = env.FIRECRAWL_API_KEY;
  const searchApiKey = env.SEARCHAPI_KEY;
  const logoToken = env.LOGO_DEV_TOKEN ?? '';

  if (!supabaseUrl || !supabaseKey || !orKey) {
    console.error('❌ Missing: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const targetsPath = path.join(process.cwd(), 'data', 'final_targets_clean_v3.json');
  const targets: Target[] = JSON.parse(fs.readFileSync(targetsPath, 'utf-8'));
  console.log(`\n📋 Loaded ${targets.length} targets from golden list`);

  // Load existing domains to skip (only those with endpoints already)
  const existingDomains = new Set<string>();
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('apis')
      .select('id, scrape_status')
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.scrape_status === 'scraped') {
        existingDomains.add(row.id.split(':')[0]);
      }
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`   ${existingDomains.size} existing scraped domains in DB`);

  const newTargets = targets.filter(t => !existingDomains.has(t.domain));
  console.log(`   ${newTargets.length} new targets to process\n`);

  if (newTargets.length === 0) { console.log('✅ All targets already in DB.'); return; }

  const stats = { total: 0, spec: 0, scrape: 0, crawl: 0, endpoints: 0, skipped: 0 };
  const limit = createLimiter(3);

  async function processTarget(target: Target) {
    stats.total++;
    const num = stats.total;
    const prefix = `[${num}/${newTargets.length}] ${target.name}`;

    // ── Step 1: Probe for OpenAPI spec or doc page ──
    const probeResult = await probeDocUrl(target.domain);

    // If we found a spec, parse it directly
    if (probeResult?.isSpec) {
      try {
        const { data: specData } = await axios.get(probeResult.url, { timeout: 15000, maxRedirects: 5 });
        const spec = typeof specData === 'string' ? JSON.parse(specData) : specData;
        if (spec?.paths) {
          const result = parseOpenApiSpec(spec, probeResult.url);
          if (result.endpoints.length > 0) {
            await upsertApi(supabase, target.domain, target.name, probeResult.url, result.tldr, result.endpoints.length, logoToken);
            await saveEndpoints(supabase, target.domain, result.endpoints);
            stats.spec++;
            stats.endpoints += result.endpoints.length;
            console.log(`   ✅ ${prefix} — OpenAPI spec — ${result.endpoints.length} endpoints`);
            return;
          }
        }
      } catch {}
    }

    // ── Step 2: Find the best doc URL ──
    let docUrl = probeResult?.url ?? null;

    // If probe found a generic page or nothing, use SearchAPI to find the real reference
    if (searchApiKey) {
      const searchUrl = await findApiReferenceUrl(target.name, target.domain, searchApiKey);
      if (searchUrl) {
        // Prefer search result if it looks more specific than probe result
        if (!docUrl || /api-reference|\/reference|\/api\/|\/endpoints|openapi|swagger/i.test(searchUrl)) {
          docUrl = searchUrl;
        }
      }
      await sleep(200);
    }

    if (!docUrl) {
      stats.skipped++;
      await upsertApi(supabase, target.domain, target.name, null, null, 0, logoToken);
      console.log(`   ⚪ ${prefix} — no docs found`);
      return;
    }

    // Check if search found an OpenAPI spec URL
    if (/\.json|\.yaml|\.yml/i.test(docUrl) && /openapi|swagger/i.test(docUrl)) {
      try {
        const { data: specData } = await axios.get(docUrl, { timeout: 15000, maxRedirects: 5 });
        const spec = typeof specData === 'string' ? JSON.parse(specData) : specData;
        if (spec?.paths) {
          const result = parseOpenApiSpec(spec, docUrl);
          if (result.endpoints.length > 0) {
            await upsertApi(supabase, target.domain, target.name, docUrl, result.tldr, result.endpoints.length, logoToken);
            await saveEndpoints(supabase, target.domain, result.endpoints);
            stats.spec++;
            stats.endpoints += result.endpoints.length;
            console.log(`   ✅ ${prefix} — OpenAPI spec (search) — ${result.endpoints.length} endpoints`);
            return;
          }
        }
      } catch {}
    }

    // ── Step 3: Firecrawl single-page scrape + LLM ──
    let result: { endpoints: Endpoint[]; tldr: string | null } | null = null;

    if (fcKey) {
      result = await scrapeAndExtract(target.name, docUrl, fcKey, orKey);
    }

    if (result && result.endpoints.length > 0) {
      await upsertApi(supabase, target.domain, target.name, docUrl, result.tldr, result.endpoints.length, logoToken);
      await saveEndpoints(supabase, target.domain, result.endpoints);
      stats.scrape++;
      stats.endpoints += result.endpoints.length;
      console.log(`   ✅ ${prefix} — scrape — ${result.endpoints.length} endpoints`);
      return;
    }

    // ── Step 4: Firecrawl crawl fallback (multi-page) ──
    if (fcKey) {
      console.log(`      🔄 ${prefix} — trying crawl fallback...`);
      result = await crawlAndExtract(target.name, docUrl, fcKey, orKey);
    }

    if (result && result.endpoints.length > 0) {
      await upsertApi(supabase, target.domain, target.name, docUrl, result.tldr, result.endpoints.length, logoToken);
      await saveEndpoints(supabase, target.domain, result.endpoints);
      stats.crawl++;
      stats.endpoints += result.endpoints.length;
      console.log(`   ✅ ${prefix} — crawl — ${result.endpoints.length} endpoints`);
      return;
    }

    // Nothing worked
    stats.skipped++;
    await upsertApi(supabase, target.domain, target.name, docUrl, result?.tldr ?? null, 0, logoToken);
    console.log(`   ⚪ ${prefix} — doc found but no endpoints extracted`);
  }

  console.log('🚀 Starting golden list ingestion...\n');
  const promises = newTargets.map(t => limit(() => processTarget(t)));
  await Promise.all(promises);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Golden list results:`);
  console.log(`   Processed: ${stats.total}`);
  console.log(`   OpenAPI specs: ${stats.spec}`);
  console.log(`   Single-page scrape: ${stats.scrape}`);
  console.log(`   Crawl fallback: ${stats.crawl}`);
  console.log(`   No endpoints found: ${stats.skipped}`);
  console.log(`   Total endpoints saved: ${stats.endpoints}`);
  console.log(`${'─'.repeat(50)}\n`);
}

main();
