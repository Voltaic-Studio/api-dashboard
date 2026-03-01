/**
 * backfill-summaries.ts
 *
 * Full-catalog quality backfill:
 * - Scans ALL APIs in `public.apis`
 * - Uses Gemini to evaluate summary quality against product rules
 * - Rewrites description/tldr only when needed
 *
 * Business rules:
 * - description: short business one-liner (homepage card)
 * - tldr: longer practical summary of what developers can do with the API
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

type ApiRow = {
  id: string;
  title: string | null;
  description: string | null;
  tldr: string | null;
  website: string | null;
  doc_url: string | null;
};

type SummaryResult = {
  description: string;
  tldr: string;
};

type QualityCheck = {
  should_rewrite: boolean;
  reasons: string[];
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
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

function stripMarkup(input: string): string {
  return input
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;\/?[a-z][^&]*&gt;/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/[#>*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen - 1)}…`;
}

function parseJsonObject(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function shouldHardRewriteLocally(api: ApiRow): boolean {
  const d = api.description ?? '';
  const t = api.tldr ?? '';
  const hasHtml = /<[a-z!/][^>]*>/i.test(d) || /<[a-z!/][^>]*>/i.test(t) || /&lt;\/?[a-z][^&]*&gt;/i.test(d) || /&lt;\/?[a-z][^&]*&gt;/i.test(t);
  const desc = stripMarkup(d);
  const tldr = stripMarkup(t);
  if (hasHtml) return true;
  if (!desc || !tldr) return true;
  if (desc.length > 220 || desc.length < 40) return true;
  if (tldr.length < 140) return true;
  if (desc.length >= tldr.length) return true;
  return false;
}

async function fetchAllApis(supabase: SupabaseClient): Promise<ApiRow[]> {
  const all: ApiRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('apis')
      .select('id,title,description,tldr,website,doc_url')
      .range(from, from + 999);
    if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as ApiRow[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function fetchEndpointHints(supabase: SupabaseClient, apiId: string): Promise<string[]> {
  const { data } = await supabase
    .from('api_endpoints')
    .select('method,path,summary')
    .eq('api_id', apiId)
    .limit(8);

  return (data ?? []).map((e: any) => {
    const method = String(e?.method ?? '').toUpperCase().trim();
    const path = String(e?.path ?? '').trim();
    const summary = String(e?.summary ?? '').trim();
    if (!method || !path) return '';
    return `${method} ${path}${summary ? ` — ${summary}` : ''}`;
  }).filter(Boolean);
}

function buildSource(api: ApiRow): string {
  const desc = stripMarkup(api.description ?? '');
  const tldr = stripMarkup(api.tldr ?? '');
  const merged = [desc, tldr].filter(Boolean).join(' ');
  return truncate(merged, 2500);
}

async function llmQualityCheck(
  openRouterKey: string,
  api: ApiRow,
  endpointHints: string[],
): Promise<QualityCheck | null> {
  const prompt = [
    'You are a strict API metadata reviewer.',
    'Decide if existing fields need rewrite.',
    'Return strict JSON: {"should_rewrite": true|false, "reasons": ["..."]}',
    '',
    'Rules for GOOD metadata:',
    '- description: short one-liner (40-180 chars), business/service focused',
    '- description should explain what business/service the API is for',
    '- tldr: longer practical summary (140-650 chars), focused on what developers can do',
    '- tldr should include capabilities/use-cases, not generic filler',
    '- description must be shorter than tldr',
    '- both must be plain text, no HTML/markdown',
    '- reject generic text like "This is a REST API" or "programmatic access"',
    '',
    `API id: ${api.id}`,
    `API title: ${api.title ?? api.id}`,
    `Website: ${api.website ?? 'unknown'}`,
    `Doc URL: ${api.doc_url ?? 'unknown'}`,
    endpointHints.length ? `Endpoint hints:\n- ${endpointHints.join('\n- ')}` : 'Endpoint hints: none',
    `Current description: ${api.description ?? ''}`,
    `Current tldr: ${api.tldr ?? ''}`,
  ].join('\n');

  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash',
        temperature: 0,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      },
    );
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== 'string') return null;
    const parsed = parseJsonObject(raw);
    if (!parsed) return null;
    return {
      should_rewrite: Boolean(parsed.should_rewrite),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map((r: any) => String(r)) : [],
    };
  } catch {
    return null;
  }
}

function isGenericFiller(text: string): boolean {
  const s = text.toLowerCase();
  const patterns = [
    /this is a rest api/,
    /this api provides programmatic access/,
    /allows developers to integrate/,
    /offers a robust interface/,
    /for various use cases/,
    /this endpoint/,
    /api endpoint/,
  ];
  return patterns.some(p => p.test(s));
}

async function generateSummaries(
  openRouterKey: string,
  api: ApiRow,
  endpointHints: string[],
  qualityReasons: string[],
): Promise<SummaryResult | null> {
  const sourceText = buildSource(api);
  if (!sourceText) return null;

  let feedback = qualityReasons.length ? qualityReasons.join(' | ') : '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const prompt = [
      'Rewrite API metadata into clean plain-text summaries.',
      'Return strict JSON with exactly these keys:',
      '{"description":"...","tldr":"..."}',
      '',
      'MANDATORY format:',
      '- description: 1 sentence, 40-180 chars.',
      '- description explains what BUSINESS/SERVICE this API is for (homepage card).',
      '- tldr: 2-4 sentences, 140-650 chars.',
      '- tldr explains what developers can actually do with this API (capabilities + use-cases).',
      '- description MUST be shorter than tldr.',
      '- No markdown, HTML, links, or boilerplate.',
      '- Avoid generic filler like "This is a REST API" or "programmatic access".',
      '- Be factual. If uncertain, stay specific but conservative.',
      '',
      'Mini examples:',
      '- BAD description: "The Stripe API. Check docs for more info."',
      '- GOOD description: "Stripe helps businesses accept online payments and manage billing."',
      '- BAD tldr: "Stripe is a REST API with endpoints for developers."',
      '- GOOD tldr: "Stripe lets you create payments, store payment methods, run subscriptions, issue refunds, and process webhook events for billing flows."',
      '',
      `API id: ${api.id}`,
      `API title: ${api.title ?? api.id}`,
      `Website: ${api.website ?? 'unknown'}`,
      `Doc URL: ${api.doc_url ?? 'unknown'}`,
      endpointHints.length ? `Endpoint hints:\n- ${endpointHints.join('\n- ')}` : 'Endpoint hints: none',
      `Current description: ${api.description ?? ''}`,
      `Current tldr: ${api.tldr ?? ''}`,
      `Source text: ${sourceText}`,
      feedback ? `\nFix these issues from prior output: ${feedback}` : '',
    ].join('\n');

    try {
      const { data } = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'google/gemini-2.5-flash',
          temperature: 0.1,
          max_tokens: 700,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            Authorization: `Bearer ${openRouterKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 35000,
        },
      );

      const raw = data?.choices?.[0]?.message?.content;
      if (!raw || typeof raw !== 'string') {
        feedback = 'No valid JSON object returned.';
        continue;
      }

      const parsed = parseJsonObject(raw);
      if (!parsed) {
        feedback = 'Output was not valid JSON.';
        continue;
      }

      let description = stripMarkup(String(parsed.description ?? '')).replace(/\s+/g, ' ').trim();
      let tldr = stripMarkup(String(parsed.tldr ?? '')).replace(/\s+/g, ' ').trim();
      if (!description || !tldr) {
        feedback = 'One or both fields were empty.';
        continue;
      }

      description = truncate(description, 180);
      tldr = truncate(tldr, 650);

      if (description.length < 40 || description.length > 180) {
        feedback = 'description must be 40-180 chars and one concise sentence.';
        continue;
      }
      if (tldr.length < 140) {
        feedback = 'tldr must be at least 140 chars and explain practical capabilities.';
        continue;
      }
      if (description.length >= tldr.length) {
        feedback = 'description must be shorter than tldr.';
        continue;
      }
      if (isGenericFiller(description) || isGenericFiller(tldr)) {
        feedback = 'Output is generic filler. Must be business/capability specific.';
        continue;
      }

      return { description, tldr };
    } catch {
      feedback = 'Model call failed or timed out; retry with stricter concise output.';
    }
  }

  return null;
}

async function updateApi(supabase: SupabaseClient, apiId: string, next: SummaryResult) {
  const { error } = await supabase
    .from('apis')
    .update({ description: next.description, tldr: next.tldr })
    .eq('id', apiId);
  if (error) throw new Error(`Update failed for ${apiId}: ${error.message}`);
}

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const openRouterKey = env.OPENROUTER_API_KEY ?? '';
  if (!supabaseUrl || !supabaseKey || !openRouterKey) {
    throw new Error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or OPENROUTER_API_KEY in Backend/.env');
  }

  const concurrency = Number(env.BACKFILL_SUMMARIES_CONCURRENCY ?? '4');
  const maxToProcess = Number(env.BACKFILL_SUMMARIES_MAX ?? '100000');
  const outPath = path.join(process.cwd(), `backfill-summaries-${Date.now()}.jsonl`);

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  console.log('🧪 Mode: APPLY (all APIs quality pass)');
  console.log('📥 Loading APIs...');
  const allApis = await fetchAllApis(supabase);
  const candidates = allApis.slice(0, maxToProcess);

  console.log(`📊 Total APIs: ${allApis.length}`);
  console.log(`🎯 Candidate scan set: ${candidates.length}`);

  const limiter = createLimiter(Math.max(1, concurrency));
  let done = 0;
  let rewritten = 0;
  let skipped = 0;
  let failed = 0;

  fs.writeFileSync(outPath, '', 'utf-8');

  await Promise.all(
    candidates.map(api =>
      limiter(async () => {
        try {
          const endpointHints = await fetchEndpointHints(supabase, api.id);

          const localNeedsRewrite = shouldHardRewriteLocally(api);
          const quality = localNeedsRewrite
            ? { should_rewrite: true, reasons: ['Failed local quality checks (length/html/inversion).'] }
            : await llmQualityCheck(openRouterKey, api, endpointHints);

          const shouldRewrite = localNeedsRewrite || Boolean(quality?.should_rewrite);
          if (!shouldRewrite) {
            skipped++;
            done++;
            if (done % 50 === 0) console.log(`⏭️ [${done}/${candidates.length}] skipped=${skipped}`);
            return;
          }

          const reasons = quality?.reasons ?? [];
          const next = await generateSummaries(openRouterKey, api, endpointHints, reasons);
          if (!next) throw new Error('No valid rewrite produced');

          await updateApi(supabase, api.id, next);

          const payload = {
            id: api.id,
            action: 'rewritten',
            reasons,
            old_description_len: (api.description ?? '').length,
            old_tldr_len: (api.tldr ?? '').length,
            new_description_len: next.description.length,
            new_tldr_len: next.tldr.length,
            description: next.description,
            tldr: next.tldr,
          };
          fs.appendFileSync(outPath, `${JSON.stringify(payload)}\n`, 'utf-8');

          rewritten++;
          done++;
          console.log(`✅ [${done}/${candidates.length}] ${api.id}`);
        } catch (err: any) {
          const payload = {
            id: api.id,
            action: 'failed',
            error: err?.message ?? String(err),
          };
          fs.appendFileSync(outPath, `${JSON.stringify(payload)}\n`, 'utf-8');
          failed++;
          done++;
          console.log(`❌ [${done}/${candidates.length}] ${api.id} — ${payload.error}`);
        }
      }),
    ),
  );

  console.log('\n──────────');
  console.log(`✅ Rewritten: ${rewritten}`);
  console.log(`⏭️ Skipped (already good): ${skipped}`);
  console.log(`⚠️ Failed: ${failed}`);
  console.log(`📝 Output: ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

