/**
 * Notification list paging — the ONE place that decides how the list grows.
 *
 * Owner bug report (2026-10-18): "在通知 tab 里滚到底部，浮窗一直闪烁，页面会卡住".
 * Measured in a real browser before this rewrite (one refresh event while the
 * user sat at the bottom): list 150 rows -> 30 -> 150, 8 HTTP requests, scroll
 * position jumping. The mechanism was NOT "the server keeps returning the same
 * page" — it was two writers fighting over one array:
 *
 *   fetchData()              replaced the whole list with page 1
 *   loadMoreNotifications()  appended page N
 *
 * So every refresh (60s timer, every WS `notification`/`approval` event, every
 * mark-read) collapsed the list back to the first page. Collapsing the list
 * clamps `scrollTop` to the (new) bottom, which the scroll handler cannot tell
 * apart from the user scrolling down — so it immediately re-armed infinite
 * scroll, appended the pages again, and the collapsed/expanded list repeated.
 * Visually: the popover flashing; on the main thread: a re-render storm.
 *
 * The two rules below remove the whole class of bug:
 *   1. `mergeNotificationPage` — a refresh is an UPSERT, never a replacement.
 *      The list can only grow (or update fields); it never shrinks, so a
 *      refresh can never move the scroll position and can never re-arm paging.
 *   2. `decideNextPage` — "is there more" is derived from a MONOTONIC cursor
 *      (how many rows the server has handed us), not from the length of a list
 *      that other code mutates. The cursor cannot be reset by a refresh.
 */

/** Anything the bell renders; only `id` (identity) and `read` (mutable flag) matter here. */
export interface MergeableNotification {
  id: string;
  read: boolean;
}

/**
 * Merge a freshly fetched page into the already-loaded list.
 *
 * Identity is `id`; the fresh row WINS for mutable fields (a notification read
 * on another surface must stop looking unread here; an approval answered
 * elsewhere must show its new status). Rows we already loaded but that are not
 * in this page are kept — that is the whole point: a refresh must never throw
 * away the pages the user scrolled through.
 *
 * `changed` names what "mutable" means for the row type. Default = the
 * notification's `read` flag; the approvals list passes status/respondedAt.
 * ONE merge implementation for every paged list, so a list cannot be born with
 * the replace-on-refresh bug.
 *
 * Returns the previous array reference when nothing changed, so an idle refresh
 * does not re-render the list.
 */
export function mergeNotificationPage<T extends { id: string }>(
  existing: T[],
  incoming: T[],
  changed: (prev: T, row: T) => boolean = (prev, row) =>
    (prev as { read?: boolean }).read !== (row as { read?: boolean }).read,
): T[] {
  if (incoming.length === 0) return existing;

  const byId = new Map<string, T>(existing.map(row => [row.id, row] as const));
  let anyChange = byId.size !== existing.length;

  for (const row of incoming) {
    const prev = byId.get(row.id);
    if (!prev) anyChange = true;
    else if (changed(prev, row)) anyChange = true;
    byId.set(row.id, row);
  }

  return anyChange ? [...byId.values()] : existing;
}

export interface NextPageInput {
  /** Rows the server has handed us so far (offset + received). Monotonic. */
  loadedCount: number;
  /** Items the server returned for the last request. */
  received: number;
  /** How many of those the list did not already have. */
  fresh: number;
  /** Server total, when it reports one. */
  totalCount?: number | null;
  pageSize: number;
}

/**
 * `hasMore` is true only when the last page made PROGRESS and the server
 * signals more. Two terminators, both necessary:
 *  - a page that adds nothing terminates the cursor (it can never produce rows);
 *  - `loadedCount` (monotonic) reaching `totalCount` terminates the list.
 */
export function decideNextPage(input: NextPageInput): { hasMore: boolean } {
  const { loadedCount, received, fresh, totalCount, pageSize } = input;
  if (received <= 0) return { hasMore: false };
  if (fresh <= 0) return { hasMore: false };
  const more = totalCount != null
    ? loadedCount < totalCount
    : received >= pageSize;
  return { hasMore: more };
}

