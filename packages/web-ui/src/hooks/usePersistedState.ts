import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

/**
 * useState with automatic localStorage persistence.
 *
 * - State is restored on page load from localStorage.
 * - When `key` changes (e.g. switching agent), loads state for the new key.
 * - If `limit` is provided and T is an array, only the last `limit` items are
 *   stored to prevent localStorage from growing unbounded.
 */
export function usePersistedState<T>(
  key: string,
  initialValue: T,
  options?: { limit?: number },
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => load(key, initialValue));
  const prevKeyRef = useRef(key);

  // When the key changes, swap to the stored value for the new key
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      setState(load(key, initialValue));
    }
  }, [key, initialValue]);

  // Persist whenever state changes
  useEffect(() => {
    try {
      const value =
        options?.limit !== undefined && Array.isArray(state)
          ? (state as unknown[]).slice(-options.limit)
          : state;
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore QuotaExceededError and other storage errors
    }
  }, [key, state, options?.limit]);

  return [state, setState];
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
