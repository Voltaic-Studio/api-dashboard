import type { Brand } from '@/lib/supabase';

interface ApiGridProps {
  brands: Brand[];
  loading?: boolean;
  query?: string;
}

function cleanDescription(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/&lt;style[\s\S]*?&lt;\/style\s*&gt;/gi, '')
    .replace(/&lt;script[\s\S]*?&lt;\/script\s*&gt;/gi, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\|.*$/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ApiGrid({ brands, loading = false, query = '' }: ApiGridProps) {
  if (brands.length === 0 && query.trim()) {
    return (
      <div className="text-center py-20 text-[var(--foreground)]/50 text-lg font-medium">
        No APIs found for &ldquo;{query}&rdquo;
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto px-4 mt-16 pb-20">
      {brands.map((brand) => (
        <a
          key={brand.id}
          href={`/brand/${encodeURIComponent(brand.id)}`}
          className="group block p-6 bg-[var(--background)] rounded-2xl border border-[var(--border)] hover:border-[var(--accent)] hover:shadow-lg transition-all duration-300"
        >
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-xl bg-[var(--muted)] flex items-center justify-center overflow-hidden flex-shrink-0">
                {brand.logo ? (
                  <img src={brand.logo} alt={brand.title} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-xl font-bold">{brand.title[0]}</span>
                )}
              </div>
              {brand.api_count > 1 && (
                <span className="text-[10px] font-semibold bg-[#007AFF] text-white px-2 py-1 rounded-full tracking-wide">
                  {brand.api_count} APIs
                </span>
              )}
            </div>

            <h3 className="text-lg font-semibold mb-2 group-hover:text-[var(--accent)] transition-colors">
              {brand.title}
            </h3>
            <p className="text-sm text-[var(--foreground)]/70 line-clamp-3 leading-relaxed">
              {brand.description ? cleanDescription(brand.description) : null}
            </p>
        </a>
      ))}
    </div>
  );
}
