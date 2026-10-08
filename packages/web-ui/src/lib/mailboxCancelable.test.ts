/**
 * Mailbox item "cancellable" derivation — single source of truth for whether
 * the ✕ 取消 button should render in 「运行与注意力」.
 *
 * Defect this fixes (docs/records/message-stop-cancel-fix-plan.md §2.3b):
 * the button used to render whenever `item.status === 'processing'`, but core
 * cancel-processing is a no-op unless the item is ACTUALLY in-flight (current
 * focus of the attention loop). After stop/resend or a restart the DB row can
 * stay `processing` while the agent is idle → the button rendered but did
 * nothing on click ("取消按钮无效").
 *
 * Pure-function tests only — this package has no jsdom / @testing-library/react.
 */
import { describe, it, expect } from 'vitest';
import { canCancelMailboxItem } from './mailboxCancelable.ts';

describe('canCancelMailboxItem', () => {
  const base = {
    agentRunning: true,
    itemId: 'mbx_A',
    currentFocusId: 'mbx_A',
    itemStatus: 'processing',
  };

  it('agent running + item is current focus + processing → cancellable', () => {
    expect(canCancelMailboxItem(base)).toBe(true);
  });

  it('【根因】stale processing：agent 空闲但 DB 行仍 processing → 不可取消', () => {
    // stop/resend 或重启后，条目卡在 processing 但 attention 已 idle（无 currentFocus）
    expect(canCancelMailboxItem({ ...base, currentFocusId: null })).toBe(false);
    // 或当前 focus 是别的条目
    expect(canCancelMailboxItem({ ...base, currentFocusId: 'mbx_OTHER' })).toBe(false);
  });

  it('agent 已停止 → 任何条目都不可取消（注意力循环不存在）', () => {
    expect(canCancelMailboxItem({ ...base, agentRunning: false })).toBe(false);
    expect(canCancelMailboxItem({ ...base, agentRunning: false, currentFocusId: null })).toBe(false);
  });

  it('非 processing 状态 → 不可取消', () => {
    for (const st of ['queued', 'completed', 'dropped', 'deferred', 'merged', 'failed']) {
      expect(canCancelMailboxItem({ ...base, itemStatus: st })).toBe(false);
    }
  });

  it('有在途流（=currentFocus）但状态非 processing → 不可取消（focus 是运行态，不以它反推 DB 状态）', () => {
    expect(canCancelMailboxItem({ ...base, itemStatus: 'completed' })).toBe(false);
  });
});