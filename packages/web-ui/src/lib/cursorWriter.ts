/**
 * Coalesce read-cursor writes into one request per burst.
 *
 * The bug this makes structurally impossible: "mark this conversation read"
 * reaches the network one key at a time. Three separate call sites each had their
 * own loop, and fixing them one by one kept missing the next one — measured on
 * the wire, opening one agent's chat still fired 495 POST /api/unread/mark-read
 * in 435 ms, because that agent owns 247 sessions and the effect ran twice.
 *
 * Batching at the call sites cannot close this class of bug: every new caller can
 * reintroduce it, and a loop that forgets is invisible until someone counts
 * requests. So coalescing lives at the transport instead. Callers state what
 * became read; this decides how many requests that is.
 */

export interface CursorWrite {
  conversationKey: string;
  lastReadAt: string;
}

export interface CursorWriter {
  /** Record conversations as read at `lastReadAt`. Never sends synchronously. */
  queue(keys: readonly string[], lastReadAt: string): void;
  /** Send whatever is pending now (page hide / tests). */
  flushNow(): void;
  /** Conversations waiting to be sent. */
  pendingCount(): number;
}

export const DEFAULT_FLUSH_DELAY_MS = 100;

export function createCursorWriter(
  send: (items: CursorWrite[]) => void,
  opts?: {
    delayMs?: number;
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
  },
): CursorWriter {
  const delayMs = opts?.delayMs ?? DEFAULT_FLUSH_DELAY_MS;
  const schedule = opts?.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts?.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  /** key -> latest lastReadAt. A Map, so N writes to one key still send one item. */
  const pending = new Map<string, string>();
  let handle: unknown = null;
  let hasHandle = false;

  function flush(): void {
    handle = null;
    hasHandle = false;
    if (pending.size === 0) return;
    const items: CursorWrite[] = [];
    for (const [conversationKey, lastReadAt] of pending) items.push({ conversationKey, lastReadAt });
    pending.clear();
    send(items);
  }

  return {
    queue(keys, lastReadAt) {
      let added = false;
      for (const key of keys) {
        if (!key) continue;
        pending.set(key, lastReadAt);
        added = true;
      }
      if (!added) return;
      // One timer per burst: the first call arms it, the rest only add keys.
      if (!hasHandle) {
        hasHandle = true;
        handle = schedule(flush, delayMs);
      }
    },
    flushNow() {
      if (hasHandle) { cancel(handle); hasHandle = false; handle = null; }
      flush();
    },
    pendingCount() {
      return pending.size;
    },
  };
}
