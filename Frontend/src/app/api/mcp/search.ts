import { createServerClient } from '@/lib/supabase';
import { getRedis, type AnyApi, type DiscoveredApi } from './utils';

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
    const results = data?.results ?? [];
    if (results.length === 0) return [];

    const orKey = process.env.OPENROUTER_API_KEY;
    if (!orKey) {
      return results.slice(0, limit).map((r: any) => ({
        id: new URL(r.url).hostname,
        title: r.title ?? new URL(r.url).hostname,
        description: r.summary ?? r.text ?? '',
        doc_url: r.url,
        source: 'discovered' as const,
      }));
    }

    const listing = results.map((r: any, i: number) => {
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
  const supabase = createServerClient();
  const max = Math.min(limit, 50);
  const q = query.trim();
  if (!q) return { count: 0, apis: [] };

  async function embedQuery(text: string): Promise<number[] | null> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.EMBEDDING_MODEL ?? 'openai/text-embedding-3-small';
    if (!apiKey || text.length < 3) return null;
    try {
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.data?.[0]?.embedding ?? null;
    } catch {
      return null;
    }
  }

  let apis: AnyApi[] | null = null;

  const queryEmbedding = await embedQuery(q);
  if (queryEmbedding) {
    const rpc = supabase as any;
    const { data: hybrid } = await rpc.rpc('search_apis_hybrid', {
      query_text: q,
      query_embedding: queryEmbedding,
      match_count: 120,
    });
    if (Array.isArray(hybrid) && hybrid.length > 0) {
      apis = hybrid.map((r: any) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        tldr: r.tldr ?? null,
        website: r.website ?? null,
        doc_url: r.doc_url ?? null,
        logo: r.logo ?? null,
      }));
    }
  }

  if (!apis) {
    const words = q.split(/\s+/).filter(Boolean);
    const conditions = words
      .map(w => `title.ilike.%${w}%,description.ilike.%${w}%,id.ilike.%${w}%,tldr.ilike.%${w}%`)
      .join(',');
    const { data } = await supabase
      .from('apis')
      .select('id, title, description, tldr, website, doc_url, logo')
      .or(conditions)
      .limit(200);
    apis = (data as AnyApi[] | null) ?? [];
  }

  if (!apis || apis.length === 0) {
    const discovered = await exaDiscoverApis(q, max);
    if (discovered.length > 0) {
      return { count: discovered.length, apis: discovered, source: 'discovered' };
    }
    return { count: 0, apis: [] };
  }

  const grouped = new Map<string, AnyApi[]>();
  for (const api of apis as AnyApi[]) {
    const base = api.id.split(':')[0];
    if (!grouped.has(base)) grouped.set(base, []);
    grouped.get(base)!.push(api);
  }

  const brands = Array.from(grouped.entries()).slice(0, max).map(([domain, entries]) => {
    const primary = entries.find((e: AnyApi) => e.id === domain) ?? entries[0];
    return {
      id: domain,
      title: primary.title,
      description: primary.tldr ?? primary.description,
      website: primary.website,
      doc_url: entries.find((e: AnyApi) => e.doc_url)?.doc_url ?? primary.website,
    };
  });

  return { count: brands.length, apis: brands };
}
