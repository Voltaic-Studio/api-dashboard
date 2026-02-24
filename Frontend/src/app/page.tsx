import type { Metadata } from 'next';
import { Navbar } from '@/components/ui/navbar';
import { SearchSection } from '@/components/ui/search-section';
import { FloatingLogo } from '@/components/ui/floating-logo';
import { createServerClient } from '@/lib/supabase';

export const metadata: Metadata = {
  title: 'ApiFlora — Developer API Marketplace',
  description: 'Discover, test and integrate thousands of REST APIs in seconds.',
  alternates: { canonical: '/' },
};

// Well-known APIs to surface on the homepage first
const FEATURED_IDS = [
  'stripe.com', 'twilio.com', 'github.com', 'slack.com',
  'sendgrid.com', 'spotify.com', 'twitter.com', 'paypal.com',
  'mailchimp.com', 'zoom.us', 'openai.com', 'airtable.com',
  'notion.so', 'discord.com', 'shopify.com', 'hubspot.com',
];

const PAGE_SIZE = 24;

export default async function Home() {
  const supabase = createServerClient();

  // Fetch a larger pool, reorder to put well-known APIs first
  const { data: pool } = await supabase
    .from('apis')
    .select('*')
    .limit(100);

  const featuredSet = new Set(FEATURED_IDS);
  const featured = (pool ?? []).filter(a => featuredSet.has(a.id));
  const rest     = (pool ?? []).filter(a => !featuredSet.has(a.id));
  const initialApis = [...featured, ...rest].slice(0, PAGE_SIZE);

  return (
    <main className="min-h-screen pt-32">
      <Navbar />

      <section className="text-center px-4 mb-20 space-y-6">
        <FloatingLogo />
        <p className="text-xl md:text-2xl text-[var(--foreground)]/60 font-medium max-w-2xl mx-auto leading-relaxed">
          Find any API in one place.
        </p>
      </section>

      <SearchSection initialApis={initialApis} initialPage={1} />
    </main>
  );
}
