/**
 * knowledge.md 文件助手 —— 记忆体系的**唯一**长期存储。
 *
 * ## 为什么这里只剩一个文件
 *
 * 原先本模块自称「knowledge.md / state.md dual store（双存储）」：
 * state.md 存放「短期情境状态」。但它实际上是一个**半成品机制** ——
 * 有读取方（reflex 提示词）、有淘汰方（dream cycle 的 TTL 裁剪）、有初始化，
 * 却**没有任何一等写入工具**（全仓库只能靠 `file_write` 手改）。
 *
 * 按 `(作用域 × 持久度)` 判据，凡是「短期、自动过期、喂给提示词的情境状态」
 * 都属于 **Working 层**，而 Working 层已经有 `NOTEBOOK.md`（有工具、有分档 TTL、
 * 有条数上限、每轮注入）—— 同一个职责不需要两个物理实现。
 *
 * 因此 state.md 退场，本模块只保留：
 *   1. knowledge 文件的路径 / 读写；
 *   2. 历史文件的**一次性迁移**（外部存储已被清空的情形下不静默丢内容）。
 *
 * 设计依据：docs/MEMORY-SYSTEM.md §10.2（state.md 退场，方案 A）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function knowledgePath(dataDir: string): string {
  return join(dataDir, 'knowledge.md');
}

/** 历史文件名（迁移来源，不再是写入目标）。 */
export function legacyMemoryPath(dataDir: string): string {
  return join(dataDir, 'MEMORY.md');
}

/** 已退场介质的文件名（迁移来源）。 */
export function retiredStatePath(dataDir: string): string {
  return join(dataDir, 'state.md');
}

/**
 * 一次性迁移：历史 `MEMORY.md` → `knowledge.md`。
 *
 * 旧实现把它**拆成两半**（`splitLegacyMemory` 按关键词猜哪些段落属于「状态」）；
 * state 档退场后拆分不再有意义 —— 整体并入 knowledge.md，宁可多留一点内容，
 * 也不静默丢弃。仅在 knowledge.md 尚不存在时执行。
 */
export function migrateLegacyMemory(dataDir: string): { migrated: boolean } {
  const knowledge = knowledgePath(dataDir);
  const legacy = legacyMemoryPath(dataDir);
  if (existsSync(knowledge) || !existsSync(legacy)) return { migrated: false };
  mkdirSync(dirname(knowledge), { recursive: true });
  const raw = readFileSync(legacy, 'utf8').trim();
  writeFileSync(knowledge, raw ? `${raw}\n` : '# Knowledge\n', 'utf8');
  return { migrated: true };
}

/** 确保 knowledge.md 存在（含历史迁移）。 */
export function ensureKnowledgeFile(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  migrateLegacyMemory(dataDir);
  const knowledge = knowledgePath(dataDir);
  if (!existsSync(knowledge)) writeFileSync(knowledge, '# Knowledge\n', 'utf8');
}

export function readKnowledge(dataDir: string): string {
  ensureKnowledgeFile(dataDir);
  return readFileSync(knowledgePath(dataDir), 'utf8');
}

export function writeKnowledge(dataDir: string, content: string): void {
  mkdirSync(dirname(knowledgePath(dataDir)), { recursive: true });
  writeFileSync(knowledgePath(dataDir), content, 'utf8');
}

export function dreamArchiveSkillSuggestion(opts: {
  usageCount: number;
  ageDays: number;
}): boolean {
  return opts.usageCount === 0 && opts.ageDays > 30;
}
