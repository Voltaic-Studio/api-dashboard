import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Navbar } from '@/components/ui/navbar';
import { EndpointCard } from '@/components/ui/endpoint-card';
import { CopyForAgentButton } from '@/components/ui/copy-for-agent';
import { createServerClient } from '@/lib/supabase';
import type { Api, Endpoint } from '@/lib/supabase';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const domain = decodeURIComponent(id);
  const supabase = createServerClient();

  const { data } = await supabase
    .from('apis')
    .select('title, description, tldr')
    .or(`id.eq.${domain},id.like.${domain}:%`)
    .limit(1)
    .single();

  const row = data as { title?: string; description?: string | null; tldr?: string | null } | null;
  if (!row) return {};

  return {
    title: row.title,
    description: row.tldr ?? row.description ?? undefined,
  };
}

function groupEndpointsBySection(endpoints: Endpoint[]) {
  const groups: Record<string, Endpoint[]> = {};
  for (const ep of endpoints) {
    const label = ep.section ?? 'General';
    if (!groups[label]) groups[label] = [];
    groups[label].push(ep);
  }
  return groups;
}

function toTitleCase(raw: string): string {
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(' ');
}

function fromApiIdSuffix(apiId: string): string | null {
  const parts = apiId.split(':');
  if (parts.length < 2) return null;
  const suffix = parts.slice(1).join(':').trim();
  if (!suffix) return null;
  return toTitleCase(suffix);
}

function summarizeCapability(eps: Endpoint[], fallback: string): string {
  const best = eps.find((e) => e.summary && e.summary.trim().length > 0)
    ?? eps.find((e) => e.description && e.description.trim().length > 0)
    ?? eps[0];
  const description = (best?.summary ?? best?.description ?? fallback).trim();
  return description.length > 64 ? `${description.slice(0, 61)}...` : description;
}

function buildCapabilities(sections: Record<string, Endpoint[]>, endpointList: Endpoint[], fallbackDocUrl: string | null) {
  const map = new Map<string, { name: string; description: string; endpointCount: number; doc_url: string | null }>();

  // 1) Section-based capabilities (current behavior)
  for (const [name, eps] of Object.entries(sections)) {
    map.set(name.toLowerCase(), {
      name,
      description: summarizeCapability(eps, `Core ${name.toLowerCase()} capabilities`),
      endpointCount: eps.length,
      doc_url: eps.find((e) => e.doc_url)?.doc_url ?? fallbackDocUrl,
    });
  }

  // 2) Sub-API capabilities from api_id suffix (e.g. amazonaws.com:ec2)
  const bySuffix = new Map<string, Endpoint[]>();
  for (const ep of endpointList) {
    const suffixName = fromApiIdSuffix(ep.api_id);
    if (!suffixName) continue;
    const key = suffixName.toLowerCase();
    if (!bySuffix.has(key)) bySuffix.set(key, []);
    bySuffix.get(key)!.push(ep);
  }
  for (const [key, eps] of bySuffix.entries()) {
    if (map.has(key)) continue;
    const name = eps[0] ? (fromApiIdSuffix(eps[0].api_id) ?? 'General') : 'General';
    map.set(key, {
      name,
      description: summarizeCapability(eps, `${name} API capabilities`),
      endpointCount: eps.length,
      doc_url: eps.find((e) => e.doc_url)?.doc_url ?? fallbackDocUrl,
    });
  }

  return Array.from(map.values())
    .sort((a, b) => b.endpointCount - a.endpointCount)
    .slice(0, 12);
}

export default async function BrandPage({ params }: Props) {
  const { id } = await params;
  const domain = decodeURIComponent(id);
  const supabase = createServerClient();

  const { data: apis } = await supabase
    .from('apis')
    .select('*')
    .or(`id.eq.${domain},id.like.${domain}:%`);

  if (!apis || apis.length === 0) notFound();

  const primary: Api = (apis.find((a: Api) => a.id === domain) ?? apis[0]) as Api;
  const apiIds = apis.map((a: Api) => a.id);

  const logo = (apis as Api[]).find(a => a.logo)?.logo ?? null;
  const docUrl = (apis as Api[]).find(a => a.doc_url)?.doc_url ?? primary.website;
  const tldr = (apis as Api[]).find(a => a.tldr)?.tldr ?? null;

  const { data: endpoints } = await supabase
    .from('api_endpoints')
    .select('*')
    .in('api_id', apiIds)
    .order('method', { ascending: true })
    .order('path', { ascending: true });

  const endpointList: Endpoint[] = (endpoints ?? []) as Endpoint[];
  const sections = groupEndpointsBySection(endpointList);
  const capabilities = buildCapabilities(sections, endpointList, docUrl);

  return (
    <main className="min-h-screen pt-24">
      <Navbar />

      <div className="max-w-5xl mx-auto px-6 pb-24">

        {/* Back button */}
        <Link
          href="/"
          className="inline-flex items-center gap-2 mb-8 text-sm text-[var(--foreground)]/60 hover:text-[var(--foreground)] transition-colors"
        >
          <Image src="/back-button.png" alt="" width={28} height={28} className="dark:invert" />
          Back
        </Link>

        {/* Header row: logo + title/subtitle + buttons */}
        <div className="flex gap-5 items-start">
          {/* Logo */}
          <div className="w-16 h-16 rounded-2xl bg-[var(--muted)] flex items-center justify-center overflow-hidden flex-shrink-0">
            {logo ? (
              <img src={logo} alt={primary.title} className="w-full h-full object-cover" />
            ) : (
              <span className="text-2xl font-bold text-[var(--foreground)]/40">
                {primary.title[0]}
              </span>
            )}
          </div>

          {/* Title + subtitle */}
          <div className="flex-1 min-w-0 pt-1">
            <h1 className="text-2xl font-medium leading-tight text-[var(--foreground)] truncate">
              {primary.title}
            </h1>
            <p className="text-sm leading-snug text-[var(--foreground)]/60 mt-1">
              Rest · {capabilities.length} capabilities
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex flex-col gap-2.5 flex-shrink-0 w-[180px] pt-0.5">
            {docUrl && (
              <a
                href={docUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="h-10 bg-[#FF9500] rounded-xl shadow-[0px_10px_15px_0px_rgba(0,0,0,0.1),0px_4px_6px_0px_rgba(0,0,0,0.1)] flex items-center justify-center gap-2 text-white text-[13px] font-medium tracking-[-0.2px] hover:opacity-90 transition-opacity"
              >
                Documentation
                <Image src="/white-arrow.png" alt="" width={14} height={14} />
              </a>
            )}
            <CopyForAgentButton api={primary} endpoints={endpointList} docUrl={docUrl} />
          </div>
        </div>

        {/* TLDR */}
        {tldr && (
          <div className="mt-10 flex flex-col gap-2">
            <p className="text-sm font-medium text-[var(--foreground)]/50">TLDR</p>
            <p className="text-sm leading-relaxed text-[var(--foreground)]">
              {tldr}
            </p>
          </div>
        )}

        {/* Capabilities */}
        <div className="mt-10">
          <p className="text-sm font-medium text-[var(--foreground)]/50 mb-4">
            Capabilities
          </p>

          {capabilities.length === 0 ? (
            <div className="rounded-2xl border border-[var(--foreground)]/20 border-dashed p-12 text-center">
              <p className="text-[var(--foreground)]/40 text-sm font-medium">
                Capabilities coming soon
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {capabilities.map((capability) => (
                <EndpointCard key={capability.name} endpoint={capability} fallbackDocUrl={docUrl} />
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
