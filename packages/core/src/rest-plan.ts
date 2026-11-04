import type { RestWakeCondition } from './pending-callback.js';

/**
 * `rest` 的判定逻辑，与平台副作用分离。
 *
 * 单独抽出来的理由：这里有全部**边界**（空条件、未知 kind、缺字段、
 * 超上限、连续次数），而它们恰恰是最容易写错、也最该被测的部分。
 * 留在 agent 的私有方法里就只能靠集成测试间接验，边界一旦错会静默挂起。
 */

/** 未指定 timeout 时的兜底：多久后强制醒一次。 */
export const REST_DEFAULT_FALLBACK_MS = 30 * 60 * 1000;
/** 硬上限：任何 timeout 都不能超过这个。一个笔误不应让会话永久静默。 */
export const REST_HARD_MAX_MS = 2 * 60 * 60 * 1000;
/** 连续 rest 次数上限：超过就要求升级给人，而不是继续无限等。 */
export const REST_MAX_STREAK = 5;

export interface RestPlan {
  conditions: RestWakeCondition[];
  /** 被丢弃的条件 + 原因。不静默吞掉——调用方需要知道自己写错了哪一条。 */
  ignored: string[];
  /** 实际生效的等待上限（已夹到硬上限）。 */
  boundedMs: number;
  /** 是否由平台补了兜底 timeout（调用方没写 timeot 时）。 */
  fallbackAdded: boolean;
}

export type RestPlanResult =
  | { ok: true; plan: RestPlan }
  | { ok: false; status: 'error' | 'refused'; message: string; ignored?: string[]; restStreak?: number };

/**
 * 解析 `wake_on` 并算出有效等待上限。
 *
 * 三条平台约束在这里兑现，而不是靠调用方自觉：
 * 1. 至少一个有效条件（空等待没有意义，等价于永远不醒）；
 * 2. 必须有界 —— 没有 timeout 就补兜底，有也夹到硬上限；
 * 3. 连续次数上限 —— 防「换个条件再等一次」绕过有界性。
 */
export function planRest(rawList: unknown, restStreak: number): RestPlanResult {
  if (restStreak >= REST_MAX_STREAK) {
    return {
      ok: false,
      status: 'refused',
      message: `已连续 rest ${restStreak} 次且没有做任何实事。继续等下去只是在假装在线。`,
      restStreak,
    };
  }

  if (!Array.isArray(rawList) || rawList.length === 0) {
    return {
      ok: false,
      status: 'error',
      message:
        'wake_on 不能为空：rest 必须至少等待一个条件。若你只是「过一会儿再看」（没有具体条件），用 schedule_wakeup —— 那是定时，不是等待事件。',
    };
  }

  const conditions: RestWakeCondition[] = [];
  const ignored: string[] = [];

  for (const item of rawList) {
    if (!item || typeof item !== 'object') {
      ignored.push('非对象条件');
      continue;
    }
    const o = item as Record<string, unknown>;
    const kind = o['kind'];

    if (kind === 'trigger') {
      const threadRef = typeof o['thread_ref'] === 'string' && o['thread_ref'] ? o['thread_ref'] : undefined;
      // 不指定 threadRef 是合法的：意思是「任何一条流有新 trigger 都叫醒我」。
      conditions.push(threadRef ? { kind: 'trigger', threadRef } : { kind: 'trigger' });
    } else if (kind === 'stage') {
      const threadRef = typeof o['thread_ref'] === 'string' ? o['thread_ref'] : '';
      const stage = typeof o['stage'] === 'string' ? o['stage'] : '';
      if (!threadRef || !stage) {
        ignored.push('stage 条件缺 thread_ref 或 stage');
        continue;
      }
      conditions.push({ kind: 'stage', threadRef, stage });
    } else if (kind === 'timeout') {
      const ms = typeof o['ms'] === 'number' ? o['ms'] : 0;
      if (!(ms > 0)) {
        ignored.push('timeout 条件的 ms 必须 > 0');
        continue;
      }
      conditions.push({ kind: 'timeout', ms });
    } else if (kind === 'dependency') {
      const taskId = typeof o['task_id'] === 'string' ? o['task_id'] : '';
      if (!taskId) {
        ignored.push('dependency 条件缺 task_id');
        continue;
      }
      conditions.push({ kind: 'dependency', taskId });
    } else {
      ignored.push(`未知 kind: ${String(kind)}`);
    }
  }

  if (conditions.length === 0) {
    return {
      ok: false,
      status: 'error',
      message: '没有任何有效条件。',
      ignored,
    };
  }

  const timeoutList = conditions
    .filter((c): c is { kind: 'timeout'; ms: number } => c.kind === 'timeout')
    .map(c => c.ms);
  const fallbackAdded = timeoutList.length === 0;
  const boundedMs = Math.min(
    timeoutList.length > 0 ? Math.min(...timeoutList) : REST_DEFAULT_FALLBACK_MS,
    REST_HARD_MAX_MS,
  );

  return { ok: true, plan: { conditions, ignored, boundedMs, fallbackAdded } };
}
