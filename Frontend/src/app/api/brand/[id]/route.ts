import { createServerClient } from '@/lib/supabase';
import type { Api, Endpoint } from '@/lib/supabase';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const domain = decodeURIComponent(id);
  const supabase = createServerClient();

  const { data: apis } = await supabase
    .from('apis')
    .select('*')
    .or(`id.eq.${domain},id.like.${domain}:%`);

  if (!apis || apis.length === 0) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const primary = (apis.find((a: Api) => a.id === domain) ?? apis[0]) as Api;
  const apiIds = apis.map((a: Api) => a.id);

  const { data: endpoints } = await supabase
    .from('api_endpoints')
    .select('*')
    .in('api_id', apiIds)
    .order('section', { ascending: true })
    .order('method', { ascending: true })
    .order('path', { ascending: true });

  const endpointList = (endpoints ?? []) as Endpoint[];

  const sections: Record<string, any[]> = {};
  for (const ep of endpointList) {
    const sec = ep.section ?? 'General';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push({
      method: ep.method,
      path: ep.path,
      summary: ep.summary,
      description: ep.description,
      parameters: ep.parameters,
      responses: ep.responses,
      doc_url: ep.doc_url,
    });
  }

  return Response.json({
    id: primary.id,
    title: primary.title,
    tldr: primary.tldr ?? primary.description,
    website: primary.website,
    doc_url: (apis as Api[]).find(a => a.doc_url)?.doc_url ?? primary.website,
    logo: (apis as Api[]).find(a => a.logo)?.logo ?? null,
    endpoint_count: endpointList.length,
    sections,
  }, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
