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
    // 心跳与普通 session 同级能力（converse）——约束由 HEARTBEAT.md + 间隔承担
    expect(scenarioToPack('heartbeat')).toBe('converse');
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
      // Optional EXTERNAL tools are the only legal eviction victims.
      ...Array.from({ length: 30 }, (_, i) => ({
        name: `feishu_tool_${i}`,
        description: `Feishu tool ${i} for testing eviction budgets and catalog demotion`,
        inputSchema: bigSchema,
      })),
    ];
    const before = estimateToolDefTokens(tools);
    expect(before).toBeGreaterThan(TOOL_DEF_BUDGET_CONVERSE);

    const { tools: kept, evicted } = evictToolsToBudget(tools, TOOL_DEF_BUDGET_CONVERSE);
    expect(kept.some((t) => t.name === 'discover_tools')).toBe(true);
    expect(kept.some((t) => t.name === 'notify_user')).toBe(true);
    expect(evicted.length).toBeGreaterThan(0);
    // Eviction only ever takes optional external tools (skill/MCP names).
    expect(evicted.every((e) => e.name.startsWith('feishu_') || e.name.includes('__'))).toBe(true);
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
      // External tools are the evictable ones — accumulate them, they must not pile up unbounded.
      tools.push(mk(`feishu_recent_${round}_a`), mk(`feishu_recent_${round}_b`), mk(`feishu_recent_${round}_c`));
      const { tools: capped } = evictToolsToBudget(tools, TOOL_DEF_BUDGET_CONVERSE);
      // First-party anchors are never evicted; the external set is capped to budget.
      expect(capped.some((t) => t.name === 'discover_tools')).toBe(true);
      expect(capped.some((t) => t.name === 'task_list')).toBe(true);
      expect(estimateToolDefTokens(capped.filter((t) => t.name.startsWith('feishu_recent_')))).toBeLessThanOrEqual(TOOL_DEF_BUDGET_CONVERSE);
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
    // First-party core tools are eviction-immune (only external skill/MCP defer); the
    // face may exceed the soft budget rather than drop a tool an agent may need.
    expect(kept.some((t) => t.name === 'shell_execute')).toBe(true);
    expect(kept.some((t) => t.name === 'file_read')).toBe(true);
    expect(kept.some((t) => t.name === 'task_create')).toBe(true);
    expect(evicted.some((e) => e.name.startsWith('feishu_') || e.name.includes('__'))).toBe(true);
  });

  it('S-reflex-eviction-not-all-protected: reflex keeps first-party tools; only external defers', () => {
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
      // External skill/MCP tools — the evictable ones that must be deferred first.
      ...Array.from({ length: 15 }, (_, i) => ({
        name: `chrome-devtools__x_${i}`,
        description: `chrome tool ${i}`,
        inputSchema: bigSchema,
      })),
    ];
    const { tools: kept, evicted } = evictToolsToBudget(
      tools,
      TOOL_DEF_BUDGET_REFLEX,
      new Set(TOOL_DEF_PROTECTED),
    );
    // First-party tools survive budget pressure (availability is a hard invariant).
    expect(kept.some((t) => t.name === 'file_read')).toBe(true);
    expect(kept.some((t) => t.name === 'task_list')).toBe(true);
    expect(kept.some((t) => t.name === 'discover_tools')).toBe(true);
    // Only external tools defer, and eviction did happen.
    expect(evicted.length).toBeGreaterThan(0);
    expect(evicted.every((e) => e.name.includes('__'))).toBe(true);
  });

  it('S-catalog-not-in-tooldef: eviction catalog stays out of discover_tools.description', () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(80) }]),
      ),
    };
    const tools = [
      { name: 'discover_tools', description: 'discover', inputSchema: { type: 'object', properties: {} } },
      { name: 'notify_user', description: 'notify', inputSchema: { type: 'object', properties: {} } },
      ...Array.from({ length: 25 }, (_, i) => ({
        name: `feishu_big_${i}`,
        description: `Huge tool ${i} with a long description that must not bloat tool defs after eviction`,
        inputSchema: bigSchema,
      })),
    ];
    expect(estimateToolDefTokens(tools)).toBeGreaterThan(TOOL_DEF_BUDGET_CONVERSE);
    const { tools: kept, evicted } = evictToolsToBudget(tools, TOOL_DEF_BUDGET_CONVERSE);
    // Eviction actually happened, taking only the optional external tools.
    expect(evicted.length).toBeGreaterThan(0);
    expect(evicted.every((e) => e.name.startsWith('feishu_'))).toBe(true);
    // First-party survives.
    expect(kept.some((t) => t.name === 'discover_tools')).toBe(true);
    // The deferred catalog is SEPARATE Tier-3 text, not tool schema: short, name-only.
    const catalog = formatEvictedToolCatalog(evicted);
    expect(catalog.length).toBeLessThanOrEqual(DEFERRED_CATALOG_MAX_CHARS);
    expect(catalog).toMatch(/Deferred Tools/);
    // name-only / short: no multi-hundred-char descriptions
    expect(catalog).not.toMatch(/must not bloat tool defs after eviction/);
  });
});
