'use client';

import { useState } from 'react';
import type { Api } from '@/lib/supabase';

interface CopyForAgentProps {
  api: Api;
  docUrl: string | null;
}

function buildAgentPrompt(api: Api, docUrl: string | null): string {
  const name = api.title;
  const url = docUrl ?? api.website ?? api.doc_url;

  if (!url) {
    return `I want to learn about the ${name} API. What endpoints are available, how does authentication work, and what are the key capabilities? If I haven't specified what I need, please ask me what I'm most interested in.`;
  }

  return `Can you please read [${name} API Documentation](${url}) and give me a full overview — what endpoints are available, how authentication works, and key capabilities. If I haven't specified what I need, please ask me what I'm most interested in learning about.`;
}

export function CopyForAgentButton({ api, docUrl }: CopyForAgentProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const prompt = buildAgentPrompt(api, docUrl);
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="h-10 rounded-xl border border-[var(--foreground)]/20 bg-[var(--background)] flex items-center justify-center gap-2 text-[var(--foreground)] text-[13px] font-medium hover:bg-[var(--muted)] transition-colors w-full cursor-pointer"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      {copied ? 'Copied!' : 'Copy for agent'}
    </button>
  );
}
