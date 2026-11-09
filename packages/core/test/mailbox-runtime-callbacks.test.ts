import { describe, it, expect, vi } from 'vitest';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import type { MailboxItemMetadata } from '@markus/shared';

const A = 'rt-agent';
function makeMailbox() { return new AgentMailbox(A, new EventBus()); }

describe('runtime callbacks live outside the persisted payload type', () => {
  it('enqueue attaches runtime.responsePromise and it is usable in-process', () => {
    const mailbox = makeMailbox();
    const resolve = vi.fn();
    const item = mailbox.enqueue('human_chat', { summary: 's', content: 'c' }, {
      metadata: { senderId: 'u1' },
      runtime: { responsePromise: { resolve, reject: vi.fn() } },
    });
    expect(typeof item.runtime?.responsePromise?.resolve).toBe('function');
    item.runtime!.responsePromise!.resolve('hi');
    expect(resolve).toHaveBeenCalledWith('hi');
  });

  it('the persisted surface {payload, metadata} never carries the callback', () => {
    const mailbox = makeMailbox();
    const item = mailbox.enqueue('human_chat', { summary: 's', content: 'c' }, {
      runtime: { responsePromise: { resolve: vi.fn(), reject: vi.fn() } },
    });
    const persisted = JSON.stringify({ payload: item.payload, metadata: item.metadata ?? {} });
    expect(persisted).not.toContain('responsePromise');
    const reloaded = JSON.parse(persisted) as { metadata: Record<string, unknown> };
    expect(reloaded.metadata.responsePromise).toBeUndefined();
    expect(Object.values(item.metadata ?? {}).some(v => typeof v === 'function')).toBe(false);
  });

  it('compile-time guard: MailboxItemMetadata cannot hold a function', () => {
    const ok: MailboxItemMetadata = { senderId: 'u1' };
    // @ts-expect-error responsePromise is runtime-only and must not be a persisted-metadata field
    const bad: MailboxItemMetadata = { responsePromise: { resolve: () => {}, reject: () => {} } };
    expect(ok.senderId).toBe('u1');
    expect(bad).toBeTruthy();
  });
});
