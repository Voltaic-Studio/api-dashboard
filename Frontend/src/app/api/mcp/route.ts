import { createServerClient } from '@/lib/supabase';

type AnyApi = any;
type AnyEndpoint = any;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsJson(data: any, status = 200) {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

async function searchApis(query: string, limit: number) {
  const supabase = createServerClient();
  const max = Math.min(limit, 50);
  const words = query.split(/\s+/).filter(Boolean);
  const conditions = words
    .map(w => `title.ilike.%${w}%,description.ilike.%${w}%,id.ilike.%${w}%,tldr.ilike.%${w}%`)
    .join(',');

  const { data: apis } = await supabase
    .from('apis')
    .select('id, title, description, tldr, website, doc_url, logo')
    .or(conditions)
    .limit(200);

  if (!apis || apis.length === 0) return { count: 0, apis: [] };

  const grouped = new Map<string, AnyApi[]>();
  for (const api of (apis as AnyApi[])) {
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

async function getApiDetail(apiId: string) {
  const supabase = createServerClient();

  const { data: apis } = await supabase
    .from('apis')
    .select('*')
    .or(`id.eq.${apiId},id.like.${apiId}:%`);

  if (!apis || apis.length === 0) return null;

  const typedApis = apis as AnyApi[];
  const primary = typedApis.find((a) => a.id === apiId) ?? typedApis[0];
  const apiIds = typedApis.map((a) => a.id);

  const { data: endpoints } = await supabase
    .from('api_endpoints')
    .select('*')
    .in('api_id', apiIds)
    .order('section', { ascending: true })
    .order('method', { ascending: true })
    .order('path', { ascending: true });

  const sections: Record<string, any[]> = {};
  for (const ep of ((endpoints ?? []) as AnyEndpoint[])) {
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

  return {
    id: primary.id,
    title: primary.title,
    tldr: primary.tldr ?? primary.description,
    website: primary.website,
    doc_url: typedApis.find((a) => a.doc_url)?.doc_url ?? primary.website,
    endpoint_count: ((endpoints ?? []) as AnyEndpoint[]).length,
    sections,
  };
}

async function getEndpointInfo(apiId: string, method: string, path: string) {
  const supabase = createServerClient();

  const { data } = await supabase
    .from('api_endpoints')
    .select('*')
    .ilike('api_id', `${apiId}%`)
    .eq('method', method.toUpperCase())
    .eq('path', path)
    .limit(1)
    .single();

  if (!data) return null;

  const ep = data as AnyEndpoint;
  return {
    method: ep.method,
    path: ep.path,
    summary: ep.summary,
    description: ep.description,
    section: ep.section,
    parameters: ep.parameters,
    responses: ep.responses,
    doc_url: ep.doc_url,
  };
}

function jsonRpcResponse(id: any, result: any) {
  return corsJson({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: any, code: number, message: string) {
  return corsJson({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  {
    name: 'search_apis',
    description: 'Search for APIs by keyword. Returns matching APIs with title, description, and documentation URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword (e.g. "payments", "weather", "email")' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_api_detail',
    description: 'Get full details for a specific API including all endpoints with parameters, responses, and documentation links.',
    inputSchema: {
      type: 'object',
      properties: {
        api_id: { type: 'string', description: 'The API identifier (domain, e.g. "stripe.com")' },
      },
      required: ['api_id'],
    },
  },
  {
    name: 'get_endpoint_info',
    description: 'Get detailed information about a specific endpoint including parameters, response schema, and documentation URL.',
    inputSchema: {
      type: 'object',
      properties: {
        api_id: { type: 'string', description: 'The API identifier (e.g. "stripe.com")' },
        method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE, PATCH)' },
        path: { type: 'string', description: 'Endpoint path (e.g. "/v1/payments/{id}")' },
      },
      required: ['api_id', 'method', 'path'],
    },
  },
];

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { method, id, params } = body;

  if (method === 'initialize') {
    return jsonRpcResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'apiflora', version: '1.0.0' },
    });
  }

  if (method === 'tools/list') {
    return jsonRpcResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments ?? {};

    if (toolName === 'search_apis') {
      const result = await searchApis(args.query ?? '', args.limit ?? 20);
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    }

    if (toolName === 'get_api_detail') {
      const result = await getApiDetail(args.api_id ?? '');
      if (!result) {
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `API "${args.api_id}" not found.` }],
        });
      }
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    }

    if (toolName === 'get_endpoint_info') {
      const result = await getEndpointInfo(args.api_id ?? '', args.method ?? '', args.path ?? '');
      if (!result) {
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `Endpoint ${args.method} ${args.path} not found for "${args.api_id}".` }],
        });
      }
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    }

    return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
  }

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export async function GET() {
  return corsJson({
    name: 'apiflora',
    version: '1.0.0',
    description: 'MCP server for searching and querying API documentation. Find any API, get endpoint details, parameters, and documentation links.',
    tools: TOOLS.map(t => t.name),
    instructions: 'Add this MCP server to your agent config: { "mcpServers": { "apiflora": { "url": "https://apiflora.com/api/mcp" } } }',
  });
}
