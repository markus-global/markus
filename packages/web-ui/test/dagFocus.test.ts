import { describe, it, expect } from 'vitest';
import {
  resolveDagNodeClick,
  isRequirementNode,
  reqNodeId,
  visibleIdsInFocus,
  defaultGroupsFor,
} from '../src/lib/dagFocus.ts';

const ACTIVE = new Set(['pending', 'in_progress', 'blocked', 'review']);

const REQ_A = reqNodeId('rq_a');
const REQ_B = reqNodeId('rq_b');

describe('依赖图卡片点击：身份只由「任务/需求」决定，不由图的拓扑决定', () => {
  it('任务卡片在概览态只选中，不改变图', () => {
    expect(resolveDagNodeClick('tsk_1', null, null)).toEqual({ type: 'selectTask' });
  });

  it('任务卡片即使无人阻塞它（旧实现里的 topLevel）也只选中', () => {
    // 这是旧实现的真 bug：孤儿任务曾被当成 topLevel，点一下把整张图切成只剩它自己。
    // 断言咬的是"任务卡片永远不换图"，与它有没有上游无关。
    expect(resolveDagNodeClick('tsk_orphan', null, null)).toEqual({ type: 'selectTask' });
  });

  it('任务卡片在聚焦态里也只选中，不会退出聚焦', () => {
    expect(resolveDagNodeClick('tsk_1', REQ_A, 'rq_a')).toEqual({ type: 'selectTask' });
    expect(resolveDagNodeClick('tsk_1', REQ_A, null)).toEqual({ type: 'selectTask' });
  });

  it('概览态点需求卡片 = 进入聚焦', () => {
    expect(resolveDagNodeClick(REQ_A, null, null)).toEqual({ type: 'focus', nodeId: REQ_A });
  });

  it('聚焦 A 时点关联需求 B = 换焦到 B（不是只换右侧面板）', () => {
    expect(resolveDagNodeClick(REQ_B, REQ_A, 'rq_a')).toEqual({ type: 'focus', nodeId: REQ_B });
  });

  it('再点聚焦根 = 退出聚焦，且面板正显示这张需求时一并关闭', () => {
    expect(resolveDagNodeClick(REQ_A, REQ_A, 'rq_a')).toEqual({
      type: 'unfocus',
      closeRequirementPanel: true,
    });
  });

  it('再点聚焦根时，若面板显示的是聚焦内的任务，任务详情保留', () => {
    // 面板此刻没有在展示需求（selectedReqId=null），所以退出聚焦不碰它。
    expect(resolveDagNodeClick(REQ_A, REQ_A, null)).toEqual({
      type: 'unfocus',
      closeRequirementPanel: false,
    });
  });

  it('再点聚焦根时，若面板显示的是另一个需求，也不关它', () => {
    expect(resolveDagNodeClick(REQ_A, REQ_A, 'rq_b')).toEqual({
      type: 'unfocus',
      closeRequirementPanel: false,
    });
  });

  it('节点 id 约定：需求前缀可判定、可往返', () => {
    expect(isRequirementNode(REQ_A)).toBe(true);
    expect(isRequirementNode('tsk_1')).toBe(false);
    expect(REQ_A.slice(4)).toBe('rq_a');
  });
});

describe('筛选项按层作用域：概览与聚焦各有默认值', () => {
  const ALL = ['todo', 'in_progress', 'review', 'done'];

  it('概览层默认不勾「已完成」（已完成的需求可能成百上千，全铺会把图淹没）', () => {
    const groups = defaultGroupsFor('overview', ALL);
    expect(groups.has('done')).toBe(false);
    expect(groups.has('todo')).toBe(true);
    expect(groups.has('in_progress')).toBe(true);
    expect(groups.has('review')).toBe(true);
  });

  it('聚焦层默认勾上「已完成」（进去就是看这个需求整体做到哪一步）', () => {
    const groups = defaultGroupsFor('focus', ALL);
    expect(groups.has('done')).toBe(true);
    expect(groups.size).toBe(ALL.length);
  });

  it('两层的差异**只有** done，不是顺手把别的组也关掉', () => {
    const overview = defaultGroupsFor('overview', ALL);
    const focus = defaultGroupsFor('focus', ALL);
    const onlyInFocus = [...focus].filter(id => !overview.has(id));
    expect(onlyInFocus).toEqual(['done']);
    expect([...overview].filter(id => !focus.has(id))).toEqual([]);
  });

  it('每组返回新集合，互不共享引用（否则改一层会串到另一层）', () => {
    const a = defaultGroupsFor('focus', ALL);
    a.delete('done');
    expect(defaultGroupsFor('focus', ALL).has('done')).toBe(true);
  });
});

describe('聚焦态可见集：只有当前需求 + 它自己的任务，且受同一套筛选项约束', () => {
  const tasks = [
    { id: 'tsk_a1', requirementId: 'rq_a', status: 'in_progress' },
    { id: 'tsk_a2', requirementId: 'rq_a', status: 'completed' },
    { id: 'tsk_a3', requirementId: 'rq_a', status: 'archived' },
    // 不在 req.taskIds 里，但任务自己指明归属 —— 归档/分页场景的真实形态
    { id: 'tsk_a4', status: 'pending' },
    // 别的需求的任务：即使被 A 依赖也不该出现在 A 的聚焦视图里
    { id: 'tsk_b1', requirementId: 'rq_b', status: 'in_progress' },
    // 没有归属的孤儿任务
    { id: 'tsk_orphan', status: 'pending' },
  ];

  const run = (allowed: Set<string>, showArchived: boolean, taskIds: string[] = ['tsk_a4']) =>
    visibleIdsInFocus({
      focusedNodeId: REQ_A,
      requirementTaskIds: taskIds,
      tasks,
      allowedStatuses: allowed,
      showArchived,
    });

  it('不显示其他需求的任务，也不显示孤儿任务', () => {
    const visible = run(ACTIVE, false);
    expect(visible.has('tsk_b1')).toBe(false);
    expect(visible.has('tsk_orphan')).toBe(false);
    expect(visible.has(REQ_B)).toBe(false);
  });

  it('聚焦需求节点自身永远可见（哪怕它的任务全被筛掉）', () => {
    expect(run(new Set<string>(), false).has(REQ_A)).toBe(true);
  });

  it('筛选项就地生效：未勾「已完成」时完成的任务不显示，勾上就出现', () => {
    expect(run(ACTIVE, false).has('tsk_a2')).toBe(false);
    expect(run(new Set([...ACTIVE, 'completed']), false).has('tsk_a2')).toBe(true);
  });

  it('归档沿用与概览完全相同的两道闸（done 组 + 归档开关），不在这里另立一套', () => {
    const withDone = new Set([...ACTIVE, 'completed']);
    // 只勾 done 组：归档仍不可见——概览里也是这个行为（P1-4 待 Owner 定调）
    expect(run(withDone, false).has('tsk_a3')).toBe(false);
    // done 组 + 归档开关：可见
    expect(run(new Set([...withDone, 'archived']), true).has('tsk_a3')).toBe(true);
    // 只开归档开关、没勾 done 组：静默无效，与概览一致（同一个已知缺陷，不在聚焦里另造一个）
    expect(run(ACTIVE, true).has('tsk_a3')).toBe(false);
  });

  it('任务归属取 taskIds 与 requirementId 的并集（两处各缺一半都不漏）', () => {
    const visible = run(ACTIVE, false);
    expect(visible.has('tsk_a1')).toBe(true); // 靠 requirementId
    expect(visible.has('tsk_a4')).toBe(true); // 靠 req.taskIds
  });
});
