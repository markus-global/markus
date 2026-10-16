/**
 * Mailbox recovery — the instance ownerId must reach the persistence layer.
 *
 * Root cause this locks down (2026-10-15): a process restart left a killed worker's
 * in-flight `mailbox_items` row stuck in `processing` (its lease had not expired yet),
 * because recovery "respected" the still-valid lease. `recoverStaleItems()` now hands the
 * persistence layer its own `ownerId`, so a claim owned by ANY other instance counts as
 * stale. This test pins that the argument is actually threaded through.
 */
import { describe, it, expect } from 'vitest';
import { AgentMailbox, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

describe('recoverStaleItems → markStaleProcessingAsDropped carries the instance ownerId', () => {
  it('passes (agentId, undefined, thisOwnerId)', () => {
    const calls: Array<{ agentId: string; nowIso?: string; ownerId?: string }> = [];
    const persistence = {
      markStaleProcessingAsDropped: (agentId: string, nowIso?: string, ownerId?: string) => {
        calls.push({ agentId, nowIso, ownerId });
        return 0;
      },
    } as unknown as MailboxPersistence;

    const mailbox = new AgentMailbox('agt_owner_test', new EventBus(), persistence);
    mailbox.recoverStaleItems();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe('agt_owner_test');
    expect(calls[0]!.ownerId).toBe(mailbox.getOwnerId());
    expect(calls[0]!.ownerId).toContain('agt_owner_test#');
  });

  it('cleanStaleProcessing carries the ownerId too (runtime watchdog path)', () => {
    const calls: string[] = [];
    const persistence = {
      markStaleProcessingAsDropped: (_agentId: string, _nowIso?: string, ownerId?: string) => {
        calls.push(ownerId ?? '<none>');
        return 0;
      },
    } as unknown as MailboxPersistence;

    const mailbox = new AgentMailbox('agt_owner_test', new EventBus(), persistence);
    mailbox.cleanStaleProcessing();
    expect(calls).toEqual([mailbox.getOwnerId()]);
  });
});
