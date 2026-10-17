/**
 * Lean view of a persisted chat message.
 *
 * Chat history rows store the FULL execution trace in `metadata.segments`
 * (thinking, tool arguments, complete tool results). Measured on a real
 * production DB: 13.5k messages carried 6.9 MB of prose but **304 MB** of
 * metadata (44x) — 126 MB of it tool results and 104 MB intermediate text.
 * A 50-message history page could therefore reach several megabytes, which is
 * what made remote chat loading slow (nothing to do with the number of
 * messages requested).
 *
 * This module is the ONE place that decides what a "list" view needs. Storage
 * keeps full fidelity (single source of truth); the API applies this clip; and
 * `GET /api/sessions/:id/messages/:messageId` returns the untouched original
 * when the user actually expands a block.
 *
 * Deliberate rules:
 * - Small tool results are kept verbatim: inline approval cards are derived
 *   client-side from `result` JSON (task_create / requirement_propose), and
 *   those payloads are small. Clipping them would silently drop the cards.
 * - Everything clipped is marked (`resultTruncated`, `contentTruncated`,
 *   `segmentsTruncated` on the message) so the client can fetch the detail
 *   instead of rendering a lie.
 */

/**
 * Caps are in characters. Deliberately aggressive: a list page renders the
 * final answer from `content`, and the collapsed process row only needs counts
 * and timing (derived from the segment skeleton). Anything clipped here is
 * fetched on expand.
 */
export const LEAN_CAPS = {
  thinking: 200,
  toolError: 200,
} as const;

/**
 * Tools whose result the client parses WITHOUT expanding anything: the inline
 * approval cards are built from this JSON (`parseTaskApprovalFromResult` /
 * `parseRequirementApprovalFromResult`). Clipping these would silently drop a
 * pending approval from the chat — the worst possible failure mode here.
 * Their payloads are small, so keeping them whole costs nothing.
 */
export const RESULT_KEEP_WHOLE_TOOLS = new Set(['task_create', 'create_task', 'requirement_propose']);

type Seg = Record<string, unknown>;
type Meta = Record<string, unknown>;

export interface LeanMetadataResult {
  metadata: Meta | null;
  /** True when at least one field was clipped — the client must lazily fetch detail. */
  truncated: boolean;
}

function clipString(value: unknown, cap: number): { out: string; clipped: boolean } {
  if (typeof value !== 'string') return { out: '', clipped: false };
  if (value.length <= cap) return { out: value, clipped: false };
  return { out: value.slice(0, cap), clipped: true };
}

function leanSegment(seg: unknown, isLastText: boolean): { seg: Seg; clipped: boolean } | null {
  if (!seg || typeof seg !== 'object') return null;
  const src = seg as Seg;
  let clipped = false;

  if (src['type'] === 'text') {
    const out: Seg = { ...src };
    // The FINAL text segment renders as the visible answer block, so it stays
    // whole. Intermediate narration is pure expansion material — drop the body
    // but keep the segment (its presence/ordering drives the process summary).
    if (isLastText) {
      // Keep verbatim: this IS the answer the user reads without expanding.
    } else if (typeof src['content'] === 'string' && src['content'].length > 0) {
      clipped = true;
      out['content'] = '';
      out['contentTruncated'] = true;
      out['contentSize'] = src['content'].length;
    }
    // Thinking stays (capped): the collapsed row counts thinking blocks, and an
    // empty string would make the count disappear.
    if (typeof src['thinking'] === 'string' && src['thinking'].length > 0) {
      const thinking = clipString(src['thinking'], LEAN_CAPS.thinking);
      if (thinking.clipped) { clipped = true; out['thinking'] = thinking.out; out['thinkingTruncated'] = true; }
    }
    return { seg: out, clipped };
  }

  if (src['type'] === 'tool') {
    const out: Seg = { ...src };
    const toolName = typeof src['tool'] === 'string' ? src['tool'] : '';
    const keepResultWhole = RESULT_KEEP_WHOLE_TOOLS.has(toolName);

    // Arguments are display-only; nothing renders (or decides) from them until
    // the block is expanded. Drop the body, keep the fact that it existed.
    if (src['arguments'] !== undefined && src['arguments'] !== null) {
      clipped = true;
      delete out['arguments'];
      out['argumentsDropped'] = true;
    }

    // Results are dropped EXCEPT for the approval tools whose JSON the client
    // parses without expanding (inline approval cards).
    if (!keepResultWhole && typeof src['result'] === 'string' && src['result'].length > 0) {
      clipped = true;
      out['result'] = '';
      out['resultTruncated'] = true;
      out['resultSize'] = src['result'].length;
    }

    if (typeof src['error'] === 'string') {
      const error = clipString(src['error'], LEAN_CAPS.toolError);
      if (error.clipped) { clipped = true; out['error'] = error.out; out['errorTruncated'] = true; }
    }

    // Sub-agent progress logs are live-progress data, meaningless for a finished
    // turn and potentially huge. Drop them; the detail endpoint still has them.
    if (Array.isArray(src['subagentLogs']) && src['subagentLogs'].length > 0) {
      delete out['subagentLogs'];
      out['subagentLogsDropped'] = true;
      clipped = true;
    }
    return { seg: out, clipped };
  }

  return { seg: { ...src }, clipped: false };
}

/**
 * Clip a message's metadata for list rendering. Non-segment keys are preserved
 * verbatim — they are all small flags the UI needs eagerly (isError, emptyReply,
 * activityLog, taskId, images, ...).
 */
export function leanMessageMetadata(metadata: unknown): LeanMetadataResult {
  if (!metadata || typeof metadata !== 'object') return { metadata: null, truncated: false };
  const src = metadata as Meta;
  const segments = src['segments'];
  if (!Array.isArray(segments)) return { metadata: src, truncated: false };

  let truncated = false;
  // Index of the LAST text segment — that one is the visible answer block.
  let lastTextIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] as Seg | null;
    if (s && typeof s === 'object' && s['type'] === 'text') lastTextIndex = i;
  }

  const leaned: Seg[] = [];
  for (let i = 0; i < segments.length; i++) {
    const item = leanSegment(segments[i], i === lastTextIndex);
    if (!item) continue;
    if (item.clipped) truncated = true;
    leaned.push(item.seg);
  }

  const out: Meta = { ...src, segments: leaned };
  if (truncated) out['segmentsTruncated'] = true;
  return { metadata: out, truncated };
}

/** Apply the lean view to a stored message object without touching other fields. */
export function leanChatMessage<T extends { metadata?: unknown }>(message: T): T & { metadata: Meta | null } {
  const { metadata } = leanMessageMetadata(message.metadata);
  return { ...message, metadata } as T & { metadata: Meta | null };
}
