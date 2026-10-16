import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../src/router.js';
import { FeishuAdapter } from '../src/feishu/adapter.js';
import { buildResolvedApprovalCard } from '../src/feishu/cards.js';
import type { CardResolution, CommAdapter, InboundAction } from '../src/adapter.js';

/**
 * The defect these guard: tapping an approval-card button produced *no visible
 * change*. An interactive card is a one-shot message — the platform never edits
 * it for us — so unless the gateway rewrites the card after the decision, the
 * tapper sees a card that looks untouched and reasonably concludes "it did
 * nothing". The decision was recorded; only the feedback was missing.
 */
describe('resolved approval card', () => {
  it('drops the action row and shows a status line instead', () => {
    const card = buildResolvedApprovalCard({
      title: 'Deploy to prod?',
      body: 'app v2 is ready',
      status: 'approved',
      actorId: 'ou_boss',
      at: '2026-10-13T11:33:25.123Z',
    });

    const elements = card['elements'] as Array<Record<string, unknown>>;
    // The buttons are gone — otherwise the card still invites a second tap.
    expect(elements.some((e) => e['tag'] === 'action')).toBe(false);

    const text = JSON.stringify(elements);
    expect(text).toContain('已批准');
    expect(text).toContain('ou_boss');
    expect(text).toContain('2026-10-13 11:33 UTC');
    // Header is colour-coded by outcome, not the request's blue.
    expect((card['header'] as Record<string, unknown>)['template']).toBe('green');
  });

  it('colours and labels each terminal status distinctly', () => {
    const header = (status: CardResolution['status']) => {
      const c = buildResolvedApprovalCard({ title: 't', body: 'b', status });
      return (c['header'] as Record<string, unknown>)['template'];
    };
    expect(header('approved')).toBe('green');
    expect(header('rejected')).toBe('red');
    expect(header('cancelled')).toBe('grey');
    expect(header('expired')).toBe('grey');
  });

  it('surfaces a named option, but not the plain approve/reject commands', () => {
    const named = JSON.stringify(
      buildResolvedApprovalCard({ title: 't', body: 'b', status: 'approved', selectedOption: 'deploy_now' }),
    );
    expect(named).toContain('deploy_now');

    const plain = JSON.stringify(
      buildResolvedApprovalCard({ title: 't', body: 'b', status: 'approved', selectedOption: 'approve' }),
    );
    expect(plain).not.toContain('选项');
  });

  it('names the actor: the resolved name when we have one, else a live reference', () => {
    const named = JSON.stringify(
      buildResolvedApprovalCard({ title: 't', body: 'b', status: 'approved', actorId: 'ou_boss', actorName: '老板' }),
    );
    expect(named).toContain('老板');
    // A resolved name is preferred: it reads the same and pings nobody.
    expect(named).not.toContain('ou_boss');

    // Without a resolved name the card must still not show an unreadable id —
    // it emits a person reference, which Feishu renders as the display name and
    // makes tappable, and which needs no contact-read scope.
    const fallback = JSON.stringify(
      buildResolvedApprovalCard({ title: 't', body: 'b', status: 'approved', actorId: 'ou_boss' }),
    );
    expect(fallback).toContain('<at id=ou_boss></at>');
  });

  it('refuses to emit a reference from an id that is not a plain platform id', () => {
    // The id is payload from the platform; markup must not be injectable through it.
    // Interpolating the raw string as a "safe fallback" was tried and *does* inject —
    // text inside a lark_md element is still markup.
    const card = JSON.stringify(
      buildResolvedApprovalCard({
        title: 't',
        body: 'b',
        status: 'approved',
        actorId: '"><at id=all></at>',
      }),
    );
    expect(card).not.toContain('<at id=all>');
    // Nothing legible to say about the actor ⇒ the line is omitted, not faked.
    expect(card).not.toContain('操作人');
  });

  it('does not let a display name inject card markup', () => {
    // Any tenant member can set their own display name, so the *resolved* name is
    // attacker-controlled too — `<at id=all></at>` as a name would mass-mention.
    const card = JSON.stringify(
      buildResolvedApprovalCard({
        title: 't',
        body: 'b',
        status: 'approved',
        actorId: 'ou_boss',
        actorName: '<at id=all></at>',
      }),
    );
    expect(card).not.toContain('<at id=all>');
    // It still names the actor — via the id reference, which is checked.
    expect(card).toContain('<at id=ou_boss></at>');
  });
});

describe('FeishuAdapter.updateResolvedCard', () => {
  it('rewrites the message in place via client.updateInteractiveMessage', async () => {
    const adapter = new FeishuAdapter();
    const updateInteractiveMessage = vi.fn().mockResolvedValue(undefined);
    (adapter as Record<string, unknown>)['client'] = { updateInteractiveMessage };

    await adapter.updateResolvedCard('om_card_1', {
      status: 'rejected',
      title: 'Deploy to prod?',
      body: 'app v2 is ready',
      actorId: 'ou_boss',
      at: '2026-10-13T11:33:25.000Z',
    });

    expect(updateInteractiveMessage).toHaveBeenCalledOnce();
    const [messageId, card] = updateInteractiveMessage.mock.calls[0]!;
    expect(messageId).toBe('om_card_1');
    expect((card as Record<string, unknown>)['header']).toMatchObject({ template: 'red' });
    expect(JSON.stringify(card)).toContain('已驳回');
  });

  it('throws when the adapter has no client (never silently drops the feedback)', async () => {
    const adapter = new FeishuAdapter();
    await expect(
      adapter.updateResolvedCard('om_card_1', { status: 'approved', title: 't', body: 'b' }),
    ).rejects.toThrow('not connected');
  });
});

describe('FeishuAdapter card action carries the message id', () => {
  it('reads open_message_id from context so the tap can be written back', async () => {
    const adapter = new FeishuAdapter();
    const seen: InboundAction[] = [];
    adapter.onAction((a) => {
      seen.push(a);
    });

    // The private inbound path, driven exactly as the SDK delivers it.
    await (
      adapter as unknown as { processCardAction(e: unknown): Promise<void> }
    ).processCardAction({
      context: { open_message_id: 'om_card_42' },
      operator: { open_id: 'ou_boss' },
      action: { value: { ref: 'apr_1', action: 'approve' } },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.messageId).toBe('om_card_42');
    expect(seen[0]!.actorId).toBe('ou_boss');
  });

  it('falls back to a top-level open_message_id (older card callbacks)', async () => {
    const adapter = new FeishuAdapter();
    const seen: InboundAction[] = [];
    adapter.onAction((a) => {
      seen.push(a);
    });

    await (
      adapter as unknown as { processCardAction(e: unknown): Promise<void> }
    ).processCardAction({
      open_message_id: 'om_legacy',
      operator: { open_id: 'ou_boss' },
      action: { value: { ref: 'apr_1', action: 'approve' } },
    });

    expect(seen[0]!.messageId).toBe('om_legacy');
  });
});

describe('MessageRouter.updateResolvedCard', () => {
  const resolution: CardResolution = { status: 'approved', title: 't', body: 'b' };

  function fakeAdapter(platform: string, updateResolvedCard?: CommAdapter['updateResolvedCard']) {
    return {
      platform,
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendMessage: vi.fn(),
      sendReply: vi.fn(),
      onMessage: vi.fn(),
      isConnected: () => true,
      updateResolvedCard,
    } as unknown as CommAdapter;
  }

  it('routes to the instance adapter that can edit messages', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter('default');
    router.registerAdapter(fakeAdapter('feishu', update), 'bi_feishu_x');

    expect(await router.updateResolvedCard('feishu', 'bi_feishu_x', 'om_1', resolution)).toBe(true);
    expect(update).toHaveBeenCalledWith('om_1', resolution);
  });

  it('reports false (never throws) when the platform cannot edit a sent message', async () => {
    const router = new MessageRouter('default');
    router.registerAdapter(fakeAdapter('sms'));

    expect(await router.updateResolvedCard('sms', undefined, 'om_1', resolution)).toBe(false);
  });

  it('reports false for an unknown platform', async () => {
    const router = new MessageRouter('default');
    expect(await router.updateResolvedCard('nope', undefined, 'om_1', resolution)).toBe(false);
  });
});

describe('MessageRouter.resolveActorName', () => {
  function fakeAdapter(platform: string, resolveActorName?: CommAdapter['resolveActorName']) {
    return {
      platform,
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendMessage: vi.fn(),
      sendReply: vi.fn(),
      onMessage: vi.fn(),
      isConnected: () => true,
      resolveActorName,
    } as unknown as CommAdapter;
  }

  it('routes to the instance adapter and returns the name', async () => {
    const resolve = vi.fn().mockResolvedValue('老板');
    const router = new MessageRouter('default');
    router.registerAdapter(fakeAdapter('feishu', resolve), 'bi_feishu_x');

    expect(await router.resolveActorName('feishu', 'bi_feishu_x', 'ou_boss')).toBe('老板');
    expect(resolve).toHaveBeenCalledWith('ou_boss');
  });

  it('returns null (never throws) when the adapter cannot resolve names', async () => {
    const router = new MessageRouter('default');
    router.registerAdapter(fakeAdapter('sms'));

    expect(await router.resolveActorName('sms', undefined, 'ou_boss')).toBeNull();
  });

  it('returns null for an empty actor id without touching any adapter', async () => {
    const resolve = vi.fn();
    const router = new MessageRouter('default');
    router.registerAdapter(fakeAdapter('feishu', resolve), 'bi_feishu_x');

    expect(await router.resolveActorName('feishu', 'bi_feishu_x', '')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('asks the platform’s only bot when the action names no instance', async () => {
    const resolve = vi.fn().mockResolvedValue('老板');
    const router = new MessageRouter('default');
    router.registerAdapter(fakeAdapter('feishu', resolve), 'bi_feishu_only');

    expect(await router.resolveActorName('feishu', undefined, 'ou_boss')).toBe('老板');
    expect(resolve).toHaveBeenCalledWith('ou_boss');
  });

  it('refuses to guess when the platform hosts several bots', async () => {
    // An actor id is scoped to the app that issued it — a Feishu `open_id` asked of
    // a *different* app fails with `99992361 open_id cross app` (observed live on a
    // two-bot org). Asking an arbitrary bot would therefore return nothing while
    // looking like a successful lookup, so the honest answer is "I cannot know".
    const resolveA = vi.fn().mockResolvedValue('老板');
    const resolveB = vi.fn().mockResolvedValue('老板');
    const router = new MessageRouter('default');
    router.registerAdapter(fakeAdapter('feishu', resolveA), 'bi_feishu_1');
    router.registerAdapter(fakeAdapter('feishu', resolveB), 'bi_feishu_2');

    expect(await router.resolveActorName('feishu', undefined, 'ou_boss')).toBeNull();
    expect(resolveA).not.toHaveBeenCalled();
    expect(resolveB).not.toHaveBeenCalled();
  });

  it('still resolves by explicit instance when several bots share a platform', async () => {
    const resolveA = vi.fn().mockResolvedValue('老板');
    const resolveB = vi.fn().mockResolvedValue('CTO');
    const router = new MessageRouter('default');
    router.registerAdapter(fakeAdapter('feishu', resolveA), 'bi_feishu_1');
    router.registerAdapter(fakeAdapter('feishu', resolveB), 'bi_feishu_2');

    expect(await router.resolveActorName('feishu', 'bi_feishu_2', 'ou_other')).toBe('CTO');
    expect(resolveA).not.toHaveBeenCalled();
  });
});
