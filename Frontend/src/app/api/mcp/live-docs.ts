import { createServerClient } from '@/lib/supabase';
import { getRedis, CACHE_TTL, type AnyApi } from './utils';

export async function getLiveDocs(apiId: string, url?: string) {
  const supabase = createServerClient();
  const redis = getRedis();

  let docUrl = url;
  if (!docUrl) {
    const { data: apis } = await supabase
      .from('apis')
      .select('doc_url, website')
      .or(`id.eq.${apiId},id.like.${apiId}:%`)
      .limit(5);

    if (!apis || apis.length === 0) return null;
    const typedApis = apis as AnyApi[];
    docUrl = typedApis.find((a) => a.doc_url)?.doc_url ?? typedApis[0]?.website;
  }

  if (!docUrl) return null;

  const cacheKey = `docs:${docUrl}`;

  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        return { api: apiId, doc_url: docUrl, markdown: cached, cached: true };
      }
    } catch {}
  }

  try {
    const jinaUrl = `https://r.jina.ai/${docUrl}`;
    const headers: Record<string, string> = { Accept: 'text/markdown' };
    if (process.env.JINA_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
    }
    const res = await fetch(jinaUrl, { headers, signal: AbortSignal.timeout(30000) });

    if (!res.ok) return null;
    let markdown = await res.text();

    if (markdown.length > 25000) {
      markdown = markdown.slice(0, 25000) + '\n\n[... truncated — visit doc_url for full documentation]';
    }

    if (redis) {
      try { await redis.set(cacheKey, markdown, { ex: CACHE_TTL }); } catch {}
    }

    return { api: apiId, doc_url: docUrl, markdown, cached: false };
  } catch {
    return null;
  }
}
