import { createServerClient, type Api } from '@/lib/supabase';
import { groupApisByBrand, searchIndexedApis } from '@/lib/api-search';

export const PAGE_SIZE = 24;

export interface Brand {
  id: string;
  title: string;
  description: string | null;
  logo: string | null;
  website: string | null;
  api_count: number;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q    = searchParams.get('q')?.trim() ?? '';
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));

  const supabase = createServerClient();

  if (q) {
    const result = await searchIndexedApis(q, 50);
    const brands = groupApisByBrand(result.apis);
    return Response.json({ brands, count: brands.length });
  }

  const offset = (page - 1) * PAGE_SIZE;
  const limit = PAGE_SIZE * 5;

  const { data, error } = await supabase
    .from('apis')
    .select('*')
    .range(offset * 3, offset * 3 + limit - 1);

  if (error) return Response.json({ brands: [], count: 0, error: error.message }, { status: 500 });

  const brands = groupApisByBrand((data ?? []) as Api[]);
  return Response.json({ brands: brands.slice(0, PAGE_SIZE), count: brands.length });
}
