/**
 * Approval buttons must be written in the **recipient's** language.
 *
 * Reported (2026-10-16): a Chinese owner received a Feishu review card whose
 * buttons read "Approve" / "Request Changes". The gate had baked English
 * literals, while the dispatcher's fallback was a *different* hardcoded Chinese
 * pair — so neither surface owned the wording and no locale could change it.
 *
 * The rule now: a gate declares the **direction** of a choice (structure) and the
 * renderer owns the label (display). Without a direction the author's label is
 * passed through verbatim — an LLM-authored option has arbitrary ids and must
 * never be reinterpreted.
 */
import { describe, it, expect } from 'vitest';
import { OutboundDispatcher, notificationToOutbound } from '../src/gateway/dispatcher.js';
import type { OutboundSink } from '../src/gateway/dispatcher.js';
import type { NotifyTarget, NotifyTargetLookup } from '../src/gateway/notify-route.js';

const TARGET: NotifyTarget = { platform: 'feishu', instanceId: 'bi_1', nativeId: 'oc_1' };

const lookup: NotifyTargetLookup = { candidates: () => [{ target: TARGET, scope: 'global' }] };

function sinkRecorder(): OutboundSink & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    capabilities: () => ({ markdown: true }),
    send: async (_t, rendered) => {
      texts.push(rendered.text);
      return 'm1';
    },
  };
}

const reviewOptions = [
  { id: 'approve', label: 'Approve', direction: 'approve' },
  { id: 'reject', label: 'Request Changes', direction: 'request_changes' },
];

describe('approval button labels are localized from the declared direction', () => {
  it('writes the review gate’s buttons in Chinese for a zh recipient', () => {
    const msg = notificationToOutbound(
      { title: '待审核', body: 'b', metadata: { approvalId: 'apr_1', options: reviewOptions } },
      undefined,
      'zh-CN',
    );
    expect(msg.actions!.map(a => a.label)).toEqual(['批准', '要求修改']);
  });

  it('writes them in English for an en recipient — same gate, same options', () => {
    const msg = notificationToOutbound(
      { title: 'Review', body: 'b', metadata: { approvalId: 'apr_1', options: reviewOptions } },
      undefined,
      'en',
    );
    expect(msg.actions!.map(a => a.label)).toEqual(['Approve', 'Request Changes']);
  });

  /**
   * 打回 is not a rejection. The review gate's second choice carries the legacy
   * id `reject` but means request-changes, so it must not be painted as the
   * destructive action.
   */
  it('styles request-changes as neutral, not as the destructive choice', () => {
    const msg = notificationToOutbound(
      { title: 't', body: 'b', metadata: { approvalId: 'apr_1', options: reviewOptions } },
      undefined,
      'zh-CN',
    );
    expect(msg.actions!.find(a => a.id === 'approve')!.style).toBe('primary');
    expect(msg.actions!.find(a => a.id === 'reject')!.style).toBe('default');
  });

  it('passes an option with no direction through verbatim (LLM-authored choice)', () => {
    const msg = notificationToOutbound({
      title: 't',
      body: 'b',
      metadata: { approvalId: 'apr_1', options: [{ id: 'deploy', label: '部署到生产' }] },
    });
    expect(msg.actions!.map(a => a.label)).toEqual(['部署到生产']);
  });

  /**
   * The option-less fallback used to be a hardcoded Chinese pair, which is why an
   * English recipient saw Chinese buttons. It is a direction like any other.
   */
  it('localizes the option-less fallback too', () => {
    expect(
      notificationToOutbound({ title: 't', body: 'b', metadata: { approvalId: 'apr_1' } }, undefined, 'en')
        .actions!.map(a => a.label),
    ).toEqual(['Approve', 'Reject']);
    expect(
      notificationToOutbound({ title: 't', body: 'b', metadata: { approvalId: 'apr_1' } }, undefined, 'zh-CN')
        .actions!.map(a => a.label),
    ).toEqual(['批准', '拒绝']);
  });

  it('defaults to English when the composition root knows no locale', () => {
    const msg = notificationToOutbound({
      title: 't',
      body: 'b',
      metadata: { approvalId: 'apr_1', options: reviewOptions },
    });
    expect(msg.actions!.map(a => a.label)).toEqual(['Approve', 'Request Changes']);
  });

  /** The locale is read per delivery, so a later preference change takes effect. */
  it('re-reads the locale on every notification', async () => {
    const sink = sinkRecorder();
    let locale = 'en';
    const dispatcher = new OutboundDispatcher({ lookup, sink, locale: () => locale });

    let handler: ((n: unknown) => void) | undefined;
    dispatcher.attachNotifications({
      onChannelNotification: (cb) => {
        handler = cb as (n: unknown) => void;
        return () => {};
      },
    });

    handler!({ title: 't', body: 'b', metadata: { approvalId: 'apr_1', options: reviewOptions } });
    await new Promise(r => setTimeout(r, 0));
    expect(sink.texts[0]).toContain('Request Changes');

    locale = 'zh-CN';
    handler!({ title: 't', body: 'b', metadata: { approvalId: 'apr_2', options: reviewOptions } });
    await new Promise(r => setTimeout(r, 0));
    expect(sink.texts[1]).toContain('要求修改');
    expect(sink.texts[1]).not.toContain('Request Changes');
  });
});
