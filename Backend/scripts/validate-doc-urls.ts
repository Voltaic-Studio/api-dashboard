/**
 * validate-doc-urls.ts
 *
 * Autonomous pipeline to validate and fix doc_url for ALL APIs:
 *   1. HEAD check existing doc_url
 *   2. Playwright screenshot + Gemini verify valid ones
 *   3. Heuristic probe for broken/null
 *   4. Screenshot + Gemini verify probed candidates
 *   5. SearchAPI for remaining failures
 *   6. Screenshot + Gemini verify search results
 *   7. Set doc_url = null for truly unfindable ones
 *
 * Usage:
 *   cd Backend && pnpm run validate:doc-urls
 *   cd Backend && pnpm run validate:doc-urls --dry-run
 */

import { createClient } from '@supabase/supabase-js';
import { chromium, type Browser, type Page } from 'playwright';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

type ApiRow = {
  id: string;
  title: string | null;
  doc_url: string | null;
  website: string | null;
};

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

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function domainFromId(id: string): string {
  return id.split(':')[0];
}

// ─── Step 1: HEAD check ────────────────────────────────────────────────────

async function headCheck(url: string): Promise<{ ok: boolean; finalUrl: string; status: number }> {
  try {
    const resp = await axios.head(url, {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApiDashboard/1.0)' },
    });
    const finalUrl = resp.request?.res?.responseUrl ?? url;
    return { ok: resp.status >= 200 && resp.status < 400, finalUrl, status: resp.status };
  } catch {
    try {
      const resp = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApiDashboard/1.0)' },
        responseType: 'stream',
      });
      resp.data.destroy();
      const finalUrl = resp.request?.res?.responseUrl ?? url;
      return { ok: resp.status >= 200 && resp.status < 400, finalUrl, status: resp.status };
    } catch {
      return { ok: false, finalUrl: url, status: 0 };
    }
  }
}

// ─── Step 2: Playwright screenshot ─────────────────────────────────────────

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

// ─── Step 3: Gemini visual verification ────────────────────────────────────

async function geminiVerifyScreenshot(
  orKey: string,
  screenshotBuf: Buffer,
  apiName: string,
): Promise<{ isApiDoc: boolean; explanation: string }> {
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
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64}` },
            },
            {
              type: 'text',
              text: `Is this page the API documentation, API reference, or developer docs for "${apiName}"? Answer with EXACTLY "YES" or "NO" on the first line, then a brief 1-sentence explanation on the second line. A marketing homepage, pricing page, blog, or login wall is NOT API documentation.`,
            },
          ],
        }],
      },
      {
        headers: { Authorization: `Bearer ${orKey}` },
        timeout: 30000,
      },
    );

    const raw = (data?.choices?.[0]?.message?.content ?? '').trim();
    const firstLine = raw.split('\n')[0].trim().toUpperCase();
    const isApiDoc = firstLine.startsWith('YES');
    return { isApiDoc, explanation: raw.replace(/^(YES|NO)\s*/i, '').trim() };
  } catch (err: any) {
    console.error(`   ⚠️  Gemini verification failed: ${err?.message ?? 'unknown'}`);
    return { isApiDoc: false, explanation: 'verification failed' };
  }
}

// ─── Step 4: Heuristic URL probing ─────────────────────────────────────────

function generateHeuristicUrls(domain: string): string[] {
  const bare = domain.replace(/^www\./, '');
  return [
    `https://docs.${bare}`,
    `https://developer.${bare}`,
    `https://developers.${bare}`,
    `https://${bare}/docs`,
    `https://${bare}/api`,
    `https://${bare}/api-reference`,
    `https://${bare}/documentation`,
    `https://${bare}/docs/api`,
    `https://${bare}/developer`,
    `https://api.${bare}`,
    `https://${bare}/docs/api-reference`,
    `https://${bare}/reference`,
  ];
}

async function probeHeuristicUrls(domain: string): Promise<string | null> {
  const candidates = generateHeuristicUrls(domain);
  for (const url of candidates) {
    const result = await headCheck(url);
    if (result.ok) return result.finalUrl;
  }
  return null;
}

// ─── Step 5: SearchAPI fallback ────────────────────────────────────────────

async function searchForDocUrl(
  searchApiKey: string,
  apiName: string,
  domain: string,
): Promise<string[]> {
  try {
    const query = `"${apiName}" API reference documentation site:${domain} OR site:docs.${domain} OR site:developer.${domain}`;
    const { data } = await axios.get('https://www.searchapi.io/api/v1/search', {
      params: {
        engine: 'google',
        q: query,
        api_key: searchApiKey,
        num: 5,
      },
      timeout: 15000,
    });

    const results: string[] = [];
    for (const r of (data?.organic_results ?? [])) {
      if (r?.link) results.push(r.link);
    }

    if (results.length === 0) {
      const fallbackQuery = `"${apiName}" API documentation`;
      const { data: d2 } = await axios.get('https://www.searchapi.io/api/v1/search', {
        params: { engine: 'google', q: fallbackQuery, api_key: searchApiKey, num: 5 },
        timeout: 15000,
      });
      for (const r of (d2?.organic_results ?? [])) {
        if (r?.link) results.push(r.link);
      }
    }

    return results;
  } catch (err: any) {
    console.error(`   ⚠️  SearchAPI failed for ${apiName}: ${err?.message ?? 'unknown'}`);
    return [];
  }
}

// ─── Main pipeline ─────────────────────────────────────────────────────────

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

  const dryRun = argFlag('dry-run');
  const concurrency = 5;
  const limiter = createLimiter(concurrency);

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('📦 Loading APIs...');
  const apis: ApiRow[] = [];
  {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('apis')
        .select('id,title,doc_url,website')
        .range(from, from + 999);
      if (error) {
        console.error(`❌ Failed to load APIs: ${error.message}`);
        process.exit(1);
      }
      if (!data || data.length === 0) break;
      apis.push(...(data as ApiRow[]));
      if (data.length < 1000) break;
      from += 1000;
    }
  }
  console.log(`📦 ${apis.length} APIs loaded\n`);

  const results: ValidationResult[] = [];
  const stats = { valid: 0, fixed: 0, not_found: 0, total: apis.length };

  // ─── STEP 1: HEAD check all existing doc_urls ──────────────────────────

  console.log('━━━ Step 1: HEAD check existing doc_urls ━━━');
  const headResults = new Map<string, { ok: boolean; finalUrl: string }>();
  let headDone = 0;

  await Promise.all(apis.map(api => limiter(async () => {
    headDone++;
    if (!api.doc_url) {
      headResults.set(api.id, { ok: false, finalUrl: '' });
      return;
    }
    const result = await headCheck(api.doc_url);
    headResults.set(api.id, { ok: result.ok, finalUrl: result.finalUrl });
    if (headDone % 100 === 0) console.log(`   HEAD checked ${headDone}/${apis.length}`);
  })));

  const headOk = [...headResults.values()].filter(r => r.ok).length;
  const headNull = apis.filter(a => !a.doc_url).length;
  const headFail = apis.length - headOk - headNull;
  console.log(`   ✅ ${headOk} reachable | ❌ ${headFail} broken | ⚪ ${headNull} null\n`);

  // ─── STEP 2: Screenshot + Gemini verify reachable URLs ─────────────────

  console.log('━━━ Step 2: Screenshot + Gemini verify reachable doc_urls ━━━');
  const browser = await chromium.launch({ headless: true });

  const verified = new Map<string, boolean>();
  const needsFixing: ApiRow[] = [];
  let verifyDone = 0;

  const reachableApis = apis.filter(a => a.doc_url && headResults.get(a.id)?.ok);

  const screenshotLimiter = createLimiter(3);

  await Promise.all(reachableApis.map(api => screenshotLimiter(async () => {
    verifyDone++;
    const url = headResults.get(api.id)!.finalUrl;
    const screenshot = await takeScreenshot(browser, url);

    if (!screenshot) {
      verified.set(api.id, false);
      needsFixing.push(api);
      if (verifyDone % 50 === 0) console.log(`   Verified ${verifyDone}/${reachableApis.length}`);
      return;
    }

    const result = await geminiVerifyScreenshot(orKey, screenshot, api.title ?? api.id);
    verified.set(api.id, result.isApiDoc);

    if (result.isApiDoc) {
      const finalUrl = headResults.get(api.id)!.finalUrl;
      if (finalUrl !== api.doc_url) {
        results.push({ api_id: api.id, original_url: api.doc_url, final_url: finalUrl, status: 'fixed', source: 'redirect' });
      } else {
        results.push({ api_id: api.id, original_url: api.doc_url, final_url: api.doc_url, status: 'valid', source: 'existing' });
      }
      stats.valid++;
    } else {
      needsFixing.push(api);
    }

    if (verifyDone % 50 === 0) console.log(`   Verified ${verifyDone}/${reachableApis.length}`);
  })));

  const unreachableApis = apis.filter(a => !a.doc_url || !headResults.get(a.id)?.ok);
  needsFixing.push(...unreachableApis);

  const uniqueFixing = [...new Map(needsFixing.map(a => [a.id, a])).values()];
  console.log(`   ✅ ${stats.valid} confirmed valid | 🔧 ${uniqueFixing.length} need fixing\n`);

  // ─── STEP 3+4: Heuristic probe + verify ────────────────────────────────

  console.log('━━━ Step 3-4: Heuristic probe + screenshot verify ━━━');
  const stillBroken: ApiRow[] = [];
  let probeDone = 0;

  await Promise.all(uniqueFixing.map(api => screenshotLimiter(async () => {
    probeDone++;
    const domain = domainFromId(api.id);
    const probed = await probeHeuristicUrls(domain);

    if (!probed) {
      stillBroken.push(api);
      if (probeDone % 50 === 0) console.log(`   Probed ${probeDone}/${uniqueFixing.length}`);
      return;
    }

    const screenshot = await takeScreenshot(browser, probed);
    if (!screenshot) {
      stillBroken.push(api);
      if (probeDone % 50 === 0) console.log(`   Probed ${probeDone}/${uniqueFixing.length}`);
      return;
    }

    const result = await geminiVerifyScreenshot(orKey, screenshot, api.title ?? api.id);
    if (result.isApiDoc) {
      results.push({ api_id: api.id, original_url: api.doc_url, final_url: probed, status: 'fixed', source: 'heuristic' });
      stats.fixed++;
    } else {
      stillBroken.push(api);
    }

    if (probeDone % 50 === 0) console.log(`   Probed ${probeDone}/${uniqueFixing.length}`);
  })));

  console.log(`   ✅ ${stats.fixed} fixed via heuristic | 🔧 ${stillBroken.length} still broken\n`);

  // ─── STEP 5+6: SearchAPI + verify ──────────────────────────────────────

  if (searchApiKey && stillBroken.length > 0) {
    console.log('━━━ Step 5-6: SearchAPI + screenshot verify ━━━');
    let searchDone = 0;
    let searchFixed = 0;

    const searchLimiter = createLimiter(2);

    await Promise.all(stillBroken.map(api => searchLimiter(async () => {
      searchDone++;
      const domain = domainFromId(api.id);
      const candidates = await searchForDocUrl(searchApiKey, api.title ?? api.id, domain);

      let found = false;
      for (const candidateUrl of candidates.slice(0, 3)) {
        const screenshot = await takeScreenshot(browser, candidateUrl);
        if (!screenshot) continue;

        const result = await geminiVerifyScreenshot(orKey, screenshot, api.title ?? api.id);
        if (result.isApiDoc) {
          results.push({ api_id: api.id, original_url: api.doc_url, final_url: candidateUrl, status: 'fixed', source: 'searchapi' });
          searchFixed++;
          stats.fixed++;
          found = true;
          break;
        }
      }

      if (!found) {
        results.push({ api_id: api.id, original_url: api.doc_url, final_url: null, status: 'not_found', source: 'exhausted' });
        stats.not_found++;
      }

      if (searchDone % 20 === 0) console.log(`   Searched ${searchDone}/${stillBroken.length}`);
    })));

    console.log(`   ✅ ${searchFixed} fixed via SearchAPI | ❌ ${stats.not_found} not found\n`);
  } else {
    for (const api of stillBroken) {
      results.push({ api_id: api.id, original_url: api.doc_url, final_url: null, status: 'not_found', source: 'no-searchapi-key' });
      stats.not_found++;
    }
    if (stillBroken.length > 0) {
      console.log(`   ⚪ ${stillBroken.length} marked not_found (no SEARCHAPI_KEY)\n`);
    }
  }

  await browser.close();

  // ─── STEP 7: Write results to DB ───────────────────────────────────────

  console.log('━━━ Step 7: Writing results to database ━━━');

  const toUpdate = results.filter(r => r.status === 'fixed' && r.final_url);
  const redirectFixed = results.filter(r => r.status === 'fixed' && r.source === 'redirect');

  if (dryRun) {
    console.log('   🏃 DRY RUN — no DB writes');
    console.log(`   Would update ${toUpdate.length} doc_urls`);
    console.log(`   Would fix ${redirectFixed.length} redirect URLs`);
  } else {
    let writeOk = 0;
    let writeErr = 0;

    for (const r of toUpdate) {
      const { error } = await supabase
        .from('apis')
        .update({ doc_url: r.final_url })
        .eq('id', r.api_id);
      if (error) {
        writeErr++;
        console.error(`   ❌ Failed to update ${r.api_id}: ${error.message}`);
      } else {
        writeOk++;
      }
    }

    for (const r of redirectFixed) {
      const { error } = await supabase
        .from('apis')
        .update({ doc_url: r.final_url })
        .eq('id', r.api_id);
      if (error) {
        writeErr++;
      } else {
        writeOk++;
      }
    }

    console.log(`   ✅ ${writeOk} updated | ❌ ${writeErr} failed`);
  }

  // ─── Summary ───────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════');
  console.log(`Total APIs:      ${stats.total}`);
  console.log(`✅ Valid:         ${stats.valid}`);
  console.log(`🔧 Fixed:         ${stats.fixed}`);
  console.log(`❌ Not found:     ${stats.not_found}`);
  console.log('══════════════════════════════════════════');

  const logPath = path.join(process.cwd(), 'data', 'doc-url-validation.json');
  await fs.ensureDir(path.dirname(logPath));
  await fs.writeJson(logPath, results, { spaces: 2 });
  console.log(`\n📄 Full results log: ${logPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
