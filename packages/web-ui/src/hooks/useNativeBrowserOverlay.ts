import { useEffect } from 'react';
import { acquireNativeBrowserOverlay } from '../lib/nativeBrowserOverlay.ts';

/** While `active`, keep native embedded browsers hidden so HTML modals stay on top. */
export function useNativeBrowserOverlay(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return acquireNativeBrowserOverlay();
  }, [active]);
}
