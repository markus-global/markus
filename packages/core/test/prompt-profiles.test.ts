import { ContextEngine, prepareKnowledgeForPrompt } from '../src/context-engine.js';
import type { IMemoryStore } from '../src/memory/types.js';
import {
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
  it('A-collab-rules-always-on: Collaboration Rules present; no HANDBOOK dump', async () => {
    const engine = new ContextEngine();
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short CTO role.' } as never,
      memory: mockMemory(),
      scenario: 'chat',
      promptProfile: 'converse',
    });
    expect(text).toContain('## Markus Collaboration Rules');
    expect(text).toContain('requirement_id');
    expect(text).toContain('STOP');
    expect(text).toContain('task_submit_review');
    expect(text).toContain('Platform Handbook (on demand)');
    expect(text).toMatch(/file_read` the handbook at this absolute path/);
    expect(text).toContain('templates/roles/HANDBOOK.md');
    expect(text).toContain('Conversation vs task');
    expect(text).toContain('Conversation-first');
    expect(text).toContain('Requirements gate all tasks');
    expect(text).toMatch(/already created a task|After you create a task/i);
    expect(text).toContain('## How Your Prompt Is Composed');
    expect(text).toContain('ROLE.md');
    expect(text).toContain('does not guess from the board');
    expect(text).not.toContain('if it would take more than a few minutes, it deserves a task');
    expect(text).not.toContain('How Markus Works — The Big Picture');
    expect(text).not.toContain('Organization (Org)');
  });

  it('A-conversation-first-chat: chat mode allows pair work; STOP only after task_create', async () => {
    const engine = new ContextEngine();
    const { text, volatile } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short founder role.' } as never,
      memory: mockMemory(),
      scenario: 'chat',
      promptProfile: 'converse',
      identity: {
        self: {
          id: 'agt_1',
          name: 'CTO',
          role: '技术联合创始人',
          agentRole: 'manager',
          skills: ['git'],
        },
        organization: { id: 'org_1', name: 'Org' },
        colleagues: [
          { id: 'agt_2', name: 'Dev', role: 'Developer', type: 'agent', status: 'offline' },
          { id: 'agt_3', name: 'Writer', role: 'Writer', type: 'agent', status: 'offline' },
        ],
        humans: [{ id: 'u1', name: 'Owner', role: 'owner' }],
      } as never,
    });
    expect(text).toContain('Conversation-first (default)');
    expect(text).toContain('player-coach');
    expect(text).toContain('Own the work when pairing');
    expect(text).toContain('After you create a task for some work, STOP');
    expect(text).not.toContain('tiny clarifications');
    expect(volatile).toContain('## Team Status');
    expect(volatile).toContain('stopped');
    expect(volatile).toContain('agent_start');
    expect(text).not.toContain('Dev: offline');
  });

  it('A-team-status-live-and-late: live statuses override snapshot; Team Status is at prompt tail', async () => {
    const engine = new ContextEngine();
    const { text, segments, volatile } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short founder role.' } as never,
      memory: mockMemory(),
      scenario: 'chat',
      promptProfile: 'converse',
      identity: {
        self: {
          id: 'agt_1',
          name: 'CTO',
          role: '技术联合创始人',
          agentRole: 'manager',
          skills: ['git'],
        },
        organization: { id: 'org_1', name: 'Org' },
        // Stale creation-time snapshot: both teammates were offline then.
        colleagues: [
          { id: 'agt_2', name: 'Dev', role: 'Developer', type: 'agent', status: 'offline' },
          { id: 'agt_3', name: 'Writer', role: 'Writer', type: 'agent', status: 'offline' },
        ],
        humans: [{ id: 'u1', name: 'Owner', role: 'owner' }],
      } as never,
      // Live runtime statuses read at build time: they have started since.
      liveColleagueStatuses: { agt_2: 'idle', agt_3: 'working' },
    });
    // Live statuses win over the stale snapshot.
    expect(volatile).toContain('Dev: idle');
    expect(volatile).toContain('Writer: busy');
    expect(volatile).not.toContain('All listed teammates are stopped');
    // Scheme A cache contract: Team Status rides the volatile tail (pinned at the
    // end of history) AFTER the timestamp, so a status flip never invalidates the
    // byte-stable system + history prefix.
    const tsIdx = (volatile ?? '').indexOf('Current date and time:');
    const teamIdx = (volatile ?? '').indexOf('## Team Status');
    expect(tsIdx).toBeGreaterThan(-1);
    expect(teamIdx).toBeGreaterThan(tsIdx);
    // Every system segment is a cache breakpoint and none carries Team Status.
    for (const seg of segments) expect(seg.cacheBreakpoint).toBe(true);
    for (const seg of segments) expect(seg.content).not.toContain('## Team Status');
    expect(volatile).toContain('## Team Status');
  });

  it('A-knowledge-heading-demote: knowledge ## becomes ### under Your Knowledge', async () => {
    const prepared = prepareKnowledgeForPrompt(
      '## DeepSeek API 故障模式\nstale noise\n\n## Useful Facts\nkeep me\n',
      10_000,
    );
    expect(prepared.text).toContain('### Useful Facts');
    expect(prepared.text).toContain('### DeepSeek API 故障模式');
    expect(prepared.text).not.toMatch(/^## Useful Facts/m);
    // Non-stale section should appear before stale when truncating aggressively
    const tight = prepareKnowledgeForPrompt(
      '## DeepSeek API 故障模式\n' + 'x'.repeat(400) + '\n\n## Useful Facts\nkeep me\n',
      80,
    );
    expect(tight.text).toContain('Useful Facts');
    expect(tight.truncated).toBe(true);
  });

  it('A-heartbeat-no-task-create-prompt: heartbeat mode omits create/propose tools', async () => {
    const engine = new ContextEngine();
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short.' } as never,
      memory: mockMemory(),
      scenario: 'heartbeat',
      promptProfile: 'reflex',
    });
    expect(text).toContain('heartbeat mode');
    expect(text).toMatch(/Do \*\*not\*\* call `task_create`/);
    expect(text).not.toContain('You MAY create tasks via `task_create`');
    expect(text).not.toContain('## Self-Evolution');
  });

  it('S-skill-body-not-dyn-capped: activated skills survive converse dynamic cap', async () => {
    const engine = new ContextEngine();
    const skillBody = `UNIQUE_SKILL_BODY_${'x'.repeat(2_000)}`;
    const { text, volatile } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short role.' } as never,
      memory: mockMemory(),
      scenario: 'chat',
      promptProfile: 'converse',
      dynamicContext: 'DYNAMIC_PAD '.repeat(500),
      activatedSkills: `\n## Activated Skills\n<skill name="demo">\n${skillBody}\n</skill>`,
    });
    expect(text).toContain('UNIQUE_SKILL_BODY_');
    expect(text).toContain(skillBody.slice(-20));
    expect(text).toContain('## Activated Skills');
    expect(volatile).toContain('dynamic context truncated');
  });

  it('A-profile-role-full: never truncates ROLE (important always-on)', async () => {
    const engine = new ContextEngine();
    const marker = 'UNIQUE_ROLE_TAIL_MARKER_9f3a';
    const longRole = [
      '## Identity\n',
      'You are a tester. '.repeat(800),
      '\n## Deep Domain Dump\n',
      'API field docs. '.repeat(800),
      `\n## Tail\n${marker}\n`,
    ].join('');
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: longRole } as never,
      memory: mockMemory(),
      scenario: 'chat',
      promptProfile: 'converse',
    });
    expect(text).toContain(marker);
    expect(text).toContain('## Identity');
    expect(text).not.toContain('ROLE truncated');
    expect(text).not.toContain('ROLE.md continues beyond');
    expect(text).not.toContain('_[system trimmed');
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
    const { text, volatile } = await engine.buildSystemPrompt({
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
    expect(volatile).toMatch(/Current date and time: \d{4}-\d{2}-\d{2}/);
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

  it('S-converse-assemble-caps: progressive caps on announcements/workflows (not ROLE/L0)', async () => {
    const engine = new ContextEngine();
    const blob = 'ANNOUNCEMENT LINE PAD '.repeat(4_000);
    const { text, volatile } = await engine.buildSystemPrompt({
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

    // Progressive disclosure caps (full files remain on disk)
    expect(text).toContain('announcements truncated');
    expect(text).toContain('norms truncated');
    expect(volatile).toContain('dynamic context truncated');
    expect(text.split('ANNOUNCEMENT LINE PAD').length - 1).toBeLessThanOrEqual(
      Math.ceil(SYSTEM_ANNOUNCEMENTS_CHARS_CONVERSE / 'ANNOUNCEMENT LINE PAD '.length) + 2,
    );
    expect(volatile).toContain('more — use `workflow_list`');
    expect(text).toContain('Subagent delegation');
    expect(text).toContain('## Search & Exploration Strategy');
    expect(text).not.toContain('## Error Recovery');
    expect(text).not.toContain('_[system trimmed');

    expect(volatile).toMatch(/Current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Asia\/Shanghai/);
    expect(text).toContain('## Current Interaction Mode');
    expect(volatile).toContain('User locale:');
  });

  it('S-converse-keeps-essentials: date/mode/L0 survive heavy progressive sections', async () => {
    const engine = new ContextEngine();
    const { text, volatile } = await engine.buildSystemPrompt({
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
    expect(volatile).toMatch(/Current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Asia\/Shanghai/);
    expect(text).toContain('## Current Interaction Mode');
    expect(text).toContain('## Search & Exploration Strategy');
    expect(text).toContain('## Learning Habits');
    expect(text).not.toContain('_[system trimmed');
    expect(text).not.toContain('ROLE truncated');
  });

  it('S-converse-keeps-date: date/mode never surgically removed', async () => {
    const engine = new ContextEngine();
    const { text, volatile } = await engine.buildSystemPrompt({
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
    expect(volatile).toMatch(/Current date and time: \d{4}-\d{2}-\d{2}/);
    expect(text).toContain('## Current Interaction Mode');
    expect(text).not.toContain('_[system trimmed');
    // Token counter imported for regression visibility in heavy assemble
    expect(getDefaultTokenCounter().countTokens(text)).toBeGreaterThan(1000);
  });

  it('A-handbook-injected-absolute-path: handbookPath is injected verbatim; no full text dump', async () => {
    const engine = new ContextEngine();
    const absPath = '/opt/markus/templates/roles/HANDBOOK.md';
    const { text } = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'T',
      role: { ...baseRole, systemPrompt: 'Short role.' } as never,
      memory: mockMemory(),
      scenario: 'chat',
      promptProfile: 'converse',
      handbookPath: absPath,
    });
    // The absolute path is injected so the agent reads it WITHOUT searching.
    expect(text).toContain('Platform Handbook (on demand)');
    expect(text).toContain(absPath);
    expect(text).toContain('AGENT HANDBOOK');
    // Handbook is NEVER dumped into the prompt (no auto-injection / context bloat).
    expect(text).not.toContain('How Markus Works — The Big Picture');
    expect(text).not.toContain('## Agent Work Principles');
  });
});
