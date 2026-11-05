import { describe, it, expect } from 'vitest';
import {
  NO_APPROVAL_CHANNEL_HINT,
  approvalBlock,
  requireApproval,
  type ApprovalFn,
} from './approval.js';

const REQ = { toolName: 'delete_project', toolArgs: { project_id: 'p1' }, reason: 'test' };

describe('requireApproval — 缺通道必须拒绝（fail-closed）', () => {
  it('回调缺失时拒绝，而不是放行', async () => {
    const outcome = await requireApproval(undefined, REQ);
    expect(outcome.approved).toBe(false);
  });

  it('拒绝时必须给出可行动提示（不能只说"未配置"）', async () => {
    const { comment } = await requireApproval(undefined, REQ);
    expect(comment).toContain(NO_APPROVAL_CHANNEL_HINT);
    // 提示里要有「下一步怎么办」，否则调用方仍然卡住
    expect(comment).toMatch(/Web UI|HITL/);
    // 并且要指出是哪个动作被拒，否则日志里无法定位
    expect(comment).toContain('delete_project');
  });

  it('回调存在且批准 → 放行，comment 原样透传', async () => {
    const fn: ApprovalFn = async () => ({ approved: true });
    const outcome = await requireApproval(fn, REQ);
    expect(outcome.approved).toBe(true);
  });

  it('回调存在且拒绝 → 拒绝，人给的 comment 原样透传', async () => {
    const fn: ApprovalFn = async () => ({ approved: false, comment: '这是生产库，别删' });
    const outcome = await requireApproval(fn, REQ);
    expect(outcome.approved).toBe(false);
    expect(outcome.comment).toBe('这是生产库，别删');
  });

  it('请求原样交给回调（工具名/参数/理由都不丢）', async () => {
    let seen: unknown;
    const fn: ApprovalFn = async (req) => {
      seen = req;
      return { approved: true };
    };
    await requireApproval(fn, REQ);
    expect(seen).toEqual(REQ);
  });
});

describe('approvalBlock — 工具返回值形状统一', () => {
  it('无回调 → 返回 rejected JSON（绝非 null）', async () => {
    const blocked = await approvalBlock(undefined, REQ, 'fallback');
    // null 的含义是「允许继续执行」。这里必须是字符串，否则调用方会继续删数据。
    expect(blocked).not.toBeNull();
    const parsed = JSON.parse(blocked!);
    expect(parsed.status).toBe('rejected');
    expect(parsed.reason).toContain(NO_APPROVAL_CHANNEL_HINT);
  });

  it('批准 → 返回 null（调用方据 null 继续执行）', async () => {
    const fn: ApprovalFn = async () => ({ approved: true });
    expect(await approvalBlock(fn, REQ, 'fallback')).toBeNull();
  });

  it('拒绝且人未留言 → 用调用方给的兜底理由', async () => {
    const fn: ApprovalFn = async () => ({ approved: false });
    const blocked = await approvalBlock(fn, REQ, 'User denied project deletion');
    expect(JSON.parse(blocked!).reason).toBe('User denied project deletion');
  });
});

describe('防退化：这组断言守住的是修复本身', () => {
  it('「回调可选」不等于「没回调就免审批」', async () => {
    // 修复前的写法：if (ctx.requestApproval) { ... }
    //   回调为 undefined → 整个 if 跳过 → 动作直接执行。
    // 这条测试存在的意义：有人把它改回 `if (fn)` 时，上面 5 条会同时变红。
    expect((await requireApproval(undefined, REQ)).approved).toBe(false);
  });
});
