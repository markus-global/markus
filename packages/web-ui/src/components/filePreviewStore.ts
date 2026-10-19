/**
 * File preview: one owner, outside the message list.
 *
 * ── Why this store exists ────────────────────────────────────────────────────
 * The preview modal used to be owned by `FilePathLink`, i.e. by the message row
 * that contains the link. Message rows are rendered by the chat virtualizer and
 * are **recycled**: a row disappears from the DOM whenever it leaves the
 * rendered window (auto-follow while streaming, load-more prepending history, a
 * background session reconcile, a window resize). The portal node lives at
 * `document.body`, but its React owner does not — so recycling the row unmounted
 * the modal and the reader's document closed by itself, with no user action.
 *
 * It only showed up on mobile because there the right panel is unavailable
 * (`hostAvailable === false`) and the modal is the only preview surface; on
 * desktop the click is routed to the right panel, whose lifetime is the page's.
 *
 * Fix by construction: the preview is app state with a single writer, rendered
 * by one host mounted at the app root. A row's lifetime can no longer decide
 * whether a document the user is reading stays open.
 */

let currentPath: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openFilePreview(path: string) {
  if (currentPath === path) return;
  currentPath = path;
  emit();
}

export function closeFilePreview() {
  if (currentPath === null) return;
  currentPath = null;
  emit();
}

export function getFilePreviewPath(): string | null {
  return currentPath;
}

export function subscribeFilePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
