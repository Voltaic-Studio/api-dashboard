/**
 * backfill-capabilities.ts
 *
 * LLM-first capabilities backfill.
 * For every API, generates:
 *   capabilities: [{ title: string, description: string }]
 * and writes it to `apis.capabilities` (jsonb).
 *
 * Usage:
 *   cd Backend && pnpm run backfill:capabilities
 *
 * Optional flags:
 *   --limit=2000
 *   --concurrency=3
 *   --withDocs=true
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

type ApiRow = {
  id: string;
  title: string | null;
  description: string | null;
  tldr: string | null;
  website: string | null;
  doc_url: string | null;
};

type EndpointRow = {
  id: string;
  api_id: string;
  method: string | null;
  path: string | null;
  summary: string | null;
  description: string | null;
  section: string | null;
  doc_url: string | null;
};

type Capability = {
  title: string;
  description: string;
  logo_url?: string | null;
};

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

function argNum(name: string, fallback: number): number {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const n = Number(raw.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function argBool(name: string, fallback: boolean): boolean {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const v = raw.split('=')[1].toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(v);
}

function toTitleCase(raw: string): string {
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(' ');
}

function normalizeCapabilityTitle(raw: string): string {
  return toTitleCase(raw.replace(/api$/i, '').trim());
}

function tokenizeTitle(raw: string): string {
  return normalizeCapabilityTitle(raw).toLowerCase();
}

function pathPrefix(pathValue: string | null): string | null {
  if (!pathValue) return null;
  const clean = pathValue.trim();
  if (!clean.startsWith('/')) return null;
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const candidate = parts[0];
  if (/^v\d+$/i.test(candidate)) return parts[1] ? normalizeCapabilityTitle(parts[1]) : null;
  return normalizeCapabilityTitle(candidate);
}

function compactSentence(s: string, max = 90): string {
  const text = s.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trim()}...`;
}

function buildHintsFromEndpoints(endpoints: EndpointRow[]): string[] {
  const hints = new Set<string>();

  // sections
  for (const ep of endpoints) {
    if (ep.section?.trim()) hints.add(normalizeCapabilityTitle(ep.section));
  }

  // path prefixes
  for (const ep of endpoints) {
    const pref = pathPrefix(ep.path);
    if (pref) hints.add(pref);
  }

  return Array.from(hints).slice(0, 24);
}

async function fetchJinaMarkdown(url: string, jinaKey?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { Accept: 'text/markdown' };
    if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;
    const { data } = await axios.get(`https://r.jina.ai/${url}`, {
      headers,
      timeout: 30000,
    });
    if (!data || typeof data !== 'string') return null;
    return data.length > 22000 ? data.slice(0, 22000) : data;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are an API capabilities analyst. Your job is to list the high-level capabilities (product areas / categories) of an API.

CRITICAL RULES:
1. Return STRICT JSON: {"capabilities":[{"title":"...","description":"...","domain":"..."}]}
2. 4 to 12 capabilities max.
3. "title" — short, specific product area (e.g. "Payments", "Webhooks", "Vertex Ai", "Google Maps").
4. "description" — one sentence explaining the capability. If you know specific features/methods/sub-features, append a "Supports: " list after the sentence. Only add "Supports: " when you can list concrete, specific items — omit it if you'd just be restating the title.
   Example with Supports: "Accept and move money. Supports: cards, wallets (Apple Pay, Google Pay), bank transfers (ACH, SEPA, Bacs), local methods (iDEAL, Bancontact, Klarna, Afterpay), SCA / 3DS, one-off & saved payments."
   Example without Supports: "Send transactional and marketing emails at scale."
5. "domain" — ONLY set this when the capability is a well-known standalone product/sub-brand that has its own website domain (e.g. "maps.google.com", "stripe.com/connect"). Set to null otherwise. This is used to show the sub-brand's logo.
6. No extra fields. No confidence, no evidence.

IMPORTANT — THE MARKDOWN IS OFTEN INCOMPLETE:
- The provided docs markdown is frequently truncated, missing pages, or only covers a fraction of the API's real capabilities.
- You MUST use your training knowledge extensively. You likely know far more about this API than what the markdown shows.
- Treat the markdown and endpoint hints as SUPPLEMENTARY context — not the full picture. If you know the API has capabilities not mentioned in the markdown, INCLUDE them.
- DO NOT assume the markdown is comprehensive. Most APIs have many more features than what a single scraped page shows.
- However, do NOT hallucinate capabilities that the API genuinely does not have.

SUB-API / SUB-BRAND HANDLING:
- Large platforms (AWS, Google Cloud, Azure, Meta, etc.) contain many independent sub-APIs. Each significant sub-API MUST appear as its own capability.
  Example for Google: "Google Maps", "Vertex Ai", "BigQuery", "Cloud Storage", "Gmail Api", etc.
  Example for AWS: "Ec2", "S3", "Lambda", "DynamoDb", "Sqs", etc.
- If the API was merged from multiple sub-domains during cleanup, the endpoint hints and sections will reflect the sub-APIs. Include ALL of them.
- For sub-APIs that are well-known standalone products, provide their "domain" so their logo can be fetched (e.g. domain: "maps.google.com").

CATEGORIES:
- Capabilities also serve as categories for the API. Think of them as "what can I do with this API?"
- Cover the full breadth: if an API has payments, webhooks, subscriptions, reporting — list all of them.
- The "Supports: " line in the description is critical — it tells agents exactly what specific features are available without needing to read the full docs.`;

async function llmGenerateCapabilities(
  orKey: string,
  api: ApiRow,
  endpointHints: string[],
  markdown: string | null,
): Promise<Capability[]> {
  const userPrompt = [
    `API: ${api.title ?? api.id} (${api.id})`,
    api.tldr ? `TLDR: ${api.tldr}` : '',
    api.description ? `Description: ${api.description}` : '',
    '',
    'Hints from known endpoints/sections:',
    ...(endpointHints.length ? endpointHints.map((h, i) => `${i + 1}. ${h}`) : ['(none)']),
    '',
    'Docs markdown (possibly truncated):',
    markdown ?? '(none)',
  ].filter(Boolean).join('\n');

  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash',
        temperature: 0.1,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      },
      {
        headers: { Authorization: `Bearer ${orKey}` },
        timeout: 45000,
      },
    );

    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.capabilities) ? parsed.capabilities : []);
    return arr
      .filter((x: any) => x?.title && x?.description)
      .map((x: any) => ({
        title: normalizeCapabilityTitle(String(x.title)),
        description: compactSentence(String(x.description), 300),
        logo_url: x.domain && typeof x.domain === 'string' ? x.domain.trim() : null,
      }))
      .filter((x: Capability) => x.title.length > 1 && x.description.length > 8)
      .slice(0, 12);
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = typeof err?.response?.data === 'object'
      ? JSON.stringify(err.response.data)
      : (err?.response?.data ?? err?.message ?? 'unknown');
    console.error(`   ⚠️  LLM capability generation failed [${status ?? 'n/a'}]: ${msg}`);
    return [];
  }
}

function dedupeCapabilities(caps: Capability[]): Capability[] {
  const map = new Map<string, Capability>();
  for (const c of caps) {
    const key = tokenizeTitle(c.title);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || c.description.length > existing.description.length) {
      map.set(key, { ...c, logo_url: c.logo_url ?? existing?.logo_url ?? null });
    }
  }
  return Array.from(map.values()).slice(0, 12);
}

async function updateApiCapabilities(supabase: any, apiId: string, caps: Capability[], logoToken: string) {
  const payload = caps.map((c) => {
    const entry: Record<string, string> = {
      title: c.title,
      description: c.description,
    };
    if (c.logo_url) {
      const domain = c.logo_url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      entry.logo_url = logoToken
        ? `https://img.logo.dev/${domain}?token=${logoToken}&size=64&format=png`
        : `https://img.logo.dev/${domain}?size=64&format=png`;
    }
    return entry;
  });
  const { error } = await supabase
    .from('apis')
    .update({ capabilities: payload })
    .eq('id', apiId);
  if (error) throw new Error(error.message);
}

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const orKey = env.OPENROUTER_API_KEY ?? '';
  const jinaKey = env.JINA_API_KEY;
  const logoToken = env.LOGO_DEV_TOKEN ?? '';

  if (!supabaseUrl || !supabaseKey || !orKey) {
    console.error('❌ Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or OPENROUTER_API_KEY');
    process.exit(1);
  }

  const concurrency = 3;
  const withDocs = argBool('withDocs', true);
  const limiter = createLimiter(concurrency);

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('📦 Loading all APIs...');
  const apis: ApiRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('apis')
      .select('id,title,description,tldr,website,doc_url')
      .range(from, from + 999);
    if (error) {
      console.error(`❌ Failed to load APIs: ${error.message}`);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    apis.push(...(data as ApiRow[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`📦 APIs loaded: ${apis.length}`);

  let done = 0;
  let ok = 0;
  let fail = 0;

  await Promise.all(apis.map((api) => limiter(async () => {
    try {
      const { data: endpointData } = await supabase
        .from('api_endpoints')
        .select('id,api_id,method,path,summary,description,section,doc_url')
        .eq('api_id', api.id);
      const endpoints = (endpointData ?? []) as EndpointRow[];

      const hints = buildHintsFromEndpoints(endpoints);
      let markdown: string | null = null;
      if (withDocs && (api.doc_url || api.website)) {
        markdown = await fetchJinaMarkdown(api.doc_url ?? api.website!, jinaKey);
      }

      const llmCaps = await llmGenerateCapabilities(orKey, api, hints, markdown);
      const capabilities = dedupeCapabilities(llmCaps);
      await updateApiCapabilities(supabase, api.id, capabilities, logoToken);

      ok++;
      done++;
      console.log(`✅ [${done}/${apis.length}] ${api.id} — ${capabilities.length} capabilities`);
    } catch (err: any) {
      fail++;
      done++;
      console.error(`❌ [${done}/${apis.length}] ${api.id} — ${err?.message ?? String(err)}`);
    }
  })));

  console.log('\n──────────');
  console.log(`✅ APIs processed successfully: ${ok}`);
  console.log(`⚠️  APIs failed: ${fail}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

