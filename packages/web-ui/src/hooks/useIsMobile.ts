import { createContext, useContext, useSyncExternalStore } from 'react';

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

export const ForceDesktopContext = createContext(false);

export function useIsMobile(): boolean {
  const forceDesktop = useContext(ForceDesktopContext);
  const mediaResult = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return forceDesktop ? false : mediaResult;
}
