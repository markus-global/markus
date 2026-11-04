/**
 * 日常链路写 Thread 的**唯一收口**（设计 §7.3.1）。
 *
 * `threads` 表只允许被 `ThreadService.ensure()` 写入。本文件只做「构造 service + 调 ensure」，
 * 不自己拼 SQL、不直接调 repo —— 否则就是第二个写者，而 A1 整条链路为 0 的根因正是
 * 「写了对象却没人负责写它」。
 *
 * 失败不抛：流是派生视图，不能因为建流失败而丢用户消息 / 任务。
 * 但**不许静默**（2026-11-04 起）：每个入口都拿到一个可判定的 outcome，并在真实缺失时
 * 由 `reportThreadEnsureFailure` / `reportThreadEventFailure` 打一条**可行动**的 warn +
 * 计数（`threadWiringHealth()` 会出现在 `/api/health`）。
 *
 * 为什么不是「返回 boolean，调用方自己写一句 warn」：那样「缺什么 / 去改哪里」的文案会有
 * N 个副本（本文件曾经连 `if (!threads) return false` 一行 log 都没有，两个注入点又都丢弃
 * 了返回值 —— 于是 `threadRepo` 没装配时「流没建」在日志里查不到）。文案与计数只能有一处。
 */
import { ThreadService, emitThreadWake } from '@markus/core';
import type { ActorKind, ThreadEnsureOutcome, ThreadEventOutcome } from '@markus/shared';
import { createLogger } from '@markus/shared';
import type { StorageBridge } from './storage-bridge.js';
import { bumpEnsure, bumpEvent } from './thread-wiring-metrics.js';

const log = createLogger('thread-ensure');

// 结论类型定义在 `@markus/shared`（core 与 org-manager 都要写它），这里重导出，
// 让调用方仍然只依赖 `thread-ensure` 一个入口。
export type { ThreadEnsureOutcome, ThreadEventOutcome };

/**
 * 建流的结论。刻意不是 boolean：
 * - `ensured` = 流已存在或已创建（含幂等重入）
 * - `no-thread-repo` = 存储没挂 thread repo（**配置缺失**，去改装配，不是业务错误）
 * - `failed` = 抛了（数据/约束问题，看 warn 里的 error）
 *
 * 三者对「该怎么办」的答案完全不同，合成一个 false 就等于把可行动信息丢掉。
 */

/**
 * 记事件的结论。`duplicate` 是正常情况（重投），不是失败。
 */

/**
 * 建流缺失时**唯一**的上报点。
 *
 * @param context 哪个入口（`task.create` / `a2a.deliver` / `chat.turn`）——
 *   没有它，warn 只说「流没建」，看日志的人得自己猜是哪条链路。
 */
export function reportThreadEnsureFailure(
  outcome: ThreadEnsureOutcome,
  ref: string,
  context: string,
): void {
  if (outcome === 'ensured') return;
  if (outcome === 'no-thread-repo') {
    log.warn(
      `流未建立（${context}）：storage 没有 threadRepo —— 装配缺失，不是业务错误`,
      {
        ref,
        fix: '启动时 initStorage() 必须挂上 threadRepo；检查 org-manager 的 StorageBridge 装配',
      },
    );
    return;
  }
  // 具体 error 已经由 ensureThread 内部打过一条带 error 的 warn；这里补上「哪个入口」。
  log.warn(`流未建立（${context}）：ensureThread 抛错，见上一条 warn 的 error`, { ref });
}

/**
 * 记事件缺失时**唯一**的上报点（与 `reportThreadEnsureFailure` 同族的另一半：
 * 只修建流、不修记事件，等于让「时间线空了」继续是个盲区）。
 */
export function reportThreadEventFailure(
  outcome: ThreadEventOutcome,
  ref: string,
  context: string,
): void {
  if (outcome === 'recorded' || outcome === 'duplicate') return;
  if (outcome === 'no-trigger-repo') {
    log.warn(
      `事件未登记（${context}）：storage 没有 triggerRepo —— 装配缺失，时间线会一直是空的`,
      {
        ref,
        fix: '启动时 initStorage() 必须挂上 triggerRepo；检查 org-manager 的 StorageBridge 装配',
      },
    );
    return;
  }
  log.warn(`事件未登记（${context}）：insertOrGet 抛错，见上一条 warn 的 error`, { ref });
}

/**
 * @param actorAgentId 谁制造了这个事件。用于**排除自激** —— agent 自己在某条流里
 *   说话不应把自己叫醒，否则「发一条 → 被自己叫醒 → 再发一条」是个无界循环，
 *   而且每一步看起来都是合法消息，不会报错。
 * @returns `ensured` = 流已存在或已创建；`no-thread-repo` / `failed` = 没建成（调用方
 *   **必须**交给 `reportThreadEnsureFailure`，不要自己分支——那是文案的第二写者）
 */
export function ensureThread(storage: StorageBridge | undefined, ref: string, actorAgentId?: string): ThreadEnsureOutcome {
  const threads = storage?.threadRepo;
  if (!threads) {
    bumpEnsure('no-thread-repo');
    return 'no-thread-repo';
  }
  try {
    // `ensure()` 只读 threads；dispositions 仅 route() 需要，所以这里直传、不造假对象。
    new ThreadService({ threads, dispositions: storage?.dispositionRepo }).ensure(ref);
  } catch (err) {
    log.warn('ensureThread failed', { ref, error: String(err) });
    bumpEnsure('failed');
    return 'failed';
  }
  bumpEnsure('ensured');

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
  return 'ensured';
}

/**
 * 往一条流上记一件事 —— 写进 `triggers`（「发生过什么」的唯一事实源）。
 *
 * 2026-11-03 改变：这里以前写 `thread_events` 表。那张表存的是 `triggers` 内容的副本，
 * 也就是同一件事的第二个写者——两个写者必然会在某天不一致，而时间线恰好是「证据」，
 * 错了最难发现。现在表已删除，时间线改为对 `triggers.thread_refs` 的派生查询。
 *
 * 2026-11-04 改变：返回值可判定（`ThreadEventOutcome`），并在同一个调用里做**影子判定**
 * （`observeThreadEvent`）—— 事件先「按真路由该得到什么结论」记一笔，但不改行为。
 * 三个入口（task 评论 / a2a 投递 / chat 回合）都经过这里，所以埋点只需要一行，
 * 而不是三个入口各埋一遍（那会是三份漂移的副本）。
 *
 * 失败不抛：这是旁路记账，不能因为记不上而丢用户消息 / 任务。
 * 但必须留 warn —— 否则「时间线空了」会变成查不到的盲区。
 *
 * @param event.actorKind 制造者类别。给了就用（a2a / chat 明确知道是 agent）；
 *   没给则按 id 前缀推断，见 `actorKindOf`。
 */
export function recordThreadEvent(
  storage: StorageBridge | undefined,
  ref: string,
  event: { kind: string; actor?: string; actorKind?: ActorKind; summary: string; eventId?: string },
): ThreadEventOutcome {
  const triggers = storage?.triggerRepo;
  if (!triggers) {
    bumpEvent('no-trigger-repo');
    return 'no-trigger-repo';
  }
  let outcome: ThreadEventOutcome = 'recorded';
  try {
    const res = triggers.insertOrGet({
      kind: event.kind,
      // 幂等键：调用方给了稳定 id 就用它（重投安全）；否则每次调用都是**一件新事实**
      // （一条新消息就该是新行），所以不带内容哈希——两条相同内容的消息是两件事。
      idempotencyKey: event.eventId ? `evt:${event.eventId}` : `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      actorId: event.actor ?? null,
      summary: event.summary,
      threadRefs: [ref],
    });
    outcome = res.created ? 'recorded' : 'duplicate';
  } catch (err) {
    log.warn('recordThreadEvent failed', { ref, kind: event.kind, error: String(err) });
    bumpEvent('failed');
    return 'failed';
  }
  bumpEvent(outcome);
  return outcome;
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
