import type { MetadataRoute } from 'next';
import { createServerClient } from '@/lib/supabase';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const supabase = createServerClient();

  const allIds: string[] = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('apis')
      .select('id')
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allIds.push(...(data as { id: string }[]).map(a => a.id));
    if (data.length < 1000) break;
    from += 1000;
  }

  const domains = new Set<string>();
  for (const id of allIds) {
    domains.add(id.split(':')[0]);
  }

  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://apiflora.com';

  const entries: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: 'daily', priority: 1 },
  ];

  for (const domain of domains) {
    entries.push({
      url: `${base}/brand/${encodeURIComponent(domain)}`,
      changeFrequency: 'weekly',
      priority: 0.8,
    });
  }

  return entries;
}
