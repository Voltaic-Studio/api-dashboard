'use client';

import { Search, Moon, Sun } from 'lucide-react';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-12 apple-blur border-b border-[var(--border)] transition-all duration-300">
      <div className="max-w-5xl mx-auto h-full px-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="font-semibold tracking-tight text-lg">API Market</span>
        </div>
        
        <div className="hidden md:flex items-center gap-8 text-xs font-medium text-[var(--foreground)]/80">
          <a href="#" className="hover:text-[var(--accent)] transition-colors">Discover</a>
          <a href="#" className="hover:text-[var(--accent)] transition-colors">Categories</a>
          <a href="#" className="hover:text-[var(--accent)] transition-colors">Submit</a>
        </div>

        <div className="flex items-center gap-4">
          <button className="p-2 hover:bg-[var(--muted)] rounded-full transition-colors">
            <Search className="w-4 h-4 opacity-70" />
          </button>
        </div>
      </div>
    </nav>
  );
}
