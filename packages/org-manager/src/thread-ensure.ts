/**
 * 日常链路写 Thread 的**唯一收口**（设计 §7.3.1）。
 *
 * `threads` 表只允许被 `ThreadService.ensure()` 写入。本文件只做「构造 service + 调 ensure」，
 * 不自己拼 SQL、不直接调 repo —— 否则就是第二个写者，而 A1 整条链路为 0 的根因正是
 * 「写了对象却没人负责写它」。
 *
 * 失败不抛：流是派生视图，不能因为建流失败而丢用户消息 / 任务。
 * 但必须留 warn —— 否则「流没建」会成为查不到的盲区（这正是首版 8 项全红的成因）。
 */
import { ThreadService, emitThreadWake } from '@markus/core';
import { createLogger } from '@markus/shared';
import type { StorageBridge } from './storage-bridge.js';

const log = createLogger('thread-ensure');

/**
 * @param actorAgentId 谁制造了这个事件。用于**排除自激** —— agent 自己在某条流里
 *   说话不应把自己叫醒，否则「发一条 → 被自己叫醒 → 再发一条」是个无界循环，
 *   而且每一步看起来都是合法消息，不会报错。
 * @returns true = 流已存在或已创建；false = 当前存储没挂 thread repo（不报错，调用方无需分支）
 */
export function ensureThread(storage: StorageBridge | undefined, ref: string, actorAgentId?: string): boolean {
  const threads = storage?.threadRepo;
  if (!threads) return false;
  try {
    // `ensure()` 只读 threads；dispositions 仅 route() 需要，所以这里直传、不造假对象。
    new ThreadService({ threads, dispositions: storage?.dispositionRepo }).ensure(ref);
  } catch (err) {
    log.warn('ensureThread failed', { ref, error: String(err) });
    return false;
  }

  // 建流成功才发事件。
  //
  // 为什么必须在这里：`ensureThread` 是日常链路（chat / task / a2a）写 thread 的唯一收口，
  // 而 rest 的 `trigger` 条件等的就是「这条流有新事件」。不发事件 = 那三类条件永远不命中，
  // agent 只能等 timeout 兜底才醒——那时候事情早过去了。
  //
  // 发事件失败不影响建流（rest 是旁路，不能回滚业务写入）。
  try {
    emitThreadWake({
      kind: 'trigger',
      threadRef: ref,
      actorAgentId,
      summary: `${ref} 上有新事件`,
    });
  } catch (err) {
    log.warn('emitThreadWake failed', { ref, error: String(err) });
  }
  return true;
}

/**
 * 往一条流上记一件事 —— 写进 `triggers`（「发生过什么」的唯一事实源）。
 *
 * 2026-11-03 改变：这里以前写 `thread_events` 表。那张表存的是 `triggers` 内容的副本，
 * 也就是同一件事的第二个写者——两个写者必然会在某天不一致，而时间线恰好是「证据」，
 * 错了最难发现。现在表已删除，时间线改为对 `triggers.thread_refs` 的派生查询。
 *
 * 失败不抛：这是旁路记账，不能因为记不上而丢用户消息 / 任务。
 * 但必须留 warn —— 否则「时间线空了」会变成查不到的盲区。
 */
export function recordThreadEvent(
  storage: StorageBridge | undefined,
  ref: string,
  event: { kind: string; actor?: string; summary: string; eventId?: string },
): void {
  const triggers = storage?.triggerRepo;
  if (!triggers) return;
  try {
    triggers.insertOrGet({
      kind: event.kind,
      // 幂等键：调用方给了稳定 id 就用它（重投安全）；否则每次调用都是**一件新事实**
      // （一条新消息就该是新行），所以不带内容哈希——两条相同内容的消息是两件事。
      idempotencyKey: event.eventId ? `evt:${event.eventId}` : `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      actorId: event.actor ?? null,
      summary: event.summary,
      threadRefs: [ref],
    });
  } catch (err) {
    log.warn('recordThreadEvent failed', { ref, kind: event.kind, error: String(err) });
  }
}

/** 任务流的 ref 形态：`tsk_<taskId>`。集中在一处，避免各调用点各拼一个。 */
export const taskRef = (taskId: string): string => (taskId.startsWith('tsk_') ? taskId : `tsk_${taskId}`);

/**
 * A2A 流的 ref：两个 agent 之间的 DM 是一条流，**与方向无关**（按 id 排序）。
 * 方向各自记账会让「同一条对话」变成两条流，直通判定随即失效。
 */
export const a2aRef = (a: string, b: string): string => {
  const [x, y] = [a, b].sort();
  return `a2a_${x}__${y}`;
};
