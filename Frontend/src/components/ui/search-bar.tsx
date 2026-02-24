'use client';

import { Search as SearchIcon, ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { motion } from 'framer-motion';
import type { Api } from '@/lib/supabase';

interface SearchBarProps {
  onSearch: (query: string) => void;
  suggestions?: Api[];
}

export function SearchBar({ onSearch, suggestions = [] }: SearchBarProps) {
  const [focused, setFocused] = useState(false);
  const [value, setValue] = useState('');

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value);
    onSearch(e.target.value);
  }

  function handleSuggestion(title: string) {
    setValue(title);
    onSearch(title);
    setFocused(false);
  }

  return (
    <div className="w-full max-w-2xl mx-auto relative group">
      <div
        className={`
          absolute -inset-0.5 bg-gradient-to-r from-[var(--accent)] to-orange-400 rounded-2xl opacity-20 blur group-hover:opacity-40 transition duration-1000 group-hover:duration-200
          ${focused ? 'opacity-60 blur-md' : ''}
        `}
      />
      <div className="relative bg-[var(--background)] rounded-xl border border-[var(--border)] shadow-sm overflow-hidden flex items-center p-2">
        <SearchIcon className="w-5 h-5 ml-3 text-[var(--foreground)] opacity-50" />
        <input
          type="text"
          value={value}
          placeholder="Find an API for..."
          className="w-full h-12 bg-transparent border-none outline-none px-4 text-lg placeholder:text-[var(--foreground)]/30 font-medium"
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onChange={handleChange}
        />
        <button className="p-2 bg-[var(--muted)] rounded-lg hover:bg-[var(--accent)] hover:text-white transition-colors">
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>

      {focused && !value && suggestions.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute top-full left-0 right-0 mt-4 p-4 bg-[var(--background)] rounded-xl border border-[var(--border)] shadow-xl z-10"
        >
          <div className="text-xs font-semibold text-[var(--foreground)]/50 uppercase tracking-wider mb-3">Suggested</div>
          <div className="space-y-2">
            {suggestions.map(api => (
              <div
                key={api.id}
                onMouseDown={() => handleSuggestion(api.title)}
                className="flex items-center gap-3 p-2 hover:bg-[var(--muted)] rounded-lg cursor-pointer transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-[var(--muted)] flex items-center justify-center overflow-hidden flex-shrink-0">
                  {api.logo ? (
                    <img src={api.logo} alt={api.title} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-[10px] font-bold">{api.title[0]}</span>
                  )}
                </div>
                <span className="text-sm font-medium truncate">{api.title}</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}
