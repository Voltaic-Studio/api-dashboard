import { createServerClient } from '@/lib/supabase';

export async function GET() {
  const supabase = createServerClient();

  const allApis: any[] = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('apis')
      .select('id, title, tldr, description, doc_url, website')
      .order('title', { ascending: true })
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allApis.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const seen = new Set<string>();
  const deduped: any[] = [];
  for (const api of allApis) {
    const domain = api.id.split(':')[0];
    if (seen.has(domain)) continue;
    seen.add(domain);
    deduped.push(api);
  }

  let content = `# ApiFlora — API Search Engine for Agents

> Find any API documentation, endpoints, and parameters in one place.
> MCP Server: https://apiflora.com/api/mcp

## How to use (for AI agents)

Add the MCP server to your configuration:
\`\`\`json
{
  "mcpServers": {
    "apiflora": {
      "url": "https://apiflora.com/api/mcp"
    }
  }
}
\`\`\`

Tools available:
- search_apis(query) — Search for APIs by keyword
- get_api_detail(api_id) — Get all endpoints with parameters
- get_endpoint_info(api_id, method, path) — Get single endpoint detail

## API Index

`;

  for (const api of deduped) {
    const desc = api.tldr ?? api.description ?? '';
    const url = api.doc_url ?? api.website ?? '';
    const domain = api.id.split(':')[0];
    content += `- [${api.title}](https://apiflora.com/brand/${encodeURIComponent(domain)})`;
    if (desc) content += `: ${desc.slice(0, 150).replace(/\n/g, ' ')}`;
    if (url) content += ` | Docs: ${url}`;
    content += `\n`;
  }

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
