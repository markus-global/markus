/**
 * Mobile document scrolling (`mobile-doc-scroll`) has exactly ONE scroller: the
 * document. A page whose content must live in a fixed-height, self-scrolling
 * pane (the chat list is virtualized and bound to an inner scroll element) has
 * to opt out — otherwise its inner scroller eats the gesture, the document never
 * scrolls, and the browser's toolbar stops auto-hiding.
 *
 * One fact, one writer: a page declares "I need inner scrolling"; `App` derives
 * whether the document is the scroller. `App` still scopes the flag to the page
 * that owns it, so a stale `true` from a background page can never leak.
 */
let blocked = false;
const listeners = new Set<() => void>();

export function setDocScrollBlocked(next: boolean): void {
  if (blocked === next) return;
  blocked = next;
  for (const listener of listeners) listener();
}

export function subscribeDocScrollBlocked(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getDocScrollBlocked(): boolean {
  return blocked;
}
