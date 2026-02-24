'use client';

import { useState, useEffect, useRef } from 'react';
import { SearchBar } from '@/components/ui/search-bar';
import { ApiGrid } from '@/components/ui/api-grid';
import type { Brand } from '@/lib/supabase';

const PAGE_SIZE = 24;

interface SearchSectionProps {
  initialBrands: Brand[];
  initialPage: number;
}

export function SearchSection({ initialBrands, initialPage }: SearchSectionProps) {
  const [query, setQuery]             = useState('');
  const [brands, setBrands]           = useState<Brand[]>(initialBrands);
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [loading, setLoading]         = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPage, setNextPage]       = useState(initialPage + 1);
  const [hasMore, setHasMore]         = useState(initialBrands.length === PAGE_SIZE);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setBrands(initialBrands);
      setResultCount(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/apis?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        setBrands(json.brands ?? []);
        setResultCount(json.count ?? 0);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, initialBrands]);

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

  return (
    <>
      <div className="mt-10 px-4">
        <SearchBar onSearch={setQuery} />
        {resultCount !== null && isSearching && !loading && (
          <p className="text-center text-sm text-[var(--foreground)]/50 mt-4 font-medium">
            {resultCount} result{resultCount !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      <ApiGrid brands={brands} loading={loading} query={query} />

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
