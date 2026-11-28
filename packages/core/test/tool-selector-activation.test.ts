/**
 * P1-12 回归：`deliverable_create` 在 converse/govern 下「未激活则剔除、已激活则放行」。
 *
 * 审计 P1-12：CONVERSE_FORBIDDEN_DEFAULT 的 splice 发生在 activated 注入**之后**，
 * 旧实现把「已被 discover_tools 显式激活」的 deliverable_create 也无条件剔除
 * → 激活成功却永远拿不到（与 P0-3 同族的「激活被静默回退」）。
 */
import { describe, it, expect } from 'vitest';
import { ToolSelector } from '../src/tool-selector.js';

function makeToolMap(names: string[]): Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }> {
  const map = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
  for (const name of names) {
    map.set(name, { name, description: `d ${name}`, inputSchema: { type: 'object', properties: {} } });
  }
  return map;
}

const TOOLS = [
  'deliverable_create', 'deliverable_search', 'agent_send_message', 'task_create',
  'memory_search', 'shell_execute', 'file_read', 'web_search', 'spawn_subagent',
];

describe('work family (requirements + milestones + tasks) travels together', () => {
  const REQ = ['requirement_propose', 'requirement_list', 'requirement_update', 'requirement_comment'];
  const MS = ['milestone_list', 'milestone_create', 'milestone_update', 'milestone_delete', 'milestone_assign'];
  const TK = ['task_create', 'task_list', 'task_note'];
  const TOOLS2 = [...REQ, ...MS, ...TK, 'list_projects', 'get_project', 'create_project', 'project_stats', 'agent_send_message', 'shell_execute'];
  const face = (msg: string) => new ToolSelector()
    .selectTools({ allTools: makeToolMap(TOOLS2), userMessage: msg, pack: 'converse' })
    .map((t) => t.name);

  it('a message about 里程碑 / milestone brings the WHOLE family', () => {
    for (const msg of ['帮我看下这个里程碑的进度', 'add a milestone for phase 2', '现在这个阶段还差什么']) {
      const names = face(msg);
      expect(names, msg).toContain('milestone_list');
      // The seam we are guarding: milestone without requirement tools is half a toolkit —
      // creating a checkpoint is followed immediately by attaching requirements.
      expect(names, msg).toContain('requirement_list');
    }
  });

  it('a message about 需求 also brings the milestone tools', () => {
    const names = face('把这个需求排到第二阶段');
    expect(names).toContain('requirement_propose');
    expect(names).toContain('milestone_assign');
  });

  it('a message about 项目 / project also brings the whole family (project tools had no home at all)', () => {
    for (const msg of ['这个项目现在什么情况', 'which project should own this milestone']) {
      const names = face(msg);
      expect(names, msg).toContain('list_projects');
      expect(names, msg).toContain('milestone_list');
      expect(names, msg).toContain('requirement_list');
    }
  });

  it('an unrelated message drags in neither (the group really gates)', () => {
    const names = face('hello there');
    expect(names).not.toContain('milestone_list');
    expect(names).not.toContain('requirement_propose');
  });

  it('a task-execution turn sees the milestone tools it needs to place work in a phase', () => {
    const names = new ToolSelector()
      .selectTools({ allTools: makeToolMap(TOOLS2), userMessage: 'work on it', pack: 'converse', isTaskExecution: true })
      .map((t) => t.name);
    expect(names).toContain('milestone_list');
    expect(names).toContain('milestone_assign');
  });
});

describe('P1-12 · deliverable_create 在 converse 下的激活语义', () => {
  it('未激活 → converse 下被剔除（保持 discover-only）', () => {
    const selector = new ToolSelector();
    const names = selector
      .selectTools({ allTools: makeToolMap(TOOLS), userMessage: 'hello', pack: 'converse' })
      .map((t) => t.name);
    expect(names).not.toContain('deliverable_create');
  });

  it('已激活 → 必须放行（不能在 activated 注入后被 splice 掉）', () => {
    const selector = new ToolSelector();
    const names = selector
      .selectTools({
        allTools: makeToolMap(TOOLS),
        userMessage: 'hello',
        pack: 'converse',
        activatedToolNames: ['deliverable_create'],
      })
      .map((t) => t.name);
    expect(names).toContain('deliverable_create');
  });
});
