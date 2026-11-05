/**
 * 流事件 → rest 等待者的投递总线。
 *
 * ## 为什么需要这个文件
 *
 * 上一轮建好了 `takeRestMatches()`（算出「谁被这个事件命中」），但它**没有投递能力**；
 * 而 `deliverCallback()` 能投递，却只认「到期的 wakeup」。两者之间原来没有人接。
 *
 * 后果是 rest 的 `trigger / stage / dependency` 三类条件永远不命中 ——
 * 不报错、不告警，agent 只是永远不醒，最后靠 timeout 兜底才被叫起来，
 * 而那时已经晚了。这正是「存在且可测」和「端到端跑通」的区别。
 *
 * ## 为什么用「注册投递器」而不是直接 import Agent
 *
 * core 里 Agent 与 bus 是同级模块，直接互相引用会成环。更重要的是：
 * 注册一个函数后，测试里只要一个 spy 就能验「事件进来后谁被叫醒、载荷内容是什么」，
 * 不需要构造真 agent —— 而「载荷里塞了历史正文」正是最该被守住的那条。
 */
import { pendingCallbackRegistry, type PendingCallback } from './pending-callback.js';
import { buildWakePayload, type WakeEvent } from './rest-wake.js';

export type ThreadWakeDeliverer = (matched: PendingCallback, event: WakeEvent, payload: string) => void;

let deliverer: ThreadWakeDeliverer | undefined;

/**
 * 由组合根注入一次（AgentManager 构造时）。
 *
 * 传 `undefined` 可清空 —— 测试之间必须能重置，否则前一个用例注册的 spy 会污染下一个，
 * 而那种污染看起来像「本用例通过了」。
 */
export function setThreadWakeDeliverer(fn: ThreadWakeDeliverer | undefined): void {
  deliverer = fn;
}

/**
 * 发出一个流事件，返回被唤醒的等待者数量。
 *
 * **没有投递器时直接返回、不 take**：`takeRestMatches` 会顺手 resolve（删掉）等待者，
 * 若此时没人能投递，等待者就被静默吞掉了 —— 比不唤醒更坏，因为 timeout 兜底也没了，
 * 它会永久消失。所以宁可留着（等 timeout 兜底），也不要在没有出路时把它取走。
 */
export function emitThreadWake(event: WakeEvent): number {
  if (!deliverer) return 0;
  const matched = pendingCallbackRegistry.takeRestMatches(event);
  if (matched.length === 0) return 0;

  for (const cb of matched) {
    try {
      deliverer(cb, event, buildWakePayload(event, cb.note));
    } catch {
      // 一个投递失败不该拖累同批其他人 —— 它们等的是同一个事件，但各自独立。
    }
  }
  return matched.length;
}

/** 仅供测试：读取当前是否已注册投递器。 */
export function hasThreadWakeDeliverer(): boolean {
  return deliverer !== undefined;
}
