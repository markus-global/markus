/**
 * 资源键解析 —— 并发锁的**唯一真源**。
 *
 * ## 为什么需要它
 *
 * 资源域锁原先的粒度是**工具名**，因此同一个资源可以有两条互不互斥的写入路径：
 *
 *   1. notebook 写工具曾按「正式名 + 别名」分登记到不同的域（`'notebook'` 与
 *      `'working-memory'`），写的却是**同一个 Map**（`Agent.writeNotebookEntry`），
 *      因域名不同被判定为「不冲突」，锁形同虚设。现别名已删除、名字归一为
 *      `notebook_upsert` / `notebook_clear`，共享 `agent-memory:notebook` 锁域。
 *   2. `file_write` 走 `fs:<path>` 域，而记忆工具走 `memory` / `notebook` 域：
 *      同一个 `knowledge.md` 由「内存模型整文件重写」与「通用文件工具」两条路径
 *      写入，互不互斥 —— 外部编辑会被下一次内存落盘**静默覆盖**。
 *
 * 本模块把判据从「工具名」换成「**资源**」：任何工具（内建 / 别名 / 技能 / MCP）
 * 只要触及同一个 agent 记忆文件，就解析到同一个锁请求。
 *
 * ## 已知取舍
 *
 * 只按 **basename** 识别记忆文件，不要求它位于 agent home 之下 —— 因为
 * `resourceLocksFor` 可能拿不到 `dataDir`。代价是「仓库里恰好叫 knowledge.md 的
 * 文件」也会被当成记忆资源，多一次不必要的串行；方向是安全的（宁可串行不可竞态）。
 * 若调用方提供了 `dataDir`，则额外要求路径位于该目录内，误判归零。
 */

import { basename, resolve, sep } from 'node:path';
import type { LockRequest } from './resource-locks.js';

/** 记忆资源的锁域（所有记忆文件共用，`sub` 区分具体文件）。 */
export const AGENT_MEMORY_RESOURCE_DOMAIN = 'agent-memory';

/** 记忆资源键 —— 与「一个文件 = 一个可变状态」一一对应。 */
export type AgentMemoryResource = 'knowledge' | 'notebook' | 'identity' | 'state';

/**
 * 记忆文件 basename → 资源键。
 *
 * `state.md` 处于**退场中**（见 docs/architecture/MEMORY-SYSTEM.md §10.2）：
 * 它保留在表里只为覆盖一次性迁移写入，不代表它仍是受支持的介质。
 */
const MEMORY_FILE_RESOURCES: Readonly<Record<string, AgentMemoryResource>> = {
  'knowledge.md': 'knowledge',
  'notebook.md': 'notebook',
  'state.md': 'state',
  'role.md': 'identity',
  'heartbeat.md': 'identity',
};

/**
 * 若路径指向 agent 记忆文件，返回其资源键；否则 `undefined`（调用方退化为普通 fs 锁）。
 *
 * @param dataDir 可选；提供时要求路径位于该目录内（消除「同名文件误判」）。
 */
export function memoryResourceForPath(
  rawPath: string,
  dataDir?: string,
): AgentMemoryResource | undefined {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined;
  const resource = MEMORY_FILE_RESOURCES[basename(rawPath).toLowerCase()];
  if (!resource) return undefined;
  if (dataDir) {
    const abs = resolve(rawPath);
    const root = resolve(dataDir);
    if (abs !== root && !abs.startsWith(root + sep)) return undefined;
  }
  return resource;
}

/** 记忆资源的锁请求（跨工具面统一锁键的落点）。 */
export function memoryResourceLock(resource: AgentMemoryResource): LockRequest {
  return { domain: AGENT_MEMORY_RESOURCE_DOMAIN, sub: resource };
}

/**
 * 「单一写入者」记忆文件 —— 通用文件工具 / shell 一律禁止直写。
 *
 * 这些文件由记忆服务整文件维护；任何绕过服务的外部写入都会与内存模型分叉，
 * 最终被下一次落盘**静默覆盖**（审计 P-01：实测 2026-09-27 手改 knowledge.md
 * 于 2026-09-28 被覆盖）。因此写门禁直接拒绝，并引导改用记忆 / 笔记本工具。
 *
 * 注意：`role.md` / `heartbeat.md`（身份 / 巡检）**不在此列** —— 它们本就由
 * Agent 自行编辑（Learning Habits），不属于单一写入者资源。
 */
export const SINGLE_WRITER_MEMORY_FILES: ReadonlySet<string> = new Set([
  'knowledge.md',
  'notebook.md',
  'state.md',
]);

/**
 * 目标路径是否为「单一写入者记忆文件」。
 *
 * `workspacePath` 提供时，位于**该工作区内**的同名文件视为普通文件（放行）——
 * 记忆文件位于 agent home，不在工作区内；工作区里的 `knowledge.md` 可能只是
 * 普通文档，Agent 有权编辑。未提供 workspacePath 时按安全方向（拒绝）。
 */
export function isSingleWriterMemoryFile(rawPath: string, workspacePath?: string): boolean {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return false;
  if (!SINGLE_WRITER_MEMORY_FILES.has(basename(rawPath).toLowerCase())) return false;
  if (workspacePath) {
    const abs = resolve(rawPath);
    const root = resolve(workspacePath);
    if (abs === root || abs.startsWith(root + sep)) return false;
  }
  return true;
}
