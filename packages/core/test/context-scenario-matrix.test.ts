/**
 * Scenario × context matrix invariants — PROMPT-ENGINEERING §2.2.
 *
 * Every AgentScenario must render a `## Current Interaction Mode` block that
 * tells the agent (a) whether its text is human-visible, (b) which tool reaches
 * a human, and (c) when to stay silent. These are the facts a model cannot infer
 * from history — losing them is a completeness regression, not a token saving.
 *
 * The group-chat case guards a real defect: an `a2a` item whose `channelKey` is a
 * GROUP channel was rendered with the 1:1-A2A wording ("humans do NOT see this
 * conversation … absorb silently"), which is false inside a group chat where the
 * reply is auto-broadcast to humans.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import type { AgentScenario } from '../src/session-workspace.js';
import type { RoleTemplate } from '@markus/shared';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-scenario-matrix-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const MOCK_ROLE = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Scenario matrix test role',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [],
  builtIn: false,
} as RoleTemplate;

function build(opts: { scenario: AgentScenario; channelKey?: string; isManager?: boolean }) {
  const memory = new MemoryStore(tempDir);
  const engine = new ContextEngine({ memorySearchTopK: 3 });
  return engine.buildSystemPrompt({
    agentId: 'agt_scenario_matrix',
    agentName: 'Test Agent',
    role: MOCK_ROLE,
    memory,
    scenario: opts.scenario,
    channelKey: opts.channelKey,
    isTeamManager: opts.isManager,
  });
}

const ALL_SCENARIOS: AgentScenario[] = [
  'chat',
  'task_execution',
  'heartbeat',
  'a2a',
  'group_chat',
  'comment_response',
  'memory_consolidation',
  'distillation',
  'review',
  'requirement_action',
  'workflow_action',
  'deliberation',
];

describe('scenario matrix: every scenario renders its interaction-mode block', () => {
  it('all AgentScenario values produce a non-trivial section (no silent gap)', async () => {
    for (const scenario of ALL_SCENARIOS) {
      const { text } = await build({ scenario });
      const idx = text.indexOf('## Current Interaction Mode');
      expect(idx, `scenario='${scenario}' has no interaction-mode section`).toBeGreaterThanOrEqual(0);
      // Each block carries at least a channel sentence + a rule list.
      expect(text.slice(idx).length, `scenario='${scenario}' block looks empty`).toBeGreaterThan(200);
    }
  });

  it('every scenario states who can see the output or which tool reaches a human', async () => {
    for (const scenario of ALL_SCENARIOS) {
      const { text } = await build({ scenario });
      const block = text.slice(text.indexOf('## Current Interaction Mode'));
      const saysVisibility = /visible|NOT visible|automatically sent|auto-sent|appears in|persisted/i.test(block);
      const namesReachTool = /notify_user/.test(block);
      expect(
        saysVisibility || namesReachTool,
        `scenario='${scenario}' never explains output visibility / human reachability`,
      ).toBe(true);
    }
  });
});

describe('group chat is never rendered with 1:1-A2A semantics', () => {
  it("scenario='a2a' + group channel renders the group-chat block", async () => {
    const { text } = await build({ scenario: 'a2a', channelKey: 'group:team_abc' });

    // Group-chat facts the agent needs:
    expect(text).toContain('team group chat channel');
    expect(text).toContain('automatically sent');
    // …and NOT the DM/A2A-only wording:
    expect(text).not.toContain('direct message (DM) conversation');
    expect(text).not.toContain('Humans do NOT see this conversation');
  });

  it("scenario='a2a' + DM channel still renders the DM block", async () => {
    const { text } = await build({ scenario: 'a2a', channelKey: 'dm:a2a:agt_a:agt_b' });
    expect(text).toContain('direct message (DM) conversation');
    expect(text).not.toContain('team group chat channel');
  });

  it("scenario='a2a' without a channel keeps the general-A2A block", async () => {
    const { text } = await build({ scenario: 'a2a' });
    expect(text).toContain('agent-to-agent (A2A) conversation');
    expect(text).not.toContain('team group chat channel');
  });

  it('manager group-chat block demands task-backed delegation', async () => {
    const { text } = await build({ scenario: 'group_chat', channelKey: 'group:team_abc', isManager: true });
    expect(text).toContain('team group chat channel');
    expect(text).toMatch(/MUST use `task_create`/);
  });
});

describe('reflex scenarios restrict tools in the prompt (and the runtime enforces it)', () => {
  it('heartbeat names the reflex pack and forbids execute-pack tools', async () => {
    const { text } = await build({ scenario: 'heartbeat' });
    expect(text).toContain('reflex pack only');
    expect(text).toContain('task_create');
    expect(text).toContain('HEARTBEAT_OK');
  });

  it('task_execution gets the full ANALYZE→SUBMIT cycle', async () => {
    const { text } = await build({ scenario: 'task_execution' });
    expect(text).toContain('task execution mode');
    expect(text).toContain('Phase 1 — ANALYZE');
    expect(text).toContain('task_submit_review');
  });

  it('comment_response mandates context-first gathering before replying', async () => {
    const { text } = await build({ scenario: 'comment_response' });
    expect(text).toContain('task_get');
    expect(text).toContain('[NO_REPLY_NEEDED]');
  });
});
