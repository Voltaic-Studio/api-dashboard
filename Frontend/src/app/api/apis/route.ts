import { createServerClient } from '@/lib/supabase';

export const PAGE_SIZE = 24;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q    = searchParams.get('q')?.trim() ?? '';
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));

  const supabase = createServerClient();

  if (q) {
    const { data, error } = await supabase
      .from('apis')
      .select('*')
      .or(`title.ilike.%${q}%,description.ilike.%${q}%,id.ilike.%${q}%`)
      .limit(48);

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json(data ?? []);
  }

  const offset = (page - 1) * PAGE_SIZE;
  const { data, error } = await supabase
    .from('apis')
    .select('*')
    .range(offset, offset + PAGE_SIZE - 1);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data ?? []);
}
