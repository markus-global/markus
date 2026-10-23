/**
 * toolApproval 回归护栏 —— 哪些审批该冒到聊天输入框上方。
 *
 * 用户报障：Git 之类的工具审批只在通知浮窗里，用户没看到 → Agent 一直卡住。
 * 修法是复用 request_user_input 的近场横幅，但**只能**放工具审批进去，不能把
 * task / requirement 这类结构化审批也塞进聊天输入框（那是工作台的活）。
 *
 * 判据 = `details.toolName` 存在 且 无 questions 且 type==='action'。这里把
 * 三种「看起来像审批但不应出现」的负例都钉住。
 */
import { describe, it, expect } from 'vitest';
import { isToolExecutionApproval, selectToolApprovals, type ApprovalLike } from '../src/lib/toolApproval.ts';

const toolApproval = (over: Partial<ApprovalLike> = {}): ApprovalLike => ({
  id: 'ap1',
  agentId: 'agt_a',
  type: 'action',
  status: 'pending',
  details: { toolName: 'shell_execute', command: 'git push origin main', agentId: 'agt_a' },
  ...over,
});

describe('isToolExecutionApproval', () => {
  it('工具执行审批 → true', () => {
    expect(isToolExecutionApproval(toolApproval())).toBe(true);
  });

  it('带 questions 的 request_user_input → false（另有 UI 通道）', () => {
    expect(
      isToolExecutionApproval(toolApproval({ questions: [{ id: 'q1', prompt: 'x' }] })),
    ).toBe(false);
  });

  it('无 toolName 的结构化审批（task/requirement）→ false', () => {
    expect(
      isToolExecutionApproval(toolApproval({ details: { subType: 'task', taskId: 'tsk_1' } })),
    ).toBe(false);
  });

  it('非 action 类型 → false', () => {
    expect(isToolExecutionApproval(toolApproval({ type: 'plan' }))).toBe(false);
  });

  it('已响应（非 pending）→ false', () => {
    expect(isToolExecutionApproval(toolApproval({ status: 'approved' }))).toBe(false);
  });

  it('空值 → false', () => {
    expect(isToolExecutionApproval(null)).toBe(false);
    expect(isToolExecutionApproval(undefined)).toBe(false);
  });
});

describe('selectToolApprovals', () => {
  it('按 agentId 过滤（details.agentId 优先于顶层）', () => {
    const mine = toolApproval({ id: 'mine', details: { toolName: 'shell_execute', agentId: 'agt_a' } });
    const other = toolApproval({ id: 'other', agentId: 'agt_b', details: { toolName: 'shell_execute', agentId: 'agt_b' } });
    const got = selectToolApprovals([mine, other], { agentId: 'agt_a' });
    expect(got.map((a) => a.id)).toEqual(['mine']);
  });

  /**
   * 这条用例原来断言「sessionId 不符 → 排除」。夹具用 `sess_1` 对 `sess_1`，
   * 即**同一个 id 空间**，所以它一直绿；生产里载荷写的是 `sess_…`（内存会话）、
   * UI 传的是 `cs_…`（DB 会话），永远不相等 → 2026-10-11 起所有工具审批都被
   * 过滤掉，只剩通知铃铛（事故复盘见 src/lib/toolApproval.ts 头注释）。
   *
   * 正确的不变量：**工具审批阻塞 Agent 回合，作用域只能决定顺序，不能决定可见性**。
   */
  it('会话归属：不同会话的审批仍然可见，只影响排序', () => {
    const here = toolApproval({ id: 'here', details: { toolName: 'shell_execute', agentId: 'agt_a', sessionId: 'sess_1' } });
    const elsewhere = toolApproval({ id: 'elsewhere', details: { toolName: 'shell_execute', agentId: 'agt_a', sessionId: 'sess_2' } });
    const got = selectToolApprovals([elsewhere, here], { agentId: 'agt_a', sessionId: 'sess_1' });
    expect(got.map((a) => a.id)).toEqual(['here', 'elsewhere']);
  });

  it('跨 id 命名空间：载荷 sess_… 在 cs_… 会话视图里依然可见（本次事故的形态）', () => {
    const real = toolApproval({
      id: 'real',
      details: { toolName: 'shell_execute', agentId: 'agt_a', sessionId: 'sess_1792327845728_p0getw' },
    });
    const got = selectToolApprovals([real], { agentId: 'agt_a', sessionId: 'cs_9809eb465fec4577' });
    expect(got.map((a) => a.id)).toEqual(['real']);
  });

  it('本地优先：chatSessionId（cs_…）命中的排到最前，其余不丢', () => {
    const foreign = toolApproval({ id: 'foreign', details: { toolName: 'shell_execute', agentId: 'agt_a', chatSessionId: 'cs_other' } });
    const local = toolApproval({ id: 'local', details: { toolName: 'shell_execute', agentId: 'agt_a', chatSessionId: 'cs_9809eb465fec4577' } });
    const got = selectToolApprovals([foreign, local], { agentId: 'agt_a', sessionId: 'cs_9809eb465fec4577' });
    expect(got.map((a) => a.id)).toEqual(['local', 'foreign']);
  });

  it('别的 Agent 的审批不冒到这条聊天里（可见性的唯一硬边界）', () => {
    const other = toolApproval({ id: 'other', agentId: 'agt_b', details: { toolName: 'shell_execute', agentId: 'agt_b', sessionId: 'sess_1' } });
    expect(selectToolApprovals([other], { agentId: 'agt_a', sessionId: 'sess_1' })).toHaveLength(0);
  });

  it('会话归属：旧数据无 sessionId → 退回按 agentId 匹配（仍显示）', () => {
    const legacy = toolApproval({ id: 'legacy', details: { toolName: 'shell_execute', agentId: 'agt_a' } });
    const got = selectToolApprovals([legacy], { agentId: 'agt_a', sessionId: 'sess_1' });
    expect(got.map((a) => a.id)).toEqual(['legacy']);
  });

  it('没有活动会话时不做会话过滤', () => {
    const a = toolApproval({ id: 'a', details: { toolName: 'shell_execute', agentId: 'agt_a', sessionId: 'sess_9' } });
    const got = selectToolApprovals([a], { agentId: 'agt_a', sessionId: null });
    expect(got.map((x) => x.id)).toEqual(['a']);
  });

  it('结构化审批 / user-input 审批不会被选中', () => {
    const structural = toolApproval({ id: 'st', details: { subType: 'task', taskId: 'tsk_1' } });
    const userInput = toolApproval({ id: 'ui', questions: [{ id: 'q' }] });
    const tool = toolApproval({ id: 'tool' });
    const got = selectToolApprovals([structural, userInput, tool], { agentId: 'agt_a' });
    expect(got.map((a) => a.id)).toEqual(['tool']);
  });
});
