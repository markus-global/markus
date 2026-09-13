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
