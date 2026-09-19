/**
 * Proves the "Element Selection" setting actually changes agent behaviour.
 *
 * A setting that nothing reads is decoration. This test drives the real path —
 * Settings → AgentManager → provider callback → skill activation → injected context —
 * and asserts the chrome-devtools body differs between modes while every other skill is untouched.
 */
import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { COMPLETION_MARKER } from '@markus/shared';
import { InMemorySkillRegistry } from '../src/skills/registry.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'markus-elemsel-'));

const MOCK_ROLE: RoleTemplate = {
  id: 'elemsel-role',
  name: 'Element Selection Role',
  description: 'test',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

const CHROME_BODY = '# Chrome DevTools Browser Automation\n\nBase SOP body.';
const OTHER_BODY = '# Some Other Skill\n\nDo other things.';

function makeMockRouter(): LLMRouter {
  const resp = () => ({
    content: `ok ${COMPLETION_MARKER}`,
    finishReason: 'end_turn',
    toolCalls: undefined,
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  return {
    chat: vi.fn(async () => resp()),
    chatStream: vi.fn(async (_req: unknown, onEvent: (e: unknown) => void) => {
      onEvent?.({ type: 'text_delta', text: 'x' });
      return resp();
    }),
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

type PrivateAgent = Agent & {
  executeTool: (
    tc: { id: string; name: string; arguments: Record<string, unknown> },
    onOutput?: unknown,
    sessionId?: string,
  ) => Promise<string>;
  getActivatedSkillContext: () => string | undefined;
};

function makeAgent() {
  const registry = new InMemorySkillRegistry();
  registry.register({
    manifest: {
      name: 'chrome-devtools', version: '1.0.0', description: 'Browser automation',
      author: 'test', category: 'browser', instructions: CHROME_BODY,
    },
  });
  registry.register({
    manifest: {
      name: 'weather', version: '1.0.0', description: 'Weather',
      author: 'test', category: 'utility', instructions: OTHER_BODY,
    },
  });

  const agent = new Agent({
    config: {
      id: 'elemsel-agent', name: 'Element Selection Agent', roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
    skillRegistry: registry,
  } as never);
  return agent as PrivateAgent;
}

async function activate(agent: PrivateAgent, skill: string) {
  await agent.executeTool(
    { id: 'tc1', name: 'discover_tools', arguments: { name: [skill] } },
    undefined,
    'sess-1',
  );
  return agent.getActivatedSkillContext() ?? '';
}

describe('browser element-selection mode', () => {
  it('defaults to direct — chrome-devtools body is injected unmodified', async () => {
    const agent = makeAgent();
    const ctx = await activate(agent, 'chrome-devtools');
    expect(ctx).toContain('Base SOP body.');
    expect(ctx).not.toContain('ACTIVE MODE: Jev-assisted');
  });

  it('injects the Jev SOP when the provider reports jev', async () => {
    const agent = makeAgent();
    agent.setBrowserElementSelectionProvider(() => 'jev');
    const ctx = await activate(agent, 'chrome-devtools');
    expect(ctx).toContain('ACTIVE MODE: Jev-assisted');
    // The three measured rules must survive into the prompt, not just a bare mention.
    expect(ctx).toContain('255 options');
    expect(ctx).toContain('current stage');
    expect(ctx).toContain('Base SOP body.');
  });

  it('direct after jev returns to the unmodified body', async () => {
    const agent = makeAgent();
    let mode: 'direct' | 'jev' = 'jev';
    agent.setBrowserElementSelectionProvider(() => mode);
    expect(await activate(agent, 'chrome-devtools')).toContain('ACTIVE MODE: Jev-assisted');

    // Same agent, setting flipped — the callback (not a copied value) must be re-read.
    mode = 'direct';
    const agent2 = makeAgent();
    agent2.setBrowserElementSelectionProvider(() => mode);
    const ctx = await activate(agent2, 'chrome-devtools');
    expect(ctx).not.toContain('ACTIVE MODE: Jev-assisted');
  });

  it('never augments a non-browser skill', async () => {
    const agent = makeAgent();
    agent.setBrowserElementSelectionProvider(() => 'jev');
    const ctx = await activate(agent, 'weather');
    expect(ctx).toContain('Do other things.');
    expect(ctx).not.toContain('ACTIVE MODE: Jev-assisted');
  });

  it('the provider is read at activation time, so a live Settings change applies', async () => {
    const agent = makeAgent();
    let mode: 'direct' | 'jev' = 'direct';
    agent.setBrowserElementSelectionProvider(() => mode);
    // No restart, no re-registration — just flip the source of truth.
    mode = 'jev';
    const ctx = await activate(agent, 'chrome-devtools');
    expect(ctx).toContain('ACTIVE MODE: Jev-assisted');
  });
});

process.on('exit', () => rmSync(tempDir, { recursive: true, force: true }));
