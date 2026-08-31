import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  onboardingKey,
  checklistDismissedKey,
  isUserOnboarded,
  markUserOnboarded,
  clearUserOnboarded,
  isChecklistDismissed,
  markChecklistDismissed,
} from './onboarding.ts';

const LEGACY_ONBOARDED = 'markus_onboarded';
const LEGACY_DISMISSED = 'markus_checklist_dismissed';

// Node test env has no localStorage — provide a tiny in-memory shim.
function installStorageShim() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  vi.stubGlobal('localStorage', stub);
  return () => store.clear();
}

describe('per-user onboarding state', () => {
  installStorageShim();
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('marks users independently (a new user does not inherit another user state)', () => {
    markUserOnboarded('user-a');
    expect(isUserOnboarded('user-a')).toBe(true);
    expect(isUserOnboarded('user-b')).toBe(false);
    expect(localStorage.getItem(onboardingKey('user-a'))).toBe('1');
    expect(localStorage.getItem(onboardingKey('user-b'))).toBeNull();
  });

  it('falls back to the legacy global key so familiar users are not re-onboarded', () => {
    localStorage.setItem(LEGACY_ONBOARDED, '1');
    expect(isUserOnboarded('legacy-user')).toBe(true);
    // legacy dismissal does not leak into per-user dismissal (avoid hiding the card)
    localStorage.setItem(LEGACY_DISMISSED, 'true');
    expect(isChecklistDismissed('legacy-user')).toBe(false);
  });

  it('clearUserOnboarded only clears the per-user key', () => {
    markUserOnboarded('user-a');
    clearUserOnboarded('user-a');
    expect(isUserOnboarded('user-a')).toBe(false);
  });

  it('checklist dismissal is per-user', () => {
    markChecklistDismissed('user-a');
    expect(isChecklistDismissed('user-a')).toBe(true);
    expect(isChecklistDismissed('user-b')).toBe(false);
    expect(localStorage.getItem(checklistDismissedKey('user-a'))).toBe('true');
  });
});