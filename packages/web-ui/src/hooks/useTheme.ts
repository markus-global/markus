import { useState, useEffect, useCallback } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark' | 'cyberpunk' | 'midnight';

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'cyberpunk', label: 'Cyberpunk' },
  { value: 'midnight', label: 'Midnight' },
];

const STORAGE_KEY = 'markus-theme';

function applyTheme(mode: ThemeMode) {
  const html = document.documentElement;
  html.classList.remove('light', 'dark', 'cyberpunk', 'midnight');
  if (mode === 'light') html.classList.add('light');
  else if (mode === 'dark') html.classList.add('dark');
  else if (mode === 'cyberpunk') html.classList.add('cyberpunk');
  else if (mode === 'midnight') html.classList.add('midnight');
}

function getStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system' || v === 'cyberpunk' || v === 'midnight') return v;
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
