import { createServerClient, type Api } from '@/lib/supabase';

export const PAGE_SIZE = 24;

export interface Brand {
  id: string;
  title: string;
  description: string | null;
  logo: string | null;
  website: string | null;
  api_count: number;
}

function groupByBrand(apis: Api[]): Brand[] {
  const groups = new Map<string, Api[]>();

  for (const api of apis) {
    const base = api.id.split(':')[0];
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push(api);
  }

  return Array.from(groups.entries()).map(([domain, entries]) => {
    const primary = entries.find(e => e.id === domain) ?? entries[0];
    return {
      id: domain,
      title: primary.title,
      description: primary.description,
      logo: entries.find(e => e.logo)?.logo ?? null,
      website: primary.website,
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q    = searchParams.get('q')?.trim() ?? '';
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));

  const supabase = createServerClient();

  if (q) {
    // Preferred path: endpoint-aware hybrid search (vector + lexical)
    const queryEmbedding = q.length >= 3 ? await embedQuery(q) : null;
    if (queryEmbedding) {
      const rpc = supabase as any;
      const { data: hybrid, error: hybridError } = await rpc.rpc('search_apis_hybrid', {
        query_text: q,
        query_embedding: queryEmbedding,
        match_count: 120,
      });

      const hybridRows: any[] = Array.isArray(hybrid) ? hybrid : [];
      if (!hybridError && hybridRows.length > 0) {
        const normalized = hybridRows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          logo: r.logo ?? null,
          website: r.website ?? null,
        })) as Api[];
        const brands = groupByBrand(normalized);
        return Response.json({ brands, count: brands.length });
      }
    }

    // Fallback path: keyword search only
    const words = q.split(/\s+/).filter(Boolean);
    const conditions = words
      .map(w => `title.ilike.%${w}%,description.ilike.%${w}%,tldr.ilike.%${w}%,id.ilike.%${w}%`)
      .join(',');

    const { data, error } = await supabase
      .from('apis')
      .select('*')
      .or(conditions)
      .limit(200);

    if (error) return Response.json({ brands: [], count: 0, error: error.message }, { status: 500 });

    const brands = groupByBrand(data ?? []);
    return Response.json({ brands, count: brands.length });
  }

  const offset = (page - 1) * PAGE_SIZE;
  const limit = PAGE_SIZE * 5;

  const { data, error } = await supabase
    .from('apis')
    .select('*')
    .range(offset * 3, offset * 3 + limit - 1);

  if (error) return Response.json({ brands: [], count: 0, error: error.message }, { status: 500 });

  const brands = groupByBrand(data ?? []);
  return Response.json({ brands: brands.slice(0, PAGE_SIZE), count: brands.length });
}
