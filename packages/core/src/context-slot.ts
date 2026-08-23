/**
 * ContextOS — SLOT 段模型 (session-slot store)
 *
 * 槽位（SLOTS）是 Agent 通过 session_pin 钉入当前 session 固定段的事实锚点。
 * 它们：
 *  - 每次注入都出现在 prompt 的固定段 C 尾（见 context-engine 的 slot 段注入）；
 *  - 永不参与业务压缩（compact/summarize/trim 只处理可变段历史）；
 *  - 跨轮次保留（随 session 的 slots 字段持久化到 disk）。
 *
 * 与 memory_save（长期语义知识库，可被裁剪/语义检索）粒度不同：
 * pin 是本会话「不会冲掉」的工作锚点。
 */
import { CONTEXT_SLOT_MAX_CHARS } from '@markus/shared';

export interface SlotEntry {
  key: string;
  text: string;
  updatedAt: number;
}

/**
 * 从 session 管理对象中读写 slots 的存储契约。
 * 实现持有 session 的 slots 字段；MemoryStore.getOrCreateSession 返回的
 * ConversationSession 已含 slots?: Record<string, string>。
 */
export interface SlotsStore {
  getSlots(sessionId: string): SlotEntry[];
  setSlot(sessionId: string, key: string, text: string): void;
  removeSlot(sessionId: string, key: string): void;
  /** 生成注入用的 [SLOTS] 固定段文本；空槽 -> 空串。 */
  serialize(sessionId: string): string;
}

/** 限制单个槽位值长度（由 limits 控制，默认 1200 字符）。 */
export const SLOT_MAX_TEXT = CONTEXT_SLOT_MAX_CHARS;

/**
 * 把键值槽位序列化为固定段文本。仅供注入/展示，不落盘。
 * 格式（agent-managed，不受压缩影响）：
 *   [SLOTS] (agent-managed, not compacted)
 *   · goal: ...
 *   · done: ...
 */
export function buildSlotSegment(entries: SlotEntry[], maxChars: number = SLOT_MAX_TEXT): string {
  if (!entries.length) return '';
  const lines = entries.map(
    (e) => `· ${sanitizeSlotKey(e.key)}: ${e.text.slice(0, Math.max(64, maxChars))}`,
  );
  return `[SLOTS] (agent-managed, not compacted)\n${lines.join('\n')}`;
}

/**
 * 构建固定段中的「会话摘要锚点」块。
 *
 * ContextOS 让 compact 产生的摘要进入 [SYSTEM] 固定段（与 [SLOTS] 语义分区），
 * 而非注入成一条 `role:'user'` 假消息——这样它：
 *  - 每次请求都在场（agent 始终知道自己压缩过多少历史）；
 *  - 永不进入可变段压缩链（不会把自己二次压缩掉）；
 *  - 不污染 turn 归属（不会让模型以为这是用户真实输入）。
 *
 * @param summary  压缩摘要文本（可为空串，空则不渲染该块）
 * @param pagedOut 被换出的消息条数（用于提示，可选）
 */
export function buildSummarySegment(summary: string, pagedOut?: number): string {
  if (!summary) return '';
  const header = pagedOut ? `${pagedOut} earlier messages paged out` : 'history paged out earlier';
  return (
    `[CONTEXT SUMMARY] (platform compaction anchor, not compacted, recoverable via session_retrieve — ${header})\n` +
    summary.slice(0, CONTEXT_SLOT_MAX_CHARS)
  );
}

/** 仅允许安全的槽位键字符，防止键内注入格式破坏。 */
export function sanitizeSlotKey(key: string): string {
  return key.slice(0, 64).replace(/[\r\n:]/g, '_').trim();
}
