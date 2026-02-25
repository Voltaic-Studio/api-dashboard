/**
 * discover-golden.ts
 *
 * Ingests curated company list → searches for API docs → extracts endpoints.
 * Populates both `apis` (tier='verified') and `api_endpoints` tables.
 * Deduplicates against existing DB entries.
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

async function findDocUrl(
  name: string,
  domain: string,
  searchApiKey: string,
): Promise<string | null> {
  try {
    const query = `${name} API documentation site:${domain}`;
    const { data } = await axios.get('https://www.searchapi.io/api/v1/search', {
      params: { engine: 'google', q: query, api_key: searchApiKey },
      timeout: 15000,
    });

    const results = data.organic_results ?? [];
    for (const r of results) {
      const url: string = r.link ?? '';
      if (!url) continue;
      if (/docs|api|developer|reference|swagger|openapi/i.test(url)) return url;
    }

    if (results.length > 0 && results[0].link) return results[0].link;
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error ?? err?.message ?? '';
    if (status === 429 || status === 402 || status === 403) {
      console.error(`   🚨 SearchAPI LIMIT HIT (${status}): ${msg}`);
      console.error(`      ↳ You may need to upgrade your SearchAPI plan.`);
    } else {
      console.error(`   ⚠️  SearchAPI error for ${name}: [${status}] ${msg}`);
    }
  }

  return null;
}

// ─── Doc Probing (no SearchAPI needed) ───────────────────────────────────────

const DOC_PATTERNS = [
  '/docs', '/docs/api', '/api', '/api-reference', '/developers',
  '/developer', '/documentation', '/reference', '/api/docs',
];

const OPENAPI_PATTERNS = [
  '/openapi.json', '/swagger.json', '/api/openapi.json',
  '/api/swagger.json', '/v1/openapi.json', '/docs/openapi.json',
];

async function probeUrl(url: string): Promise<boolean> {
  try {
    await axios.head(url, { timeout: 8000, maxRedirects: 3, validateStatus: s => s < 400 });
    return true;
  } catch { return false; }
}

async function probeDocUrl(domain: string): Promise<string | null> {
  const bases = [
    `https://${domain}`, `https://docs.${domain}`,
    `https://developer.${domain}`, `https://developers.${domain}`,
    `https://api.${domain}`,
  ];

  for (const base of bases) {
    for (const pattern of OPENAPI_PATTERNS) {
      try {
        const { data } = await axios.get(base + pattern, { timeout: 8000, maxRedirects: 3 });
        if (data?.paths || data?.openapi || data?.swagger) return base + pattern;
      } catch {}
      await sleep(50);
    }
  }

  for (const base of bases) {
    for (const pattern of DOC_PATTERNS) {
      if (await probeUrl(base + pattern)) return base + pattern;
      await sleep(50);
    }
  }

  return null;
}

// ─── Firecrawl + LLM Extraction ──────────────────────────────────────────────

async function scrapeAndExtract(
  name: string,
  docUrl: string,
  fcKey: string,
  orKey: string,
): Promise<{ endpoints: Endpoint[]; tldr: string | null } | null> {
  try {
    const { data } = await axios.post(
      'https://api.firecrawl.dev/v1/scrape',
      { url: docUrl, formats: ['markdown'], timeout: 45000, onlyMainContent: true },
      { headers: { Authorization: `Bearer ${fcKey}` }, timeout: 60000 },
    );

    if (!data.success) {
      console.error(`   ⚠️  Firecrawl scrape failed for ${docUrl}: ${data.error ?? 'unknown'}`);
      return null;
    }
    const markdown: string = data.data?.markdown ?? '';
    if (markdown.length < 100) return null;

    const truncated = markdown.slice(0, 15000);

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

Return ONLY valid JSON in this exact format, no markdown fences:
{"tldr": "...", "endpoints": [...]}

API: ${name}
Documentation:
${truncated}`;

    const { data: llmData } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash-preview',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' }, timeout: 30000 },
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
    const msg = err?.response?.data?.error ?? err?.message ?? '';
    if (status === 429 || status === 402 || status === 403) {
      const service = err?.config?.url?.includes('firecrawl') ? 'Firecrawl' : 
                      err?.config?.url?.includes('openrouter') ? 'OpenRouter' : 'API';
      console.error(`   🚨 ${service} LIMIT HIT (${status}): ${msg}`);
      console.error(`      ↳ You may need to upgrade your ${service} plan.`);
    } else {
      console.error(`   ⚠️  scrapeAndExtract error for ${name}: [${status}] ${msg}`);
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
) {
  const { error } = await supabase.from('apis').upsert({
    id: domain,
    title: name,
    website: `https://${domain}`,
    doc_url: docUrl,
    tldr,
    tier: 'verified',
    scrape_status: endpointCount > 0 ? 'scraped' : 'not_found',
  }, { onConflict: 'id' });

  if (error) console.error(`   ❌ API upsert error for ${domain}: ${error.message}`);
}

async function saveEndpoints(supabase: SupabaseClient, apiId: string, endpoints: Endpoint[]) {
  if (endpoints.length === 0) return;

  const rows = endpoints.map(ep => ({
    api_id: apiId,
    method: ep.method,
    path: ep.path,
    summary: ep.summary,
    description: ep.description,
    parameters: ep.parameters,
    responses: ep.responses,
    doc_url: ep.doc_url,
    section: ep.section,
  }));

  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
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

  if (!supabaseUrl || !supabaseKey || !orKey) {
    console.error('❌ Missing: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const targetsPath = path.join(process.cwd(), 'data', 'final_targets_clean_v3.json');
  const targets: Target[] = JSON.parse(fs.readFileSync(targetsPath, 'utf-8'));
  console.log(`\n📋 Loaded ${targets.length} targets from golden list`);

  // Load existing domains to skip
  const existingDomains = new Set<string>();
  let from = 0;
  while (true) {
    const { data } = await supabase.from('apis').select('id').range(from, from + 999);
    if (!data || data.length === 0) break;
    for (const row of data) existingDomains.add(row.id.split(':')[0]);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`   ${existingDomains.size} existing domains in DB`);

  const newTargets = targets.filter(t => !existingDomains.has(t.domain));
  console.log(`   ${newTargets.length} new targets to process\n`);

  if (newTargets.length === 0) { console.log('✅ All targets already in DB.'); return; }

  const stats = { total: 0, found: 0, endpoints: 0, skipped: 0 };
  const limit = createLimiter(3);

  async function processTarget(target: Target) {
    stats.total++;
    const num = stats.total;
    const prefix = `[${num}/${newTargets.length}] ${target.name}`;

    // Step 1: Find doc URL (probe first, then SearchAPI fallback)
    let docUrl = await probeDocUrl(target.domain);

    if (!docUrl && searchApiKey) {
      docUrl = await findDocUrl(target.name, target.domain, searchApiKey);
      await sleep(200);
    }

    if (!docUrl) {
      stats.skipped++;
      await upsertApi(supabase, target.domain, target.name, null, null, 0);
      console.log(`   ⚪ ${prefix} — no docs found`);
      return;
    }

    // Step 2: Try to fetch as OpenAPI spec first
    let result: { endpoints: Endpoint[]; tldr: string | null } | null = null;

    if (/\.json|\.yaml|\.yml|openapi|swagger/i.test(docUrl)) {
      try {
        const { data: specData } = await axios.get(docUrl, { timeout: 15000, maxRedirects: 5 });
        const spec = typeof specData === 'string' ? JSON.parse(specData) : specData;
        if (spec?.paths) {
          result = parseOpenApiSpec(spec, docUrl);
          if (result.endpoints.length === 0) result = null;
        }
      } catch (err: any) {
        const status = err?.response?.status;
        if (status) console.error(`   ⚠️  Spec fetch failed for ${docUrl}: [${status}]`);
      }
    }

    // Step 3: Firecrawl + LLM fallback
    if (!result && fcKey) {
      result = await scrapeAndExtract(target.name, docUrl, fcKey, orKey);
    }

    if (!result || result.endpoints.length === 0) {
      stats.skipped++;
      await upsertApi(supabase, target.domain, target.name, docUrl, null, 0);
      console.log(`   ⚪ ${prefix} — doc found but no endpoints extracted`);
      return;
    }

    // Step 4: Save to DB
    await upsertApi(supabase, target.domain, target.name, docUrl, result.tldr, result.endpoints.length);
    await saveEndpoints(supabase, target.domain, result.endpoints);
    stats.found++;
    stats.endpoints += result.endpoints.length;
    console.log(`   ✅ ${prefix} — ${result.endpoints.length} endpoints`);
  }

  console.log('🚀 Starting golden list ingestion...\n');
  const promises = newTargets.map(t => limit(() => processTarget(t)));
  await Promise.all(promises);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Golden list results:`);
  console.log(`   Processed: ${stats.total}`);
  console.log(`   APIs with endpoints: ${stats.found}`);
  console.log(`   No endpoints found: ${stats.skipped}`);
  console.log(`   Total endpoints saved: ${stats.endpoints}`);
  console.log(`${'─'.repeat(50)}\n`);
}

main();
