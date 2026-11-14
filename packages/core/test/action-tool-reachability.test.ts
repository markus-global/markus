/**
 * C8-D — action-tool reachability.
 *
 * Defect being closed ("Agent 自知" gap C): the tool-definition budget evicts by
 * SCHEMA SIZE, so under pressure an agent could lose the very tools that let it
 * ACT (`work_status` / `check_mailbox` / `task_submit_review` …) — and the
 * eviction was silent: no hint about what left the schema or how to get it back.
 *
 * Contract locked here (one test per clause):
 *   1. an over-budget tool face still carries every action tool;
 *   2. the whitelist is derived from a LIVE registry — a name the registry does
 *      not know makes `assertActionToolReachability` throw (fail-fast, no silent
 *      filtering);
 *   3. a ghost id in the whitelist therefore turns this suite RED;
 *   4. the deferred catalog names the evicted tools AND the recovery call;
 *   5. `discover_tools` activation brings an evicted tool back on the next turn;
 *   6. one switch (`MARKUS_ACTION_TOOL_GUARD=0` / `actionToolGuard: false`)
 *      restores the legacy behaviour wholesale.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  ACTION_TOOL_IDS,
  assertActionToolReachability,
  formatEvictedToolCatalog,
  SCHEMA_INJECTED_TOOLS,
} from '../src/capability-packs.js';
import { ToolSelector } from '../src/tool-selector.js';
import { createMailboxTools, type MailboxToolContext } from '../src/tools/mailbox-tools.js';
import { createAgentTaskTools, type AgentTaskContext } from '../src/tools/task-tools.js';

type ToolLike = { name: string; description: string; inputSchema: Record<string, unknown> };

function mk(name: string): ToolLike {
  return { name, description: `d ${name}`, inputSchema: { type: 'object', properties: {} } };
}

/** Big schema on purpose: the budget evictor picks the largest victim first. */
function bigTool(name: string): ToolLike {
  return {
    name,
    description: `${name} `.repeat(100),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`f${i}`, { type: 'string', description: 'x'.repeat(80) }]),
      ),
    },
  };
}

/** Ledger/queue tools, derived from the REAL factory (never copied from prose). */
function mailboxToolNames(): string[] {
  const ctx = {
    agentId: 'agt_test',
    getMindState: () => ({}) as never,
    deferItem: () => true,
    dropItem: () => true,
    prioritizeItem: () => true,
    updateWorkingMemory: () => ({ status: 'ok', key: 'k' }),
    clearWorkingMemory: () => ({ status: 'ok', cleared: 0 }),
    getWorkingMemorySnapshot: () => [],
    // Wired exactly like production (agent-manager always passes this port).
    workStatus: () => ({ status: 'ok', units: [] }),
  } as unknown as MailboxToolContext;
  return createMailboxTools(ctx).map((t) => t.name);
}

/** Task tools, derived from the REAL factory (the review port gates submit). */
function taskToolNames(): string[] {
  const ctx = {
    submitForReview: async () => ({ status: 'ok' }),
  } as unknown as AgentTaskContext;
  return createAgentTaskTools(ctx).map((t) => t.name);
}

/** Tools offered by ToolSelector itself (pushUnique / schema-injected). */
function injectedToolNames(): string[] {
  return new ToolSelector()
    .selectTools({ allTools: new Map(), userMessage: '', pack: 'converse' })
    .map((t) => t.name);
}

/** The live tool face, as assembled from production factories. */
function liveFace(): Set<string> {
  return new Set([...mailboxToolNames(), ...taskToolNames(), ...injectedToolNames()]);
}

/** Oversized ordinary builtins — they must be SELECTED to create real pressure. */
const BULK_NAMES = Array.from({ length: 60 }, (_, i) => `bulk_tool_${i}`);

/** A face under budget pressure: every action tool + 60 oversized builtins. */
function pressuredFace(): Map<string, ToolLike> {
  const map = new Map<string, ToolLike>();
  for (const n of [...mailboxToolNames(), ...taskToolNames()]) map.set(n, mk(n));
  map.set('notify_user', mk('notify_user'));
  for (const n of BULK_NAMES) map.set(n, bigTool(n));
  return map;
}

/**
 * Selector whose `code` group carries the bulk tools. A tool that never enters
 * the selection cannot create budget pressure — skill/MCP names stay out of the
 * face until activated (activation also protects them), so they prove nothing.
 */
function bigSelector(): ToolSelector {
  return new ToolSelector([{ name: 'code', keywords: ['code'], toolNames: [...BULK_NAMES] }]);
}

const ACTION_WITHOUT_WORK_CONTEXT = ACTION_TOOL_IDS.filter((id) => id !== 'task_submit_review');

afterEach(() => {
  delete process.env['MARKUS_ACTION_TOOL_GUARD'];
});

describe('C8-D 白名单（从注册表派生，缺一 fail-fast）', () => {
  it('every whitelisted id resolves on the live tool face', () => {
    // This is the biting assertion: add a ghost name to ACTION_TOOL_IDS and it
    // fails here (and throws in production assembly), instead of becoming an
    // "always reachable" promise nobody can check.
    expect(() => assertActionToolReachability(liveFace())).not.toThrow();
  });

  it('the whitelist is exactly the six registry-verified action tools', () => {
    expect([...ACTION_TOOL_IDS].sort()).toEqual(
      ['check_mailbox', 'notify_user', 'task_create', 'task_submit_review', 'task_update', 'work_status'],
    );
  });

  it('request_user_input stays out: it is offered but NOT registry-resolvable', () => {
    // Schema-pushed by ToolSelector.pushUnique, yet absent from the registry —
    // the exact trap that made the first draft of this whitelist a dead promise.
    expect(injectedToolNames()).toContain('request_user_input');
    expect(ACTION_TOOL_IDS as readonly string[]).not.toContain('request_user_input');
    expect(taskToolNames()).not.toContain('request_user_input');
    expect(mailboxToolNames()).not.toContain('request_user_input');
  });

  it('fail-fast: a missing action tool throws and is named (no silent filtering)', () => {
    const face = liveFace();
    face.delete('work_status');
    expect(() => assertActionToolReachability(face)).toThrow(/work_status/);
  });
});

describe('C8-D 超限工具面下行动类工具恒在', () => {
  it('execute pack: all six action tools survive, and pressure really did evict', () => {
    const selector = bigSelector();
    const names = selector
      .selectTools({ allTools: pressuredFace(), userMessage: 'code work on task', isTaskExecution: true, pack: 'execute' })
      .map((t) => t.name);
    for (const id of ACTION_TOOL_IDS) {
      expect(names, `action tool ${id} must stay LIVE under budget pressure`).toContain(id);
    }
    expect(
      selector.consumeDeferredCatalog().length,
      'the fixture must actually exceed the budget, otherwise this test proves nothing',
    ).toBeGreaterThan(0);
  });

  it('converse pack: the action surface stays, work-context tools stay session-gated', () => {
    const selector = bigSelector();
    const names = selector
      .selectTools({ allTools: pressuredFace(), userMessage: 'code hello', pack: 'converse' })
      .map((t) => t.name);
    for (const id of ACTION_WITHOUT_WORK_CONTEXT) {
      expect(names, `action tool ${id} must stay LIVE in free chat`).toContain(id);
    }
    expect(names).not.toContain('task_submit_review');
  });

  it('reflex pack is untouched: a patrol turn does not grow the action surface', () => {
    const selector = new ToolSelector();
    const names = selector
      .selectTools({ allTools: pressuredFace(), userMessage: 'heartbeat', pack: 'reflex' })
      .map((t) => t.name);
    expect(names).toContain('check_mailbox');
    expect(names).not.toContain('work_status');
    expect(names).not.toContain('task_submit_review');
  });

  it('only re-discoverable tools are ever evicted', () => {
    const allTools = pressuredFace();
    const selector = bigSelector();
    selector.selectTools({ allTools, userMessage: 'code work on task', isTaskExecution: true, pack: 'execute' });
    const evicted = selector.consumeDeferredCatalog().map((e) => e.name);
    expect(evicted.length).toBeGreaterThan(0);
    for (const name of evicted) {
      expect(
        allTools.has(name) || SCHEMA_INJECTED_TOOLS.has(name),
        `${name} was evicted but cannot be re-discovered — unreachable for the rest of the turn`,
      ).toBe(true);
    }
  });
});

describe('C8-D 淘汰提示可行动 + discover_tools 可取回', () => {
  it('the deferred catalog names the tools and the recovery call', () => {
    const catalog = formatEvictedToolCatalog([
      { name: 'feishu_tool_0', description: 'a calendar tool' },
      { name: 'office_generate', description: 'docx/xlsx' },
    ]);
    expect(catalog).toContain('feishu_tool_0');
    expect(catalog).toContain('office_generate');
    expect(catalog).toContain('discover_tools({ name:');
  });

  it('an evicted tool is back on the next turn once activated', () => {
    const selector = bigSelector();
    const allTools = pressuredFace();
    selector.selectTools({ allTools, userMessage: 'code work on task', isTaskExecution: true, pack: 'execute' });
    const evicted = selector.consumeDeferredCatalog().map((e) => e.name);
    const target = evicted[0];
    expect(target).toBeTruthy();

    const nextTurn = selector
      .selectTools({
        allTools,
        userMessage: 'code work on task',
        isTaskExecution: true,
        pack: 'execute',
        activatedToolNames: [target!],
      })
      .map((t) => t.name);
    expect(nextTurn).toContain(target!);
  });
});

describe('C8-D 单开关回退', () => {
  it('actionToolGuard: false restores the legacy face (action extras not forced in)', () => {
    const selector = bigSelector();
    const names = selector
      .selectTools({ allTools: pressuredFace(), userMessage: 'code hello', pack: 'converse', actionToolGuard: false })
      .map((t) => t.name);
    expect(names).not.toContain('work_status');
    expect(names).not.toContain('check_mailbox');
  });

  it('MARKUS_ACTION_TOOL_GUARD=0 is the same single switch', () => {
    process.env['MARKUS_ACTION_TOOL_GUARD'] = '0';
    const selector = bigSelector();
    const names = selector
      .selectTools({ allTools: pressuredFace(), userMessage: 'code hello', pack: 'converse' })
      .map((t) => t.name);
    expect(names).not.toContain('work_status');
    expect(names).not.toContain('check_mailbox');
  });
});
