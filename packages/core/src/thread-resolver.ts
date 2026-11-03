/**
 * **唯一解析点**：mailbox item → 它属于哪条流。
 *
 * 为什么必须只有一个解析点：以前 `task:` / `req:` / `conv:` / `system:` 四个作用域键
 * 散落在 registry、heuristics、mailbox 三处各自拼，任何一处多读一个字段，并发保护就
 * 静默失效（表现是「偶发两次同时处理同一任务」，不报错、只是变慢和偶发重复）。
 * 现在：**这个文件是唯一能产出流标识的地方**，别处只准调用它。
 *
 * 解析顺序（顺序即语义）：显式外部键 → 任务 → 需求 → 渠道 → 会话 → agent 兜底。
 * 前一个命中就不再往下走 —— 「具体」永远压过「宽泛」。
 */
import { resolveEntityKeys, type MailboxItem } from '@markus/shared';
import { parseThreadRef, threadRefOf, type ThreadRef } from '@markus/shared';

export type ResolvableItem = Pick<MailboxItem, 'sourceType' | 'payload' | 'metadata'>;

export interface ResolvedThread {
  /** 主轴：这条流是谁（平台实体 id，或已注册前缀的外部资源键） */
  ref: ThreadRef;
  /** 兼容维度：旧的 `task:` / `req:` / `conv:` / `channel:` 键，保留但不再是主轴 */
  legacyKeys: string[];
  /** 命中来源，用于诊断与面板展示（不参与逻辑判断） */
  axis: 'explicit' | 'task' | 'requirement' | 'channel' | 'session' | 'agent';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * 主轴解析。`extra` 与 `metadata` 两处**都要读**：
 * 实测只读一处会让 a2a / IM 事件退化成 agent 全局串行（变慢但不报错，最难查的那种）。
 */
export function resolveThreadRef(item: ResolvableItem, agentId: string): ResolvedThread {
  const extra = item.payload.extra ?? {};
  const meta = item.metadata ?? {};

  // 1. 适配器已经解出外部资源键（`gh:owner/repo` / `xhs:brand_01`），直接用
  const explicit = str(extra.threadRef) ?? str((meta as Record<string, unknown>)['threadRef']);
  if (explicit) {
    return { ref: threadRefOf(explicit), legacyKeys: legacy(item, agentId), axis: 'explicit' };
  }

  // 2. 任务：最具体的执行单元
  const taskId = str(item.payload.taskId) ?? str(meta.taskId) ?? str(extra.taskId);
  if (taskId) return { ref: threadRefOf(taskId), legacyKeys: legacy(item, agentId), axis: 'task' };

  // 3. 需求：多任务共享的上层
  const reqId = str(item.payload.requirementId) ?? str(extra.requirementId);
  if (reqId) return { ref: threadRefOf(reqId), legacyKeys: legacy(item, agentId), axis: 'requirement' };

  // 4. 渠道：同一个群/同一个仓库只允许一个回合在跑（否则两条消息并行改同一处）
  const channelKey = str(extra.channelKey);
  if (channelKey) return { ref: `channel:${channelKey}`, legacyKeys: legacy(item, agentId), axis: 'channel' };

  // 5. 会话：读三处，缺一处就会漏
  const sessionId = str(extra.sessionId) ?? str(meta.dbSessionId) ?? str(meta.sessionId);
  if (sessionId) return { ref: threadRefOf(sessionId), legacyKeys: legacy(item, agentId), axis: 'session' };

  // 6. 兜底：未知 = 保守串行（同 agent 内），不是未知 = 完全并发
  return { ref: `agent:${agentId}`, legacyKeys: legacy(item, agentId), axis: 'agent' };
}

/**
 * mailbox 并发键：**主轴放在第一位**，旧维度保留在后面。
 *
 * 为什么保留旧键：一条任务流同时可能被 `conv:` 维度约束（同一会话里不许并行），
 * 两个维度是「与」关系，不是替代关系。删掉旧键等于放宽并发保护。
 */
export function threadEntityKeys(item: ResolvableItem, agentId: string): string[] {
  const { ref, legacyKeys } = resolveThreadRef(item, agentId);
  const out = [ref];
  for (const k of legacyKeys) if (!out.includes(k)) out.push(k);
  return out;
}

function legacy(item: ResolvableItem, agentId: string): string[] {
  return resolveEntityKeys(item, agentId);
}

/** 外部资源键是否带已注册前缀（写侧校验用；未知前缀不是错误，只是没有适配器）。 */
export function isExternalRef(ref: ThreadRef): boolean {
  return parseThreadRef(ref) !== null;
}
