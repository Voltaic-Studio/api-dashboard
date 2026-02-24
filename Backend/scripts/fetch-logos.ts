/**
 * fetch-logos.ts
 *
 * One-shot script: reads apis.json, fills in missing logos using logo.dev,
 * then writes the updated file back. Run once — results are cached in the JSON.
 *
 * Usage:
 *   1. Add your key to Backend/.env  →  LOGO_DEV_TOKEN=pk_...
 *   2. cd Backend && npm run fetch-logos
 */

import fs from 'fs-extra';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), '../Frontend/src/data/apis.json');

function getLogoDevToken(): string {
  // Minimal .env parser — avoids pulling in dotenv just for one value
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('LOGO_DEV_TOKEN=')) {
        return trimmed.slice('LOGO_DEV_TOKEN='.length).trim();
      }
    }
  }
  return process.env.LOGO_DEV_TOKEN ?? '';
}

/**
 * Extract a clean domain from the api id (e.g. "stripe.com:payment" → "stripe.com")
 * or fall back to parsing the website URL.
 */
function extractDomain(id: string, website?: string): string | null {
  // The api.guru id is usually just the domain (e.g. "1forge.com")
  const byId = id.split(':')[0].trim();
  if (byId && byId.includes('.')) return byId;

  if (website) {
    try {
      return new URL(website).hostname.replace(/^www\./, '');
    } catch {
      // ignore
    }
  }

  return null;
}

async function fetchLogos() {
  const token = getLogoDevToken();
  if (!token) {
    console.error('❌ LOGO_DEV_TOKEN is not set. Add it to Backend/.env and retry.');
    process.exit(1);
  }

  console.log('📖 Reading apis.json...');
  const apis: any[] = await fs.readJson(DATA_FILE);

  const missing = apis.filter(api => !api.logo);
  console.log(`🔍 Found ${missing.length} APIs without a logo (out of ${apis.length} total).`);

  if (missing.length === 0) {
    console.log('✅ All APIs already have logos. Nothing to do.');
    return;
  }

  let filled = 0;

  for (const api of apis) {
    if (api.logo) continue;

    const domain = extractDomain(api.id, api.website);
    if (!domain) {
      console.warn(`  ⚠️  Could not derive domain for ${api.id} — skipping`);
      continue;
    }

    // logo.dev publishable token is safe to embed in image URLs
    api.logo = `https://img.logo.dev/${domain}?token=${token}&size=64&format=png`;
    filled++;
  }

  await fs.writeJson(DATA_FILE, apis, { spaces: 2 });
  console.log(`✅ Filled ${filled} logos. Updated ${DATA_FILE}`);
}

fetchLogos();
