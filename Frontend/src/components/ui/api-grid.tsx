import type { Api } from '@/lib/supabase';

interface ApiGridProps {
  apis: Api[];
  loading?: boolean;
  query?: string;
}

function cleanDescription(text: string): string {
  return text
    // 1. Strip fenced code blocks before anything else
    .replace(/```[\s\S]*?```/g, '')
    // 2. Strip entity-encoded <style> and <script> blocks BEFORE decoding
    //    (e.g. viator: &lt;style type='text/css'&gt;...&lt;/style&gt;)
    .replace(/&lt;style[\s\S]*?&lt;\/style\s*&gt;/gi, '')
    .replace(/&lt;script[\s\S]*?&lt;\/script\s*&gt;/gi, '')
    // 3. Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, '')
    // 4. Strip raw <style> and <script> blocks (post-decode)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // 5. Keep anchor text, drop the tag
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')
    // 6. Drop all remaining HTML tags
    .replace(/<[^>]+>/g, ' ')
    // 7. Strip markdown tables (lines that are just | col | col |)
    .replace(/^\|.*$/gm, '')
    // 8. Strip markdown
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    // 9. Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

export function ApiGrid({ apis, loading = false, query = '' }: ApiGridProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-20 text-[var(--foreground)]/40 text-sm font-medium">
        Searching...
      </div>
    );
  }

  if (apis.length === 0 && query.trim()) {
    return (
      <div className="text-center py-20 text-[var(--foreground)]/50 text-lg font-medium">
        No APIs found for &ldquo;{query}&rdquo;
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto px-4 mt-16 pb-20">
      {apis.map((api) => (
        <a
          key={api.id}
          href={api.website ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="group block p-6 bg-[var(--background)] rounded-2xl border border-[var(--border)] hover:border-[var(--accent)] hover:shadow-lg transition-all duration-300"
        >
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--muted)] flex items-center justify-center overflow-hidden flex-shrink-0">
              {api.logo ? (
                <img
                  src={api.logo}
                  alt={api.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-xl font-bold">{api.title[0]}</span>
              )}
            </div>
            <span className="text-[10px] font-semibold bg-[var(--muted)] px-2 py-1 rounded-full uppercase tracking-wide text-[var(--foreground)]/60">
              REST
            </span>
          </div>

          <h3 className="text-lg font-semibold mb-2 group-hover:text-[var(--accent)] transition-colors">
            {api.title}
          </h3>
          <p className="text-sm text-[var(--foreground)]/70 line-clamp-3 leading-relaxed">
            {api.description ? cleanDescription(api.description) : null}
          </p>
        </a>
      ))}
    </div>
  );
}
