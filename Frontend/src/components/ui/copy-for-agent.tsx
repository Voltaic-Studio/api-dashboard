'use client';

import { useState } from 'react';
import type { Api, Endpoint } from '@/lib/supabase';

interface CopyForAgentProps {
  api: Api;
  endpoints: Endpoint[];
  docUrl: string | null;
}

function buildAgentPrompt(api: Api, endpoints: Endpoint[], docUrl: string | null): string {
  const sections: Record<string, Endpoint[]> = {};
  for (const ep of endpoints) {
    const sec = ep.section ?? 'General';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(ep);
  }

  let prompt = `# ${api.title} API Reference\n\n`;

  if (api.tldr) prompt += `${api.tldr}\n\n`;

  if (docUrl) prompt += `Documentation: ${docUrl}\n`;
  if (api.website) prompt += `Base URL: ${api.website}\n`;
  prompt += `\n---\n\n`;

  if (endpoints.length === 0) {
    prompt += `No endpoints documented yet. Refer to the documentation URL above.\n`;
    return prompt;
  }

  prompt += `## Endpoints (${endpoints.length} total)\n\n`;

  for (const [section, eps] of Object.entries(sections)) {
    prompt += `### ${section}\n\n`;
    for (const ep of eps) {
      prompt += `**${ep.method} ${ep.path}**`;
      if (ep.summary) prompt += ` — ${ep.summary}`;
      prompt += `\n`;
      if (ep.description) prompt += `${ep.description}\n`;

      if (ep.parameters && ep.parameters.length > 0) {
        prompt += `Parameters:\n`;
        for (const p of ep.parameters) {
          const req = p.required ? ' (required)' : '';
          const desc = p.description ? ` — ${p.description}` : '';
          prompt += `  - ${p.name}: ${p.type}${req}${desc}\n`;
        }
      }

      if (ep.doc_url) prompt += `Docs: ${ep.doc_url}\n`;
      prompt += `\n`;
    }
  }

  return prompt.trim();
}

export function CopyForAgentButton({ api, endpoints, docUrl }: CopyForAgentProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const prompt = buildAgentPrompt(api, endpoints, docUrl);
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="h-10 rounded-xl border border-[var(--foreground)]/20 bg-[var(--background)] flex items-center justify-center gap-2 text-[var(--foreground)] text-[13px] font-medium hover:bg-[var(--muted)] transition-colors w-full"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      {copied ? 'Copied!' : 'Copy for agent'}
    </button>
  );
}
