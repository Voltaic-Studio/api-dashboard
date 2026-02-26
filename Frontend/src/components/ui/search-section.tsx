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

  return (
    <>
      <div className="mt-10 px-4">
        <SearchBar onSearch={setQuery} />
        <div className={`transition-all duration-300 ${isSearching ? 'opacity-0 pointer-events-none h-0 mt-0' : 'opacity-100 h-auto mt-0'}`}>
          <div className="flex items-center justify-center gap-3 mt-6">
            <AgentInstructions />
            <CategoryFilter selected={selectedCategories} onChange={setSelectedCategories} />
          </div>
        </div>
        {displayCount !== null && (isSearching || selectedCategories.length > 0) && !loading && (
          <p className="text-center text-sm text-[var(--foreground)]/50 mt-3 font-medium transition-opacity duration-200">
            {displayCount} result{displayCount !== 1 ? 's' : ''}
          </p>
        )}
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
