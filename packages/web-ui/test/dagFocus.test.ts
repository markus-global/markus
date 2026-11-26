import { describe, it, expect } from 'vitest';
import {
  resolveDagNodeClick,
  isRequirementNode,
  reqNodeId,
  visibleIdsInFocus,
  defaultGroupsFor,
  tasksOfRequirement,
  countArchivedTasks,
} from '../src/lib/dagFocus.ts';

const ACTIVE = new Set(['pending', 'in_progress', 'blocked', 'review']);

const REQ_A = reqNodeId('rq_a');
const REQ_B = reqNodeId('rq_b');

describe('卡片点击：含义由「点的是不是面板里那个」决定，与拓扑、与谁是聚焦根无关', () => {
  const click = (
    nodeId: string,
    opts: { focus?: string | null; selected?: string | null; taskRequirement?: string | null } = {},
  ) =>
    resolveDagNodeClick({
      nodeId,
      focusedNodeId: opts.focus ?? null,
      selectedEntityId: opts.selected ?? null,
      requirementIdOfTask: opts.taskRequirement ?? null,
    });

  it('概览：点需求 = 进入该需求，面板显示需求', () => {
    expect(click(REQ_A)).toEqual({
      type: 'focusRequirement',
      requirementNodeId: REQ_A,
      select: { kind: 'requirement', requirementId: 'rq_a' },
    });
  });

  it('概览：点该需求下的任意任务 = 进入该需求，但面板显示被点的任务', () => {
    expect(click('tsk_1', { taskRequirement: 'rq_a' })).toEqual({
      type: 'focusRequirement',
      requirementNodeId: REQ_A,
      select: { kind: 'task', taskId: 'tsk_1' },
    });
  });

  it('概览：孤儿任务没有可进的层，只开面板', () => {
    expect(click('tsk_orphan')).toEqual({ type: 'selectTask', taskId: 'tsk_orphan' });
  });

  it('概览：即使它已被选中，点它仍然进入聚焦（退出只在聚焦态成立）', () => {
    expect(click(REQ_A, { selected: 'rq_a' })).toEqual({
      type: 'focusRequirement',
      requirementNodeId: REQ_A,
      select: { kind: 'requirement', requirementId: 'rq_a' },
    });
  });

  it('聚焦：再点面板里那个需求 = 整体退出聚焦', () => {
    expect(click(REQ_A, { focus: REQ_A, selected: 'rq_a' })).toEqual({ type: 'exitFocus' });
  });

  it('聚焦：再点面板里那个**任务** = 也整体退出聚焦（不区分需求/任务）', () => {
    expect(click('tsk_1', { focus: REQ_A, selected: 'tsk_1', taskRequirement: 'rq_a' })).toEqual({
      type: 'exitFocus',
    });
  });

  it('聚焦、面板显示任务时点需求 = 只切面板，不退出聚焦（Owner 报的那个 bug）', () => {
    expect(click(REQ_A, { focus: REQ_A, selected: 'tsk_1' })).toEqual({
      type: 'selectRequirement',
      requirementId: 'rq_a',
    });
  });

  it('聚焦、面板显示需求时点任务 = 只切面板，不退出聚焦', () => {
    expect(click('tsk_1', { focus: REQ_A, selected: 'rq_a', taskRequirement: 'rq_a' })).toEqual({
      type: 'selectTask',
      taskId: 'tsk_1',
    });
  });

  it('聚焦：点同需求内的另一个任务 = 只切面板', () => {
    expect(click('tsk_2', { focus: REQ_A, selected: 'tsk_1', taskRequirement: 'rq_a' })).toEqual({
      type: 'selectTask',
      taskId: 'tsk_2',
    });
  });

  it('聚焦：点别的需求（跨需求依赖带进来的引用卡）= 只切面板，不换焦', () => {
    expect(click(REQ_B, { focus: REQ_A, selected: 'rq_a' })).toEqual({
      type: 'selectRequirement',
      requirementId: 'rq_b',
    });
  });

  it('退出聚焦不携带任何面板指令：聚焦与面板开关互相独立', () => {
    const action = click(REQ_A, { focus: REQ_A, selected: 'rq_a' });
    expect(action.type).toBe('exitFocus');
    // 只有 `type` 一个字段。谁想在这里顺手关面板（加 closePanel / select），
    // 这条断言立即变红 —— 那两个状态属于两个主人，不能由一个动作发两个命令。
    expect(Object.keys(action)).toEqual(['type']);
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

describe('「N 个已归档」按当前层取数', () => {
  const tasks = [
    { id: 'tsk_a1', requirementId: 'rq_a', status: 'archived' },
    { id: 'tsk_a2', requirementId: 'rq_a', status: 'in_progress' },
    { id: 'tsk_a3', status: 'archived' }, // 不在 taskIds，靠 requirementId 归属
    { id: 'tsk_b1', requirementId: 'rq_b', status: 'archived' },
    { id: 'tsk_orphan', status: 'archived' },
  ];

  it('概览（scope=null）：数整张图的已归档任务', () => {
    expect(countArchivedTasks(tasks, null)).toBe(4);
  });

  it('聚焦：只数该需求自己的已归档任务，不把别的需求/孤儿算进去', () => {
    // 这是 Owner 报的那个 bug：之前全局数，给了 4。
    expect(countArchivedTasks(tasks, { requirementId: 'rq_a', requirementTaskIds: ['tsk_a3'] })).toBe(2);
  });

  it('计数与可见集用同一个归属谓词（两边不会对不上）', () => {
    const scope = { requirementId: 'rq_a', requirementTaskIds: ['tsk_a3'] };
    const own = tasksOfRequirement(tasks, scope.requirementId, scope.requirementTaskIds).map(t => t.id);
    expect(own).toEqual(['tsk_a1', 'tsk_a2', 'tsk_a3']);
    expect(countArchivedTasks(tasks, scope)).toBe(own.filter(id => tasks.find(t => t.id === id)!.status === 'archived').length);
  });

  it('没有任何已归档任务时给 0（按钮因此不渲染）', () => {
    const fresh = [{ id: 'tsk_x', requirementId: 'rq_a', status: 'pending' }];
    expect(countArchivedTasks(fresh, { requirementId: 'rq_a', requirementTaskIds: [] })).toBe(0);
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
