/**
 * mailbox 行展示状态派生 —— 展示以在途流为权威（docs/records/message-stop-cancel-fix-plan.md §2.6 H2/2d）。
 * Pure-function tests only —— 本包无 jsdom。
 */
import { describe, it, expect } from 'vitest';
import { deriveMailboxRowDisplayStatus } from './mailboxRowDisplay.ts';

describe('deriveMailboxRowDisplayStatus — 「处理中」展示以在途流为权威', () => {
  it('DB processing ∧ 且就是 currentFocus ∧ agent 在跑 → 活动「处理中」', () => {
    expect(deriveMailboxRowDisplayStatus({
      itemStatus: 'processing', agentRunning: true, currentFocusMailboxItemId: 'mbx_1', itemId: 'mbx_1',
    })).toBe('processing');
  });

  it('DB processing 但当前 focus 是另一条 → stale（不再谎称在处理）', () => {
    expect(deriveMailboxRowDisplayStatus({
      itemStatus: 'processing', agentRunning: true, currentFocusMailboxItemId: 'mbx_9', itemId: 'mbx_1',
    })).toBe('stale');
  });

  it('DB processing 但 agent 已停止 → stale（没有 loop 在跑）', () => {
    expect(deriveMailboxRowDisplayStatus({
      itemStatus: 'processing', agentRunning: false, currentFocusMailboxItemId: 'mbx_1', itemId: 'mbx_1',
    })).toBe('stale');
  });

  it('DB processing 但无任何 focus（idle 且刚停止/崩溃） → stale', () => {
    expect(deriveMailboxRowDisplayStatus({
      itemStatus: 'processing', agentRunning: true, currentFocusMailboxItemId: null, itemId: 'mbx_1',
    })).toBe('stale');
  });

  it('非 processing 状态原样透传（completed/queued/dropped…）', () => {
    for (const s of ['completed', 'queued', 'dropped', 'deferred', 'merged']) {
      expect(deriveMailboxRowDisplayStatus({
        itemStatus: s, agentRunning: true, currentFocusMailboxItemId: 'mbx_1', itemId: 'mbx_1',
      })).toBe(s);
    }
  });
});