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
 *   4. under REAL over-budget pressure NOTHING is evicted: first-party tools
 *      are eviction-immune (tier 0), and external skill/MCP tools enter the
 *      face only via `discover_tools` activation — which itself grants
 *      immunity (P0-3). No legal victim exists, so the deferred catalog is
 *      empty by construction; the over-budget face is tolerated and the
 *      VARIABLE segment (history) is compressed instead (Owner 2026-11-20);
 *   5. an external skill tool enters the face once activated and survives
 *      over-budget pressure on that turn and the next;
 *   6. one switch (`MARKUS_ACTION_TOOL_GUARD=0` / `actionToolGuard: false`)
 *      restores the legacy behaviour wholesale.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  ACTION_TOOL_IDS,
  assertActionToolReachability,
  estimateToolDefTokens,
  formatEvictedToolCatalog,
  packToolDefBudget,
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

/** Oversized first-party builtins — real pressure, and ALL must survive (tier 0). */
const BULK_NAMES = Array.from({ length: 60 }, (_, i) => `bulk_tool_${i}`);

/** Oversized EXTERNAL decoy: tier-3 by name, but activation grants immunity. */
const EXT_DECOY = 'feishu_bulk_0';

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
 * the selection cannot create budget pressure. External skill/MCP names stay
 * out of the face until activated — and activation grants eviction immunity
 * (P0-3), so under the current policy NO legal eviction victim exists: the
 * over-budget face is tolerated and history is compressed downstream instead.
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

  it('the whitelist is exactly the seven registry-verified action tools', () => {
    expect([...ACTION_TOOL_IDS].sort()).toEqual(
      [
        'check_mailbox',
        'notify_user',
        'request_user_input',
        'task_create',
        'task_submit_review',
        'task_update',
        'work_status',
      ],
    );
  });

  it('request_user_input IS a member: the HITL channel must survive compression', () => {
    // The whole point of the card is "agent knows what it lacks". A compressed
    // face that cannot ask a human for authorisation is the defect, not an edge
    // case. It is schema-injected (pushUnique) + eviction-protected, exactly like
    // `notify_user` — so excluding it while keeping notify_user would be one
    // predicate answered two ways.
    expect(ACTION_TOOL_IDS as readonly string[]).toContain('request_user_input');
    expect(injectedToolNames()).toContain('request_user_input');
    // It has NO registerTool handler — that is *why* the face (not the handler
    // registry) is the thing the assertion checks. Locked here so a future
    // "simplification" to `agent.getTools()` alone goes red instead of silently
    // dropping the HITL tool from the whitelist again.
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
  it('execute pack: real over-budget pressure — every tool survives, nothing evicted', () => {
    const selector = bigSelector();
    const face = selector
      .selectTools({ allTools: pressuredFace(), userMessage: 'code work on task', isTaskExecution: true, pack: 'execute' });
    const names = face.map((t) => t.name);
    // The fixture must REALLY exceed the budget — otherwise "survives" proves nothing.
    expect(estimateToolDefTokens(face)).toBeGreaterThan(packToolDefBudget('execute'));
    for (const id of ACTION_TOOL_IDS) {
      expect(names, `action tool ${id} must stay LIVE under budget pressure`).toContain(id);
    }
    // New invariant: budget pressure compresses HISTORY, never the tool face.
    // Re-introducing first-party eviction makes these two assertions red.
    for (const n of BULK_NAMES) expect(names).toContain(n);
    expect(selector.consumeDeferredCatalog()).toEqual([]);
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

  it('nothing is ever evicted — activated external tools survive pressure too', () => {
    const allTools = pressuredFace();
    allTools.set(EXT_DECOY, bigTool(EXT_DECOY));
    const selector = bigSelector();
    const face = selector.selectTools({
      allTools,
      userMessage: 'code work on task',
      isTaskExecution: true,
      pack: 'execute',
      activatedToolNames: [EXT_DECOY],
    });
    const names = face.map((t) => t.name);
    expect(estimateToolDefTokens(face)).toBeGreaterThan(packToolDefBudget('execute'));
    // P0-3: activation grants immunity — evicting an activated external tool in
    // the same turn would make discover_tools a token-burning no-op.
    expect(names).toContain(EXT_DECOY);
    for (const id of ACTION_TOOL_IDS) expect(names).toContain(id);
    expect(selector.consumeDeferredCatalog()).toEqual([]);
  });
});

describe('C8-D 渐进披露 + discover_tools 激活可行动', () => {
  it('the deferred catalog names the tools and the recovery call', () => {
    const catalog = formatEvictedToolCatalog([
      { name: 'feishu_tool_0', description: 'a calendar tool' },
      { name: 'office_generate', description: 'docx/xlsx' },
    ]);
    expect(catalog).toContain('feishu_tool_0');
    expect(catalog).toContain('office_generate');
    expect(catalog).toContain('discover_tools({ name:');
  });

  it('an external skill tool enters via activation and survives pressure across turns', () => {
    const allTools = pressuredFace();
    allTools.set(EXT_DECOY, bigTool(EXT_DECOY));
    const selector = bigSelector();
    // Turn 1: not activated → progressive disclosure keeps it out of the face.
    const turn1 = selector
      .selectTools({ allTools, userMessage: 'code work on task', isTaskExecution: true, pack: 'execute' })
      .map((t) => t.name);
    expect(turn1).not.toContain(EXT_DECOY);
    // Turn 2: activated → live, and immune even though the face is over budget.
    const face2 = selector.selectTools({
      allTools,
      userMessage: 'code work on task',
      isTaskExecution: true,
      pack: 'execute',
      activatedToolNames: [EXT_DECOY],
    });
    expect(estimateToolDefTokens(face2)).toBeGreaterThan(packToolDefBudget('execute'));
    expect(face2.map((t) => t.name)).toContain(EXT_DECOY);
    expect(selector.consumeDeferredCatalog()).toEqual([]);
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
