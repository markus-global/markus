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

  it('activates Chinese keywords', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const selected = selector.selectTools({
      allTools,
      userMessage: '请在终端执行命令',
    });
    expect(selected.map((t) => t.name)).toContain('shell_execute');
  });
});
