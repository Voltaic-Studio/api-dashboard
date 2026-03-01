import { corsJson, jsonRpcResponse, jsonRpcError, UNTRUSTED_NOTICE } from './utils';
import { searchApis } from './search';
import { getApiDetail } from './detail';
import { getLiveDocs } from './live-docs';

const TOOLS = [
  {
    name: 'search_apis',
    description: 'Search for APIs by keyword. Returns matching APIs with title, description, and documentation URL. If no results are found in the database, automatically discovers APIs from the web via Exa search. This is the starting point — use it first to find APIs, then use the returned `id` with other tools.',
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
    description: 'Get full details for a specific API. Two modes:\n\n1) WITHOUT method/path: Returns overview (auth, pricing, rate limits, SDKs, gotchas, alternatives) + light endpoint list (method, path, summary only — no params). Use this to understand what the API offers.\n\n2) WITH method/path: Returns full detail for ONE endpoint (all parameters, response schema) + auth/rate-limit context. Use this when ready to implement a specific endpoint.\n\nEndpoints are discovered from official docs across multiple pages and extracted by LLM. Results are cached for 14 days. You can also pass a doc_url directly if you already have the documentation URL.',
    inputSchema: {
      type: 'object',
      properties: {
        api_id: { type: 'string', description: 'The API identifier returned by search_apis (a domain, e.g. "stripe.com")' },
        doc_url: { type: 'string', description: 'Optional: direct documentation URL to extract endpoints from. If provided, this URL is used instead of looking up the doc_url from the database. Useful when you already have an API docs link.' },
        method: { type: 'string', description: 'Optional: HTTP method (GET, POST, PUT, DELETE, PATCH). When provided with path, returns full detail for that specific endpoint.' },
        path: { type: 'string', description: 'Optional: Endpoint path (e.g. "/v1/payments/{id}"). When provided with method, returns full detail for that specific endpoint.' },
      },
      required: ['api_id'],
    },
  },
  {
    name: 'get_live_docs',
    description: 'Fetch live API documentation as raw markdown from the official docs page. Use this when you need the full unstructured documentation content beyond what get_api_detail provides. Results are cached for 14 days.',
    inputSchema: {
      type: 'object',
      properties: {
        api_id: { type: 'string', description: 'The API identifier (e.g. "stripe.com"). Used to look up the documentation URL.' },
        url: { type: 'string', description: 'Optional: direct URL to fetch. If omitted, the stored doc_url for the API is used.' },
      },
      required: ['api_id'],
    },
  },
];

const INSTRUCTIONS = `You are connected to apiflora — your second brain for working with third-party APIs. Use it whenever you need to find, evaluate, or integrate any API.

WORKFLOWS:
1) DISCOVER: search_apis("payments") → returns matching APIs ranked by relevance
2) EXPLORE: get_api_detail("stripe.com") → returns overview (auth, pricing, rate limits, gotchas, SDKs) + light endpoint list (method + path + summary only, no params)
3) IMPLEMENT: get_api_detail("stripe.com", method="POST", path="/v1/charges") → returns full params/responses for that ONE endpoint + auth/rate-limit context
4) DIRECT URL: If the user gives you an API docs URL, extract the domain and call get_api_detail with api_id=domain and doc_url=the URL
5) RAW DOCS: get_live_docs if you need the full unstructured markdown (rare — get_api_detail usually has everything)

IMPORTANT:
- The api_id is always a domain (e.g. "stripe.com", "twilio.com")
- You can use get_api_detail for ANY API — even ones not in the database. Just pass the domain.
- If the user shares a docs URL (e.g. "https://docs.stripe.com/api"), extract "stripe.com" as api_id and pass the full URL as doc_url
- Search results are ranked but not perfect — use your own judgment if results seem off. If you know the API domain already, skip search and go straight to get_api_detail.
- The overview.gotchas field contains critical implementation warnings (rate limits, expiring tokens, sandbox vs production differences). Always read and apply these.`;

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { method, id, params } = body;

  if (method === 'initialize') {
    return jsonRpcResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'apiflora', version: '1.0.0' },
      instructions: INSTRUCTIONS,
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
      const notice = (result as any).source === 'discovered'
        ? 'Note: No results found in database. These APIs were discovered from the web and may not be in our index. Use get_api_detail with the doc_url to explore them.\n\n'
        : '';
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: UNTRUSTED_NOTICE + notice + JSON.stringify(result, null, 2) }],
      });
    }

    if (toolName === 'get_api_detail') {
      const result = await getApiDetail(args.api_id ?? '', args.doc_url, args.method, args.path);
      if (!result) {
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `API "${args.api_id}" not found.` }],
        });
      }
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: UNTRUSTED_NOTICE + JSON.stringify(result, null, 2) }],
      });
    }

    if (toolName === 'get_live_docs') {
      const result = await getLiveDocs(args.api_id ?? '', args.url);
      if (!result) {
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `Could not fetch live docs for "${args.api_id}". No documentation URL found or the page could not be reached.` }],
        });
      }
      const cacheNote = result.cached ? '(served from cache)' : '(fetched live)';
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: `${UNTRUSTED_NOTICE}Documentation for ${result.api} ${cacheNote}\nSource: ${result.doc_url}\n\n${result.markdown}` }],
      });
    }

    return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
  }

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export async function GET() {
  return corsJson({
    name: 'apiflora',
    version: '1.0.0',
    description: 'Your second brain for third-party APIs. Search 2000+ APIs, get live endpoint specs with auth/pricing/rate-limits/gotchas, or pass any docs URL to extract endpoints instantly.',
    tools: TOOLS.map(t => t.name),
    instructions: 'Add this MCP server to your agent config: { "mcpServers": { "apiflora": { "url": "https://apiflora.dev/api/mcp" } } }. Workflow: search_apis → get_api_detail (returns everything) → get_api_detail with method/path (drill down).',
  });
}
