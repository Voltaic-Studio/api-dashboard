import { createServerClient } from '@/lib/supabase';
import { getRedis, CACHE_TTL, ENDPOINTS_CACHE_TTL, type AnyApi, type ExtractedEndpoint, type ApiEvaluation } from './utils';
import { discoverAndFetchDocs } from './discovery';
import { llmExtractEndpoints, llmEvaluateApi } from './extraction';

async function getExtractedEndpoints(apiId: string, docUrl: string, apiName: string): Promise<{ endpoints: ExtractedEndpoint[]; markdown: string | null }> {
  const redis = getRedis();
  const cacheKey = `endpoints:${apiId}`;

  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (Array.isArray(parsed) && parsed.length > 0) return { endpoints: parsed, markdown: null };
      }
    } catch {}
  }

  const markdown = await discoverAndFetchDocs(apiId, docUrl, apiName);
  if (!markdown) return { endpoints: [], markdown: null };

  const endpoints = await llmExtractEndpoints(markdown, apiName);

  if (redis && endpoints.length > 0) {
    try { await redis.set(cacheKey, JSON.stringify(endpoints), { ex: ENDPOINTS_CACHE_TTL }); } catch {}
  }

  return { endpoints, markdown };
}

async function getApiEvaluation(apiId: string, apiName: string, markdown: string | null, docUrl: string): Promise<ApiEvaluation | null> {
  const redis = getRedis();
  const cacheKey = `evaluate:${apiId}`;

  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (parsed && typeof parsed === 'object') return parsed as ApiEvaluation;
      }
    } catch {}
  }

  const md = markdown ?? await discoverAndFetchDocs(apiId, docUrl, apiName);
  if (!md) return null;

  const evaluation = await llmEvaluateApi(md, apiName, apiId);

  if (redis && evaluation) {
    try { await redis.set(cacheKey, JSON.stringify(evaluation), { ex: CACHE_TTL }); } catch {}
  }

  return evaluation;
}

export async function getApiDetail(apiId: string, directDocUrl?: string, targetMethod?: string, targetPath?: string) {
  const supabase = createServerClient();

  const { data: apis } = await supabase
    .from('apis')
    .select('*')
    .or(`id.eq.${apiId},id.like.${apiId}:%`);

  const typedApis = (apis as AnyApi[] | null) ?? [];
  const primary = typedApis.find((a) => a.id === apiId) ?? typedApis[0] ?? null;
  const docUrl = directDocUrl
    ?? typedApis.find((a) => a.doc_url)?.doc_url
    ?? primary?.website
    ?? (apiId.includes('.') ? `https://${apiId}` : null);

  if (!docUrl) return null;

  const apiName = primary?.title ?? apiId;
  const { endpoints, markdown } = await getExtractedEndpoints(apiId, docUrl, apiName);
  const evaluation = await getApiEvaluation(apiId, apiName, markdown, docUrl);

  if (targetMethod && targetPath) {
    const match = endpoints.find(
      ep => ep.method === targetMethod.toUpperCase() && ep.path === targetPath
    );
    if (!match) {
      return {
        id: primary?.id ?? apiId,
        title: apiName,
        doc_url: docUrl,
        error: `Endpoint ${targetMethod.toUpperCase()} ${targetPath} not found. Use get_api_detail without method/path to see all available endpoints.`,
        endpoint_count: endpoints.length,
      };
    }
    return {
      id: primary?.id ?? apiId,
      title: apiName,
      doc_url: docUrl,
      endpoint: {
        method: match.method,
        path: match.path,
        summary: match.summary,
        description: match.description,
        section: match.section,
        parameters: match.parameters,
        responses: match.responses,
      },
      ...(evaluation ? {
        auth: evaluation.auth,
        rate_limits: evaluation.rate_limits,
        gotchas: evaluation.gotchas,
      } : {}),
      live: true,
    };
  }

  const sections: Record<string, { method: string; path: string; summary: string | null }[]> = {};
  for (const ep of endpoints) {
    const sec = ep.section ?? 'General';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push({
      method: ep.method,
      path: ep.path,
      summary: ep.summary,
    });
  }

  return {
    id: primary?.id ?? apiId,
    title: apiName,
    tldr: primary?.tldr ?? primary?.description ?? evaluation?.purpose ?? null,
    website: primary?.website ?? (apiId.includes('.') ? `https://${apiId}` : null),
    doc_url: docUrl,
    ...(evaluation ? {
      overview: {
        purpose: evaluation.purpose,
        auth: evaluation.auth,
        pricing: evaluation.pricing,
        rate_limits: evaluation.rate_limits,
        sdks: evaluation.sdks,
        gotchas: evaluation.gotchas,
        best_for: evaluation.best_for,
        alternatives: evaluation.alternatives,
      },
    } : {}),
    endpoint_count: endpoints.length,
    sections,
    live: true,
    _agent_note: endpoints.length === 0
      ? `No endpoints could be extracted automatically. Visit ${docUrl} directly to find the API reference.`
      : endpoints.length < 10
        ? `Only ${endpoints.length} endpoints extracted. The full API may have more — check ${docUrl} for the complete reference.`
        : undefined,
  };
}
