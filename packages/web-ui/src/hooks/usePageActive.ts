import { useSyncExternalStore } from 'react';
import { type PageId, getPageFromHash } from '../routes.ts';

let currentPage: PageId = getPageFromHash();
const listeners = new Set<() => void>();

function notifyAll() {
  currentPage = getPageFromHash();
  listeners.forEach(cb => cb());
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', notifyAll);
  window.addEventListener('popstate', notifyAll);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Returns true only when the given pageId is the currently visible page.
 * Uses useSyncExternalStore for tear-free reads — polling/WS effects
 * should gate on this to avoid background work on hidden pages.
 */
export function usePageActive(pageId: PageId): boolean {
  return useSyncExternalStore(
    subscribe,
    () => currentPage === pageId,
    () => false,
  );
}
