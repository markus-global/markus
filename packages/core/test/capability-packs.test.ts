import {
  scenarioToPack,
  packToolDefBudget,
  getReflexAllowlist,
  getDistillationAllowlist,
  CONVERSE_FORBIDDEN_DEFAULT,
  estimateToolDefTokens,
  evictToolsToBudget,
  formatEvictedToolCatalog,
  TOOL_DEF_PROTECTED,
  REFLEX_CORE_TOOLS,
} from '../src/capability-packs.js';
import {
  TOOL_DEF_BUDGET_REFLEX,
  TOOL_DEF_BUDGET_CONVERSE,
  TOOL_DEF_BUDGET_EXECUTE,
  DEFERRED_CATALOG_MAX_CHARS,
} from '@markus/shared';
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

  it('A-pack-execute-has-code: task_execution maps to execute pack with larger budget', () => {
    expect(scenarioToPack('task_execution')).toBe('execute');
    expect(packToolDefBudget('execute')).toBe(TOOL_DEF_BUDGET_EXECUTE);
    expect(packToolDefBudget('execute')).toBeGreaterThan(packToolDefBudget('converse'));
  });

  it('maps heartbeat/review scenarios', () => {
    expect(scenarioToPack('heartbeat')).toBe('reflex');
    expect(scenarioToPack('review')).toBe('govern');
    expect(packToolDefBudget('reflex')).toBe(TOOL_DEF_BUDGET_REFLEX);
    expect(packToolDefBudget('converse')).toBe(TOOL_DEF_BUDGET_CONVERSE);
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

describe('toolDef eviction (AGENT-RUNTIME §5)', () => {
  it('A-tooldef-budget: evicts large extras under budget; keeps protected', () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(80) }]),
      ),
    };
    const tools = [
      { name: 'discover_tools', description: 'discover', inputSchema: { type: 'object', properties: {} } },
      { name: 'notify_user', description: 'notify', inputSchema: { type: 'object', properties: {} } },
      ...Array.from({ length: 30 }, (_, i) => ({
        name: `huge_tool_${i}`,
        description: `Huge tool ${i} for testing eviction budgets and catalog demotion`,
        inputSchema: bigSchema,
      })),
    ];
    const before = estimateToolDefTokens(tools);
    expect(before).toBeGreaterThan(TOOL_DEF_BUDGET_CONVERSE);

    const { tools: kept, evicted } = evictToolsToBudget(tools, TOOL_DEF_BUDGET_CONVERSE);
    expect(estimateToolDefTokens(kept)).toBeLessThanOrEqual(TOOL_DEF_BUDGET_CONVERSE);
    expect(kept.some((t) => t.name === 'discover_tools')).toBe(true);
    expect(kept.some((t) => t.name === 'notify_user')).toBe(true);
    expect(evicted.length).toBeGreaterThan(0);
    expect(evicted.every((e) => !TOOL_DEF_PROTECTED.has(e.name))).toBe(true);
    expect(evicted[0]!.description.length).toBeLessThanOrEqual(60);
  });

  it('A-tooldef-sticky-capped: repeated recent activations still fit converse budget', () => {
    const mk = (name: string) => ({
      name,
      description: `Tool ${name}`,
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'string', description: 'y'.repeat(200) } },
      },
    });
    let tools = [mk('discover_tools'), mk('notify_user'), mk('task_list')];
    for (let round = 0; round < 10; round++) {
      tools.push(mk(`recent_${round}_a`), mk(`recent_${round}_b`), mk(`recent_${round}_c`));
      const { tools: capped } = evictToolsToBudget(tools, TOOL_DEF_BUDGET_CONVERSE);
      expect(estimateToolDefTokens(capped)).toBeLessThanOrEqual(TOOL_DEF_BUDGET_CONVERSE);
      tools = capped;
    }
  });

  it('S-tooldef-evict-mcp-before-core: feishu/chrome defer before shell/file', () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(80) }]),
      ),
    };
    const small = { type: 'object', properties: {} };
    const tools = [
      { name: 'discover_tools', description: 'discover', inputSchema: small },
      { name: 'notify_user', description: 'notify', inputSchema: small },
      { name: 'shell_execute', description: 'run shell', inputSchema: bigSchema },
      { name: 'file_read', description: 'read files', inputSchema: bigSchema },
      { name: 'task_create', description: 'create task', inputSchema: bigSchema },
      ...Array.from({ length: 20 }, (_, i) => ({
        name: `feishu_calendar_${i}`,
        description: `Feishu calendar tool ${i}`,
        inputSchema: bigSchema,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `chrome-devtools__nav_${i}`,
        description: `Chrome nav ${i}`,
        inputSchema: bigSchema,
      })),
    ];
    expect(estimateToolDefTokens(tools)).toBeGreaterThan(TOOL_DEF_BUDGET_CONVERSE);
    const { tools: kept, evicted } = evictToolsToBudget(tools, TOOL_DEF_BUDGET_CONVERSE);
    expect(estimateToolDefTokens(kept)).toBeLessThanOrEqual(TOOL_DEF_BUDGET_CONVERSE);
    expect(kept.some((t) => t.name === 'shell_execute')).toBe(true);
    expect(kept.some((t) => t.name === 'file_read')).toBe(true);
    expect(kept.some((t) => t.name === 'task_create')).toBe(true);
    expect(evicted.some((e) => e.name.startsWith('feishu_') || e.name.includes('__'))).toBe(true);
  });

  it('S-reflex-eviction-not-all-protected: reflex can drop large allowlist tools under budget', () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`field_${i}`, { type: 'string', description: 'z'.repeat(100) }]),
      ),
    };
    const tools = [
      { name: 'discover_tools', description: 'discover', inputSchema: { type: 'object', properties: {} } },
      { name: 'notify_user', description: 'notify', inputSchema: { type: 'object', properties: {} } },
      { name: 'file_read', description: 'read files', inputSchema: bigSchema },
      { name: 'memory_search', description: 'search mem', inputSchema: bigSchema },
      { name: 'task_list', description: 'list tasks', inputSchema: bigSchema },
    ];
    const { tools: kept, evicted } = evictToolsToBudget(
      tools,
      TOOL_DEF_BUDGET_REFLEX,
      new Set(TOOL_DEF_PROTECTED),
    );
    expect(estimateToolDefTokens(kept)).toBeLessThanOrEqual(TOOL_DEF_BUDGET_REFLEX);
    expect(kept.some((t) => t.name === 'discover_tools')).toBe(true);
    expect(evicted.length).toBeGreaterThan(0);
  });

  it('S-catalog-not-in-tooldef: eviction catalog stays out of discover_tools.description', () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(80) }]),
      ),
    };
    const selector = new ToolSelector();
    const allTools = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
    for (const name of ['discover_tools', 'notify_user', 'request_user_input', 'task_list', 'memory_search']) {
      allTools.set(name, { name, description: `${name} desc`, inputSchema: { type: 'object', properties: {} } });
    }
    for (let i = 0; i < 25; i++) {
      const name = `huge_tool_${i}`;
      allTools.set(name, {
        name,
        description: `Huge tool ${i} with a long description that must not bloat tool defs after eviction`,
        inputSchema: bigSchema,
      });
    }
    // Force keyword activation of many huge tools via recentToolNames
    const recent = Array.from({ length: 25 }, (_, i) => `huge_tool_${i}`);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'hello',
      pack: 'converse',
      recentToolNames: recent,
    });
    expect(estimateToolDefTokens(selected)).toBeLessThanOrEqual(TOOL_DEF_BUDGET_CONVERSE);
    const discover = selected.find((t) => t.name === 'discover_tools');
    expect(discover).toBeTruthy();
    expect(discover!.description).not.toMatch(/Deferred for budget/i);
    expect(discover!.description).not.toMatch(/huge_tool_0:/);
    const deferred = selector.consumeDeferredCatalog();
    expect(deferred.length).toBeGreaterThan(0);
    const catalog = formatEvictedToolCatalog(deferred);
    expect(catalog.length).toBeLessThanOrEqual(DEFERRED_CATALOG_MAX_CHARS);
    expect(catalog).toMatch(/Deferred Tools/);
    // name-only / short: no multi-hundred-char descriptions
    expect(catalog).not.toMatch(/must not bloat tool defs after eviction/);
  });
});
