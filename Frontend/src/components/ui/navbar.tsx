'use client';

import { Monitor, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import Image from 'next/image';
import { useEffect, useState } from 'react';

const themeOptions = [
  { key: 'system' as const, icon: Monitor },
  { key: 'light' as const, icon: Sun },
  { key: 'dark' as const, icon: Moon },
];

export function Navbar() {
  const { theme, setTheme } = useTheme();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 16);
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 h-14 apple-blur transition-all duration-500 ${
        scrolled ? 'border-b border-[var(--border)]/40' : 'border-b border-transparent'
      }`}
    >
      <div className="max-w-5xl mx-auto h-full px-6 grid grid-cols-3 items-center">

        <div className="flex items-center gap-2">
          <Image src="/logo.png" alt="ApiFlora" width={22} height={22} className="rounded-md" />
          <span className="font-semibold tracking-tight text-[17px]">
            Api<span className="text-[var(--accent)]">Flora</span>
          </span>
        </div>

        <div className="hidden md:flex items-center justify-center gap-8 text-sm font-medium text-[var(--foreground)]/70">
          <a href="#apis" className="hover:text-[var(--foreground)] transition-colors">Discover</a>
          <a href="#apis" className="hover:text-[var(--foreground)] transition-colors">Categories</a>
          <a href="#submit" className="hover:text-[var(--foreground)] transition-colors">Submit</a>
        </div>

        <div className="flex justify-end">
          <div className="group flex items-center rounded-full border border-[var(--border)] p-[3px] gap-0 hover:gap-0.5 transition-all duration-300">
            {themeOptions.map(({ key, icon: Icon }) => {
              const active = theme === key;
              return (
                <button
                  key={key}
                  onClick={(e) => setTheme(key, e)}
                  className={`
                    flex items-center justify-center h-7 rounded-full transition-all duration-300 shrink-0 cursor-pointer
                    ${active
                      ? 'w-7 opacity-100 bg-[var(--accent)] text-white'
                      : 'w-0 opacity-0 overflow-hidden group-hover:w-7 group-hover:opacity-100 hover:bg-[var(--muted)]'
                    }
                  `}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                </button>
              );
            })}
          </div>
        </div>

      </div>
    </nav>
  );
}
