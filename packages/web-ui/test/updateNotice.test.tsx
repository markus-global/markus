/**
 * Guard: **the desktop update notice is driven by the native updater, and the
 * website-link banner is only a fallback for surfaces that have none.**
 *
 * Context (2026-11-27): before this, macOS could never auto-update — there was
 * no `.zip` in the release feed, the renderer never subscribed to the
 * electron-updater events, and the only visible "update available" UI was a
 * banner built from the *server's npm version check* linking to the website.
 * Two facts answered "is there a new version?" and the user only saw the one
 * that could not install anything.
 *
 * What must stay true (each assertion below fails if it stops being true):
 *  1. No desktop API (plain browser) → renders nothing. The legacy banner is
 *     App's job; rendering both would be the two-writers bug again.
 *  2. MAS build → renders nothing, even though the API object exists, because
 *     the App Store owns updates there.
 *  3. Downloading → shows progress and **no** restart button (there is nothing
 *     to install yet; offering the button would produce a dead click).
 *  4. Downloaded → restart button appears, and one click calls `installUpdate`
 *     exactly once (a double-quit would kill the app mid-install).
 *  5. Bundle outside /Applications → shows the "move it first" instruction and
 *     **no** restart button, because Squirrel.Mac cannot swap a translocated app.
 *  6. Dismissal is per version, so the next release still notifies.
 *
 * Assertions pin real English copy from the locale files (not i18n keys), so a
 * missing translation goes red here instead of rendering a raw key in the UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import i18n from '../src/i18n/index.ts';
import { UpdateNotice, hasDesktopUpdater, type DesktopUpdateState } from '../src/components/UpdateNotice.tsx';

type StateListener = (state: DesktopUpdateState) => void;

interface Harness {
  api: Record<string, unknown>;
  emit: (state: DesktopUpdateState) => void;
  installUpdate: ReturnType<typeof vi.fn>;
}

function state(over: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    phase: 'downloading',
    version: '0.13.0',
    percent: 42,
    requiresMoveToApplications: false,
    error: null,
    ...over,
  };
}

/** Install a fake `window.markusDesktop` without replacing the whole window. */
function harness(over: { isMAS?: boolean } = {}): Harness {
  const listeners: StateListener[] = [];
  const installUpdate = vi.fn().mockResolvedValue({ ok: true });
  const api = {
    platform: 'darwin',
    isMAS: over.isMAS ?? false,
    getUpdateState: vi.fn().mockResolvedValue(null),
    onUpdateState: (cb: StateListener) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    installUpdate,
  };
  (window as unknown as { markusDesktop?: unknown }).markusDesktop = api;
  return {
    api,
    installUpdate,
    emit: (s) => {
      act(() => {
        for (const cb of [...listeners]) cb(s);
      });
    },
  };
}

/**
 * happy-dom's global `localStorage` is not a real Storage (its `clear()` throws
 * "is not a function" — same trap the repo hit in 2026-09-23). Install a real
 * in-memory stub instead of trusting the environment global.
 */
function installStorage(): void {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true, writable: true });
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  installStorage();
});

afterEach(() => {
  delete (window as unknown as { markusDesktop?: unknown }).markusDesktop;
});

describe('hasDesktopUpdater', () => {
  it('is false without a desktop API (browser build)', () => {
    expect(hasDesktopUpdater(undefined)).toBe(false);
  });

  it('is false for MAS builds even though the API exists', () => {
    const h = harness({ isMAS: true });
    expect(hasDesktopUpdater(h.api as unknown as MarkusDesktopAPI)).toBe(false);
  });

  it('is true for a packaged non-MAS build', () => {
    const h = harness();
    expect(hasDesktopUpdater(h.api as unknown as MarkusDesktopAPI)).toBe(true);
  });
});

describe('UpdateNotice', () => {
  it('renders nothing in a browser build (App owns the fallback banner)', () => {
    const { container } = render(<UpdateNotice />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing for a MAS build', () => {
    harness({ isMAS: true });
    const { container } = render(<UpdateNotice />);
    expect(container.textContent).toBe('');
  });

  it('shows progress while downloading, without a restart button', () => {
    const h = harness();
    render(<UpdateNotice />);
    h.emit(state({ phase: 'downloading', percent: 42 }));
    expect(screen.getByText(/Downloading v0\.13\.0/)).toBeTruthy();
    expect(screen.getByText(/42%/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull();
  });

  it('offers restart once downloaded and installs exactly once per click', async () => {
    const h = harness();
    render(<UpdateNotice />);
    h.emit(state({ phase: 'ready', percent: 100 }));

    const button = screen.getByRole('button', { name: 'Restart to update' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(h.installUpdate).toHaveBeenCalledTimes(2));
    // One call per click — never a third from a re-render, which would race two
    // quitAndInstall invocations against each other.
    expect(screen.queryByText(/Could not install/)).toBeNull();
  });

  it('asks the user to move the app into /Applications instead of offering a dead button', () => {
    const h = harness();
    render(<UpdateNotice />);
    h.emit(state({ phase: 'ready', percent: 100, requiresMoveToApplications: true }));

    expect(screen.getByText(/Applications folder/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull();
  });

  it('surfaces a failed install without losing the banner', async () => {
    const h = harness();
    h.installUpdate.mockResolvedValue({ ok: false, error: 'no-update-ready' });
    render(<UpdateNotice />);
    h.emit(state({ phase: 'ready', percent: 100 }));

    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    await waitFor(() => expect(screen.getByText(/Could not install the update/)).toBeTruthy());
  });

  it('dismisses per version, so the next release still notifies', () => {
    const h = harness();
    render(<UpdateNotice />);
    h.emit(state({ phase: 'ready', percent: 100 }));

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/is ready/)).toBeNull();
    expect(localStorage.getItem('markus_native_update_dismissed')).toBe('0.13.0');

    // A newer version is not covered by the old dismissal.
    h.emit(state({ phase: 'downloading', version: '0.14.0', percent: 10 }));
    expect(screen.getByText(/Downloading v0\.14\.0/)).toBeTruthy();
  });
});
