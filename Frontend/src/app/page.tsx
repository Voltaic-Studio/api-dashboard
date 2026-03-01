import type { Metadata } from 'next';
import { Navbar } from '@/components/ui/navbar';
import { SearchSection } from '@/components/ui/search-section';
import { FloatingLogo } from '@/components/ui/floating-logo';
import { createServerClient, type Api, type Brand } from '@/lib/supabase';

export const metadata: Metadata = {
  title: 'ApiFlora — Developer API Marketplace',
  description: 'Discover, test and integrate thousands of REST APIs in seconds.',
  alternates: { canonical: '/' },
};

const FEATURED_IDS = [
  'stripe.com', 'twilio.com', 'github.com', 'slack.com',
  'sendgrid.com', 'spotify.com', 'twitter.com', 'paypal.com',
  'mailchimp.com', 'zoom.us', 'openai.com', 'airtable.com',
  'notion.so', 'discord.com', 'shopify.com', 'hubspot.com',
];

const PAGE_SIZE = 24;

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

export default async function Home() {
  const supabase = createServerClient();

  const { data: pool } = await supabase
    .from('apis')
    .select('*')
    .limit(500);

  const allBrands = groupByBrand(pool ?? []);

  const featuredSet = new Set(FEATURED_IDS);
  const featured = allBrands.filter(b => featuredSet.has(b.id));
  const rest     = allBrands.filter(b => !featuredSet.has(b.id));
  const initialBrands = [...featured, ...rest].slice(0, PAGE_SIZE);

  return (
    <main className="min-h-screen pt-32">
      <Navbar />

      <section className="text-center px-4 mb-20 space-y-6">
        <FloatingLogo />
        <p className="text-xl md:text-2xl text-[var(--foreground)]/60 font-medium max-w-2xl mx-auto leading-relaxed">
          Find any API in one place.
        </p>
      </section>

      <SearchSection initialBrands={initialBrands} initialPage={1} />

      <footer className="px-4 pb-12 text-center text-sm text-[var(--foreground)]/55">
        Made with ❤️ by{' '}
        <a
          href="https://x.com/giginotmario"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline decoration-[var(--foreground)]/35 underline-offset-4 hover:text-[var(--accent)] hover:decoration-[var(--accent)] transition-colors"
        >
          @giginotmario
        </a>
      </footer>
    </main>
  );
}
