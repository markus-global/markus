import { useSyncExternalStore } from 'react';

const MOBILE_QUERY = '(max-width: 767px)';

let mql: MediaQueryList | null = null;

function getMql(): MediaQueryList {
  if (!mql) mql = window.matchMedia(MOBILE_QUERY);
  return mql;
}

function subscribe(cb: () => void): () => void {
  const q = getMql();
  q.addEventListener('change', cb);
  return () => q.removeEventListener('change', cb);
}

function getSnapshot(): boolean {
  return getMql().matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
