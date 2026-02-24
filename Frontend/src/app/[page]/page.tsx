import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Navbar } from '@/components/ui/navbar';
import { SearchSection } from '@/components/ui/search-section';
import { FloatingLogo } from '@/components/ui/floating-logo';
import { createServerClient, type Api, type Brand } from '@/lib/supabase';

const PAGE_SIZE = 24;

interface Props {
  params: Promise<{ page: string }>;
}

function groupByBrand(apis: Api[]): Brand[] {
  const groups = new Map<string, Api[]>();
  for (const api of apis) {
    const base = api.id.split(':')[0];
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push(api);
  }
  return Array.from(groups.entries()).map(([domain, entries]) => {
    const primary = entries.find(e => e.id === domain) ?? entries[0];
    return {
      id: domain,
      title: primary.title,
      description: primary.description,
      logo: entries.find(e => e.logo)?.logo ?? null,
      website: primary.website,
      api_count: entries.length,
    };
  });
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { page } = await params;
  const pageNum = parseInt(page, 10);
  return {
    title: `ApiFlora — Page ${pageNum}`,
    description: `Browse developer APIs — page ${pageNum} of the ApiFlora marketplace.`,
    alternates: { canonical: `/${pageNum}` },
    robots: pageNum > 50 ? { index: false } : undefined,
  };
}

export default async function PaginatedPage({ params }: Props) {
  const { page } = await params;
  const pageNum = parseInt(page, 10);

  if (isNaN(pageNum) || pageNum < 2) notFound();

  const supabase = createServerClient();
  const offset = (pageNum - 1) * PAGE_SIZE * 3;

  const { data } = await supabase
    .from('apis')
    .select('*')
    .range(offset, offset + PAGE_SIZE * 5 - 1);

  const brands = groupByBrand(data ?? []).slice(0, PAGE_SIZE);
  if (brands.length === 0) notFound();

  return (
    <main className="min-h-screen pt-32">
      <Navbar />

      <section className="text-center px-4 mb-20 space-y-6">
        <FloatingLogo />
        <p className="text-xl md:text-2xl text-[var(--foreground)]/60 font-medium max-w-2xl mx-auto leading-relaxed">
          Find any API in one place.
        </p>
      </section>

      <SearchSection initialBrands={brands} initialPage={pageNum} />
    </main>
  );
}
