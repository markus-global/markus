import { ContextEngine } from '../src/context-engine.js';
import type { IMemoryStore } from '../src/memory/types.js';
import { ROLE_PROMPT_MAX_TOKENS, SYSTEM_PROMPT_BUDGET_CONVERSE } from '@markus/shared';

function mockMemory(knowledge = '## Facts\nKnow things.\n'): IMemoryStore {
  return {
    getLongTermMemory: () => knowledge,
    getStateMemory: () => '## Current\nQuiet day 1\nline2\nline3\nline4\nline5\nline6\n',
    getEntries: () => [],
    addEntry: () => {},
    search: () => [],
    getObservations: () => [],
  } as unknown as IMemoryStore;
}

const baseRole = {
  name: 'Tester',
  description: 'test',
  systemPrompt: 'You are a tester. '.repeat(2000),
  defaultPolicies: [] as Array<{ name: string; rules: string[] }>,
  heartbeatChecklist: '',
};

describe('prompt profiles (AGENT-RUNTIME §4)', () => {
  it('A-profile-role-cap: truncates long ROLE', async () => {
    const engine = new ContextEngine();
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: baseRole as never,
      memory: mockMemory(),
      scenario: 'chat',
      promptProfile: 'converse',
    });
    const roleCapChars = ROLE_PROMPT_MAX_TOKENS * 4;
    expect(text).toContain('ROLE truncated');
    // Truncated body should not retain the full repeated prompt
    expect(text.indexOf('ROLE truncated')).toBeLessThan(roleCapChars + 200);
  });

  it('A-profile-reflex-omits: no channel history / no full knowledge', async () => {
    const engine = new ContextEngine();
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short role.' } as never,
      memory: mockMemory('## Secrets\nTOP SECRET KNOWLEDGE BLOCK\n'),
      scenario: 'heartbeat',
      promptProfile: 'reflex',
      channelContext: [
        { role: 'user', content: 'secret channel line XYZ' },
        { role: 'assistant', content: 'reply' },
      ],
    });
    expect(text).not.toContain('secret channel line XYZ');
    expect(text).not.toContain('TOP SECRET KNOWLEDGE BLOCK');
    expect(text).toMatch(/Current State|Learning note|heartbeat/i);
  });

  it('B-hb-no-evolution-essay: reflex scenario lacks long self-evolution table', async () => {
    const engine = new ContextEngine();
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short.' } as never,
      memory: mockMemory(),
      scenario: 'heartbeat',
      promptProfile: 'reflex',
    });
    expect(text).not.toContain('Practice worth sharing');
    expect(text).not.toContain('memory_update_longterm({ section: "procedures"');
  });

  it('S-converse-system-budget: trims oversized org/announcements to ≤8000 tok', async () => {
    const engine = new ContextEngine();
    const blob = 'ANNOUNCEMENT LINE PAD '.repeat(4_000);
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'You are a secretary. '.repeat(800) } as never,
      memory: mockMemory('## Facts\n' + 'knowledge pad '.repeat(2_000)),
      scenario: 'chat',
      promptProfile: 'converse',
      teamAnnouncements: blob,
      teamNorms: 'NORM PAD '.repeat(2_000),
      dynamicContext: 'DYNAMIC PAD '.repeat(3_000),
    });
    const approxTokens = Math.ceil(text.length / 4);
    expect(approxTokens).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET_CONVERSE);
    // Low-priority sections should be dropped first
    expect(text).not.toContain('ANNOUNCEMENT LINE PAD');
  });
});
