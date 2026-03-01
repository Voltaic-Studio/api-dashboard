'use client';

import { useState } from 'react';

const DOMAIN = 'https://apiflora.dev';

const AGENT_PROMPT = `You are a coding agent. Add the ApiFlora API search MCP server to your tools so you can search and query any API documentation.

## Setup Instructions

### For Cursor
Add this to your project's .cursor/mcp.json file (create it if it doesn't exist):

\`\`\`json
{
  "mcpServers": {
    "apiflora": {
      "url": "${DOMAIN}/api/mcp"
    }
  }
}
\`\`\`

### For Claude Code
Run this command in the terminal:

\`\`\`bash
claude mcp add apiflora --transport http ${DOMAIN}/api/mcp
\`\`\`

Verify it was added:
\`\`\`bash
claude mcp list
\`\`\`

### For Codex CLI
Run this command in the terminal:

\`\`\`bash
codex mcp add apiflora --url ${DOMAIN}/api/mcp
\`\`\`

Verify it was added:
\`\`\`bash
codex mcp list
\`\`\`

## Available Tools

Once connected, you have access to:

1. **search_apis**(query, limit?) — Search for APIs by keyword (e.g. "payments", "email", "weather"). Returns matching APIs with id, title, description, website, and doc_url.

2. **get_api_detail**(api_id, doc_url?, method?, path?) — Get API detail in two modes:
   - Without method/path: overview (auth, pricing, rate limits, SDKs, gotchas, alternatives) + light endpoint list (method/path/summary only).
   - With method/path: full detail for one endpoint, including parameters and responses.

3. **get_live_docs**(api_id, url?) — Fetch raw live documentation markdown from the docs page.

## Usage Pattern

Always call search_apis first to discover APIs, then get_api_detail for the chosen API.
Use get_api_detail with method+path when you need full detail for one endpoint.
Use get_live_docs only when you need full raw markdown from docs.`;

export function AgentInstructions() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(AGENT_PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="h-12 px-8 bg-[#FF9500] rounded-2xl shadow-[0px_10px_15px_0px_rgba(0,0,0,0.1),0px_4px_6px_0px_rgba(0,0,0,0.1)] flex items-center justify-center gap-2.5 text-white text-sm font-medium tracking-[-0.2px] hover:opacity-90 transition-opacity"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      {copied ? 'Copied!' : 'Instructions for agents'}
    </button>
  );
}
