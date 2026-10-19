import { describe, it, expect } from 'vitest';
import { nextNoSubmitBudget } from '../src/task-service.js';

/**
 * 回归：tsk_7c17a56d45ab9ff49fccd2a9（2026-10-18）
 *
 * 「该提交却没提交」的预算必须**单独计数**。事故现场 8 次尝试里有若干次其实是
 * provider 瞬时错误（deepseek 返回坏 JSON）或执行报错收尾，但旧实现把它们和
 * 「agent 正常收尾却没提交」共用 `_retryAttempt` 一个计数器 —— 一次网络抖动
 * 就等于吃掉一次提交机会，最后把仍在推进的任务判成 failed。
 */
describe('no-submit strike budget', () => {
  const MAX = 8;

  it('counts from 0 and retries the first attempt', () => {
    expect(nextNoSubmitBudget(0, MAX)).toEqual({ strikes: 1, exhausted: false, delayIndex: 0 });
  });

  it('walks the backoff ladder one step per strike', () => {
    expect(nextNoSubmitBudget(1, MAX).delayIndex).toBe(1);
    expect(nextNoSubmitBudget(2, MAX).delayIndex).toBe(2);
  });

  it('is exhausted only at the max strike, not before', () => {
    expect(nextNoSubmitBudget(MAX - 2, MAX).exhausted).toBe(false);
    // 第 MAX 次才判耗尽：MAX-1 已累计 → 本次为第 MAX 次
    const last = nextNoSubmitBudget(MAX - 1, MAX);
    expect(last.strikes).toBe(MAX);
    expect(last.exhausted).toBe(true);
  });

  it('never goes backwards on corrupt input', () => {
    expect(nextNoSubmitBudget(-5, MAX).strikes).toBe(1);
    expect(nextNoSubmitBudget(1.7, MAX).strikes).toBe(2);
  });

  it('treats a non-positive max as unlimited rather than instantly-fatal', () => {
    expect(nextNoSubmitBudget(100, 0).exhausted).toBe(false);
  });
});
