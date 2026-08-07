import { ContextEngine } from '../src/context-engine.js';
import type { IMemoryStore } from '../src/memory/types.js';
import {
  ROLE_PROMPT_MAX_TOKENS,
  SYSTEM_PROMPT_BUDGET_CONVERSE,
  SYSTEM_ANNOUNCEMENTS_CHARS_CONVERSE,
} from '@markus/shared';
import { getDefaultTokenCounter } from '../src/token-counter.js';

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

  it('A-profile-converse-no-l3: comment_response omits Error Recovery / Quality Gates', async () => {
    const engine = new ContextEngine();
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short role for comment.' } as never,
      memory: mockMemory(),
      scenario: 'comment_response',
      promptProfile: 'converse',
      viewerContext: { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    });
    expect(text).toContain('## Current Interaction Mode');
    expect(text).toContain('comment on a task or requirement');
    expect(text).not.toContain('## Error Recovery');
    expect(text).not.toContain('## Quality Gates');
    expect(text).not.toContain('## Deliverable & Report Output Format');
    expect(text).toMatch(/Current date and time: \d{4}-\d{2}-\d{2}/);
  });

  it('A-profile-execute-has-l3: task_execution includes Error Recovery', async () => {
    const engine = new ContextEngine();
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short role for task.' } as never,
      memory: mockMemory(),
      scenario: 'task_execution',
      promptProfile: 'execute',
    });
    expect(text).toContain('## Error Recovery');
    expect(text).toContain('## Quality Gates');
    expect(text).toContain('Subagent delegation');
    expect(text).toContain('Semantic search');
  });

  it('S-converse-assemble-caps: announcements/workflows truncated at inject (no trim needed)', async () => {
    const engine = new ContextEngine();
    const blob = 'ANNOUNCEMENT LINE PAD '.repeat(4_000);
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short secretary role.' } as never,
      memory: mockMemory('## Facts\n' + 'knowledge pad '.repeat(2_000)),
      scenario: 'chat',
      promptProfile: 'converse',
      teamAnnouncements: blob,
      teamNorms: 'NORM PAD '.repeat(2_000),
      teamDataDir: '/tmp/team',
      dynamicContext: 'DYNAMIC PAD '.repeat(3_000),
      viewerContext: { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
      workflowContext: {
        activeRuns: [],
        availableWorkflows: Array.from({ length: 10 }, (_, i) => ({
          name: `wf-${i}`,
          stepCount: 5,
          description: 'A very long workflow description that should be truncated in converse mode for budget',
        })),
      },
    });

    const tokens = getDefaultTokenCounter().countTokens(text);
    expect(tokens).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET_CONVERSE);

    // Upstream caps visible (short ROLE → failsafe trim should not strip these)
    expect(text).toContain('announcements truncated');
    expect(text).toContain('norms truncated');
    expect(text).toContain('dynamic context truncated');
    expect(text.split('ANNOUNCEMENT LINE PAD').length - 1).toBeLessThanOrEqual(
      Math.ceil(SYSTEM_ANNOUNCEMENTS_CHARS_CONVERSE / 'ANNOUNCEMENT LINE PAD '.length) + 2,
    );
    expect(text).toContain('more — use `workflow_list`');
    expect(text).not.toContain('Subagent delegation');
    expect(text).not.toContain('## Error Recovery');

    expect(text).toMatch(/Current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Asia\/Shanghai/);
    expect(text).toContain('## Current Interaction Mode');
    expect(text).toContain('User locale:');
  });

  it('S-converse-system-budget: heavy ROLE still ≤8000 with date retained', async () => {
    const engine = new ContextEngine();
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'You are a secretary. '.repeat(800) } as never,
      memory: mockMemory('## Facts\n' + 'knowledge pad '.repeat(2_000)),
      scenario: 'chat',
      promptProfile: 'converse',
      teamAnnouncements: 'ANNOUNCEMENT LINE PAD '.repeat(4_000),
      teamNorms: 'NORM PAD '.repeat(2_000),
      dynamicContext: 'DYNAMIC PAD '.repeat(3_000),
      viewerContext: { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    });
    expect(getDefaultTokenCounter().countTokens(text)).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET_CONVERSE);
    expect(text).toMatch(/Current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Asia\/Shanghai/);
    expect(text).toContain('## Current Interaction Mode');
  });

  it('S-converse-keeps-date: date survives even if failsafe trim must run', async () => {
    const engine = new ContextEngine();
    // Pathological: huge ROLE + huge dynamic still must keep date/mode
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'ROLEPAD '.repeat(5_000) } as never,
      memory: mockMemory('## Facts\n' + 'k '.repeat(8_000)),
      scenario: 'chat',
      promptProfile: 'converse',
      teamAnnouncements: 'ANN '.repeat(5_000),
      teamNorms: 'NORM '.repeat(5_000),
      dynamicContext: 'DYN '.repeat(10_000),
      viewerContext: { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    });
    expect(text).toMatch(/Current date and time: \d{4}-\d{2}-\d{2}/);
    expect(text).toContain('## Current Interaction Mode');
    expect(getDefaultTokenCounter().countTokens(text)).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET_CONVERSE);
  });
});
