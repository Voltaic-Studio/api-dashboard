/**
 * cleanup-apis.ts
 *
 * Three-step database cleanup:
 *   1. Delete junk APIs (no website, no swagger_url, no doc_url)
 *   2. Merge duplicate IDs (adyen.com:TfmAPIService → adyen.com),
 *      re-point all endpoints to the canonical domain ID
 *   3. Backfill short descriptions via LLM for the homepage grid
 *
 * Usage:  cd Backend && pnpm run cleanup
 *
 * Flags:
 *   --dry-run   Log what would happen without mutating
 *   --step=1    Run only step 1
 *   --step=2    Run only step 2
 *   --step=3    Run only step 3
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';
import fs from 'fs';
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

const env = loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');
const STEP_FLAG = process.argv.find(a => a.startsWith('--step='));
const ONLY_STEP = STEP_FLAG ? parseInt(STEP_FLAG.split('=')[1]) : null;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const OPENROUTER_KEY = env.OPENROUTER_API_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAll(table: string, columns = '*') {
  const PAGE = 1000;
  const rows: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE - 1);
    if (error) { console.error(`  fetch error: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function baseDomain(id: string): string {
  return id.split(':')[0].toLowerCase();
}

// ─── Step 1: Delete Junk ─────────────────────────────────────────────────────

async function step1_deleteJunk() {
  console.log('\n━━━ Step 1: Delete junk APIs ━━━');

  const apis = await fetchAll('apis', 'id,website,swagger_url,doc_url,title');

  const junk = apis.filter(a =>
    !a.website && !a.swagger_url && !a.doc_url
  );

  console.log(`  Total APIs: ${apis.length}`);
  console.log(`  Junk (no website, swagger_url, or doc_url): ${junk.length}`);

  if (junk.length === 0) { console.log('  ✅ Nothing to delete.'); return; }

  // Show some examples
  for (const j of junk.slice(0, 10)) {
    console.log(`    🗑  ${j.id} — "${j.title ?? '(no title)'}"`);
  }
  if (junk.length > 10) console.log(`    ... and ${junk.length - 10} more`);

  if (DRY_RUN) { console.log('  [DRY RUN] Skipping deletes.'); return; }

  const BATCH = 100;
  let deleted = 0;
  for (let i = 0; i < junk.length; i += BATCH) {
    const ids = junk.slice(i, i + BATCH).map(j => j.id);

    // Delete endpoints first (FK)
    await supabase.from('api_endpoints').delete().in('api_id', ids);

    const { error } = await supabase.from('apis').delete().in('id', ids);
    if (error) console.error(`    ❌ Delete error: ${error.message}`);
    else deleted += ids.length;
  }

  console.log(`  ✅ Deleted ${deleted} junk APIs.`);
}

// ─── Step 2: Merge Duplicates ────────────────────────────────────────────────

async function step2_mergeDuplicates() {
  console.log('\n━━━ Step 2: Merge duplicate IDs → bare domain ━━━');

  const apis = await fetchAll('apis', 'id,title,description,website,doc_url,swagger_url,logo,tldr,tier,scrape_status');

  // Group by base domain
  const groups = new Map<string, any[]>();
  for (const api of apis) {
    const domain = baseDomain(api.id);
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain)!.push(api);
  }

  // Find domains with either: multiple rows OR a single row whose id has ":"
  const toMerge = [...groups.entries()].filter(([domain, entries]) =>
    entries.length > 1 || entries[0].id !== domain
  );

  console.log(`  Domains with duplicates or colon IDs: ${toMerge.length}`);

  if (toMerge.length === 0) { console.log('  ✅ All IDs are clean.'); return; }

  let merged = 0;
  let endpointsRepointed = 0;

  for (const [domain, entries] of toMerge) {
    // Pick the best "winner": prefer the one that already IS the bare domain,
    // then pick the one with the most data (doc_url, description, tier=verified)
    const winner = entries.sort((a: any, b: any) => {
      if (a.id === domain && b.id !== domain) return -1;
      if (b.id === domain && a.id !== domain) return 1;
      const scoreA = (a.doc_url ? 2 : 0) + (a.description ? 1 : 0) + (a.tier === 'verified' ? 3 : 0) + (a.tldr ? 1 : 0);
      const scoreB = (b.doc_url ? 2 : 0) + (b.description ? 1 : 0) + (b.tier === 'verified' ? 3 : 0) + (b.tldr ? 1 : 0);
      return scoreB - scoreA;
    })[0];

    const losers = entries.filter((e: any) => e.id !== winner.id);
    const loserIds = losers.map((l: any) => l.id);

    console.log(`  📦 ${domain}: keeping "${winner.id}", merging ${loserIds.length} duplicates`);
    for (const lid of loserIds.slice(0, 5)) console.log(`      ↳ merging: ${lid}`);
    if (loserIds.length > 5) console.log(`      ... and ${loserIds.length - 5} more`);

    if (DRY_RUN) { merged += loserIds.length; continue; }

    const needsRename = winner.id !== domain;

    // ── Phase 1: Ensure the bare domain API row exists ──
    if (needsRename) {
      const { id: _old, ...rest } = winner;
      const { error: insertErr } = await supabase
        .from('apis')
        .upsert({ ...rest, id: domain }, { onConflict: 'id' });
      if (insertErr) {
        console.error(`    ❌ Rename insert error: ${insertErr.message}`);
        continue;
      }
      // Re-point winner's own endpoints to bare domain
      await supabase
        .from('api_endpoints')
        .update({ api_id: domain })
        .eq('api_id', winner.id);
      // Delete old winner row
      await supabase.from('apis').delete().eq('id', winner.id);
    }

    // ── Phase 2: Merge loser endpoints into bare domain ──
    // Build a running set of existing endpoint keys on the target
    const { data: targetEndpoints } = await supabase
      .from('api_endpoints')
      .select('method,path')
      .eq('api_id', domain);

    const existingKeys = new Set(
      (targetEndpoints ?? []).map((e: any) => `${e.method}:${e.path}`)
    );

    for (const loserId of loserIds) {
      const { data: loserEndpoints } = await supabase
        .from('api_endpoints')
        .select('id,method,path')
        .eq('api_id', loserId);

      if (loserEndpoints && loserEndpoints.length > 0) {
        const conflicting = loserEndpoints.filter((e: any) => existingKeys.has(`${e.method}:${e.path}`));
        const safe = loserEndpoints.filter((e: any) => !existingKeys.has(`${e.method}:${e.path}`));

        // Delete conflicting endpoints (target already has them)
        if (conflicting.length > 0) {
          await supabase
            .from('api_endpoints')
            .delete()
            .in('id', conflicting.map((c: any) => c.id));
        }

        // Re-point safe endpoints one by one to avoid batch unique conflicts
        for (const ep of safe) {
          const { error } = await supabase
            .from('api_endpoints')
            .update({ api_id: domain })
            .eq('id', ep.id);
          if (error) {
            // Conflict from another loser — just delete this dupe
            await supabase.from('api_endpoints').delete().eq('id', ep.id);
          } else {
            existingKeys.add(`${ep.method}:${ep.path}`);
            endpointsRepointed++;
          }
        }
      }

      // Delete the loser API row
      const { error } = await supabase.from('apis').delete().eq('id', loserId);
      if (error) console.error(`    ❌ Delete loser error: ${error.message}`);
      else merged++;
    }
  }

  console.log(`  ✅ Merged ${merged} duplicate rows, re-pointed ${endpointsRepointed} endpoints.`);
}

// ─── Step 3: Backfill Descriptions ──────────────────────────────────────────

async function step3_backfillDescriptions() {
  console.log('\n━━━ Step 3: Backfill short descriptions via LLM ━━━');

  if (!OPENROUTER_KEY) {
    console.error('  ❌ Missing OPENROUTER_API_KEY — skipping step 3.');
    return;
  }

  const apis = await fetchAll('apis', 'id,title,description,website,doc_url');

  // Only backfill APIs with missing or very short/generic descriptions
  const needsBackfill = apis.filter(a =>
    !a.description ||
    a.description.length < 20 ||
    a.description.toLowerCase().includes('todo') ||
    a.description.startsWith('{') ||
    a.description.startsWith('[')
  );

  console.log(`  Total APIs: ${apis.length}`);
  console.log(`  Need description backfill: ${needsBackfill.length}`);

  if (needsBackfill.length === 0) { console.log('  ✅ All descriptions look good.'); return; }

  if (DRY_RUN) {
    for (const a of needsBackfill.slice(0, 10)) {
      console.log(`    📝 Would backfill: ${a.id} — current: "${(a.description ?? '').slice(0, 50)}"`);
    }
    if (needsBackfill.length > 10) console.log(`    ... and ${needsBackfill.length - 10} more`);
    console.log('  [DRY RUN] Skipping LLM calls.');
    return;
  }

  // Fetch top endpoints per API for context (batch)
  const endpointMap = new Map<string, string[]>();
  const allEndpoints = await fetchAll('api_endpoints', 'api_id,method,path');
  for (const ep of allEndpoints) {
    if (!endpointMap.has(ep.api_id)) endpointMap.set(ep.api_id, []);
    endpointMap.get(ep.api_id)!.push(`${ep.method} ${ep.path}`);
  }

  let updated = 0;
  let failed = 0;
  const CONCURRENCY = 5;

  // Process in batches for concurrency control
  for (let i = 0; i < needsBackfill.length; i += CONCURRENCY) {
    const batch = needsBackfill.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (api) => {
        const endpoints = (endpointMap.get(api.id) ?? []).slice(0, 10);
        const endpointCtx = endpoints.length > 0
          ? `\nTop endpoints: ${endpoints.join(', ')}`
          : '';

        const prompt = `Write a concise 1-sentence description (max 120 chars) of what the "${api.title ?? api.id}" API does. It should be for a developer audience, factual, and describe the core functionality.

Company/API: ${api.title ?? api.id}
Domain: ${api.id}
Website: ${api.website ?? 'unknown'}${endpointCtx}

Reply with ONLY the description sentence, nothing else.`;

        const res = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'google/gemini-2.5-flash',
            max_tokens: 200,
            messages: [{ role: 'user', content: prompt }],
          },
          { headers: { Authorization: `Bearer ${OPENROUTER_KEY}` } }
        );

        const desc = res.data?.choices?.[0]?.message?.content?.trim();
        if (!desc || desc.length < 10) throw new Error('Empty LLM response');

        // Clean: remove wrapping quotes if present
        const cleaned = desc.replace(/^["']|["']$/g, '').trim();

        const { error } = await supabase
          .from('apis')
          .update({ description: cleaned })
          .eq('id', api.id);

        if (error) throw new Error(error.message);
        return api.id;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        updated++;
        console.log(`    ✅ ${r.value}`);
      } else {
        failed++;
        console.error(`    ❌ ${r.reason}`);
      }
    }

    console.log(`  Progress: ${Math.min(i + CONCURRENCY, needsBackfill.length)}/${needsBackfill.length}`);

    // Small delay to avoid rate limits
    if (i + CONCURRENCY < needsBackfill.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`  ✅ Updated ${updated} descriptions, ${failed} failed.`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🧹 API Cleanup Script${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`${'━'.repeat(50)}`);

  if (!ONLY_STEP || ONLY_STEP === 1) await step1_deleteJunk();
  if (!ONLY_STEP || ONLY_STEP === 2) await step2_mergeDuplicates();
  if (!ONLY_STEP || ONLY_STEP === 3) await step3_backfillDescriptions();

  console.log(`\n${'━'.repeat(50)}`);
  console.log('🏁 Cleanup complete.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
