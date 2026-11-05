/**
 * Task attention economy — the single execution point that answers
 * "does this comment wake someone up?".
 *
 * Why this file exists (2026-10-17 ITM/Anteum review):
 * the platform used to answer that question in three different places
 * (mailbox fan-out in `postTaskComment`, live injection in
 * `injectCommentIntoRunningTask`, post-task turns in `handlePostTaskComment`),
 * and every one of them treated "someone wrote a comment" as "you are needed".
 * 60% of wakes ended in `end_turn` — pure noise at ~113k input tokens each.
 *
 * The invariant, stated once:
 *
 *   A comment wakes an agent ONLY IF it names that agent (mention), or it
 *   changes a state that agent must know about (human author, or a reviewer
 *   verdict during review). Everything else is a RECORD — it stays in the
 *   thread and wakes nobody.
 *
 * Separately, and even stricter: a comment is only ever injected INTO a running
 * agent session if a HUMAN wrote it. Agents never interrupt agents — an agent's
 * comment never enters another agent's context while that agent is working.
 */

import { isTerminal } from '@markus/shared';

export type CommentAuthorType = 'agent' | 'human';

export interface CommentAttentionInput {
  /** Author of the comment. */
  authorId: string;
  authorType: CommentAuthorType;
  /** Explicitly addressed agent/user ids. */
  mentions?: string[];
  /** Task status at the moment the comment is posted. */
  taskStatus: string;
  assignedAgentId?: string;
  createdBy?: string;
  reviewerId?: string;
  /**
   * `decision_record` = the delivery of this comment is owned by another
   * channel (status transition), so the comment channel must not fan out.
   */
  commentKind?: string;
}

export type WakeReason = 'mention' | 'human_author' | 'review_verdict' | 'record_only';

export interface WakeTarget {
  agentId: string;
  reason: Exclude<WakeReason, 'record_only'>;
}

export interface CommentAttentionDecision {
  /** Agents to wake immediately. Empty ⇒ record-only. */
  wake: WakeTarget[];
  /** True when nobody is woken and the comment is pure record. */
  recordOnly: boolean;
  reason: WakeReason;
}

/**
 * 终态判定的唯一入口是 `@markus/shared#isTerminal` —— 本函数只是它在本模块里的名字。
 *
 * 这里曾经有一份私有字面量，其中包含一个 FSM 里根本不存在的 `'accepted'`：它咬不到
 * 任何真实状态（于是既不保护什么），又让人误以为「这里已经判过终态了」。
 * 保留函数名是为了让调用方（`task-service.ts` 的注释注入分派）和测试继续用同一个
 * 词表述意图，而不是让每个调用方去重新拼一个集合。
 */
export function isTerminalTaskStatus(status: string | undefined): boolean {
  return isTerminal(status);
}

/**
 * Decide who (if anyone) must be woken by this comment.
 *
 * Precedence matters:
 *  1. A decision record never fans out — its delivery is another channel's job.
 *  2. Mentions always wake (explicit addressing is the cheapest signal we have).
 *  3. Human authors wake the card's owner-side agents (humans write rarely, so
 *     the signal is high-value).
 *  4. A reviewer posting while the card is in `review` wakes the assignee
 *     (this is a revision verdict).
 *  5. Everything else — including the 2026-10-17 storm case of one agent
 *     posting a long correction on another agent's card — is record-only.
 */
export function resolveCommentAttention(input: CommentAttentionInput): CommentAttentionDecision {
  const mentions = (input.mentions ?? []).filter(id => !!id && id !== input.authorId);

  if (input.commentKind === 'decision_record') {
    return { wake: [], recordOnly: true, reason: 'record_only' };
  }

  if (mentions.length > 0) {
    return {
      wake: mentions.map(agentId => ({ agentId, reason: 'mention' as const })),
      recordOnly: false,
      reason: 'mention',
    };
  }

  const { assignedAgentId, createdBy } = input;

  if (input.authorType === 'human') {
    const targets: WakeTarget[] = [];
    if (assignedAgentId && assignedAgentId !== input.authorId) {
      targets.push({ agentId: assignedAgentId, reason: 'human_author' });
    }
    if (createdBy && createdBy !== input.authorId && createdBy !== assignedAgentId) {
      targets.push({ agentId: createdBy, reason: 'human_author' });
    }
    if (targets.length > 0) {
      return { wake: targets, recordOnly: false, reason: 'human_author' };
    }
  }

  if (input.taskStatus === 'review' && input.reviewerId && input.reviewerId === input.authorId && assignedAgentId) {
    return {
      wake: [{ agentId: assignedAgentId, reason: 'review_verdict' }],
      recordOnly: false,
      reason: 'review_verdict',
    };
  }

  return { wake: [], recordOnly: true, reason: 'record_only' };
}

/**
 * Does this comment belong in a running agent's session?
 *
 * Humans, yes — a person talking to a working agent is the one interruption
 * worth taking. Agents, no — an agent's comment stays in the thread and wakes
 * nobody's context. No buffering, no coalescing, no truncation: it simply does
 * not enter the session.
 */
export function shouldInjectIntoSession(authorType: CommentAuthorType): boolean {
  return authorType === 'human';
}
