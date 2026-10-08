/**
 * H24 —— 机器记录改用机器格式（消灭 in-band markdown 容器这一族缺陷）。
 *
 * 根因（见 docs/records/platform-hardening-2026-10.md §20）：Agent 记忆把**结构**用 markdown 记号
 * （`## ` / `### ` / `<!-- … -->`）**带内编码**在文本文件里，而这些记号**载荷自己也能生产**。
 * 于是"结构"与"内容"不可区分，H13/H17/H18/H22 都是同一定理的四次实例，每个"修复"都只是又一个
 * 能被别的载荷打败的形状启发式。
 *
 * 第一性原理：结构必须待在**载荷够不到**的地方。观察与会话片段是追加式、机器写、**不注入 prompt**、
 * 无需人读的——它们根本不需要 markdown。现在每个池就是一个 JSON 数组：**载荷是 JSON 字符串**，
 * 由 JSON 规范保证它永远无法凭空造出一条记录。无需自定义转义、边界正则、形状启发式或修复遍历。
 */
import type { MemoryEntry } from './types.js';

export const VALID_ENTRY_TYPES = new Set<string>([
  'conversation', 'fact', 'task_result', 'note', 'insight', 'conversation_fragment',
]);

/** Sanity ceiling for one record's content — a corrupt 50MB entry must not be re-served. */
const MAX_CONTENT_CHARS = 2_000_000;

/** Coerce one unknown JSON value into a `MemoryEntry`, or `null` if it cannot be one. */
export function coerceEntry(raw: unknown): MemoryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? r['id'].trim() : '';
  if (!id) return null;
  const type = typeof r['type'] === 'string' && VALID_ENTRY_TYPES.has(r['type'])
    ? (r['type'] as MemoryEntry['type'])
    : 'note';
  let content = typeof r['content'] === 'string' ? r['content'] : '';
  if (content.length > MAX_CONTENT_CHARS) content = content.slice(0, MAX_CONTENT_CHARS);
  const timestamp = typeof r['timestamp'] === 'string' && r['timestamp']
    ? r['timestamp']
    : new Date().toISOString();
  const m = r['metadata'];
  const metadata = m && typeof m === 'object' && !Array.isArray(m)
    ? (m as Record<string, unknown>)
    : undefined;
  return { id, timestamp, type, content, ...(metadata ? { metadata } : {}) };
}

export interface ParseRecordsResult {
  entries: MemoryEntry[];
  /** Set when the text was present but not valid JSON — callers must report this, never swallow it. */
  error?: string;
}

/**
 * Read a JSON-array record file. Never throws: a corrupt file yields `{ entries: [], error }` so the
 * caller can log honestly instead of starting from a silent empty state.
 */
export function parseRecords(text: string): ParseRecordsResult {
  if (!text || !text.trim()) return { entries: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { entries: [], error: `invalid JSON: ${String(err)}` };
  }
  if (!Array.isArray(raw)) return { entries: [], error: 'expected a JSON array of records' };
  return { entries: raw.map(coerceEntry).filter((e): e is MemoryEntry => e !== null) };
}

/** Write records as a JSON array. Structure is JSON's, so no payload can forge a boundary. */
export function serializeRecords(entries: MemoryEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}
