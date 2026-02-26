/**
 * scrape-endpoints.ts
 *
 * Populates the api_endpoints table by scraping endpoint data for every API.
 *
 * Tier 1: Parse OpenAPI/Swagger spec from swagger_url (free, ~80%)
 * Tier 2: Probe common doc URL patterns + Firecrawl scrape + LLM extract (~15%)
 * Tier 3: SerpAPI search for doc URL → Firecrawl + LLM (~5%)
 *
 * Also generates TLDR descriptions and stores doc_url on the apis table.
 *
 * Usage:  cd Backend && pnpm run scrape:endpoints
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
 * Optional env: FIRECRAWL_API_KEY, SERPAPI_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ApiRow {
  id: string;
  title: string;
  description: string | null;
  swagger_url: string | null;
  website: string | null;
  scrape_status: string | null;
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

interface ScrapeResult {
  endpoints: Endpoint[];
  doc_url: string | null;
  tldr: string | null;
  status: 'scraped' | 'failed' | 'not_found';
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

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

// ─── Tier 1: OpenAPI Spec Parser ─────────────────────────────────────────────

async function fetchSpec(url: string): Promise<any | null> {
  try {
    const { data } = await axios.get(url, { timeout: 15000, maxRedirects: 5 });
    if (typeof data === 'string') {
      // Try JSON first, then YAML
      try { return JSON.parse(data); } catch {}
      try {
        const yaml = await import(/* @ts-ignore */ 'js-yaml') as any;
        return yaml.default?.load?.(data) ?? yaml.load?.(data) ?? null;
      } catch {}
      return null;
    }
    return data;
  } catch { return null; }
}

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

function resolveParam(spec: any, p: any): any {
  if (p?.$ref) return resolveRef(spec, p.$ref) ?? p;
  return p;
}

function parseOpenApiSpec(spec: any, baseDocUrl?: string): Endpoint[] {
  const paths = spec?.paths;
  if (!paths || typeof paths !== 'object') return [];

  const endpoints: Endpoint[] = [];
  const serverUrl = spec?.servers?.[0]?.url ?? spec?.host ?? '';

  for (const [endpointPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const pathLevelParams: any[] = (pathItem as any).parameters ?? [];

    for (const [method, details] of Object.entries(pathItem as Record<string, any>)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;

      const mergedRawParams = [...pathLevelParams, ...(details.parameters ?? [])];
      const seen = new Set<string>();
      const params = mergedRawParams
        .map((p: any) => resolveParam(spec, p))
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

      let docUrl: string | null = null;
      if (baseDocUrl) {
        const anchor = endpointPath.replace(/[{}\/]/g, '-').replace(/^-|-$/g, '');
        docUrl = `${baseDocUrl}#${method.toLowerCase()}-${anchor}`;
      }

      const tag = Array.isArray(details.tags) && details.tags.length > 0 ? details.tags[0] : null;

      endpoints.push({
        method: method.toUpperCase(),
        path: endpointPath,
        summary: details.summary ?? details.operationId ?? null,
        description: details.description ?? null,
        parameters: params,
        responses,
        doc_url: docUrl,
        section: tag,
      });
    }
  }

  return endpoints;
}

function generateTldrFromSpec(spec: any, title: string): string | null {
  const info = spec?.info;
  if (!info) return null;
  const desc = info.description ?? info.summary ?? '';
  if (!desc) return null;
  return desc;
}

async function tier1(api: ApiRow): Promise<ScrapeResult | null> {
  if (!api.swagger_url) return null;

  const spec = await fetchSpec(api.swagger_url);
  if (!spec) return null;

  const endpoints = parseOpenApiSpec(spec, api.website ?? undefined);
  if (endpoints.length === 0) return null;

  const tldr = generateTldrFromSpec(spec, api.title);

  return {
    endpoints,
    doc_url: api.swagger_url,
    tldr,
    status: 'scraped',
  };
}

// ─── Tier 2: Probe common doc URLs + Firecrawl + LLM ────────────────────────

const DOC_PATTERNS = [
  '/docs',
  '/api',
  '/api-reference',
  '/developers',
  '/developer',
  '/documentation',
  '/api/docs',
  '/reference',
];

const OPENAPI_PATTERNS = [
  '/openapi.json',
  '/swagger.json',
  '/api/openapi.json',
  '/api/swagger.json',
  '/v1/openapi.json',
  '/api/v1/openapi.json',
  '/docs/openapi.json',
  '/api-docs',
];

async function probeUrl(url: string): Promise<boolean> {
  try {
    const { status } = await axios.head(url, {
      timeout: 8000,
      maxRedirects: 3,
      validateStatus: (s) => s < 400,
    });
    return true;
  } catch { return false; }
}

async function tier2(api: ApiRow, fcKey: string | undefined, orKey: string): Promise<ScrapeResult | null> {
  const domain = api.id.split(':')[0];
  const bases = [
    `https://${domain}`,
    `https://docs.${domain}`,
    `https://developer.${domain}`,
    `https://developers.${domain}`,
    `https://api.${domain}`,
  ];

  // First try to find an OpenAPI spec at common paths
  for (const base of bases) {
    for (const pattern of OPENAPI_PATTERNS) {
      const specUrl = base + pattern;
      const spec = await fetchSpec(specUrl);
      if (spec?.paths) {
        const endpoints = parseOpenApiSpec(spec, base);
        if (endpoints.length > 0) {
          return {
            endpoints,
            doc_url: specUrl,
            tldr: generateTldrFromSpec(spec, api.title),
            status: 'scraped',
          };
        }
      }
      await sleep(100);
    }
  }

  // Then try to find a doc page
  let docUrl: string | null = null;
  for (const base of bases) {
    for (const pattern of DOC_PATTERNS) {
      const url = base + pattern;
      if (await probeUrl(url)) {
        docUrl = url;
        break;
      }
      await sleep(100);
    }
    if (docUrl) break;
  }

  if (!docUrl) return null;

  // If we found a doc page, scrape it with Firecrawl + LLM extraction
  if (!fcKey) return null;

  return await scrapeDocsWithFirecrawl(api, docUrl, fcKey, orKey);
}

// ─── Tier 3: SearchAPI Google search → Firecrawl + LLM ───────────────────────

async function tier3(api: ApiRow, searchApiKey: string | undefined, fcKey: string | undefined, orKey: string): Promise<ScrapeResult | null> {
  if (!searchApiKey || !fcKey) return null;

  try {
    const query = `${api.title} API documentation`;
    const { data } = await axios.get('https://www.searchapi.io/api/v1/search', {
      params: { engine: 'google', q: query, api_key: searchApiKey },
      timeout: 15000,
    });

    const results = data.organic_results ?? [];
    for (const result of results) {
      const url: string = result.link ?? '';
      if (!url) continue;
      // Skip non-doc pages
      if (/stackoverflow|reddit|github\.com(?!.*openapi|.*swagger)|youtube|twitter/i.test(url)) continue;

      // Check if it's an OpenAPI spec
      if (/openapi|swagger/i.test(url) && /\.json|\.yaml|\.yml/i.test(url)) {
        const spec = await fetchSpec(url);
        if (spec?.paths) {
          const endpoints = parseOpenApiSpec(spec, url.replace(/\/[^/]+$/, ''));
          if (endpoints.length > 0) {
            return {
              endpoints,
              doc_url: url,
              tldr: generateTldrFromSpec(spec, api.title),
              status: 'scraped',
            };
          }
        }
      }

      // Otherwise scrape the doc page
      const scrapeResult = await scrapeDocsWithFirecrawl(api, url, fcKey, orKey);
      if (scrapeResult && scrapeResult.endpoints.length > 0) return scrapeResult;
    }
  } catch {}

  return null;
}

// ─── Firecrawl + LLM endpoint extraction ─────────────────────────────────────

async function scrapeDocsWithFirecrawl(
  api: ApiRow,
  docUrl: string,
  fcKey: string,
  orKey: string,
): Promise<ScrapeResult | null> {
  try {
    const { data } = await axios.post(
      'https://api.firecrawl.dev/v2/scrape',
      {
        url: docUrl,
        formats: ['markdown'],
        timeout: 45000,
        onlyMainContent: true,
      },
      { headers: { Authorization: `Bearer ${fcKey}` }, timeout: 60000 },
    );

    if (!data.success) return null;
    const markdown: string = data.data?.markdown ?? '';
    if (markdown.length < 100) return null;

    // Truncate to ~15k chars to fit in LLM context
    const truncated = markdown.slice(0, 15000);

    return await extractEndpointsWithLLM(api, truncated, docUrl, orKey);
  } catch { return null; }
}

async function extractEndpointsWithLLM(
  api: ApiRow,
  markdown: string,
  docUrl: string,
  orKey: string,
): Promise<ScrapeResult | null> {
  const prompt = `You are an API documentation parser. Extract ALL API endpoints from this documentation.

For each endpoint return a JSON object with:
- method: HTTP method (GET, POST, PUT, DELETE, PATCH)
- path: the endpoint path (e.g. /v1/payments/{id})
- summary: short name/title (e.g. "Create Payment")
- description: one-sentence description
- section: the category/group this endpoint belongs to (e.g. "Movies", "Payments", "Users"). Group related endpoints under the same section name, matching how the docs organize them.
- parameters: array of {name, type, required, description, in} objects
- responses: object with status codes as keys and {description} as values

Also generate a TLDR: exactly 2-3 sentences describing what this API does overall.

Return ONLY valid JSON in this exact format, no markdown fences:
{"tldr": "...", "endpoints": [...]}

API: ${api.title}
Documentation:
${markdown}`;

  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );

    const raw = data.choices?.[0]?.message?.content ?? '';
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

    return {
      endpoints,
      doc_url: docUrl,
      tldr: parsed.tldr ?? null,
      status: endpoints.length > 0 ? 'scraped' : 'failed',
    };
  } catch { return null; }
}

// ─── TLDR generation fallback ────────────────────────────────────────────────

async function generateTldr(api: ApiRow, orKey: string): Promise<string | null> {
  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash',
        messages: [{
          role: 'user',
          content: `Write exactly 2-3 sentences describing what the "${api.title}" API (${api.id}) does. Be factual and concise. Description hint: ${api.description ?? 'none'}`,
        }],
        max_tokens: 100,
      },
      { headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' } },
    );
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch { return null; }
}

// ─── DB Operations ───────────────────────────────────────────────────────────

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
    if (error) console.error(`      ❌ Endpoint upsert error: ${error.message}`);
  }
}

async function updateApi(supabase: SupabaseClient, apiId: string, updates: Record<string, any>) {
  const { error } = await supabase.from('apis').update(updates).eq('id', apiId);
  if (error) console.error(`      ❌ API update error: ${error.message}`);
}

// ─── Concurrency limiter (simple implementation) ─────────────────────────────

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= concurrency) {
      await new Promise<void>(resolve => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const orKey       = env.OPENROUTER_API_KEY ?? '';
  const fcKey       = env.FIRECRAWL_API_KEY;
  const searchApiKey = env.SEARCHAPI_KEY;

  if (!supabaseUrl || !supabaseKey || !orKey) {
    console.error('❌ Missing: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Fetch all APIs that haven't been scraped yet
  console.log('\n📊 Loading APIs to scrape...');
  const allApis: ApiRow[] = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('apis')
      .select('id, title, description, swagger_url, website, scrape_status')
      .or('scrape_status.is.null,scrape_status.eq.pending,scrape_status.eq.failed')
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allApis.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`   ${allApis.length} APIs to process\n`);
  if (allApis.length === 0) { console.log('✅ Nothing to scrape.'); return; }

  const stats = { tier1: 0, tier2: 0, tier3: 0, failed: 0, notFound: 0, total: 0, endpoints: 0 };
  const limit = createLimiter(5);

  async function processApi(api: ApiRow) {
    stats.total++;
    const num = stats.total;
    const prefix = `[${num}/${allApis.length}] ${api.title}`;

    // Tier 1: OpenAPI spec
    let result = await tier1(api);
    if (result) {
      stats.tier1++;
      console.log(`   ✅ ${prefix} — Tier 1 — ${result.endpoints.length} endpoints`);
    }

    // Tier 2: Probe + Firecrawl
    if (!result) {
      result = await tier2(api, fcKey, orKey);
      if (result) {
        stats.tier2++;
        console.log(`   ✅ ${prefix} — Tier 2 — ${result.endpoints.length} endpoints`);
      }
    }

    // Tier 3: SerpAPI + Firecrawl
    if (!result) {
      result = await tier3(api, searchApiKey, fcKey, orKey);
      if (result) {
        stats.tier3++;
        console.log(`   ✅ ${prefix} — Tier 3 — ${result.endpoints.length} endpoints`);
      }
    }

    // No result from any tier
    if (!result) {
      stats.notFound++;
      // Still try to generate a TLDR
      const tldr = await generateTldr(api, orKey);
      await updateApi(supabase, api.id, {
        scrape_status: 'not_found',
        ...(tldr ? { tldr } : {}),
      });
      if (num % 100 === 0 || num === allApis.length) {
        console.log(`   ⚪ ${prefix} — not found`);
      }
      return;
    }

    // Save endpoints
    await saveEndpoints(supabase, api.id, result.endpoints);
    stats.endpoints += result.endpoints.length;

    // Update API record
    await updateApi(supabase, api.id, {
      scrape_status: result.status,
      ...(result.doc_url ? { doc_url: result.doc_url } : {}),
      ...(result.tldr ? { tldr: result.tldr } : {}),
    });
  }

  // Process all APIs with concurrency
  console.log('🚀 Starting endpoint scraper...\n');
  const promises = allApis.map(api => limit(() => processApi(api)));
  await Promise.all(promises);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Final stats:`);
  console.log(`   Total processed: ${stats.total}`);
  console.log(`   Tier 1 (OpenAPI): ${stats.tier1}`);
  console.log(`   Tier 2 (Probe+Firecrawl): ${stats.tier2}`);
  console.log(`   Tier 3 (SerpAPI+Firecrawl): ${stats.tier3}`);
  console.log(`   Not found: ${stats.notFound}`);
  console.log(`   Total endpoints saved: ${stats.endpoints}`);
  console.log(`${'─'.repeat(50)}\n`);
}

main();
