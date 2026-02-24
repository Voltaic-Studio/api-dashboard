import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Navbar } from '@/components/ui/navbar';
import { SearchSection } from '@/components/ui/search-section';
import { FloatingLogo } from '@/components/ui/floating-logo';
import { createServerClient } from '@/lib/supabase';

const PAGE_SIZE = 24;

interface Props {
  params: Promise<{ page: string }>;
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
  const offset = (pageNum - 1) * PAGE_SIZE;

  const { data: initialApis } = await supabase
    .from('apis')
    .select('*')
    .range(offset, offset + PAGE_SIZE - 1);

  if (!initialApis || initialApis.length === 0) notFound();

  return (
    <main className="min-h-screen pt-32">
      <Navbar />

      <section className="text-center px-4 mb-20 space-y-6">
        <FloatingLogo />
        <p className="text-xl md:text-2xl text-[var(--foreground)]/60 font-medium max-w-2xl mx-auto leading-relaxed">
          Find any API in one place.
        </p>
      </section>

      <SearchSection initialApis={initialApis} initialPage={pageNum} />
    </main>
  );
}
