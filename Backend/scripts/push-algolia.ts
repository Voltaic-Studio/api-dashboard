/**
 * push-algolia.ts
 *
 * One-shot script: reads apis.json, cleans descriptions, pushes all records
 * to the Algolia index, and configures searchable attributes.
 * Safe to re-run — uses updateObject (upsert).
 *
 * Usage:
 *   1. Fill in Backend/.env  →  ALGOLIA_APP_ID + ALGOLIA_ADMIN_API_KEY + ALGOLIA_INDEX_NAME
 *   2. cd Backend && npm run push-algolia
 */

import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

const DATA_FILE  = path.join(process.cwd(), '../Frontend/src/data/apis.json');
const BATCH_SIZE = 1000; // Algolia max per batch request

// ── Env loader ────────────────────────────────────────────────────────────────
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

// ── Description cleaner (mirrors frontend) ────────────────────────────────────
function cleanDescription(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/&lt;style[\s\S]*?&lt;\/style\s*&gt;/gi, '')
    .replace(/&lt;script[\s\S]*?&lt;\/script\s*&gt;/gi, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\|.*$/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ').trim();
}

async function push() {
  const env       = loadEnv();
  const appId     = env.ALGOLIA_APP_ID     ?? process.env.ALGOLIA_APP_ID     ?? '';
  const adminKey  = env.ALGOLIA_ADMIN_API_KEY ?? process.env.ALGOLIA_ADMIN_API_KEY ?? '';
  const indexName = env.ALGOLIA_INDEX_NAME ?? process.env.ALGOLIA_INDEX_NAME ?? 'apis';

  if (!appId || !adminKey) {
    console.error('❌ ALGOLIA_APP_ID and ALGOLIA_ADMIN_API_KEY must be set in Backend/.env');
    process.exit(1);
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Algolia-API-Key': adminKey,
    'X-Algolia-Application-Id': appId,
  };
  const base = `https://${appId}.algolia.net/1/indexes/${indexName}`;

  // Configure index settings
  console.log('⚙️  Configuring index settings...');
  await axios.put(`${base}/settings`, {
    searchableAttributes: ['title', 'unordered(description)', 'id'],
    customRanking: ['asc(title)'],
    typoTolerance: true,
    minWordSizefor1Typo: 4,
  }, { headers });

  // Load and prepare records
  console.log('📖 Reading apis.json...');
  const raw: any[] = await fs.readJson(DATA_FILE);
  console.log(`   ${raw.length} APIs loaded.`);

  const records = raw.filter(Boolean).map(api => ({
    objectID:    api.id,
    id:          api.id,
    title:       api.title       ?? '',
    description: api.description ? cleanDescription(api.description) : null,
    logo:        api.logo        ?? null,
    swagger_url: api.swaggerUrl  ?? null,
    website:     api.website     ?? null,
    updated:     api.updated     ?? null,
  }));

  // Batch upsert
  const totalBatches = Math.ceil(records.length / BATCH_SIZE);
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const requests = records.slice(i, i + BATCH_SIZE).map(r => ({
      action: 'updateObject',
      body: r,
    }));

    await axios.post(`${base}/batch`, { requests }, { headers });
    console.log(`   ✅ Batch ${batchNum}/${totalBatches} — ${requests.length} records`);
  }

  console.log(`\n🎉 Done. ${records.length} APIs indexed in Algolia (index: "${indexName}").`);
}

push();
