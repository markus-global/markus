import { describe, it, expect } from 'vitest';
import {
  buildResumeMessage,
  buildSubmitReminder,
  MAX_SUBMIT_REMINDER_TURNS,
} from '../src/agent.js';

/**
 * 回归：tsk_7c17a56d45ab9ff49fccd2a9（2026-10-18）
 *
 * 现场：任务 8 轮全部「执行结束但没调 task_submit_review」，最终被判 failed。
 * 实测 transcript 里 `interrupted by a transient error` 出现 56 次，
 * 而「你未提交 / ACTION REQUIRED」出现 **0 次** —— 平台每一轮都在命令模型
 * 「继续干活」，模型于是继续改代码、跑测试，每轮又被判「未提交」。
 *
 * 根因（两个写者）：
 *   ① core 在「有历史」时**无条件**写「上一轮被瞬时错误打断」，
 *      把 TaskService 生成的权威说明（resumeNotice）覆盖掉了；
 *   ② 收尾提醒只发一次 LLM 请求，执行完它的工具就收尾 —— 工具结果不回灌，
 *      模型没有机会「看到自己刚做了什么」再提交。
 */
describe('resume notice has a single writer', () => {
  const authoritative = [
    '## ⚠ CRITICAL — YOU FORGOT TO CALL `task_submit_review`',
    'Your previous execution finished WITHOUT calling `task_submit_review`.',
    'ACTION REQUIRED — Call `task_submit_review` NOW.',
  ].join('\n');

  it('delivers the authoritative notice verbatim', () => {
    expect(buildResumeMessage(authoritative)).toBe(authoritative);
  });

  it('keeps the submit instruction reachable (the defect: it was replaced by "continue")', () => {
    const msg = buildResumeMessage(authoritative);
    expect(msg).toContain('task_submit_review');
    expect(msg).toContain('WITHOUT calling');
  });

  it('never claims a reason it does not own when no notice is provided', () => {
    const fallback = buildResumeMessage(undefined);
    // 这正是现场事故的原句，必须从兜底文本里消失。
    expect(fallback).not.toMatch(/transient error/i);
    expect(fallback).not.toMatch(/network timeout/i);
    expect(fallback).not.toMatch(/CONTINUE from where you left off/i);
    // 仍要保留「续跑但别重做」的语义，且指出真正的出口。
    expect(fallback).toContain('task_submit_review');
  });

  it('ignores blank notices and falls back to the neutral text', () => {
    expect(buildResumeMessage('   \n ')).toBe(buildResumeMessage(undefined));
  });
});

describe('submit reminder phase', () => {
  it('is a bounded multi-turn phase, not a single shot', () => {
    // 1 轮 = 模型把唯一机会用于跑测试就必然落空（事故发生的前提）。
    expect(MAX_SUBMIT_REMINDER_TURNS).toBeGreaterThanOrEqual(2);
    expect(MAX_SUBMIT_REMINDER_TURNS).toBeLessThanOrEqual(5);
  });

  it('states that the round is not complete and names the only accepted endings', () => {
    const msg = buildSubmitReminder({ taskId: 'tsk_x', turn: 1, maxTurns: 3 });
    expect(msg).toContain('tsk_x');
    expect(msg).toContain('(1/3)');
    expect(msg).toContain('task_submit_review');
    expect(msg).toContain('task_update');
  });

  it('surfaces a rejected submit verbatim instead of letting the model guess', () => {
    const err = 'Cannot submit for review: 2 subtask(s) still pending. Pending: "a" (sub_1), "b" (sub_2)';
    const msg = buildSubmitReminder({ taskId: 'tsk_x', turn: 2, maxTurns: 3, submitError: err });
    expect(msg).toContain(err);
    expect(msg).toContain('REJECTED');
  });

  it('does not tell the agent to keep working', () => {
    const msg = buildSubmitReminder({ taskId: 'tsk_x', turn: 1, maxTurns: 3 });
    expect(msg).not.toMatch(/CONTINUE from where you left off/i);
    expect(msg).not.toMatch(/transient error/i);
  });
});
