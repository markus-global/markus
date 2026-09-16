/**
 * Worker-scoped, session-keyed agent state — CONCURRENT-PROCESSING §3.4.
 *
 * Two pieces of context-assembly state used to live on the Agent INSTANCE while
 * being keyed by SESSION:
 *   - `toolSticky`        (recent/activated tool schema names)
 *   - `activatedSkillInstructions` (skill instruction bodies)
 *
 * Instance storage + session keying is incoherent under concurrency: N workers
 * handling N sessions share ONE object, so every session switch wipes the other
 * workers' state (tool-schema drift → cache-prefix break; `discover_tools`
 * activations vanish mid-session). The skill map additionally leaked across
 * sessions in serial mode, since it was neither keyed nor reset.
 *
 * Both now live in the worker's SessionWorkspace, still session-keyed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import { createSessionWorkspace, sessionWorkspaceStore } from '../src/session-workspace.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Worker-scoped state test role',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(),
    chatStream: vi.fn(),
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: () => true,
    modelSupportsVision: () => false,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
    defaultProviderName: 'test',
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

/** Private surface used by these tests. */
type PrivateAgent = Agent & {
  stickyTools(sid?: string | null): { recent: string[]; activated: Set<string> };
};

function createTestAgent(): PrivateAgent {
  return new Agent({
    config: {
      id: 'test-worker-scoped-agent',
      name: 'Worker Scoped Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  }) as unknown as PrivateAgent;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-worker-scoped-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('toolSticky is per-worker AND reset on session switch', () => {
  it('two concurrent workers on different sessions do not clobber each other', () => {
    const agent = createTestAgent();
    const wsA = createSessionWorkspace(1);
    wsA.currentSessionId = 'sess_A';
    const wsB = createSessionWorkspace(2);
    wsB.currentSessionId = 'sess_B';

    sessionWorkspaceStore.run(wsA, () => agent.stickyTools().activated.add('memory_list'));
    expect(sessionWorkspaceStore.run(wsA, () => agent.stickyTools().activated.size)).toBe(1);

    // Worker B building its own schema must NOT wipe worker A's sticky state.
    sessionWorkspaceStore.run(wsB, () => agent.stickyTools());
    expect(sessionWorkspaceStore.run(wsB, () => agent.stickyTools().activated.size)).toBe(0);
    expect(
      sessionWorkspaceStore.run(wsA, () => agent.stickyTools().activated.has('memory_list')),
      'worker B wiped worker A sticky tools (instance-level state)',
    ).toBe(true);

    // …and the reverse order too (the old bug wiped on EVERY alternation).
    sessionWorkspaceStore.run(wsA, () => agent.stickyTools());
    expect(sessionWorkspaceStore.run(wsB, () => agent.stickyTools().activated.size)).toBe(0);
  });

  it('switching session inside one worker still resets sticky state (serial behaviour)', () => {
    const agent = createTestAgent();
    const ws = createSessionWorkspace(1);
    ws.currentSessionId = 'sess_A';

    sessionWorkspaceStore.run(ws, () => agent.stickyTools().activated.add('memory_list'));
    sessionWorkspaceStore.run(ws, () => agent.stickyTools('sess_B'));
    expect(
      sessionWorkspaceStore.run(ws, () => agent.stickyTools().activated.size),
      'sticky tools leaked across sessions within one worker',
    ).toBe(0);
  });
});

describe('activated skill instructions are session-scoped, not process-scoped', () => {
  it('a skill activated in session A never appears in session B', () => {
    const agent = createTestAgent();
    const wsA = createSessionWorkspace(1);
    wsA.currentSessionId = 'sess_A';
    const wsB = createSessionWorkspace(2);
    wsB.currentSessionId = 'sess_B';

    sessionWorkspaceStore.run(wsA, () => agent.injectSkillInstructions('sk_a', 'BODY_A'));

    expect(sessionWorkspaceStore.run(wsA, () => agent.hasSkillInstructions('sk_a'))).toBe(true);
    expect(
      sessionWorkspaceStore.run(wsB, () => agent.hasSkillInstructions('sk_a')),
      'skill instructions leaked across sessions (instance-level Map)',
    ).toBe(false);
    expect(sessionWorkspaceStore.run(wsB, () => agent.getActiveSkillNames())).not.toContain('sk_a');
  });

  it('serial mode: switching sessions drops the previous session activated skills', () => {
    const agent = createTestAgent();
    const ws = createSessionWorkspace(1);
    ws.currentSessionId = 'sess_A';

    sessionWorkspaceStore.run(ws, () => agent.injectSkillInstructions('sk_a', 'BODY_A'));
    ws.currentSessionId = 'sess_B';
    expect(sessionWorkspaceStore.run(ws, () => agent.hasSkillInstructions('sk_a'))).toBe(false);
  });

  it('deactivateSkill removes only from the current session', () => {
    const agent = createTestAgent();
    const ws = createSessionWorkspace(1);
    ws.currentSessionId = 'sess_A';
    sessionWorkspaceStore.run(ws, () => {
      agent.injectSkillInstructions('sk_a', 'BODY_A');
      agent.deactivateSkill('sk_a');
      expect(agent.hasSkillInstructions('sk_a')).toBe(false);
    });
  });
});
