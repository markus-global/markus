import { useState, useEffect, useCallback } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'markus-theme';

function applyTheme(mode: ThemeMode) {
  const html = document.documentElement;
  html.classList.remove('light', 'dark');
  if (mode === 'light') html.classList.add('light');
  else if (mode === 'dark') html.classList.add('dark');
}

function getStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(getStored);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore */ }
    applyTheme(m);
  }, []);

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  return { mode, setMode } as const;
}
