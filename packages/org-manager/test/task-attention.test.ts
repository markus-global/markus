import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CommentDigest,
  isTerminalTaskStatus,
  resolveCommentAttention,
} from '../src/task-attention.js';

/**
 * Regression suite for the 2026-10-17 comment-storm review.
 *
 * Before this decision function existed, "does this comment wake someone?" was
 * answered in three different places and every one of them said YES:
 *   - postTaskComment fanned out to assignee + creator,
 *   - injectCommentIntoRunningTask live-injected each comment into the running
 *     session with "IMPORTANT: address this comment",
 *   - handlePostTaskComment started a whole new LLM turn on closed cards.
 *
 * Measured on one project: 128 agent comments / 0 human comments in a day,
 * avg 2870 chars each, and 60% of wakes ended in `end_turn` after paying for a
 * full context read (two of them 28 and 59 tool calls).
 */
describe('resolveCommentAttention — the single "does this wake anyone?" decision', () => {
  const base = {
    authorId: 'agent-db',
    authorType: 'agent' as const,
    mentions: [] as string[],
    taskStatus: 'in_progress',
    assignedAgentId: 'agent-be',
    createdBy: 'agent-lead',
    reviewerId: 'agent-reviewer',
  };

  it('wakes nobody for a plain agent-to-agent comment (the storm case)', () => {
    const result = resolveCommentAttention({ ...base });
    expect(result.recordOnly).toBe(true);
    expect(result.wake).toHaveLength(0);
  });

  it('wakes the mentioned agent even on a closed card', () => {
    const result = resolveCommentAttention({
      ...base,
      taskStatus: 'completed',
      mentions: ['agent-be'],
    });
    expect(result.reason).toBe('mention');
    expect(result.recordOnly).toBe(false);
    expect(result.wake).toEqual([{ agentId: 'agent-be', reason: 'mention' }]);
  });

  it('never wakes the author through a self-mention', () => {
    const result = resolveCommentAttention({ ...base, mentions: ['agent-db'] });
    expect(result.recordOnly).toBe(true);
  });

  it('a human comment wakes the assignee and the creator', () => {
    const result = resolveCommentAttention({ ...base, authorId: 'user-1', authorType: 'human' });
    expect(result.reason).toBe('human_author');
    expect(result.wake.map(t => t.agentId).sort()).toEqual(['agent-be', 'agent-lead']);
  });

  it('a reviewer verdict during review wakes the assignee', () => {
    const result = resolveCommentAttention({
      ...base,
      authorId: 'agent-reviewer',
      taskStatus: 'review',
    });
    expect(result.reason).toBe('review_verdict');
    expect(result.wake).toEqual([{ agentId: 'agent-be', reason: 'review_verdict' }]);
  });

  it('a non-reviewer comment during review stays record-only', () => {
    const result = resolveCommentAttention({ ...base, taskStatus: 'review' });
    expect(result.recordOnly).toBe(true);
  });

  it('a decision_record never fans out — another channel owns its delivery', () => {
    const result = resolveCommentAttention({
      ...base,
      mentions: ['agent-be'], // even with an explicit mention
      commentKind: 'decision_record',
    });
    expect(result.recordOnly).toBe(true);
    expect(result.wake).toHaveLength(0);
  });

  it('classifies terminal statuses', () => {
    expect(isTerminalTaskStatus('completed')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('in_progress')).toBe(false);
    expect(isTerminalTaskStatus(undefined)).toBe(false);
  });
});

describe('CommentDigest — coalescing, never per-comment', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const item = (n: number) => ({
    commentId: `tc_${n}`,
    authorName: `agent-${n}`,
    content: `comment body ${n}`,
  });

  it('batches every comment in one window into ONE message', () => {
    const digest = new CommentDigest({ windowMs: 1000 });
    const flush = vi.fn();
    for (let i = 0; i < 5; i++) digest.enqueue('sess-1', item(i), flush);

    expect(digest.pending('sess-1')).toBe(5);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(flush).toHaveBeenCalledTimes(1);
    const [message, items] = flush.mock.calls[0];
    expect(items).toHaveLength(5);
    expect(message).toContain('5 new comments were recorded');
    expect(digest.pending('sess-1')).toBe(0);
    digest.dispose();
  });

  it('renders a NON-directive message (the interrupted-work bug)', () => {
    const digest = new CommentDigest({ windowMs: 1000 });
    const flush = vi.fn();
    digest.enqueue('sess-1', item(1), flush);
    vi.advanceTimersByTime(1000);

    const message = flush.mock.calls[0][0] as string;
    expect(message).toContain('RECORD, not a request');
    expect(message).not.toContain('IMPORTANT: Address this comment in your current work');
    expect(message).toContain('task_get');
    digest.dispose();
  });

  it('caps a flush and keeps the remainder queued', () => {
    const digest = new CommentDigest({ windowMs: 1000, maxItems: 3 });
    const flush = vi.fn();
    for (let i = 0; i < 5; i++) digest.enqueue('sess-1', item(i), flush);
    vi.advanceTimersByTime(1000);

    expect(flush.mock.calls[0][1]).toHaveLength(3);
    expect(digest.pending('sess-1')).toBe(2);

    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1][1]).toHaveLength(2);
    digest.dispose();
  });

  it('truncates long comments but points at the full thread', () => {
    const digest = new CommentDigest({ windowMs: 1000, excerptChars: 10 });
    const flush = vi.fn();
    digest.enqueue('sess-1', { commentId: 'tc_x', authorName: 'a', content: 'x'.repeat(500) }, flush);
    vi.advanceTimersByTime(1000);

    const message = flush.mock.calls[0][0] as string;
    expect(message).toContain('[truncated — full text in the thread]');
    digest.dispose();
  });

  it('keeps sessions independent', () => {
    const digest = new CommentDigest({ windowMs: 1000, maxItems: 10 });
    const flushA = vi.fn();
    const flushB = vi.fn();
    digest.enqueue('sess-a', item(1), flushA);
    digest.enqueue('sess-b', item(2), flushB);
    vi.advanceTimersByTime(1000);

    expect(flushA).toHaveBeenCalledTimes(1);
    expect(flushB).toHaveBeenCalledTimes(1);
    expect(flushA.mock.calls[0][1]).toHaveLength(1);
    expect(flushB.mock.calls[0][1]).toHaveLength(1);
    digest.dispose();
  });
});
