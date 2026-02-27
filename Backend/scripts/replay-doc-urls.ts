/**
 * replay-doc-urls.ts
 *
 * Reads doc-url-validation.json and writes all "fixed" URLs to the DB.
 * Retries failed writes with a small delay.
 *
 * Usage:
 *   cd Backend && pnpm run replay:doc-urls
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs-extra';
import path from 'path';

type ValidationResult = {
  api_id: string;
  original_url: string | null;
  final_url: string | null;
  status: 'valid' | 'fixed' | 'not_found';
  source: string;
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const jsonPath = path.join(process.cwd(), 'data', 'doc-url-validation.json');
  if (!fs.existsSync(jsonPath)) {
    console.error(`❌ File not found: ${jsonPath}`);
    process.exit(1);
  }

  const results: ValidationResult[] = fs.readJsonSync(jsonPath);
  const toUpdate = results.filter(r => r.status === 'fixed' && r.final_url);

  console.log(`📦 Loaded ${results.length} results, ${toUpdate.length} need DB writes\n`);

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < toUpdate.length; i++) {
    const r = toUpdate[i];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { error } = await supabase
          .from('apis')
          .update({ doc_url: r.final_url })
          .eq('id', r.api_id);

        if (error) throw new Error(error.message);
        ok++;
        if (ok % 50 === 0) console.log(`   ✅ ${ok}/${toUpdate.length}`);
        break;
      } catch (err: any) {
        if (attempt < 2) {
          await sleep(1000 * (attempt + 1));
        } else {
          fail++;
          console.error(`   ❌ ${r.api_id}: ${err?.message ?? 'unknown'}`);
        }
      }
    }
  }

  console.log('\n══════════════════════════════════════════');
  console.log(`✅ Updated: ${ok}`);
  console.log(`❌ Failed:  ${fail}`);
  console.log('══════════════════════════════════════════');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
