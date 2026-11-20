import {
  scenarioToPack,
  getReflexAllowlist,
  getDistillationAllowlist,
  CONVERSE_FORBIDDEN_DEFAULT,
  REFLEX_CORE_TOOLS,
} from '../src/capability-packs.js';
import { ToolSelector } from '../src/tool-selector.js';

describe('capability packs (AGENT-RUNTIME §2)', () => {
  it('A-pack-reflex-tools: reflex allowlist excludes package/goal/spawn', () => {
    const allow = getReflexAllowlist(false);
    for (const t of REFLEX_CORE_TOOLS) expect(allow.has(t)).toBe(true);
    expect(allow.has('package_install')).toBe(false);
    expect(allow.has('goal_create')).toBe(false);
    expect(allow.has('spawn_subagent')).toBe(false);
    expect(allow.has('spawn_subagents')).toBe(false);
    expect(allow.has('deliverable_create')).toBe(false);
    expect(getReflexAllowlist(true).has('team_status')).toBe(true);
  });

  it('A-pack-converse-no-deliverable: converse forbids deliverable_create but allows spawn_subagents', () => {
    expect(CONVERSE_FORBIDDEN_DEFAULT.has('spawn_subagents')).toBe(false);
    expect(CONVERSE_FORBIDDEN_DEFAULT.has('deliverable_create')).toBe(true);
    expect(scenarioToPack('chat')).toBe('converse');
  });

  it('A-pack-execute-has-code: task_execution maps to the execute pack', () => {
    expect(scenarioToPack('task_execution')).toBe('execute');
  });

  it('maps heartbeat/review scenarios', () => {
    // 心跳与普通 session 同级能力（converse）——约束由 HEARTBEAT.md + 间隔承担
    expect(scenarioToPack('heartbeat')).toBe('converse');
    expect(scenarioToPack('review')).toBe('govern');
  });

  it('B-distill-uses-distillation-scenario / B-distill-package-install-allowed: distillation pack + install tools', () => {
    expect(scenarioToPack('distillation')).toBe('reflex');
    const allow = getDistillationAllowlist(false);
    expect(allow.has('memory_save')).toBe(true);
    expect(allow.has('memory_update')).toBe(true);
    expect(allow.has('file_write')).toBe(true);
    expect(allow.has('package_install')).toBe(true);
    expect(allow.has('package_list')).toBe(true);
    expect(allow.has('request_user_input')).toBe(true);
    expect(allow.has('hub_install')).toBe(false);
    expect(getReflexAllowlist(false).has('package_install')).toBe(false);
  });
});

describe('tool face is never shrunk for size (AGENT-RUNTIME §5, Owner 2026-11-20)', () => {
  it('activated external tools + first-party anchors all survive a face far beyond any former budget', () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(80) }]),
      ),
    };
    const map = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
    for (const n of ['discover_tools', 'notify_user', 'task_list']) {
      map.set(n, { name: n, description: `d ${n}`, inputSchema: { type: 'object', properties: {} } });
    }
    const activated: string[] = [];
    for (let i = 0; i < 30; i++) {
      const n = `feishu_tool_${i}`;
      activated.push(n);
      map.set(n, { name: n, description: `Feishu tool ${i}`, inputSchema: bigSchema });
    }
    const selector = new ToolSelector();
    const face = selector.selectTools({ allTools: map, userMessage: 'hello', pack: 'converse', activatedToolNames: activated });
    const names = face.map((t) => t.name);
    // Pressure self-check: far beyond the former converse budget (8k tokens).
    expect(Math.ceil(JSON.stringify(face).length / 3.5)).toBeGreaterThan(8_000);
    // Nothing is dropped: every activated external tool and every anchor stays.
    for (const n of activated) expect(names).toContain(n);
    expect(names).toContain('discover_tools');
    expect(names).toContain('notify_user');
    expect(names).toContain('task_list');
  });
});
