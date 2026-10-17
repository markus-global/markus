import { describe, it, expect } from 'vitest';
import {
  isTerminalTaskStatus,
  resolveCommentAttention,
  shouldInjectIntoSession,
} from '../src/task-attention.js';

/**
 * Regression suite for the 2026-10-17 comment-storm review.
 *
 * Before this decision function existed, "does this comment wake someone?" was
 * answered in three different places and every one of them said YES:
 *   - postTaskComment fanned out to assignee + creator,
 *   - injectCommentIntoRunningTask injected every comment into the running
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

describe('shouldInjectIntoSession — only a human enters a running session', () => {
  it('injects a human comment', () => {
    expect(shouldInjectIntoSession('human')).toBe(true);
  });

  it('never injects an agent comment — no buffering, no coalescing, no truncation', () => {
    expect(shouldInjectIntoSession('agent')).toBe(false);
  });
});
