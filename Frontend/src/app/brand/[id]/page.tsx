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

  if (!data) return {};

  return {
    title: data.title,
    description: data.tldr ?? data.description ?? undefined,
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
              Rest · {endpointList.length} endpoints
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

        {/* Endpoints */}
        <div className="mt-10">
          <p className="text-sm font-medium text-[var(--foreground)]/50 mb-4">
            Endpoints
          </p>

          {endpointList.length === 0 ? (
            <div className="rounded-2xl border border-[var(--foreground)]/20 border-dashed p-12 text-center">
              <p className="text-[var(--foreground)]/40 text-sm font-medium">
                Endpoints coming soon
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {Object.entries(sections).map(([section, eps]) => (
                <div key={section}>
                  {/* Section header */}
                  <div className="flex items-center gap-2 mb-3 cursor-pointer group">
                    <span className="text-[13px] font-medium text-[var(--foreground)]">
                      {section} endpoints
                    </span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--foreground)]/50">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>

                  {/* Endpoint cards */}
                  <div className="flex flex-col gap-3">
                    {eps.map((ep) => (
                      <EndpointCard key={ep.id} endpoint={ep} fallbackDocUrl={docUrl} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
