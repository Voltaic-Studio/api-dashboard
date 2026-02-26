/**
 * backfill-tldr.ts
 *
 * Backfills missing/short API TLDRs using OpenRouter.
 * Processes ALL APIs in the database.
 *
 * Usage:
 *   cd Backend && pnpm run backfill:tldr
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

type AnyApi = {
  id: string;
  title: string | null;
  description: string | null;
  tldr: string | null;
  website: string | null;
  doc_url: string | null;
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

async function fetchAllApis(supabase: SupabaseClient): Promise<AnyApi[]> {
  const all: AnyApi[] = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('apis')
      .select('id,title,description,tldr,website,doc_url')
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    all.push(...(data as AnyApi[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

function sanitizeTldr(text: string): string {
  return text
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getSampleEndpoints(supabase: SupabaseClient, apiId: string): Promise<string[]> {
  const { data } = await supabase
    .from('api_endpoints')
    .select('method,path,summary')
    .eq('api_id', apiId)
    .limit(6);
  return (data ?? []).map((e: any) => {
    const summary = e.summary ? ` — ${e.summary}` : '';
    return `${e.method} ${e.path}${summary}`;
  });
}

async function generateTldr(orKey: string, api: AnyApi, endpointHints: string[]): Promise<string | null> {
  const prompt = [
    'Write a concise, factual TLDR for this API.',
    'Rules:',
    '- 3 to 4 short sentences.',
    '- Developer-focused, plain English.',
    '- Mention core capability, common use-cases, and integration value.',
    '- No hype, no markdown, no bullet points.',
    '- Output only the TLDR text.',
    '',
    `API ID: ${api.id}`,
    `Name: ${api.title ?? api.id}`,
    `Website: ${api.website ?? 'unknown'}`,
    `Doc URL: ${api.doc_url ?? 'unknown'}`,
    `Existing description: ${api.description ?? 'none'}`,
    endpointHints.length ? `Sample endpoints:\n- ${endpointHints.join('\n- ')}` : 'Sample endpoints: none',
  ].join('\n');

  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash',
        max_tokens: 260,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${orKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 35000,
      },
    );
    const text = data?.choices?.[0]?.message?.content;
    if (!text || typeof text !== 'string') return null;
    const cleaned = sanitizeTldr(text);
    return cleaned.length >= 40 ? cleaned : null;
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = typeof err?.response?.data === 'object'
      ? JSON.stringify(err.response.data)
      : (err?.response?.data ?? err?.message ?? 'unknown');
    console.error(`   ⚠️  OpenRouter error [${status ?? 'n/a'}]: ${msg}`);
    return null;
  }
}

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const orKey = env.OPENROUTER_API_KEY ?? '';

  if (!supabaseUrl || !supabaseKey || !orKey) {
    console.error('❌ Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or OPENROUTER_API_KEY');
    process.exit(1);
  }

  const minLen = 40;
  const concurrency = 4;
  const limiter = createLimiter(concurrency);

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('🧠 Loading APIs...');
  const all = await fetchAllApis(supabase);
  const targets = all.filter(a => !a.tldr || a.tldr.trim().length < minLen);
  console.log(`📊 APIs loaded: ${all.length}`);
  console.log(`🎯 APIs needing TLDR: ${targets.length} (minLen=${minLen})`);
  if (targets.length === 0) return;

  let done = 0;
  let ok = 0;
  let fail = 0;

  await Promise.all(targets.map(api => limiter(async () => {
    const hints = await getSampleEndpoints(supabase, api.id);
    const tldr = await generateTldr(orKey, api, hints);
    done++;
    if (!tldr) {
      fail++;
      console.log(`   ⚪ [${done}/${targets.length}] ${api.id} — skipped`);
      return;
    }

    const { error: upErr } = await supabase
      .from('apis')
      .update({ tldr })
      .eq('id', api.id);

    if (upErr) {
      fail++;
      console.error(`   ❌ [${done}/${targets.length}] ${api.id} — ${upErr.message}`);
      return;
    }

    ok++;
    console.log(`   ✅ [${done}/${targets.length}] ${api.id}`);
  })));

  console.log('\n──────────');
  console.log(`✅ Updated TLDRs: ${ok}`);
  console.log(`⚠️  Skipped/failed: ${fail}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

