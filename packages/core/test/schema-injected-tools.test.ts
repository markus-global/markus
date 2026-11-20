/**
 * P0-1 回归：schema-injected 工具的 discover 激活路径。
 *
 * 根因（agent-self-management-redesign.md §二 P0-1）：schedule_wakeup /
 * cancel_wakeup / set_heartbeat_interval / recall_activity /
 * notebook_upsert / notebook_clear 由
 * ToolSelector.pushUnique 无条件注入 schema，但 handler 未经过 registerTool
 * 注册（走 agent.ts if-branch dispatch）。预算压力下被驱逐进 Deferred catalog
 * 后，discover_tools 只认注册表 + skillRegistry → 激活永远失败（unknown）。
 *（历史注记：当年清单里还有一个「结束分拣」类工具，它随 Forever Loop M7 一起被删除了，
 * 所以不再出现在这里；本用例锁的是 schema-injected 工具的 discover 激活路径。）
 *
 * 修复：
 *  1. capability-packs 导出 SCHEMA_INJECTED_TOOLS（与 pushUnique 清单同源）
 *  2. agent.ts handleDiscoverTools 对命中该集合的工具走「激活」路径
 *  3. （历史）预算驱逐豁免——驱逐机制已于 PR #471 整体删除，schema-injected 平台工具恒在工具面
 */
import { describe, it, expect } from 'vitest';
import { ToolSelector } from '../src/tool-selector.js';
import {
  SCHEMA_INJECTED_TOOLS,
  TOOL_DEF_PROTECTED,
  type CapabilityPack,
} from '../src/capability-packs.js';

function makeToolMap(names: string[]): Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }> {
  const map = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
  for (const name of names) {
    map.set(name, { name, description: `d ${name}`, inputSchema: { type: 'object', properties: {} } });
  }
  return map;
}

const CORE = ['shell_execute', 'file_read', 'file_write', 'task_create', 'memory_search', 'web_search'];
// 大量“大”工具制造预算压力，逼出驱逐路径（converse 预算 8_000 tokens）
const FILLER = Array.from({ length: 80 }, (_, i) => `tool_${i}`);

const TOOLS = [...CORE, ...FILLER];

function makeBigToolMap(names: string[]): Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }> {
  const map = makeToolMap(names);
  // 给填充工具塞大 schema，确保总预算被撑爆
  for (const name of names) {
    if (name.startsWith('tool_')) {
      map.set(name, {
        name,
        description: `d ${name} `.repeat(40), // ~ 400 chars description
        inputSchema: { type: 'object', properties: { p1: { type: 'string' }, p2: { type: 'string' } } },
      });
    }
  }
  return map;
}

function selectNames(opts: {
  pack?: CapabilityPack;
  activated?: string[];
  recent?: string[];
}): string[] {
  const selector = new ToolSelector();
  return selector
    .selectTools({
      allTools: makeBigToolMap(TOOLS),
      userMessage: 'hello',
      pack: opts.pack ?? 'converse',
      activatedToolNames: opts.activated,
      // recentToolNames 把填充工具真正塞进 schema（否则它们不在 selected 集合，
      // 永远进不了 result → 预算不会被撑爆 → 驱逐路径测不到）
      recentToolNames: opts.recent ?? FILLER,
    })
    .map((t) => t.name);
}

describe('P0-1 · SCHEMA_INJECTED_TOOLS 集合', () => {
  it('覆盖全部 pushUnique 注入的自管理工具（防清单漂移）', () => {
    for (const name of [
      'schedule_wakeup',
      'cancel_wakeup',
      'set_heartbeat_interval',
      'recall_activity',
      'notebook_upsert',
      'notebook_clear',
    ]) {
      expect(SCHEMA_INJECTED_TOOLS.has(name), `missing ${name}`).toBe(true);
    }
  });

  it('与 TOOL_DEF_PROTECTED 独立（各自职责不同）', () => {
    expect(SCHEMA_INJECTED_TOOLS.has('discover_tools')).toBe(false);
    expect(TOOL_DEF_PROTECTED.has('schedule_wakeup')).toBe(false);
  });
});

describe('P0-1 · schema-injected 工具的激活与恒在', () => {
  it('激活的 schema-injected 工具不因预算压力被驱逐', () => {
    const names = selectNames({ activated: ['schedule_wakeup'] });
    expect(names).toContain('schedule_wakeup');
  });

  it('未激活的 schema-injected 平台工具也始终在场（平台工具永不淘汰，Owner 2026-11-20）', () => {
    const names = selectNames({ activated: [] });
    // schedule_wakeup 是一方平台工具 → 永不被预算驱逐：可用性是硬不变量。
    expect(names).toContain('schedule_wakeup');
  });

});