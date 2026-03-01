import { createServerClient, type Api } from '@/lib/supabase';

export type SearchApiRecord = {
  id: string;
  title: string;
  description: string | null;
  tldr?: string | null;
  logo: string | null;
  website: string | null;
  doc_url?: string | null;
};

export type SearchBrandRecord = {
  id: string;
  title: string;
  description: string | null;
  logo: string | null;
  website: string | null;
  doc_url: string | null;
  api_count: number;
};

type AlgoliaHit = {
  objectID?: string;
  id?: string;
  title?: string;
  description?: string | null;
  tldr?: string | null;
  logo?: string | null;
  website?: string | null;
  doc_url?: string | null;
};

type HybridSearchRow = {
  id: string;
  title: string;
  description: string | null;
  tldr?: string | null;
  logo?: string | null;
  website?: string | null;
  doc_url?: string | null;
};

function normalizeApiRecord(record: Partial<SearchApiRecord> & { id: string; title: string }): SearchApiRecord {
  return {
    id: record.id,
    title: record.title,
    description: record.description ?? null,
    tldr: record.tldr ?? null,
    logo: record.logo ?? null,
    website: record.website ?? null,
    doc_url: record.doc_url ?? null,
  };
}

export function groupApisByBrand(apis: SearchApiRecord[]): SearchBrandRecord[] {
  const groups = new Map<string, SearchApiRecord[]>();

  for (const api of apis) {
    const base = api.id.split(':')[0];
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push(api);
  }

  return Array.from(groups.entries()).map(([domain, entries]) => {
    const primary = entries.find((entry) => entry.id === domain) ?? entries[0];
    return {
      id: domain,
      title: primary.title,
      description: primary.tldr ?? primary.description,
      logo: entries.find((entry) => entry.logo)?.logo ?? null,
      website: primary.website,
      doc_url: entries.find((entry) => entry.doc_url)?.doc_url ?? primary.doc_url ?? primary.website ?? null,
      api_count: entries.length,
    };
  });
}

async function embedQuery(query: string): Promise<number[] | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.EMBEDDING_MODEL ?? 'openai/text-embedding-3-small';
  if (!apiKey || !query.trim()) return null;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: query,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

async function searchApisViaAlgolia(query: string, limit: number): Promise<SearchApiRecord[] | null> {
  const appId = process.env.ALGOLIA_APP_ID;
  const apiKey = process.env.ALGOLIA_SEARCH_API_KEY ?? process.env.ALGOLIA_API_KEY;
  const indexName = process.env.ALGOLIA_INDEX_NAME;

  if (!appId || !apiKey || !indexName) return null;

  try {
    const res = await fetch(`https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Algolia-API-Key': apiKey,
        'X-Algolia-Application-Id': appId,
      },
      body: JSON.stringify({
        query,
        hitsPerPage: Math.min(Math.max(limit * 4, 40), 200),
        attributesToRetrieve: ['objectID', 'id', 'title', 'description', 'tldr', 'logo', 'website', 'doc_url'],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const hits: AlgoliaHit[] = Array.isArray(data?.hits) ? data.hits : [];
    if (hits.length === 0) return [];

    return hits
      .map((hit) => {
        const id = hit.id ?? hit.objectID;
        const title = hit.title;
        if (!id || !title) return null;
        return normalizeApiRecord({
          id,
          title,
          description: hit.description ?? null,
          tldr: hit.tldr ?? null,
          logo: hit.logo ?? null,
          website: hit.website ?? null,
          doc_url: hit.doc_url ?? null,
        });
      })
      .filter((hit): hit is SearchApiRecord => Boolean(hit));
  } catch {
    return null;
  }
}

async function searchApisViaSupabase(query: string): Promise<SearchApiRecord[]> {
  const supabase = createServerClient();

  const queryEmbedding = query.length >= 3 ? await embedQuery(query) : null;
  if (queryEmbedding) {
    const rpc = supabase as unknown as {
      rpc: (
        name: string,
        params: { query_text: string; query_embedding: number[]; match_count: number }
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
    };
    const { data: hybrid, error: hybridError } = await rpc.rpc('search_apis_hybrid', {
      query_text: query,
      query_embedding: queryEmbedding,
      match_count: 120,
    });

    const hybridRows: HybridSearchRow[] = Array.isArray(hybrid) ? hybrid as HybridSearchRow[] : [];
    if (!hybridError && hybridRows.length > 0) {
      return hybridRows.map((row) => normalizeApiRecord({
        id: row.id,
        title: row.title,
        description: row.description,
        tldr: row.tldr ?? null,
        logo: row.logo ?? null,
        website: row.website ?? null,
        doc_url: row.doc_url ?? null,
      }));
    }
  }

  const words = query.split(/\s+/).filter(Boolean);
  const conditions = words
    .map((word) => `title.ilike.%${word}%,description.ilike.%${word}%,tldr.ilike.%${word}%,id.ilike.%${word}%`)
    .join(',');

  const { data } = await supabase
    .from('apis')
    .select('id, title, description, tldr, logo, website, doc_url')
    .or(conditions)
    .limit(200);

  return ((data ?? []) as Partial<Api>[]).flatMap((row) => {
    if (!row.id || !row.title) return [];
    return [normalizeApiRecord({
      id: row.id,
      title: row.title,
      description: row.description ?? null,
      tldr: row.tldr ?? null,
      logo: row.logo ?? null,
      website: row.website ?? null,
      doc_url: row.doc_url ?? null,
    })];
  });
}

export async function searchIndexedApis(query: string, limit: number) {
  const q = query.trim();
  const max = Math.min(limit, 50);
  if (!q) return { count: 0, apis: [] as SearchApiRecord[], source: 'empty' as const };

  const algoliaResults = await searchApisViaAlgolia(q, max);
  if (algoliaResults && algoliaResults.length > 0) {
    return { count: algoliaResults.length, apis: algoliaResults, source: 'algolia' as const };
  }

  const supabaseResults = await searchApisViaSupabase(q);
  return { count: supabaseResults.length, apis: supabaseResults, source: 'supabase' as const };
}
