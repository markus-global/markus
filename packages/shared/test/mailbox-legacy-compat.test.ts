import { describe, it, expect } from 'vitest';
// 相对路径而非 '@markus/shared'：在本包内 import 自己的包名，本地靠 pnpm
// workspace 软链能解析，CI 里没有那层软链 → ERR_MODULE_NOT_FOUND（已实测红过）。
import { routeMailboxItem } from '../src/types/mailbox.js';
import type { MailboxItemLite } from '../src/types/mailbox.js';
import { triageStaleDropTypes } from '../src/limits.js';
import { producibleIn } from '../src/types/mailbox.js';

/**
 * P2 — legacy data must stay READABLE. No migration, no rewrite, no drop.
 *
 * Owner's constraint (2026-11-15): "不需要迁移数据。只需要保证旧数据能兼容读即可。"
 *
 * There are two kinds of rows already on disk that the current registry does not
 * describe:
 *   1. `heartbeat` — the type still exists but only `legacy` can produce it, so in
 *      the default `clock` channel no new row can arrive. Old rows must still read.
 *   2. types that were NEVER registered — observed in the live database as
 *      `task_assignment` (106 rows) and `a2a` (1 row). They route through
 *      `UNKNOWN_ROUTE`.
 *
 * The fallback's contract, which these tests pin: RUN, don't drop, don't throw.
 * `triageStaleDrop: false` is the part that matters — if an unregistered type were
 * droppable, the first triage pass would delete rows the runtime still needs, and
 * that loss is silent (no error, no red test, just a vanished signal).
 *
 * Why this deserves its own file rather than a line in an existing suite: the
 * fallback had ZERO test coverage before this. An untested compatibility path is a
 * promise nobody is holding — the next refactor of `routeMailboxItem` would break
 * live data with a green suite.
 */

const item = (sourceType: string, extra: Partial<MailboxItemLite> = {}): MailboxItemLite => ({
  sourceType,
  payload: {},
  ...extra,
} as MailboxItemLite);

describe('P2 — unregistered types are readable, never dropped', () => {
  it('an unregistered type routes without throwing (real rows: task_assignment, a2a)', () => {
    for (const legacyType of ['task_assignment', 'a2a', 'some_future_type_from_an_older_build']) {
      expect(() => routeMailboxItem(item(legacyType)), `${legacyType} must not throw`).not.toThrow();
    }
  });

  it('the fallback never loses work: it runs, and it is not droppable by age', () => {
    const route = routeMailboxItem(item('task_assignment'));
    // RUN, don't drop: the row still deserves a turn.
    expect(route.invokesLLM).toBe(true);
    // The load-bearing bit: a droppable unknown type would be silently deleted by
    // the first triage pass, and nothing would report it.
    expect(route.triageStaleDrop).toBe(false);
    // No per-round dedupe is invented for a type we know nothing about, because a
    // guessed dedupe key would silently merge two distinct signals into one.
    expect(route.dedupeKey).toBeUndefined();
  });

  it('an unregistered type keeps its own name in the route', () => {
    // The route must describe the ROW, not some normalised stand-in — otherwise
    // downstream logs and dashboards stop being able to name what arrived.
    expect(routeMailboxItem(item('a2a')).type).toBe('a2a');
  });
});

describe('P2 — a retired-but-readable type is still routable', () => {
  it('heartbeat routes normally even though the clock channel cannot produce it', () => {
    // Producibility and readability are different questions. H7 established that
    // `clock` cannot produce heartbeat; that must NOT make existing rows unreadable.
    expect(producibleIn('clock', 'heartbeat')).toBe(false);
    const route = routeMailboxItem(item('heartbeat'));
    expect(route.type).toBe('heartbeat');
    expect(route.invokesLLM).toBe(true);
  });

  it('readability does not leak into droppability: clock triage still excludes it', () => {
    // The two must stay independent. If readability implied droppability, the first
    // clock-mode triage would age out legacy heartbeat rows that legacy mode needs.
    expect(triageStaleDropTypes('clock')).not.toContain('heartbeat');
    expect(triageStaleDropTypes('legacy')).toContain('heartbeat');
  });
});
