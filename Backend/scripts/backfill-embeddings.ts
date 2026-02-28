/**
 * backfill-embeddings.ts
 *
 * Backfills pgvector embeddings for both:
 * - apis.embedding
 * - api_endpoints.embedding
 *
 * Usage:
 *   cd Backend && pnpm run backfill:embeddings
 *
 * Optional flags:
 *   --apiLimit=5000
 *   --endpointLimit=50000
 *   --batch=32
 *   --concurrency=3
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
  capabilities: any[] | null;
};

type EndpointRow = {
  id: string;
  api_id: string;
  method: string | null;
  path: string | null;
  summary: string | null;
  description: string | null;
  section: string | null;
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function embedTexts(orKey: string, model: string, texts: string[]): Promise<number[][]> {
  const { data } = await axios.post(
    'https://openrouter.ai/api/v1/embeddings',
    { model, input: texts },
    {
      headers: {
        Authorization: `Bearer ${orKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    },
  );
  const vectors = (data?.data ?? []).map((d: any) => d.embedding as number[]);
  return vectors;
}

function apiText(a: ApiRow): string {
  const parts = [
    `API: ${a.title ?? a.id}`,
    `Domain: ${a.id}`,
    a.description ? `Description: ${a.description}` : '',
    a.tldr ? `TLDR: ${a.tldr}` : '',
  ];

  if (Array.isArray(a.capabilities) && a.capabilities.length > 0) {
    parts.push('Capabilities:');
    for (const cap of a.capabilities) {
      if (cap?.title) parts.push(`- ${cap.title}: ${cap.description ?? ''}`);
    }
  }

  return parts.filter(Boolean).join('\n');
}

function endpointText(e: EndpointRow): string {
  return [
    `API: ${e.api_id}`,
    `Endpoint: ${(e.method ?? 'GET').toUpperCase()} ${e.path ?? ''}`,
    e.section ? `Section: ${e.section}` : '',
    e.summary ? `Summary: ${e.summary}` : '',
    e.description ? `Description: ${e.description}` : '',
  ].filter(Boolean).join('\n');
}

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const orKey = env.OPENROUTER_API_KEY ?? '';
  const embeddingModel = env.EMBEDDING_MODEL ?? 'openai/text-embedding-3-small';

  if (!supabaseUrl || !supabaseKey || !orKey) {
    console.error('❌ Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or OPENROUTER_API_KEY');
    process.exit(1);
  }

  const batchSize = 32;
  const concurrency = 3;
  const limiter = createLimiter(concurrency);

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log(`🧠 Embedding model: ${embeddingModel}`);

  // ── APIs (paginated fetch) ─────────────────────────────────────────────────
  const apis: ApiRow[] = [];
  {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('apis')
        .select('id,title,description,tldr,website,doc_url,capabilities')
        .is('embedding', null)
        .range(from, from + 999);
      if (error) {
        console.error(`❌ Failed loading APIs: ${error.message}`);
        process.exit(1);
      }
      if (!data || data.length === 0) break;
      apis.push(...(data as ApiRow[]));
      if (data.length < 1000) break;
      from += 1000;
    }
  }
  console.log(`📦 APIs missing embedding: ${apis.length}`);

  let apiDone = 0;
  for (const group of chunk(apis, batchSize)) {
    await limiter(async () => {
      try {
        const vectors = await embedTexts(orKey, embeddingModel, group.map(apiText));
        await Promise.all(group.map(async (row, i) => {
          const emb = vectors[i];
          if (!emb) return;
          await supabase.from('apis').update({ embedding: emb }).eq('id', row.id);
        }));
      } catch (err: any) {
        const status = err?.response?.status;
        const msg = typeof err?.response?.data === 'object'
          ? JSON.stringify(err.response.data)
          : (err?.response?.data ?? err?.message ?? 'unknown');
        console.error(`   ⚠️  API embedding batch failed [${status ?? 'n/a'}]: ${msg}`);
      } finally {
        apiDone += group.length;
        console.log(`   APIs progress: ${Math.min(apiDone, apis.length)}/${apis.length}`);
      }
    });
  }

  // ── Endpoints (paginated fetch) ─────────────────────────────────────────────
  const endpoints: EndpointRow[] = [];
  {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('api_endpoints')
        .select('id,api_id,method,path,summary,description,section')
        .is('embedding', null)
        .range(from, from + 999);
      if (error) {
        console.error(`❌ Failed loading endpoints: ${error.message}`);
        process.exit(1);
      }
      if (!data || data.length === 0) break;
      endpoints.push(...(data as EndpointRow[]));
      if (data.length < 1000) break;
      from += 1000;
    }
  }
  console.log(`🧩 Endpoints missing embedding: ${endpoints.length}`);

  let epDone = 0;
  for (const group of chunk(endpoints, batchSize)) {
    await limiter(async () => {
      try {
        const vectors = await embedTexts(orKey, embeddingModel, group.map(endpointText));
        await Promise.all(group.map(async (row, i) => {
          const emb = vectors[i];
          if (!emb) return;
          await supabase.from('api_endpoints').update({ embedding: emb }).eq('id', row.id);
        }));
      } catch (err: any) {
        const status = err?.response?.status;
        const msg = typeof err?.response?.data === 'object'
          ? JSON.stringify(err.response.data)
          : (err?.response?.data ?? err?.message ?? 'unknown');
        console.error(`   ⚠️  Endpoint embedding batch failed [${status ?? 'n/a'}]: ${msg}`);
      } finally {
        epDone += group.length;
        console.log(`   Endpoints progress: ${Math.min(epDone, endpoints.length)}/${endpoints.length}`);
      }
    });
  }

  console.log('✅ Embedding backfill complete.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

