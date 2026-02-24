/**
 * seed-supabase.ts
 *
 * One-shot script: reads the local apis.json and bulk-upserts every record
 * into the Supabase `apis` table. Safe to re-run — uses upsert on `id`.
 *
 * Prerequisites — run this SQL in the Supabase SQL Editor first:
 *
 *   CREATE TABLE IF NOT EXISTS apis (
 *     id          TEXT PRIMARY KEY,
 *     title       TEXT NOT NULL,
 *     description TEXT,
 *     logo        TEXT,
 *     swagger_url TEXT,
 *     website     TEXT,
 *     updated     TEXT
 *   );
 *
 *   ALTER TABLE apis ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "public read" ON apis FOR SELECT USING (true);
 *
 * Usage:
 *   1. Fill in Backend/.env  →  SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + LOGO_DEV_TOKEN
 *   2. cd Backend && npm run seed
 *
 * Logo strategy: api.guru CDN URLs are mostly dead, so we generate a logo.dev
 * URL for every entry using its domain. logo.dev returns a real logo or a clean
 * monogram fallback — no broken images.
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs-extra';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), '../Frontend/src/data/apis.json');
const BATCH_SIZE = 500;

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

function extractDomain(id: string, website?: string | null): string | null {
  const byId = id.split(':')[0].trim();
  if (byId && byId.includes('.')) return byId;
  if (website) {
    try { return new URL(website).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  }
  return null;
}

async function seed() {
  const env = loadEnv();
  const url   = env.SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  const key   = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const token = env.LOGO_DEV_TOKEN ?? process.env.LOGO_DEV_TOKEN ?? '';

  if (!url || !key) {
    console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Backend/.env');
    process.exit(1);
  }
  if (!token) {
    console.error('❌ LOGO_DEV_TOKEN must be set in Backend/.env');
    process.exit(1);
  }

  const supabase = createClient(url, key);

  console.log('📖 Reading apis.json...');
  const raw: any[] = await fs.readJson(DATA_FILE);
  console.log(`   ${raw.length} APIs loaded.`);

  const rows = raw
    .filter(Boolean)
    .map((api) => {
      const domain = extractDomain(api.id, api.website);
      const logo = domain
        ? `https://img.logo.dev/${domain}?token=${token}&size=64&format=png`
        : null;
      return {
        id: api.id,
        title: api.title ?? '',
        description: api.description ?? null,
        logo,
        swagger_url: api.swaggerUrl ?? null,
        website: api.website ?? null,
        updated: api.updated ?? null,
      };
    });

  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const { error } = await supabase
      .from('apis')
      .upsert(batch, { onConflict: 'id' });

    if (error) {
      console.error(`❌ Batch ${batchNum} failed:`, error.message);
      process.exit(1);
    }

    console.log(`   ✅ Batch ${batchNum}/${totalBatches} — ${batch.length} rows`);
  }

  console.log(`\n🎉 Done. ${rows.length} APIs upserted into Supabase.`);
}

seed();
