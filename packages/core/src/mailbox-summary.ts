/**
 * Mailbox item summaries — an *explicitly lossy* display excerpt of a message.
 *
 * ## Why this module exists (2026-10-22 incident)
 *
 * Every mailbox item carries two fields: `content` (the authoritative message)
 * and `summary` (what the attention section, handoff log and queue listings
 * show). `summary` used to be `content.slice(0, 100)` — a *silent* prefix copy
 * that sat right next to the truth, in the same shape, with no marker.
 *
 * That is the worst combination for a reader: a 100-char prefix of a real
 * message is indistinguishable from a genuinely short message. In the incident
 * the owner sent a 383-char message (a terminal-selection chip plus
 * 「已经合并了。创建一个新的rc版本吧。」); a downstream reader consumed the
 * 100-char copy — which ended exactly on the chip's opening `"""` fence — and
 * concluded "the message is empty". The agent then answered a question it had
 * never actually read.
 *
 * The fix is NOT a longer slice (a different length reproduces the bug with a
 * different number). The fix is to make truncation *self-evident*:
 *
 *   1. collapse to a single line, so a multi-line payload (chips, pasted logs,
 *      structured selections) can never masquerade as "the whole message" via
 *      its first few lines;
 *   2. when anything was dropped, append an explicit marker carrying how much —
 *      a reader that sees the marker knows to fetch `content`.
 *
 * Invariant (tested): `summarizeForMailbox(x)` is either byte-identical to a
 * single-line `x` (nothing was dropped) or visibly marked as lossy. There is no
 * third state, so "reads like a complete message but is not" cannot be
 * expressed.
 */

/** Marker placed at the end of an excerpt that dropped characters. */
const OMITTED_TEMPLATE = (omitted: number) => ` …[+${omitted} chars omitted]`;

/** Collapse any run of whitespace (including newlines) into a single space. */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Build the display excerpt for a mailbox item.
 *
 * @param content Authoritative message body.
 * @param max     Maximum characters of body to keep (default 100, matching the
 *                previous behaviour's budget). The marker is *not* counted
 *                against it — the point is readability, not an exact ceiling.
 */
export function summarizeForMailbox(content: string, max = 100): string {
  const single = toSingleLine(content ?? '');
  if (single.length <= max) return single;
  const head = single.slice(0, max).trimEnd();
  // Count what a reader cannot see. Measured in characters of the collapsed
  // body; the whitespace we collapsed is already unrecoverable from here, so we
  // only count characters present in `single`.
  const omitted = single.length - head.length;
  return `${head}${OMITTED_TEMPLATE(omitted)}`;
}

/** True when an excerpt carries the truncation marker (i.e. is lossy). */
export function isLossySummary(summary: string): boolean {
  return /…\[\+\d+ chars omitted\]$/.test(summary ?? '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessors: the ONLY sanctioned way to read a mailbox item's text.
//
// `payload.content` is authoritative. `payload.summary` is a display excerpt —
// and on rows persisted before 2026-10-22 it is a *bare* prefix with no marker,
// which is exactly the shape that made a truncated message read as complete.
// Readers must therefore never touch `payload.summary` directly: they call
// `turnContentOf` (to feed the model) or `displayLabelOf` (to show/log).
// ─────────────────────────────────────────────────────────────────────────────

export interface PayloadLike {
  content?: string;
  summary?: string;
}

export interface ItemLike {
  id?: string;
  sourceType: string;
  payload: PayloadLike;
  /**
   * Structural, NOT `Record<string, unknown>`: the real `MailboxItemMetadata`
   * declares named optional fields and no index signature, so a record type
   * would make every `MailboxItem` unassignable at the call sites.
   */
  metadata?: { mergeCount?: number };
}

/** Source types whose turn MUST carry the authoritative body. */
const AUTHORITATIVE_TURN_TYPES = new Set(['human_chat', 'a2a_message']);

function isItemLike(target: PayloadLike | ItemLike): target is ItemLike {
  return typeof (target as ItemLike).sourceType === 'string' && !!(target as ItemLike).payload;
}

/**
 * The text a turn is built from. This is the single reader for model input.
 *
 * Throws for human/agent messages that lost their body: a turn must never be
 * assembled from a display excerpt — answering a truncated question silently is
 * worse than failing loudly. System events legitimately carry only a summary,
 * so they fall back.
 */
/**
 * 入参校验失败的**结构化**错误（第六刀 C5）。
 *
 * 为什么不是裸 `Error`：退信台账的 `drop_reason` 是闭集，而「报文读不成一个回合」
 * 与「信号陈旧」是两件完全不同的事。只有当校验层用**类型**表态，终态那一步才可能
 * 按真实原因投影（`payload_invalid`）；靠 `err.message.includes('payload.content')`
 * 这类文本匹配去还原原因，会在下一次改文案时静默失效（且字符串不是结构）。
 */
export class SignalPayloadInvalidError extends Error {
  readonly code = 'payload_invalid' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SignalPayloadInvalidError';
  }
}

/**
 * 把「处理中途抛出的异常」映射为原因闭集里的退信原因。
 *
 * 只认结构化信号：不是入参校验错误的异常一律返回 `undefined`，调用方保持既有语义。
 * 绝不把 `payload_invalid` 当万能桶 —— 否则它立刻变成下一个 `stale_signal`，
 * 只是换了个更好听的名字。
 */
export function bounceReasonOfError(err: unknown): 'payload_invalid' | undefined {
  return err instanceof SignalPayloadInvalidError ? 'payload_invalid' : undefined;
}

/** 报文是否带了可用的正文 —— 与 {@link isPayloadUnreadable} 是同一个判据的前半段。 */
function hasTurnContent(item: ItemLike): boolean {
  const content = item.payload?.content;
  return typeof content === 'string' && content.trim().length > 0;
}

/**
 * 「这条报文能不能读成一个回合」—— **唯一判据**。
 *
 * `turnContentOf()`（校验层）与失败族分类（{@link bounceReasonOfFailure}）共用它，
 * 因为这是**同一个事实**的两个读者。分开写两份判断，迟早一份被改另一份没改。
 */
export function isPayloadUnreadable(item: ItemLike): boolean {
  return !hasTurnContent(item) && AUTHORITATIVE_TURN_TYPES.has(item.sourceType);
}

/**
 * 失败族的原因投影 —— 判据是**事实**（报文读不读得成回合），不是「异常是哪个类」。
 *
 * 真实实例探针（2026-11-13）暴露的 C5 漏洞：同一条缺 `content` 的 chat 报文，这次
 * 处理中途更早的一行先抛了普通 `TypeError`（`...reading 'trim'`），于是
 * `bounceReasonOfError()` 认不出来 → `undefined` → `drop()` 取默认值 → 台账又写成
 * `stale_signal`。也就是说「原因是什么」曾经取决于**哪一行先抛错**，那是巧合，不是判据。
 *
 * 现在的口径：只要有异常、且这条报文本来就读不成一个回合 → `payload_invalid`；
 * 报文**可读**时的未知异常 → `processing_error`（平台在处理过程中坏了，不是报文坏）；
 * 没有异常 → 不产出失败族原因：决策型终态（用户取消 / 主动丢弃）仍走 `stale_signal`。
 *
 * 为什么必须有 `processing_error`：`drop_reason` 的唯一用途是让操作者知道**该由谁去修**。
 * 六类旧原因里每一类都能指向一个责任方（运维补绑定 / 发送方修报文 / 平台自愈租约），
 * 只有「平台自己崩了」没有名字 —— 于是被塞进 `stale_signal`，而 `stale_signal` 的语义
 * 是「有人决定不处理它」。把「我们坏了」记成「你没价值」，与 C5 修的那条谎同构。
 */
export function bounceReasonOfFailure(
  err: unknown,
  item: ItemLike,
): 'payload_invalid' | 'processing_error' | undefined {
  if (!err) return undefined;
  if (bounceReasonOfError(err)) return 'payload_invalid';
  return isPayloadUnreadable(item) ? 'payload_invalid' : 'processing_error';
}

export function turnContentOf(item: ItemLike): string {
  if (isPayloadUnreadable(item)) {
    throw new SignalPayloadInvalidError(
      `mailbox item ${item.id ?? '(no id)'} of type ${item.sourceType} has no payload.content — ` +
        `refusing to build the turn from a display excerpt ` +
        `(summary="${item.payload?.summary ?? ''}"). Fix the enqueue site; do not degrade here.`,
    );
  }
  // 非权威类型回退到 summary：系统事件本来只带摘要，这是合法形状。
  return hasTurnContent(item) ? (item.payload?.content as string) : (item.payload?.summary ?? '');
}

/**
 * Number of items folded into this one (dedup/consolidation).
 *
 * Lives in `metadata.mergeCount`; legacy rows encoded it as a `(+N)` suffix on
 * the display summary, which is read as a fallback so existing persisted items
 * keep working without a migration.
 */
export function mergeCountOf(item: ItemLike): number {
  const fromMeta = Number(item.metadata?.mergeCount);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return Math.trunc(fromMeta);
  const legacy = /\(\+(\d+)\)$/.exec(item.payload?.summary ?? '');
  return legacy ? Number(legacy[1]) : 0;
}

/** Record one more folded item, in metadata (never as structure in a string). */
export function bumpMergeCount(item: ItemLike): void {
  const next = mergeCountOf(item) + 1;
  item.metadata = { ...(item.metadata ?? {}), mergeCount: next };
}

/**
 * Display/log label for an item or bare payload.
 *
 * Derived from `content` at read time — never from the stored `summary` — so a
 * legacy prefix can no longer travel to a human or a log as "the message".
 * The folded-item count is appended so the label stays informative.
 */
export function displayLabelOf(target: PayloadLike | ItemLike, max = 100): string {
  const item = isItemLike(target) ? target : undefined;
  const payload: PayloadLike = item ? item.payload : (target as PayloadLike);
  const body = typeof payload.content === 'string' && payload.content.trim().length > 0
    ? payload.content
    : (payload.summary ?? '');
  const label = summarizeForMailbox(body, max);
  const merged = item ? mergeCountOf(item) : 0;
  return merged > 0 ? `${label} (+${merged})` : label;
}
