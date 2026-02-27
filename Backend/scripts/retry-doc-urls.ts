/**
 * retry-doc-urls.ts
 *
 * Reads doc-url-validation.json, takes only the "not_found" entries,
 * looks up their title from the DB, and re-runs SearchAPI (no site: restriction)
 * + Playwright screenshot + Gemini verification to find their doc URLs.
 *
 * Usage:
 *   cd Backend && pnpm run retry:doc-urls
 */

import { createClient } from '@supabase/supabase-js';
import { chromium, type Browser, type Page } from 'playwright';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

type ValidationResult = {
  api_id: string;
  original_url: string | null;
  final_url: string | null;
  status: string;
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

async function takeScreenshot(browser: Browser, url: string): Promise<Buffer | null> {
  let page: Page | null = null;
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    const buf = await page.screenshot({ type: 'jpeg', quality: 50 });
    await context.close();
    return buf;
  } catch {
    if (page) {
      try { await page.context().close(); } catch {}
    }
    return null;
  }
}

async function geminiVerify(orKey: string, screenshotBuf: Buffer, apiName: string): Promise<boolean> {
  const base64 = screenshotBuf.toString('base64');
  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash',
        temperature: 0,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            {
              type: 'text',
              text: `Is this page the API documentation, API reference, or developer docs for "${apiName}"? Answer with EXACTLY "YES" or "NO" on the first line, then a brief 1-sentence explanation on the second line. A marketing homepage, pricing page, blog, or login wall is NOT API documentation.`,
            },
          ],
        }],
      },
      { headers: { Authorization: `Bearer ${orKey}` }, timeout: 30000 },
    );
    const raw = (data?.choices?.[0]?.message?.content ?? '').trim();
    return raw.split('\n')[0].trim().toUpperCase().startsWith('YES');
  } catch {
    return false;
  }
}

type SearchResult = { title: string; snippet: string; link: string };

async function searchForDocUrl(searchApiKey: string, apiName: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  try {
    const query = `"${apiName}" API documentation`;
    const { data } = await axios.get('https://www.searchapi.io/api/v1/search', {
      params: { engine: 'google', q: query, api_key: searchApiKey, num: 10 },
      timeout: 15000,
    });
    for (const r of (data?.organic_results ?? [])) {
      if (r?.link) results.push({
        title: r.title ?? '',
        snippet: r.snippet ?? '',
        link: r.link,
      });
    }
  } catch (err: any) {
    console.error(`   ⚠️  SearchAPI failed for ${apiName}: ${err?.message ?? 'unknown'}`);
  }
  return results;
}

async function geminiPickBestUrl(orKey: string, apiName: string, results: SearchResult[]): Promise<string | null> {
  const listing = results.map((r, i) =>
    `${i + 1}. URL: ${r.link}\n   Title: ${r.title}\n   Snippet: ${r.snippet}`
  ).join('\n\n');

  try {
    const { data } = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash',
        temperature: 0,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `I'm looking for the official API documentation / developer reference page for "${apiName}".

Below are Google search results. Pick the ONE result that is most likely the actual API docs page. Ignore marketing homepages, blog posts, pricing pages, third-party tutorials, login walls, and SEO spam.

${listing}

Reply with ONLY the number (e.g. "3") of the best result on the first line. If NONE of them look like API documentation for "${apiName}", reply with "NONE" on the first line. Second line: brief 1-sentence reason.`,
        }],
      },
      { headers: { Authorization: `Bearer ${orKey}` }, timeout: 30000 },
    );
    const raw = (data?.choices?.[0]?.message?.content ?? '').trim();
    const firstLine = raw.split('\n')[0].trim();
    if (firstLine.toUpperCase() === 'NONE') return null;
    const idx = parseInt(firstLine, 10);
    if (isNaN(idx) || idx < 1 || idx > results.length) return null;
    return results[idx - 1].link;
  } catch {
    return null;
  }
}

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const orKey = env.OPENROUTER_API_KEY ?? '';
  const searchApiKey = env.SEARCHAPI_KEY ?? '';

  if (!supabaseUrl || !supabaseKey || !orKey) {
    console.error('❌ Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or OPENROUTER_API_KEY');
    process.exit(1);
  }
  if (!searchApiKey) {
    console.error('❌ Missing SEARCHAPI_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const jsonPath = path.join(process.cwd(), 'data', 'doc-url-validation.json');
  const allResults: ValidationResult[] = fs.readJsonSync(jsonPath);
  const notFound = allResults.filter(r => r.status === 'not_found');
  console.log(`📦 Loaded ${notFound.length} not_found APIs to retry\n`);

  const apiIds = notFound.map(r => r.api_id);
  const titleMap = new Map<string, string>();
  for (let i = 0; i < apiIds.length; i += 500) {
    const batch = apiIds.slice(i, i + 500);
    const { data } = await supabase
      .from('apis')
      .select('id,title')
      .in('id', batch);
    for (const row of (data ?? [])) {
      titleMap.set(row.id, row.title ?? row.id);
    }
  }
  console.log(`📦 Loaded titles for ${titleMap.size} APIs\n`);

  const browser = await chromium.launch({ headless: true });
  const limiter = createLimiter(2);

  let fixed = 0;
  let still_not_found = 0;
  let done = 0;

  await Promise.all(notFound.map(entry => limiter(async () => {
    done++;
    const apiName = titleMap.get(entry.api_id) ?? entry.api_id;

    // Step 1: Search
    const searchResults = await searchForDocUrl(searchApiKey, apiName);
    if (searchResults.length === 0) {
      still_not_found++;
      if (done % 50 === 0) console.log(`   ⚪ [${done}/${notFound.length}] progress...`);
      return;
    }

    // Step 2: LLM picks the best URL from titles/snippets/URLs (no screenshots yet)
    const bestUrl = await geminiPickBestUrl(orKey, apiName, searchResults);
    if (!bestUrl) {
      still_not_found++;
      if (done % 50 === 0) console.log(`   ⚪ [${done}/${notFound.length}] progress...`);
      return;
    }

    // Step 3: Screenshot the single best pick and visually confirm
    const screenshot = await takeScreenshot(browser, bestUrl);
    if (!screenshot) {
      still_not_found++;
      return;
    }
    const confirmed = await geminiVerify(orKey, screenshot, apiName);
    if (!confirmed) {
      still_not_found++;
      return;
    }

    // Step 4: Write to DB
    const { error } = await supabase
      .from('apis')
      .update({ doc_url: bestUrl })
      .eq('id', entry.api_id);

    if (error) {
      console.error(`   ❌ [${done}/${notFound.length}] ${entry.api_id} — DB write failed: ${error.message}`);
    } else {
      fixed++;
      console.log(`   ✅ [${done}/${notFound.length}] ${apiName} → ${bestUrl}`);
    }
  })));

  await browser.close();

  console.log('\n══════════════════════════════════════════');
  console.log(`✅ Fixed:         ${fixed}`);
  console.log(`❌ Still not found: ${still_not_found}`);
  console.log('══════════════════════════════════════════');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
