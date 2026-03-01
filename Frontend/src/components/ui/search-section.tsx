'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { SearchBar } from '@/components/ui/search-bar';
import { ApiGrid } from '@/components/ui/api-grid';
import { AgentInstructions } from '@/components/ui/agent-instructions';
import { CategoryFilter, matchesCategories, type ApiCategory } from '@/components/ui/category-filter';
import type { Brand } from '@/lib/supabase';

const PAGE_SIZE = 24;

interface SearchSectionProps {
  initialBrands: Brand[];
  initialPage: number;
}

export function SearchSection({ initialBrands, initialPage }: SearchSectionProps) {
  const [query, setQuery]                     = useState('');
  const [brands, setBrands]                   = useState<Brand[]>(initialBrands);
  const [resultCount, setResultCount]         = useState<number | null>(null);
  const [loading, setLoading]                 = useState(false);
  const [copiedResults, setCopiedResults]     = useState(false);
  const [loadingMore, setLoadingMore]         = useState(false);
  const [nextPage, setNextPage]               = useState(initialPage + 1);
  const [hasMore, setHasMore]                 = useState(initialBrands.length === PAGE_SIZE);
  const [selectedCategories, setSelectedCategories] = useState<ApiCategory[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    if (!query.trim()) {
      setBrands(initialBrands);
      setResultCount(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/apis?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        const json = await res.json();
        if (controller.signal.aborted) return;
        setBrands(json.brands ?? []);
        setResultCount(json.count ?? 0);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query, initialBrands]);

  const filteredBrands = useMemo(() => {
    if (selectedCategories.length === 0) return brands;
    return brands.filter(b => matchesCategories(b, selectedCategories));
  }, [brands, selectedCategories]);

  async function handleCopyResultsForAgent() {
    const rows = filteredBrands;
    const lines = [
      `# API search results`,
      '',
      ...rows.map((b) => {
        const description = b.description?.replace(/\n+/g, ' ').trim() || 'N/A';
        const docUrl = (b as Brand & { doc_url?: string | null }).doc_url ?? b.website ?? 'N/A';
        return `- **${b.id}** (${b.title})\n  - description: ${description}\n  - doc_url: ${docUrl}`;
      }),
    ];

    await navigator.clipboard.writeText(lines.join('\n'));
    setCopiedResults(true);
    setTimeout(() => setCopiedResults(false), 1800);
  }

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res  = await fetch(`/api/apis?page=${nextPage}`);
      const json = await res.json();
      const newBrands: Brand[] = json.brands ?? [];
      setBrands(prev => [...prev, ...newBrands]);
      setHasMore(newBrands.length === PAGE_SIZE);
      window.history.replaceState({}, '', nextPage === 1 ? '/' : `/${nextPage}`);
      setNextPage(p => p + 1);
    } finally {
      setLoadingMore(false);
    }
  }

  const isSearching = query.trim().length > 0;
  const displayCount = selectedCategories.length > 0 ? filteredBrands.length : resultCount;
  const showStatusRow = loading || (displayCount !== null && (isSearching || selectedCategories.length > 0));

  return (
    <>
      <div className="mt-10 px-4">
        <SearchBar onSearch={setQuery} />
        <div className="mt-6 h-12 relative flex items-center justify-center">
          <div className={`absolute inset-0 flex items-center justify-center gap-3 transition-opacity duration-300 ${isSearching ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
            <AgentInstructions />
            <CategoryFilter selected={selectedCategories} onChange={setSelectedCategories} />
          </div>
          <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${isSearching ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
            {loading ? (
              <div className="flex items-center gap-2 text-[var(--accent)]">
                <span className="h-2.5 w-2.5 rounded-full bg-current animate-[pulse_900ms_ease-in-out_infinite]" />
                <span className="h-2.5 w-2.5 rounded-full bg-current animate-[pulse_900ms_ease-in-out_150ms_infinite]" />
                <span className="h-2.5 w-2.5 rounded-full bg-current animate-[pulse_900ms_ease-in-out_300ms_infinite]" />
              </div>
            ) : showStatusRow ? (
              <div className="flex items-center gap-3 text-sm text-[var(--foreground)]/50 font-medium">
                <span>{displayCount} result{displayCount !== 1 ? 's' : ''}</span>
                {filteredBrands.length > 0 && (
                  <button
                    onClick={handleCopyResultsForAgent}
                    className="cursor-pointer rounded-full px-3 py-1 text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
                  >
                    {copiedResults ? 'Copied!' : 'Copy results for agent'}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <ApiGrid brands={filteredBrands} loading={loading} query={query} />

      {!isSearching && hasMore && selectedCategories.length === 0 && (
        <div className="flex justify-center pb-20 -mt-4">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="px-8 py-3 rounded-full border border-[var(--border)] text-sm font-medium hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loadingMore ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}
