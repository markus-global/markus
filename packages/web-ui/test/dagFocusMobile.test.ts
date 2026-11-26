import { describe, it, expect } from 'vitest';
import { resolveDagNodeClick, reqNodeId } from '../src/lib/dagFocus.ts';

/**
 * 手机端是**三级钻取**，不是桌面那套「再点一次退出」：
 *   概览 → 点卡片 = 进入聚焦（不开详情）
 *   聚焦 → 点卡片 = 打开详情
 *   详情 → 返回键 = 回到聚焦（由 Work 的 popstate 负责，不动聚焦态）
 *   聚焦 → 左上角浮动按钮 = 回概览（唯一出口）
 *
 * 所以这里最重要的一条不变量是：**卡片点击永远不产生 exitFocus**。
 */

const REQ_A = reqNodeId('rq_a');
const REQ_B = reqNodeId('rq_b');

const mobileClick = (
  nodeId: string,
  opts: { focus?: string | null; selected?: string | null; taskRequirement?: string | null } = {},
) =>
  resolveDagNodeClick({
    nodeId,
    focusedNodeId: opts.focus ?? null,
    selectedEntityId: opts.selected ?? null,
    requirementIdOfTask: opts.taskRequirement ?? null,
    profile: 'mobile',
  });

describe('手机端：概览点卡片 = 进入聚焦，且不开详情', () => {
  it('点需求 → 聚焦该需求，select 为 null（不越过聚焦这一级）', () => {
    expect(mobileClick(REQ_A)).toEqual({
      type: 'focusRequirement',
      requirementNodeId: REQ_A,
      select: null,
    });
  });

  it('点该需求下的任务 → 同样只聚焦（不是打开任务详情）', () => {
    expect(mobileClick('tsk_1', { taskRequirement: 'rq_a' })).toEqual({
      type: 'focusRequirement',
      requirementNodeId: REQ_A,
      select: null,
    });
  });

  it('点孤儿任务（无归属需求）→ 没有可进的层，只能开详情', () => {
    expect(mobileClick('tsk_orphan')).toEqual({ type: 'selectTask', taskId: 'tsk_orphan' });
  });
});

describe('手机端：聚焦点卡片 = 打开详情，永不退出聚焦', () => {
  it('点任务 → 详情显示该任务', () => {
    expect(mobileClick('tsk_1', { focus: REQ_A, taskRequirement: 'rq_a' })).toEqual({
      type: 'selectTask',
      taskId: 'tsk_1',
    });
  });

  it('点需求 → 详情显示该需求', () => {
    expect(mobileClick(REQ_A, { focus: REQ_A })).toEqual({
      type: 'selectRequirement',
      requirementId: 'rq_a',
    });
  });

  it('点「面板正显示的那个」也不退出聚焦（桌面的退出判据在手机上不适用）', () => {
    // 桌面在这里返回 exitFocus；手机必须仍然是"打开详情"。
    expect(mobileClick(REQ_A, { focus: REQ_A, selected: 'rq_a' })).toEqual({
      type: 'selectRequirement',
      requirementId: 'rq_a',
    });
    expect(mobileClick('tsk_1', { focus: REQ_A, selected: 'tsk_1', taskRequirement: 'rq_a' })).toEqual({
      type: 'selectTask',
      taskId: 'tsk_1',
    });
  });

  it('点别的需求（跨需求依赖带进来的引用卡）→ 只切详情，不换焦', () => {
    expect(mobileClick(REQ_B, { focus: REQ_A, selected: 'rq_a' })).toEqual({
      type: 'selectRequirement',
      requirementId: 'rq_b',
    });
  });
});

describe('手机端不变量：任何卡片点击都不会退出聚焦', () => {
  it('穷举"聚焦态 × 各种选中状态 × 需求/任务/孤儿"都不产生 exitFocus', () => {
    const nodes = [REQ_A, REQ_B, 'tsk_1', 'tsk_orphan'];
    const selections: (string | null)[] = [null, 'rq_a', 'rq_b', 'tsk_1'];
    const taskReqs: (string | null)[] = [null, 'rq_a', 'rq_b'];
    const offenders: string[] = [];
    for (const nodeId of nodes) {
      for (const selected of selections) {
        for (const taskRequirement of taskReqs) {
          const action = mobileClick(nodeId, { focus: REQ_A, selected, taskRequirement });
          if (action.type === 'exitFocus') {
            offenders.push(`${nodeId}/selected=${selected}/taskReq=${taskRequirement}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
