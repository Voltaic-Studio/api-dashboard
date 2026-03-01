import { groupApisByBrand, searchIndexedApis } from '@/lib/api-search';
import { getRedis, type AnyApi, type DiscoveredApi } from './utils';

type ExaResult = {
  url: string;
  title?: string | null;
  summary?: string | null;
  text?: string | null;
  highlights?: string[] | null;
};

export async function exaDiscoverApis(query: string, limit: number): Promise<DiscoveredApi[]> {
  const exaKey = process.env.EXA_API_KEY;
  if (!exaKey) return [];

  const redis = getRedis();
  const cacheKey = `exa:search:${query.toLowerCase().trim()}`;

  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
  }

  try {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `${query} API documentation developer reference`,
        type: 'auto',
        numResults: Math.min(limit * 2, 15),
        contents: {
          text: { maxCharacters: 500 },
          highlights: { query: `${query} API pricing features`, maxCharacters: 300 },
          summary: { query: `What does this API do? Is it free or paid? Key features.` },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const results: ExaResult[] = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) return [];

    const orKey = process.env.OPENROUTER_API_KEY;
    if (!orKey) {
      return results.slice(0, limit).map((r) => ({
        id: new URL(r.url).hostname,
        title: r.title ?? new URL(r.url).hostname,
        description: r.summary ?? r.text ?? '',
        doc_url: r.url,
        source: 'discovered' as const,
      }));
    }

    const listing = results.map((r, i: number) => {
      const highlights = Array.isArray(r.highlights) ? r.highlights.join(' ') : '';
      return [
        `${i + 1}. URL: ${r.url}`,
        `   Title: ${r.title ?? 'N/A'}`,
        `   Summary: ${r.summary ?? 'N/A'}`,
        `   Content: ${(r.text ?? '').slice(0, 300)}`,
        highlights ? `   Highlights: ${highlights.slice(0, 200)}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        temperature: 0,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: `An AI agent searched for: "${query}"

Your job is to analyze these search results and return the APIs that BEST match what the agent is looking for. Consider the FULL intent of the query:
- If the query says "free", exclude paid-only APIs
- If the query mentions a specific use case (e.g. "video detection", "flight booking"), only return APIs that support that exact use case
- If the query implies constraints (e.g. "real-time", "batch", "no auth"), respect those
- Prefer APIs with actual developer documentation over marketing pages, blog posts, or tutorials

SEARCH RESULTS:
${listing}

Return JSON: {"apis": [{"index": 1, "title": "Human-readable API name", "description": "One sentence about what this API does and key details (pricing model, supported features, etc.)", "relevance": "Brief reason why this matches the query"}]}

Rank by relevance to the query. Only include results that are genuine API/developer pages. If none match, return {"apis": []}.`,
        }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!llmRes.ok) return [];
    const llmData = await llmRes.json();
    const raw = llmData?.choices?.[0]?.message?.content;
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    const picks: { index: number; title: string; description: string }[] = parsed?.apis ?? [];

    const discovered: DiscoveredApi[] = picks
      .filter(p => p.index >= 1 && p.index <= results.length)
      .slice(0, limit)
      .map(p => {
        const r = results[p.index - 1];
        let hostname: string;
        try { hostname = new URL(r.url).hostname; } catch { hostname = r.url; }
        return {
          id: hostname,
          title: p.title,
          description: p.description,
          doc_url: r.url,
          source: 'discovered' as const,
        };
      });

    if (redis && discovered.length > 0) {
      try { await redis.set(cacheKey, JSON.stringify(discovered), { ex: 60 * 60 * 24 }); } catch {}
    }

    return discovered;
  } catch {
    return [];
  }
}

export async function searchApis(query: string, limit: number) {
  const max = Math.min(limit, 50);
  const q = query.trim();
  if (!q) return { count: 0, apis: [] };

  const indexed = await searchIndexedApis(q, max);
  if (!indexed.apis || indexed.apis.length === 0) {
    const discovered = await exaDiscoverApis(q, max);
    if (discovered.length > 0) {
      return { count: discovered.length, apis: discovered, source: 'discovered' };
    }
    return { count: 0, apis: [] };
  }

  const brands = groupApisByBrand(indexed.apis as AnyApi[])
    .slice(0, max)
    .map((brand) => ({
      id: brand.id,
      title: brand.title,
      description: brand.description,
      website: brand.website,
      doc_url: brand.doc_url,
    }));

  return { count: brands.length, apis: brands };
}
