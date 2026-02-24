'use client';

import { useState, useEffect, useRef } from 'react';
import { SearchBar } from '@/components/ui/search-bar';
import { ApiGrid } from '@/components/ui/api-grid';
import type { Api } from '@/lib/supabase';

const PAGE_SIZE = 24;

interface SearchSectionProps {
  initialApis: Api[];
  initialPage: number;
}

export function SearchSection({ initialApis, initialPage }: SearchSectionProps) {
  const [query, setQuery]         = useState('');
  const [apis, setApis]           = useState<Api[]>(initialApis);
  const [loading, setLoading]     = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPage, setNextPage]   = useState(initialPage + 1);
  const [hasMore, setHasMore]     = useState(initialApis.length === PAGE_SIZE);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Search with debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setApis(initialApis);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/apis?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setApis(data);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, initialApis]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res  = await fetch(`/api/apis?page=${nextPage}`);
      const data: Api[] = await res.json();
      setApis(prev => [...prev, ...data]);
      setHasMore(data.length === PAGE_SIZE);
      // Update URL to reflect how deep the user has loaded (no new history entry)
      window.history.replaceState({}, '', nextPage === 1 ? '/' : `/${nextPage}`);
      setNextPage(p => p + 1);
    } finally {
      setLoadingMore(false);
    }
  }

  const isSearching = query.trim().length > 0;

  return (
    <>
      <div className="mt-10 px-4">
        <SearchBar onSearch={setQuery} suggestions={initialApis.slice(0, 5)} />
      </div>

      <ApiGrid apis={apis} loading={loading} query={query} />

      {!isSearching && hasMore && (
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
