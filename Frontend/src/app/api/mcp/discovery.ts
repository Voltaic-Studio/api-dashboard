import { getRedis, CACHE_TTL } from './utils';

export async function fetchJinaMarkdown(docUrl: string): Promise<string | null> {
  try {
    const jinaUrl = `https://r.jina.ai/${docUrl}`;
    const headers: Record<string, string> = { Accept: 'text/markdown' };
    if (process.env.JINA_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
    }
    const res = await fetch(jinaUrl, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    let md = await res.text();
    if (md.length > 30000) md = md.slice(0, 30000);
    return md;
  } catch {
    return null;
  }
}

async function fetchLlmsTxt(domain: string): Promise<string | null> {
  const candidates = [
    `https://${domain}/llms-full.txt`,
    `https://${domain}/llms.txt`,
    `https://docs.${domain}/llms-full.txt`,
    `https://docs.${domain}/llms.txt`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > 500 && !text.includes('<!DOCTYPE') && !text.includes('<html')) return text;
    } catch { /* next */ }
  }
  return null;
}

async function fetchSitemapUrls(domain: string): Promise<string[]> {
  const sitemapCandidates = [
    `https://${domain}/sitemap.xml`,
    `https://docs.${domain}/sitemap.xml`,
    `https://developer.${domain}/sitemap.xml`,
  ];
  for (const url of sitemapCandidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes('<urlset') && !xml.includes('<sitemapindex')) continue;
      const urls: string[] = [];
      const locRegex = /<loc>\s*(.*?)\s*<\/loc>/g;
      let match;
      while ((match = locRegex.exec(xml)) !== null) urls.push(match[1]);
      if (urls.length > 0) return urls;
    } catch { /* next */ }
  }
  return [];
}

function filterApiDocUrls(urls: string[]): string[] {
  const apiPatterns = [/\/api\//i, /\/reference/i, /\/docs\/api/i, /\/api-reference/i, /\/developer/i, /\/endpoints/i, /\/rest\//i, /\/graphql/i, /\/v[0-9]/i];
  const excludePatterns = [/\/blog\//i, /\/pricing/i, /\/changelog/i, /\/status/i, /\/careers/i, /\/about/i, /\/legal/i, /\/terms/i, /\/privacy/i, /\.pdf$/i, /\.png$/i, /\.jpg$/i];
  return urls.filter(url => {
    if (excludePatterns.some(p => p.test(url))) return false;
    return apiPatterns.some(p => p.test(url));
  });
}

async function firecrawlMap(docUrl: string): Promise<string[]> {
  const fcKey = process.env.FIRECRAWL_API_KEY;
  if (!fcKey) return [];
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/map', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fcKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: docUrl, limit: 100 }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.links ?? [];
  } catch { return []; }
}

async function llmPickDocPages(orKey: string, apiName: string, urls: string[]): Promise<string[]> {
  if (urls.length <= 8) return urls;
  const listing = urls.map((u, i) => `${i + 1}. ${u}`).join('\n');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash', temperature: 0, max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: `I need the API reference pages for "${apiName}". Pick the 5-8 URLs most likely to contain actual API endpoint definitions (REST routes, methods, request/response specs). Skip overviews, tutorials, changelogs.\n\n${listing}\n\nReturn JSON: {"indices": [1, 5, 8]}` }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return urls.slice(0, 8);
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return urls.slice(0, 8);
    const indices: number[] = JSON.parse(raw)?.indices ?? [];
    const picked = indices.filter(i => i >= 1 && i <= urls.length).map(i => urls[i - 1]);
    return picked.length > 0 ? picked.slice(0, 8) : urls.slice(0, 8);
  } catch { return urls.slice(0, 8); }
}

export async function discoverAndFetchDocs(apiId: string, docUrl: string | null, apiName: string): Promise<string | null> {
  const redis = getRedis();
  const cacheKey = `multipage:${apiId}`;
  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached && typeof cached === 'string' && cached.length > 100) return cached;
    } catch {}
  }

  const llmsTxt = await fetchLlmsTxt(apiId);
  if (llmsTxt) {
    if (redis) { try { await redis.set(cacheKey, llmsTxt, { ex: CACHE_TTL }); } catch {} }
    return llmsTxt;
  }

  let apiDocUrls = filterApiDocUrls(await fetchSitemapUrls(apiId));

  if (apiDocUrls.length === 0 && docUrl) {
    const allUrls = await firecrawlMap(docUrl);
    apiDocUrls = filterApiDocUrls(allUrls);
    if (apiDocUrls.length === 0) apiDocUrls = allUrls.filter(u => /doc|api|ref|dev/i.test(u)).slice(0, 15);
  }

  if (apiDocUrls.length === 0) {
    if (!docUrl) return null;
    const md = await fetchJinaMarkdown(docUrl);
    if (md && redis) { try { await redis.set(cacheKey, md, { ex: CACHE_TTL }); } catch {} }
    return md;
  }

  const orKey = process.env.OPENROUTER_API_KEY;
  const pagesToFetch = orKey ? await llmPickDocPages(orKey, apiName, apiDocUrls) : apiDocUrls.slice(0, 8);

  const pages = await Promise.all(pagesToFetch.map(url => fetchJinaMarkdown(url)));
  const combined = pages.filter((p): p is string => p !== null && p.length > 200).join('\n\n---\n\n');

  if (!combined) {
    if (!docUrl) return null;
    const md = await fetchJinaMarkdown(docUrl);
    if (md && redis) { try { await redis.set(cacheKey, md, { ex: CACHE_TTL }); } catch {} }
    return md;
  }

  if (redis) { try { await redis.set(cacheKey, combined, { ex: CACHE_TTL }); } catch {} }
  return combined;
}
