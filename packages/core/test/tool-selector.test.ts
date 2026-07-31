import { describe, it, expect } from 'vitest';
import { ToolSelector } from '../src/tool-selector.js';

function makeToolMap(names: string[]): Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }> {
  const map = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
  for (const name of names) {
    map.set(name, {
      name,
      description: `Description for ${name}`,
      inputSchema: { type: 'object', properties: {} },
    });
  }
  return map;
}

const ALL_BUILTIN = [
  'agent_send_message', 'agent_list_colleagues', 'task_create', 'task_list',
  'task_update', 'task_comment', 'requirement_comment', 'memory_save', 'memory_search',
  'deliverable_search', 'deliverable_create', 'spawn_subagent', 'spawn_subagents',
  'shell_execute', 'file_read', 'file_write', 'file_edit', 'grep_search', 'glob_find',
  'list_directory', 'apply_patch', 'web_fetch', 'web_search', 'generate_image',
  'team_list', 'team_status', 'delegate_message', 'package_list',
];

function makeSlimCatalog(names: string[]): Array<{ name: string }> {
  return names.map(name => ({ name }));
}

function getDiscoverToolDescription(tools: ReturnType<typeof makeToolMap>, catalog?: ReturnType<typeof makeSlimCatalog>): string {
  const selector = new ToolSelector();
  const result = selector.selectTools({
    allTools: tools,
    userMessage: 'hello',
    skillCatalog: catalog,
  });
  const discover = result.find(t => t.name === 'discover_tools');
  return discover?.description ?? '';
}

describe('ToolSelector', () => {
  it('always includes base tools when available', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const selected = selector.selectTools({ allTools, userMessage: 'hello' });
    const names = selected.map((t) => t.name);

    expect(names).toContain('agent_send_message');
    expect(names).toContain('task_create');
    expect(names).toContain('memory_search');
    expect(names).toContain('discover_tools');
    expect(names).toContain('notify_user');
  });

  it('offers right-panel tools only in Team Chat', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const chat = selector.selectTools({ allTools, userMessage: 'hello', isChat: true }).map(t => t.name);
    const task = selector.selectTools({ allTools, userMessage: 'hello', isTaskExecution: true }).map(t => t.name);
    expect(chat).toContain('open_right_panel');
    expect(chat).toContain('collapse_right_panel');
    expect(task).not.toContain('open_right_panel');
    expect(task).not.toContain('collapse_right_panel');
  });

  it('activates shell group by keyword', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'Please run a shell command to install npm packages',
    });
    const names = selected.map((t) => t.name);
    expect(names).toContain('shell_execute');
  });

  it('activates code group by keyword', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'Search the codebase for file references',
    });
    const names = selected.map((t) => t.name);
    expect(names).toContain('file_read');
    expect(names).toContain('grep_search');
  });

  it('activates browser group by keyword', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'Fetch this URL from the web',
    });
    const names = selected.map((t) => t.name);
    expect(names).toContain('web_fetch');
  });

  it('includes manager tools when isManager is true', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'status update',
      isManager: true,
    });
    const names = selected.map((t) => t.name);
    expect(names).toContain('team_list');
    expect(names).toContain('delegate_message');
    expect(names).toContain('package_list');
  });

  it('includes task execution tools when isTaskExecution is true', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap([
      ...ALL_BUILTIN,
      'task_get', 'task_note', 'task_assign', 'subtask_create',
      'subtask_complete', 'subtask_list', 'task_submit_review',
      'requirement_get', 'requirement_update', 'requirement_resubmit',
      'invoke_coding_tool', 'coding_tool_apply',
    ]);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'work on task',
      isTaskExecution: true,
    });
    const names = selected.map((t) => t.name);
    expect(names).toContain('shell_execute');
    expect(names).toContain('file_read');
    expect(names).toContain('task_get');
    expect(names).toContain('subtask_create');
    expect(names).toContain('invoke_coding_tool');
    expect(names).toContain('coding_tool_apply');
  });

  it('includes review tools when isReview is true', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap([
      ...ALL_BUILTIN,
      'task_get', 'task_note', 'requirement_get',
    ]);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'review code',
      isReview: true,
    });
    const names = selected.map((t) => t.name);
    expect(names).toContain('task_get');
    expect(names).toContain('requirement_get');
    expect(names).not.toContain('task_assign');
  });

  it('includes recent tool names', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap([...ALL_BUILTIN, 'generate_video']);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'hello',
      recentToolNames: ['generate_video'],
    });
    expect(selected.map((t) => t.name)).toContain('generate_video');
  });

  it('supports custom tool groups', () => {
    const selector = new ToolSelector([
      {
        name: 'custom',
        keywords: ['magic'],
        toolNames: ['custom_tool'],
      },
    ]);
    const allTools = makeToolMap(['agent_send_message', 'custom_tool']);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'do some magic',
    });
    expect(selected.map((t) => t.name)).toContain('custom_tool');
  });

  it('builds discover_tools with skill catalog and inactive tools', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(['agent_send_message', 'shell_execute']);
    const selected = selector.selectTools({
      allTools,
      userMessage: 'hi',
      skillCatalog: [
        {
          name: 'test-skill',
          description: 'A test skill for discovery',
          instructions: 'Do things',
        } as never,
      ],
    });
    const discover = selected.find((t) => t.name === 'discover_tools');
    expect(discover).toBeDefined();
    expect(discover!.description).toContain('test-skill');
    expect(discover!.description).toContain('Inactive tools');
    expect(discover!.description).toContain('shell_execute');
  });

  it('B2: keeps core tools + discover for empty / synthetic / short inputs (keyword-independent)', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const CORE = ['agent_send_message', 'task_create', 'task_list', 'memory_save',
      'memory_search', 'spawn_subagent', 'discover_tools', 'notify_user'];

    for (const userMessage of ['', '   ', 'ok', '[Continue]', '<<HANDLE_COMPLETE>>', 'y']) {
      const names = selector.selectTools({ allTools, userMessage }).map(t => t.name);
      for (const c of CORE) expect(names, `core "${c}" missing for input ${JSON.stringify(userMessage)}`).toContain(c);
    }
  });

  it('B2: does not throw on a missing user message and still returns core', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    // Synthetic continuations sometimes have no message; must be handled gracefully.
    const names = selector.selectTools({ allTools, userMessage: undefined as unknown as string }).map(t => t.name);
    expect(names).toContain('agent_send_message');
    expect(names).toContain('discover_tools');
  });

  it('B2: recentToolNames preserves a niche tool across a keyword-less continuation (multimodal case)', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap([...ALL_BUILTIN, 'generate_image']);
    // First turn: keyword pulls in the image tool.
    const first = selector.selectTools({ allTools, userMessage: 'please generate an image of a cat' }).map(t => t.name);
    expect(first).toContain('generate_image');
    // Follow-up continuation has no image keyword — without session-awareness the tool
    // would be dropped. recentToolNames (session-aware reactivation) keeps it available.
    const followUp = selector.selectTools({
      allTools,
      userMessage: 'now make it bigger',
      recentToolNames: ['generate_image'],
    }).map(t => t.name);
    expect(followUp).toContain('generate_image');
  });

  it('activates Chinese keywords', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const selected = selector.selectTools({
      allTools,
      userMessage: '请在终端执行命令',
    });
    expect(selected.map((t) => t.name)).toContain('shell_execute');
  });

  describe('discover_tools slim output', () => {
    it('lists skills by name only, comma-separated, without descriptions', () => {
      const tools = makeToolMap(['shell_execute', 'file_read', 'grep_search']);
      const catalog = makeSlimCatalog(['chrome-devtools', 'agent-building', 'markitdown']);

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).toContain('Skills available');
      expect(desc).toContain('chrome-devtools, agent-building, markitdown');
      // Should NOT contain the old-style (has instructions) tags
      expect(desc).not.toContain('has instructions');
      expect(desc).not.toContain('no instructions');
    });

    it('shows skill count in header', () => {
      const tools = makeToolMap(['shell_execute']);
      const catalog = makeSlimCatalog(['a', 'b', 'c']);

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).toContain('(3 total');
    });

    it('truncates to max 30 skills', () => {
      const tools = makeToolMap(['shell_execute']);
      const catalog = makeSlimCatalog(Array.from({ length: 35 }, (_, i) => `skill-${i}`));

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).toContain('... and 5 more');
      expect(desc).not.toContain('skill-30');
    });

    it('handles empty skill catalog gracefully', () => {
      const tools = makeToolMap(['shell_execute', 'file_read']);
      const catalog: Array<{ name: string }> = [];

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).not.toContain('Skills available');
    });

    it('handles undefined skill catalog', () => {
      const tools = makeToolMap(['shell_execute', 'file_read']);

      const desc = getDiscoverToolDescription(tools);

      expect(desc).not.toContain('Skills available');
    });

    it('lists inactive tools by name only, comma-separated, without descriptions', () => {
      const tools = makeToolMap(['tool_a', 'tool_b', 'tool_c']);

      const desc = getDiscoverToolDescription(tools);

      expect(desc).toContain('Inactive tools');
      expect(desc).toContain('tool_a, tool_b, tool_c');
      // Should NOT contain the long description text
      expect(desc).not.toContain('long description that wastes tokens');
    });

    it('correctly shows inactive count header', () => {
      const tools = makeToolMap(['tool_a', 'tool_b']);

      const desc = getDiscoverToolDescription(tools);

      expect(desc).toContain('Inactive tools (2)');
    });

    it('produces much smaller description than before', () => {
      const tools = makeToolMap(Array.from({ length: 20 }, (_, i) => `tool_${i}`));
      const catalog = makeSlimCatalog(Array.from({ length: 10 }, (_, i) => `skill-${i}`));

      const desc = getDiscoverToolDescription(tools, catalog);

      // The combined description should be well under 3000 chars
      expect(desc.length).toBeLessThan(3000);
      // Must contain the key headers
      expect(desc).toContain('tools active');
      expect(desc).toContain('Skills available');
      expect(desc).toContain('Inactive tools');
    });

    it('includes usage instructions with list_skills, search_registry, install hints', () => {
      const tools = makeToolMap(['shell_execute']);
      const catalog = makeSlimCatalog(['skill-1']);

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).toContain('list_skills');
      expect(desc).toContain('search_registry');
      expect(desc).toContain('install');
      expect(desc).toContain('activate');
    });
  });
});