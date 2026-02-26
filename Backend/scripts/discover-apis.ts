/**
 * discover-apis.ts
 *
 * Global discovery scraper — pulls APIs from multiple sources,
 * deduplicates by domain, generates logos + missing descriptions,
 * and upserts only NEW entries into the Supabase `apis` table.
 *
 * Sources:
 *   1. public-apis/public-apis GitHub repo (curated list)
 *   2. GitHub Search API (repos with openapi/rest-api topics)
 *
 * Existing apis.guru data is already in the DB — dedup skips those.
 *
 * Usage:
 *   cd Backend && npm run discover
 *
 * Required env vars in .env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LOGO_DEV_TOKEN
 *
 * Optional:
 *   OPENROUTER_API_KEY  — generates one-sentence descriptions for APIs missing one
 *   GITHUB_TOKEN        — higher rate limits on GitHub API (5000 vs 30 req/min)
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

interface DiscoveredApi {
  domain: string;
  title: string;
  description: string | null;
  website: string | null;
  swagger_url: string | null;
  source: string;
}

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

function cleanDomain(raw: string): string | null {
  let d = raw.toLowerCase().trim();
  if (d.startsWith('http')) {
    try { d = new URL(d).hostname; } catch { return null; }
  }
  d = d.replace(/^(www|developer|developers|api|apis|docs|doc|dev)\./i, '');
  if (!d.includes('.') || d.length < 4) return null;
  return d;
}

function titleCase(s: string): string {
  return s
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Source 1: public-apis/public-apis ────────────────────────────────────────

async function fromPublicApis(): Promise<DiscoveredApi[]> {
  console.log('📡 [public-apis] Fetching curated list...');
  const url = 'https://raw.githubusercontent.com/public-apis/public-apis/master/README.md';

  let md: string;
  try {
    const res = await axios.get<string>(url);
    md = res.data;
  } catch {
    console.warn('   ⚠ Failed to fetch public-apis README');
    return [];
  }

  const results: DiscoveredApi[] = [];
  const re = /\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*)\|/g;
  let m;

  while ((m = re.exec(md)) !== null) {
    const title = m[1].trim();
    const link = m[2].trim();
    const desc = m[3].trim().replace(/`/g, '');

    const domain = cleanDomain(link);
    if (!domain) continue;

    results.push({
      domain,
      title,
      description: desc || null,
      website: link,
      swagger_url: null,
      source: 'public-apis',
    });
  }

  console.log(`   Found ${results.length} entries`);
  return results;
}

// ─── Source 2: GitHub Search API ──────────────────────────────────────────────

async function fromGitHub(token?: string): Promise<DiscoveredApi[]> {
  console.log('📡 [github] Searching for OpenAPI repos...');
  const results: DiscoveredApi[] = [];

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'api-dashboard-discovery',
  };
  if (token) headers.Authorization = `token ${token}`;

  const queries = [
    'topic:openapi stars:>20',
    'topic:rest-api stars:>50',
    'topic:api-sdk stars:>30',
    'openapi.json in:path stars:>20',
  ];

  for (const q of queries) {
    for (let page = 1; page <= 3; page++) {
      try {
        const { data } = await axios.get(
          `https://api.github.com/search/repositories`,
          {
            params: { q, sort: 'stars', order: 'desc', per_page: 100, page },
            headers,
          },
        );

        for (const repo of data.items ?? []) {
          const homepage: string | null = repo.homepage;
          if (!homepage) continue;

          const domain = cleanDomain(homepage);
          if (!domain) continue;
          if (domain.includes('github.io') || domain.includes('github.com')) continue;
          if (domain.includes('readthedocs') || domain.includes('gitbook.io')) continue;
          if (domain.includes('npmjs.com') || domain.includes('pypi.org')) continue;

          results.push({
            domain,
            title: titleCase(repo.name),
            description: repo.description ?? null,
            website: homepage,
            swagger_url: null,
            source: 'github',
          });
        }

        if ((data.items?.length ?? 0) < 100) break;
      } catch (err: any) {
        if (err.response?.status === 403) {
          console.warn('   ⚠ GitHub rate limited, waiting 60s...');
          await sleep(60_000);
          page--;
          continue;
        }
        console.warn(`   ⚠ GitHub search failed for "${q}" page ${page}: ${err.message}`);
        break;
      }

      await sleep(2000);
    }
  }

  console.log(`   Found ${results.length} entries`);
  return results;
}

// ─── Description generation via OpenRouter ────────────────────────────────────

async function generateDescription(
  title: string,
  domain: string,
  apiKey: string,
): Promise<string | null> {
  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: `Write exactly one sentence (max 20 words) describing what the "${title}" API (${domain}) does. Be factual and specific. No marketing fluff.`,
          },
        ],
        max_tokens: 60,
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
    );
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function discover() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const logoToken   = env.LOGO_DEV_TOKEN ?? '';
  const orKey       = env.OPENROUTER_API_KEY;
  const ghToken     = env.GITHUB_TOKEN;

  if (!supabaseUrl || !supabaseKey || !logoToken) {
    console.error('❌ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LOGO_DEV_TOKEN required in .env');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1. Fetch existing domains
  console.log('\n📊 Loading existing APIs from Supabase...');
  const existingDomains = new Set<string>();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data } = await supabase.from('apis').select('id').range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    for (const row of data) existingDomains.add(row.id.split(':')[0].toLowerCase());
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`   ${existingDomains.size} unique domains already in DB\n`);

  // 2. Collect from all sources
  const allRaw: DiscoveredApi[] = [];
  allRaw.push(...await fromPublicApis());
  allRaw.push(...await fromGitHub(ghToken));

  // 3. Deduplicate by domain — keep entry with best data
  const deduped = new Map<string, DiscoveredApi>();
  for (const api of allRaw) {
    if (!api.domain) continue;
    const existing = deduped.get(api.domain);
    if (!existing) {
      deduped.set(api.domain, api);
    } else if (!existing.description && api.description) {
      deduped.set(api.domain, api);
    }
  }

  // 4. Filter out already-existing domains
  const newApis = [...deduped.values()].filter(a => !existingDomains.has(a.domain));
  console.log(`\n📊 Summary: ${allRaw.length} raw → ${deduped.size} unique → ${newApis.length} new\n`);

  if (newApis.length === 0) {
    console.log('✅ No new APIs to add.');
    return;
  }

  // 5. Generate missing descriptions
  if (orKey) {
    const needDesc = newApis.filter(a => !a.description);
    if (needDesc.length > 0) {
      console.log(`📝 Generating descriptions for ${needDesc.length} APIs via OpenRouter...`);
      let done = 0;
      for (const api of needDesc) {
        const desc = await generateDescription(api.title, api.domain, orKey);
        if (desc) api.description = desc;
        done++;
        if (done % 25 === 0) console.log(`   ${done}/${needDesc.length}`);
        await sleep(150);
      }
      console.log(`   Done — ${done} processed\n`);
    }
  } else {
    console.log('ℹ No OPENROUTER_API_KEY set — skipping description generation\n');
  }

  // 6. Build rows
  const rows = newApis.map(api => ({
    id: api.domain,
    title: api.title,
    description: api.description,
    logo: `https://img.logo.dev/${api.domain}?token=${logoToken}&size=64&format=png`,
    swagger_url: api.swagger_url,
    website: api.website,
    updated: new Date().toISOString(),
  }));

  // 7. Upsert into Supabase (ignoreDuplicates for extra safety)
  console.log(`💾 Upserting ${rows.length} new APIs...`);
  const BATCH = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('apis')
      .upsert(batch, { onConflict: 'id', ignoreDuplicates: true });

    if (error) {
      console.error(`   ❌ Batch ${Math.floor(i / BATCH) + 1} failed: ${error.message}`);
    } else {
      inserted += batch.length;
      console.log(`   ✅ ${inserted}/${rows.length}`);
    }
  }

  console.log(`\n🎉 Done. ${inserted} new APIs added to Supabase.`);
}

discover();
