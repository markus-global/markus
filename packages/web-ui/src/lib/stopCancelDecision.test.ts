/**
 * stopSending 的「是否触发后端取消」判定 —— 单一决策源。
 *
 * 缺陷（docs/MESSAGE-STOP-CANCEL-FIX-PLAN.md §2.6 H1）：
 * 旧 `stopSending` 无条件调 `cancelProcessing(agentId, target)`，而 target 在
 * 新会话（无既定 session / PLACEHOLDER）时是 `undefined` —— 请求不带 body →
 * 服务端 `resolveCancelTarget(undefined)` 走 `{ kind: 'root' }` 兼容路径，
 * 取消「当前 ALS/根上下文流」。HTTP 线程没有 ALS，于是这发取消会命中**此刻
 * 正在跑的那条流**（可能是别的会话 / 可能是刚入队那条消息旁的真实流），
 * 造成「两条都处理中 / 第一条没真正处理」。
 *
 * 修法：决策收敛到纯函数 —— 只有**既有会话**才发 scoped 取消（`none` 不误杀）；
 * 占位/无会话 → `skip`（仅前端 abort + 记 userStopped，不触后端）。
 *
 * Pure-function tests only —— 本包无 jsdom。
 */
import { describe, it, expect } from 'vitest';
import { resolveStopCancelDecision } from './stopCancelDecision.ts';

const PH = '__new_chat__';

describe('resolveStopCancelDecision — stopSending 是否触发后端取消', () => {
  it('新会话占位（PLACEHOLDER）→ skip：绝不允许发无 target 的 root 取消', () => {
    expect(resolveStopCancelDecision(PH, PH)).toEqual({ kind: 'skip' });
  });

  it('无既定会话（null / undefined）→ skip', () => {
    expect(resolveStopCancelDecision(null, PH)).toEqual({ kind: 'skip' });
    expect(resolveStopCancelDecision(undefined, PH)).toEqual({ kind: 'skip' });
  });

  it('有既定会话 → scoped 取消 { sessionId }（none 不误杀，安全）', () => {
    expect(resolveStopCancelDecision('sess_abc', PH)).toEqual({
      kind: 'cancel',
      target: { sessionId: 'sess_abc' },
    });
  });

  it('空串会话 → skip（不是合法目标）', () => {
    expect(resolveStopCancelDecision('', PH)).toEqual({ kind: 'skip' });
  });
});