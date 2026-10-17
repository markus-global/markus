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
 *   verdict during review). Everything else is a RECORD, delivered in a
 *   coalesced digest the next time the agent wakes for another reason.
 */

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

const TERMINAL_STATUSES = new Set(['completed', 'accepted', 'archived', 'failed', 'rejected', 'cancelled']);

export function isTerminalTaskStatus(status: string | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status);
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

// ─── Coalesced digest ────────────────────────────────────────────────────────

export interface DigestItem {
  commentId: string;
  authorName: string;
  content: string;
  createdAt?: string;
}

export interface CommentDigestOptions {
  /** Accumulation window. All items queued inside one window become ONE message. */
  windowMs?: number;
  /** Hard cap per flush — the oldest items beyond this stay queued for the next window. */
  maxItems?: number;
  /** Per-item excerpt length. */
  excerptChars?: number;
}

export const COMMENT_DIGEST_WINDOW_MS = 60_000;
export const COMMENT_DIGEST_MAX_ITEMS = 10;
export const COMMENT_DIGEST_EXCERPT_CHARS = 400;

interface DigestBucket {
  items: DigestItem[];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Per-session coalescing buffer for record-only comments.
 *
 * Design notes:
 *  - Buffer is in-process memory on purpose: these are non-directive records,
 *    the canonical thread lives in `task_comments`; losing an unflushed FYI on
 *    crash costs nothing (the agent can always `task_get`).
 *  - One flush per window per session, regardless of how many comments arrive.
 *  - The rendered message is explicitly NON-directive. The old "IMPORTANT:
 *    address this comment in your current work" framing is what turned a
 *    correction into an interruption.
 */
export class CommentDigest {
  private readonly buckets = new Map<string, DigestBucket>();
  private readonly windowMs: number;
  private readonly maxItems: number;
  private readonly excerptChars: number;

  constructor(opts: CommentDigestOptions = {}) {
    this.windowMs = opts.windowMs ?? COMMENT_DIGEST_WINDOW_MS;
    this.maxItems = opts.maxItems ?? COMMENT_DIGEST_MAX_ITEMS;
    this.excerptChars = opts.excerptChars ?? COMMENT_DIGEST_EXCERPT_CHARS;
  }

  /** Queue one item. `flush` receives the rendered message + the items it covered. */
  enqueue(key: string, item: DigestItem, flush: (message: string, items: DigestItem[]) => void): void {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { items: [], timer: null };
      this.buckets.set(key, bucket);
    }
    bucket.items.push(item);

    if (bucket.timer) return;
    bucket.timer = setTimeout(() => {
      const b = this.buckets.get(key);
      if (b) b.timer = null;
      this.flush(key, flush);
    }, this.windowMs);
    // Do not keep the process alive just to deliver an FYI digest.
    (bucket.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Flush immediately (used on turn boundaries / shutdown). */
  flush(key: string, flush: (message: string, items: DigestItem[]) => void): void {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.items.length === 0) return;
    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }
    const items = bucket.items.splice(0, this.maxItems);
    if (bucket.items.length === 0) {
      this.buckets.delete(key);
    } else {
      // Capped flush: keep the remainder moving. Without this the overflow would
      // sit undelivered until some unrelated comment happened to arrive.
      bucket.timer = setTimeout(() => {
        const b = this.buckets.get(key);
        if (b) b.timer = null;
        this.flush(key, flush);
      }, this.windowMs);
      (bucket.timer as unknown as { unref?: () => void }).unref?.();
    }
    const message = this.render(items);
    flush(message, items);
  }

  /** Pending item count for a key (test/diagnostic aid). */
  pending(key: string): number {
    return this.buckets.get(key)?.items.length ?? 0;
  }

  /** Drop all buffered items and timers. */
  dispose(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.timer) clearTimeout(bucket.timer);
    }
    this.buckets.clear();
  }

  render(items: DigestItem[]): string {
    const lines: string[] = [];
    lines.push(
      items.length === 1
        ? '**1 new comment was recorded on your task while you were working.**'
        : `**${items.length} new comments were recorded on your task while you were working.**`,
    );
    lines.push('');
    lines.push('This is a RECORD, not a request. Nobody is waiting on a reply.');
    lines.push('Read it only if it touches what you are doing; otherwise keep working.');
    lines.push('');
    for (const item of items) {
      const body = item.content.length > this.excerptChars
        ? `${item.content.slice(0, this.excerptChars)}… [truncated — full text in the thread]`
        : item.content;
      lines.push(`--- ${item.authorName}${item.commentId ? ` (${item.commentId})` : ''} ---`);
      lines.push(body);
      lines.push('');
    }
    lines.push('The full thread is in `task_get`. If a comment asks you a direct question, answer it with `task_comment`; otherwise no action is required.');
    return lines.join('\n');
  }
}
