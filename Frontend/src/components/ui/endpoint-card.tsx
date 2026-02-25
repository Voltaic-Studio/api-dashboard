'use client';

import Image from 'next/image';
import { getMethodColor } from '@/lib/method-colors';
import type { Endpoint } from '@/lib/supabase';

interface EndpointCardProps {
  endpoint: Endpoint;
  fallbackDocUrl?: string | null;
}

export function EndpointCard({ endpoint, fallbackDocUrl }: EndpointCardProps) {
  const color = getMethodColor(endpoint.method);
  const href = endpoint.doc_url ?? fallbackDocUrl ?? '#';

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-4 px-5 h-[72px] rounded-2xl border border-[var(--foreground)]/15 hover:border-[#FF9500]/40 transition-colors group"
    >
      <span
        className="text-xs font-semibold px-2.5 py-1 rounded-md flex-shrink-0 text-white uppercase tracking-wide"
        style={{ backgroundColor: color.bg }}
      >
        {endpoint.method.toUpperCase()}
      </span>

      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-sm text-[var(--foreground)] truncate">
          {endpoint.summary ?? endpoint.path}
        </span>
        <span className="text-xs text-[var(--foreground)]/50 truncate">
          {endpoint.path}
        </span>
      </div>

      <Image
        src="/orange-arrow.png"
        alt=""
        width={20}
        height={20}
        className="flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity"
      />
    </a>
  );
}
