/**
 * Resolving "who tapped this card" to a name — and the two ways it used to fail
 * silently on a live org (2026-10-16).
 *
 * Probing the real contact API with the configured apps showed two distinct
 * outcomes, and the code handled both the same way: it printed the operator's
 * `open_id` on the card.
 *
 *   1. `default` app → `code: 0, msg: "success"`, item `{ mobile_visible, open_id,
 *      union_id }` — **no `name` field at all**. Feishu reports success and simply
 *      omits the field when the app lacks `contact:user.base:readonly` (or the user
 *      is outside its contact visibility range). The old code read that as "no name"
 *      and fell back to the id.
 *   2. the old code then **cached that miss permanently**, so granting the scope
 *      changed nothing until the process restarted.
 *
 * The card now renders a live person reference when there is no name (see
 * `cards.ts`), so the id is never shown. These tests pin the second half: a miss is
 * not a fact worth remembering.
 */
import { describe, it, expect, vi } from 'vitest';
import { FeishuAdapter } from '../src/feishu/adapter.js';

function adapterWith(client: Record<string, unknown>): FeishuAdapter {
  const adapter = new FeishuAdapter();
  (adapter as Record<string, unknown>)['client'] = client;
  return adapter;
}

describe('FeishuAdapter.resolveActorName', () => {
  it('caches a hit — a name is stable, so one lookup is enough', async () => {
    const getUserNames = vi.fn().mockResolvedValue(new Map([['ou_1', '老板']]));
    const adapter = adapterWith({ getUserNames });

    expect(await adapter.resolveActorName('ou_1')).toBe('老板');
    expect(await adapter.resolveActorName('ou_1')).toBe('老板');
    expect(getUserNames).toHaveBeenCalledTimes(1);
  });

  it('does not cache a miss, so granting the contact scope takes effect without a restart', async () => {
    // First lookup: the app cannot read names (scope missing) → empty map.
    const getUserNames = vi
      .fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([['ou_1', '老板']]));
    const adapter = adapterWith({ getUserNames });

    expect(await adapter.resolveActorName('ou_1')).toBeNull();
    // Second lookup — the scope is now granted. A cached miss would still say null.
    expect(await adapter.resolveActorName('ou_1')).toBe('老板');
    expect(getUserNames).toHaveBeenCalledTimes(2);
  });

  it('does not cache a transport failure either', async () => {
    const getUserNames = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Map([['ou_1', '老板']]));
    const adapter = adapterWith({ getUserNames });

    expect(await adapter.resolveActorName('ou_1')).toBeNull();
    expect(await adapter.resolveActorName('ou_1')).toBe('老板');
  });

  it('degrades to null without a client instead of throwing into the card rewrite', async () => {
    const adapter = new FeishuAdapter();
    expect(await adapter.resolveActorName('ou_1')).toBeNull();
  });

  it('returns null for an empty id without calling the platform', async () => {
    const getUserNames = vi.fn();
    const adapter = adapterWith({ getUserNames });
    expect(await adapter.resolveActorName('')).toBeNull();
    expect(getUserNames).not.toHaveBeenCalled();
  });
});
