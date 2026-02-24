/**
 * fetch-logos.ts
 *
 * One-shot script: finds every API in Supabase with a null logo, derives
 * the domain from its id, builds a logo.dev URL and updates the row.
 * Run once — results are persisted in the DB.
 *
 * Usage:
 *   1. Fill in Backend/.env  →  LOGO_DEV_TOKEN + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   2. cd Backend && npm run fetch-logos
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs-extra';
import path from 'path';

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

async function fetchLogos() {
  const env = loadEnv();
  const token = env.LOGO_DEV_TOKEN ?? process.env.LOGO_DEV_TOKEN ?? '';
  const url   = env.SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  const key   = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!token) { console.error('❌ LOGO_DEV_TOKEN not set in Backend/.env'); process.exit(1); }
  if (!url || !key) { console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in Backend/.env'); process.exit(1); }

  const supabase = createClient(url, key);

  console.log('🔍 Fetching APIs with no logo from Supabase...');
  const { data: missing, error } = await supabase
    .from('apis')
    .select('id, website')
    .is('logo', null);

  if (error) { console.error('❌', error.message); process.exit(1); }
  console.log(`   ${missing?.length ?? 0} APIs without a logo.`);

  if (!missing || missing.length === 0) {
    console.log('✅ All APIs already have logos. Nothing to do.');
    return;
  }

  let filled = 0;
  for (const api of missing) {
    const domain = extractDomain(api.id, api.website);
    if (!domain) { console.warn(`  ⚠️  No domain for ${api.id} — skipping`); continue; }

    const logo = `https://img.logo.dev/${domain}?token=${token}&size=64&format=png`;
    const { error: updateErr } = await supabase
      .from('apis')
      .update({ logo })
      .eq('id', api.id);

    if (updateErr) { console.warn(`  ⚠️  Failed to update ${api.id}: ${updateErr.message}`); continue; }
    filled++;
  }

  console.log(`✅ Updated ${filled} logo URLs in Supabase.`);
}

fetchLogos();
