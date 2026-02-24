'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

type Theme = 'system' | 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme, event?: React.MouseEvent) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'system',
  setTheme: () => {},
});

export const useTheme = () => useContext(ThemeContext);

function resolvesDark(theme: Theme) {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyClass(theme: Theme) {
  const dark = resolvesDark(theme);
  if (dark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeRaw] = useState<Theme>('system');

  useEffect(() => {
    const stored = (localStorage.getItem('theme') as Theme) || 'system';
    setThemeRaw(stored);
    applyClass(stored);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const current = (localStorage.getItem('theme') as Theme) || 'system';
      if (current === 'system') applyClass('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((next: Theme, event?: React.MouseEvent) => {
    const commit = () => {
      setThemeRaw(next);
      localStorage.setItem('theme', next);
      applyClass(next);
    };

    try {
      if (event && typeof (document as any).startViewTransition === 'function') {
        const x = event.clientX;
        const y = event.clientY;
        const maxR = Math.hypot(
          Math.max(x, innerWidth - x),
          Math.max(y, innerHeight - y),
        );

        const transition = (document as any).startViewTransition(() => {
          commit();
        });

        transition.ready
          .then(() => {
            document.documentElement.animate(
              { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`] },
              { duration: 500, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' },
            );
          })
          .catch(() => {});
      } else {
        commit();
      }
    } catch {
      commit();
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
