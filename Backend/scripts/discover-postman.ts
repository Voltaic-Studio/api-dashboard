/**
 * discover-postman.ts
 *
 * Hits Postman's internal API directly to fetch ALL public collections
 * from postman.com/explore/collections, extracts API info,
 * deduplicates against existing Supabase entries, and upserts new ones.
 *
 * Usage:  cd Backend && pnpm run discover:postman
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

interface PostmanEntity {
  name: string;
  description?: string;
  publisherName?: string;
  publisherHandle?: string;
  categories?: string[];
  forkCount?: number;
  watcherCount?: number;
  slug?: string;
  universalEntityId?: string;
  [key: string]: any;
}

interface DiscoveredApi {
  domain: string;
  title: string;
  description: string | null;
  website: string | null;
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

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function titleToDomain(name: string): string | null {
  const cleaned = name
    .replace(/\s*(API|APIs|REST|SDK|Collection|Collections|Docs?|Official|Public|v\d+[\d.]*)\s*/gi, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '');

  if (cleaned.length < 2 || cleaned.length > 40) return null;
  return cleaned + '.com';
}

// ─── Fetch all collections from Postman's internal API ───────────────────────

async function fetchAllCollections(): Promise<PostmanEntity[]> {
  const LIMIT = 12;
  const all: PostmanEntity[] = [];
  let offset = 0;
  let totalPages = 1089; // known from the UI, will adjust if API tells us

  console.log(`\n🔍 Fetching Postman collections (${totalPages} pages × ${LIMIT} per page)...\n`);

  while (true) {
    try {
      const { data } = await axios.post(
        'https://www.postman.com/_api/ws/proxy',
        {
          service: 'publishing',
          method: 'get',
          path: `/v1/api/networkentity?limit=${LIMIT}&type=public&referrer=explore&entityType=collection&flattenAPIVersions=true&category=&sort=forkCount&filter=&offset=${offset}`,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        },
      );

      const entities: PostmanEntity[] = data?.data ?? data?.entities ?? data ?? [];
      if (!Array.isArray(entities) || entities.length === 0) {
        // Try to find entities in nested response structure
        const nested = data?.data?.data ?? data?.body?.data ?? [];
        if (Array.isArray(nested) && nested.length > 0) {
          all.push(...nested);
        } else {
          console.log(`   No more results at offset ${offset}`);
          break;
        }
      } else {
        all.push(...entities);
      }

      const page = Math.floor(offset / LIMIT) + 1;
      if (page % 50 === 0) {
        console.log(`   📄 Page ${page} — ${all.length} collections so far`);
      }

      offset += LIMIT;

      // Safety: if we've gone past expected total, stop
      if (offset > totalPages * LIMIT + LIMIT) break;

      // Rate limit: small delay between requests
      await sleep(200);
    } catch (err: any) {
      const status = err.response?.status;
      const msg = err.response?.data?.error ?? err.message;
      console.warn(`   ⚠ Error at offset ${offset}: ${status} ${msg}`);

      if (status === 429) {
        console.log('   Rate limited, waiting 10s...');
        await sleep(10000);
        continue;
      }
      if (status === 404 || status === 400) break;

      // Retry once after a short wait for other errors
      await sleep(2000);
      offset += LIMIT;
    }
  }

  console.log(`\n📦 Total collections fetched: ${all.length}\n`);
  return all;
}

// ─── Convert Postman entities to our API format ──────────────────────────────

function entitiesToApis(entities: PostmanEntity[]): DiscoveredApi[] {
  const results: DiscoveredApi[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    const name = entity.name ?? entity.title ?? '';
    if (!name || name.length < 2) continue;

    const desc = entity.description ?? entity.summary ?? null;
    const publisher = entity.publisherName ?? entity.publisher?.name ?? '';
    const slug = entity.slug ?? '';

    // Try to derive a domain from the publisher or name
    let domain: string | null = null;

    // Check if description or entity has a URL
    const urlMatch = (desc ?? '').match(/https?:\/\/[^\s)>"]+/);
    if (urlMatch) {
      domain = cleanDomain(urlMatch[0]);
    }

    if (!domain && publisher) {
      domain = titleToDomain(publisher);
    }
    if (!domain) {
      domain = titleToDomain(name);
    }
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);

    const website = slug
      ? `https://www.postman.com/explore/collection/${slug}`
      : null;

    results.push({
      domain,
      title: name.replace(/\s*(API|Collection)\s*$/i, '').trim() || name,
      description: desc ? desc.slice(0, 300) : null,
      website,
    });
  }

  return results;
}

// ─── LLM description generation ──────────────────────────────────────────────

async function generateDescription(title: string, domain: string, apiKey: string): Promise<string | null> {
  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-flash-1.5',
        messages: [{ role: 'user', content: `Write exactly one sentence (max 20 words) describing what the "${title}" API (${domain}) does. Be factual.` }],
        max_tokens: 60,
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
    );
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch { return null; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const logoToken   = env.LOGO_DEV_TOKEN ?? '';
  const orKey       = env.OPENROUTER_API_KEY;

  if (!supabaseUrl || !supabaseKey || !logoToken) {
    console.error('❌ Missing: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LOGO_DEV_TOKEN');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1. Load existing domains
  console.log('📊 Loading existing APIs from Supabase...');
  const existingDomains = new Set<string>();
  let from = 0;
  while (true) {
    const { data } = await supabase.from('apis').select('id').range(from, from + 999);
    if (!data || data.length === 0) break;
    for (const row of data) existingDomains.add(row.id.split(':')[0].toLowerCase());
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`   ${existingDomains.size} domains already in DB`);

  // 2. Fetch ALL collections from Postman
  const entities = await fetchAllCollections();

  // Save raw data for debugging
  fs.writeFileSync(
    path.join(process.cwd(), 'postman-raw.json'),
    JSON.stringify(entities.slice(0, 50), null, 2),
  );
  console.log('   Saved first 50 raw entities to postman-raw.json');

  // 3. Convert to our format
  const allApis = entitiesToApis(entities);
  console.log(`   Converted to ${allApis.length} unique APIs`);

  // 4. Filter out existing
  const newApis = allApis.filter(a => !existingDomains.has(a.domain));
  console.log(`\n📊 Summary: ${entities.length} collections → ${allApis.length} unique → ${newApis.length} new\n`);

  if (newApis.length === 0) {
    console.log('✅ No new APIs from Postman.');
    return;
  }

  // 5. Generate missing descriptions
  if (orKey) {
    const needDesc = newApis.filter(a => !a.description);
    if (needDesc.length > 0) {
      console.log(`📝 Generating descriptions for ${needDesc.length} APIs...`);
      let done = 0;
      for (const api of needDesc) {
        api.description = await generateDescription(api.title, api.domain, orKey);
        done++;
        if (done % 50 === 0) console.log(`   ${done}/${needDesc.length}`);
        await sleep(150);
      }
      console.log('   Done\n');
    }
  }

  // 6. Build rows and upsert
  const rows = newApis.map(api => ({
    id: api.domain,
    title: api.title,
    description: api.description,
    logo: `https://img.logo.dev/${api.domain}?token=${logoToken}&size=64&format=png`,
    swagger_url: null,
    website: api.website,
    updated: new Date().toISOString(),
  }));

  console.log(`💾 Upserting ${rows.length} new APIs...`);
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('apis')
      .upsert(batch, { onConflict: 'id', ignoreDuplicates: true });
    if (error) console.error(`   ❌ Batch error: ${error.message}`);
    else { inserted += batch.length; console.log(`   ✅ ${inserted}/${rows.length}`); }
  }

  console.log(`\n🎉 Done. ${inserted} new APIs from Postman added.`);
}

main();
