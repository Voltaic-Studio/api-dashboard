/**
 * scrape-pricing.ts
 *
 * Scrapes pricing pages for APIs in the database and extracts structured
 * pricing data using Firecrawl + LLM. Stores pricing summary on the apis
 * table and per-endpoint pricing on api_endpoints.
 *
 * Usage:  cd Backend && pnpm run scrape:pricing
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY, FIRECRAWL_API_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ApiRow {
  id: string;
  title: string;
  website: string | null;
  doc_url: string | null;
}

interface PricingPlan {
  name: string;
  price: string;
  limits: string | null;
}

interface EndpointPricing {
  method: string;
  path: string;
  tier: 'free' | 'paid' | 'freemium' | 'unknown';
  price_per_call: string | null;
  rate_limit: string | null;
}

interface PricingResult {
  pricing_url: string;
  has_free_tier: boolean;
  pricing_model: string;
  plans: PricingPlan[];
  endpoint_pricing: EndpointPricing[];
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

// ─── Pricing Page Discovery ──────────────────────────────────────────────────

const PRICING_PATTERNS = [
  '/pricing', '/api/pricing', '/developers/pricing',
  '/plans', '/api/plans', '/pricing-api',
];

async function findPricingUrl(domain: string): Promise<string | null> {
  const bases = [
    `https://${domain}`,
    `https://docs.${domain}`,
    `https://developer.${domain}`,
  ];

  for (const base of bases) {
    for (const pattern of PRICING_PATTERNS) {
      const url = base + pattern;
      try {
        await axios.head(url, { timeout: 8000, maxRedirects: 3, validateStatus: s => s < 400 });
        return url;
      } catch {}
      await sleep(50);
    }
  }

  return null;
}

// ─── Firecrawl + LLM Pricing Extraction ──────────────────────────────────────

async function extractPricing(
  api: ApiRow,
  pricingUrl: string,
  fcKey: string,
  orKey: string,
  existingEndpoints: { method: string; path: string }[],
): Promise<PricingResult | null> {
  try {
    const { data } = await axios.post(
      'https://api.firecrawl.dev/v1/scrape',
      { url: pricingUrl, formats: ['markdown'], timeout: 45000, onlyMainContent: true },
      { headers: { Authorization: `Bearer ${fcKey}` }, timeout: 60000 },
    );

    if (!data.success) return null;
    const markdown: string = data.data?.markdown ?? '';
    if (markdown.length < 50) return null;

    const truncated = markdown.slice(0, 15000);

    const endpointList = existingEndpoints.length > 0
      ? `\n\nKnown endpoints for this API:\n${existingEndpoints.map(e => `${e.method} ${e.path}`).join('\n')}`
      : '';

    const prompt = `You are an API pricing analyst. Extract structured pricing information from this pricing page.

Return a JSON object with:
- pricing_url: the URL of this pricing page
- has_free_tier: boolean, whether there's a free tier/plan
- pricing_model: one of "free", "freemium", "pay_per_use", "subscription", "enterprise_only", "unknown"
- plans: array of {name, price, limits} for each pricing tier (e.g. [{"name": "Free", "price": "$0/mo", "limits": "1000 requests/day"}, {"name": "Pro", "price": "$49/mo", "limits": "100k requests/mo"}])
- endpoint_pricing: array of {method, path, tier, price_per_call, rate_limit} mapping specific endpoints to their pricing tier. tier is one of "free", "paid", "freemium", "unknown". Only include if the pricing page gives per-endpoint or per-feature pricing info.

Return ONLY valid JSON, no markdown fences.
${endpointList}

API: ${api.title}
Pricing page content:
${truncated}`;

    const { data: llmData } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash-preview',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );

    const raw = llmData.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());

    return {
      pricing_url: parsed.pricing_url ?? pricingUrl,
      has_free_tier: parsed.has_free_tier ?? false,
      pricing_model: parsed.pricing_model ?? 'unknown',
      plans: Array.isArray(parsed.plans) ? parsed.plans : [],
      endpoint_pricing: Array.isArray(parsed.endpoint_pricing) ? parsed.endpoint_pricing : [],
    };
  } catch { return null; }
}

// ─── DB Operations ───────────────────────────────────────────────────────────

async function updateApiPricing(
  supabase: SupabaseClient,
  apiId: string,
  result: PricingResult,
) {
  const pricingSummary = {
    pricing_url: result.pricing_url,
    has_free_tier: result.has_free_tier,
    pricing_model: result.pricing_model,
    plans: result.plans,
  };

  const { error } = await supabase
    .from('apis')
    .update({
      pricing_url: result.pricing_url,
      pricing: pricingSummary,
    })
    .eq('id', apiId);

  if (error) console.error(`   ❌ API pricing update error for ${apiId}: ${error.message}`);
}

async function updateEndpointPricing(
  supabase: SupabaseClient,
  apiId: string,
  endpointPricing: EndpointPricing[],
) {
  for (const ep of endpointPricing) {
    if (!ep.method || !ep.path) continue;

    const pricing = {
      tier: ep.tier,
      price_per_call: ep.price_per_call,
      rate_limit: ep.rate_limit,
    };

    const { error } = await supabase
      .from('api_endpoints')
      .update({ pricing })
      .eq('api_id', apiId)
      .eq('method', ep.method.toUpperCase())
      .eq('path', ep.path);

    if (error && !error.message.includes('0 rows')) {
      console.error(`   ❌ Endpoint pricing update error: ${error.message}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const orKey = env.OPENROUTER_API_KEY ?? '';
  const fcKey = env.FIRECRAWL_API_KEY ?? '';

  if (!supabaseUrl || !supabaseKey || !orKey || !fcKey) {
    console.error('❌ Missing: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY, FIRECRAWL_API_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('\n📊 Loading APIs without pricing data...');
  const allApis: ApiRow[] = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('apis')
      .select('id, title, website, doc_url')
      .is('pricing', null)
      .not('website', 'is', null)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allApis.push(...(data as ApiRow[]));
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`   ${allApis.length} APIs to process\n`);
  if (allApis.length === 0) { console.log('✅ Nothing to scrape.'); return; }

  const stats = { total: 0, found: 0, notFound: 0 };
  const limit = createLimiter(3);

  async function processApi(api: ApiRow) {
    stats.total++;
    const num = stats.total;
    const prefix = `[${num}/${allApis.length}] ${api.title}`;
    const domain = api.id.split(':')[0];

    const pricingUrl = await findPricingUrl(domain);

    if (!pricingUrl) {
      stats.notFound++;
      if (num % 100 === 0) console.log(`   ⚪ ${prefix} — no pricing page`);
      return;
    }

    // Get existing endpoints for this API to help LLM map pricing
    const { data: endpoints } = await supabase
      .from('api_endpoints')
      .select('method, path')
      .eq('api_id', api.id)
      .limit(100);

    const result = await extractPricing(
      api, pricingUrl, fcKey, orKey,
      (endpoints ?? []) as { method: string; path: string }[],
    );

    if (!result) {
      stats.notFound++;
      console.log(`   ⚪ ${prefix} — extraction failed`);
      return;
    }

    await updateApiPricing(supabase, api.id, result);

    if (result.endpoint_pricing.length > 0) {
      await updateEndpointPricing(supabase, api.id, result.endpoint_pricing);
    }

    stats.found++;
    const planCount = result.plans.length;
    const freeTier = result.has_free_tier ? '(free tier)' : '(no free tier)';
    console.log(`   ✅ ${prefix} — ${planCount} plans ${freeTier} — ${result.pricing_model}`);
  }

  console.log('🚀 Starting pricing scraper...\n');
  const promises = allApis.map(a => limit(() => processApi(a)));
  await Promise.all(promises);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Pricing scrape results:`);
  console.log(`   Processed: ${stats.total}`);
  console.log(`   Pricing found: ${stats.found}`);
  console.log(`   No pricing page: ${stats.notFound}`);
  console.log(`${'─'.repeat(50)}\n`);
}

main();
