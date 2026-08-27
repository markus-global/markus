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
  'team_list', 'team_status', 'delegate_message', 'package_list', 'session',
];

describe('ToolSelector', () => {
  it('always includes base tools when available', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const selected = selector.selectTools({ allTools, userMessage: 'hello', pack: 'converse' });
    const names = selected.map((t) => t.name);

    expect(names).toContain('agent_send_message');
    expect(names).toContain('task_create');
    expect(names).toContain('memory_search');
    expect(names).toContain('discover_tools');
    expect(names).toContain('notify_user');
    // Both subagent tools are core-keep: `spawn_subagent` for serial delegation,
    // `spawn_subagents` for parallel fan-out (see spawn_subagents in CORE_KEEP).
    expect(names).toContain('spawn_subagent');
    expect(names).toContain('spawn_subagents');
    expect(names).toContain('shell_execute');
    expect(names).toContain('file_read');
    expect(names).toContain('session');
    expect(names).not.toContain('deliverable_create');
  });

  it('S-tool-mcp-progressive: skill/MCP LIVE only after discover activation', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap([
      ...ALL_BUILTIN,
      'feishu_calendar_list',
      'chrome-devtools__navigate',
    ]);
    const sticky = selector.selectTools({
      allTools,
      userMessage: 'hello',
      pack: 'converse',
      recentToolNames: ['feishu_calendar_list', 'chrome-devtools__navigate', 'shell_execute'],
    }).map((t) => t.name);
    expect(sticky).toContain('shell_execute');
    expect(sticky).toContain('file_read');
    expect(sticky).not.toContain('feishu_calendar_list');
    expect(sticky).not.toContain('chrome-devtools__navigate');

    const activated = selector.selectTools({
      allTools,
      userMessage: 'hello',
      pack: 'converse',
      activatedToolNames: ['feishu_calendar_list'],
    }).map((t) => t.name);
    expect(activated).toContain('feishu_calendar_list');
    expect(activated).toContain('shell_execute');
  });

  it('A-pack-reflex-tools: reflex pack excludes package/goal/spawn', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap([
      ...ALL_BUILTIN,
      'package_install', 'goal_create', 'discover_tools', 'notify_user',
      'request_user_input', 'schedule_wakeup', 'set_heartbeat_interval',
      'check_mailbox', 'update_notebook', 'task_get',
    ]);
    const names = selector.selectTools({
      allTools,
      userMessage: 'heartbeat',
      pack: 'reflex',
    }).map((t) => t.name);
    expect(names).toContain('task_list');
    expect(names).toContain('discover_tools');
    expect(names).not.toContain('package_install');
    expect(names).not.toContain('goal_create');
    expect(names).not.toContain('spawn_subagents');
  });

  it('A-pack-execute-has-code: execute pack includes shell/code tools', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap(ALL_BUILTIN);
    const names = selector.selectTools({
      allTools,
      userMessage: 'implement the feature',
      isTaskExecution: true,
      pack: 'execute',
    }).map((t) => t.name);
    expect(names).toContain('shell_execute');
    expect(names).toContain('file_read');
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
    const allTools = makeToolMap(['agent_send_message', 'shell_execute', 'feishu_calendar_list']);
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
    const names = selected.map((t) => t.name);
    expect(names).toContain('shell_execute'); // core LIVE, not progressive
    expect(names).not.toContain('feishu_calendar_list');
    const discover = selected.find((t) => t.name === 'discover_tools');
    expect(discover).toBeDefined();
    expect(discover!.description).toContain('test-skill');
    expect(discover!.description).toContain('Optional extras');
    expect(discover!.description).toContain('feishu_calendar_list');
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

  it('S-execute-only-no-sticky-converse: task_submit_review does not sticky into free chat', () => {
    const selector = new ToolSelector();
    const allTools = makeToolMap([...ALL_BUILTIN, 'task_submit_review', 'subtask_create', 'task_note']);
    const chat = selector.selectTools({
      allTools,
      userMessage: 'continue',
      pack: 'converse',
      scenario: 'chat',
      recentToolNames: ['task_submit_review', 'subtask_create', 'task_note', 'shell_execute'],
    }).map(t => t.name);
    expect(chat).toContain('shell_execute');
    expect(chat).not.toContain('task_submit_review');
    expect(chat).not.toContain('subtask_create');
    expect(chat).not.toContain('task_note');

    const execute = selector.selectTools({
      allTools,
      userMessage: 'finish the task',
      pack: 'execute',
      scenario: 'task_execution',
      isTaskExecution: true,
      recentToolNames: ['task_submit_review'],
    }).map(t => t.name);
    expect(execute).toContain('task_submit_review');

    // Review / comment / requirement sessions are entity-bound — work-context tools OK
    const review = selector.selectTools({
      allTools,
      userMessage: 'review this',
      pack: 'govern',
      scenario: 'review',
      isReview: true,
      recentToolNames: ['task_note'],
    }).map(t => t.name);
    expect(review).toContain('task_note');

    const comment = selector.selectTools({
      allTools,
      userMessage: 'reply to comment',
      pack: 'converse',
      scenario: 'comment_response',
      recentToolNames: ['task_note', 'task_submit_review'],
    }).map(t => t.name);
    expect(comment).toContain('task_note');
    expect(comment).toContain('task_submit_review');
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

  it('S-discover-activated-protected: core activated tools survive budget eviction', () => {
    const selector = new ToolSelector();
    // Inflate schemas so converse budget must evict something.
    const map = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
    for (const name of ALL_BUILTIN) {
      map.set(name, {
        name,
        description: `Description for ${name} ${'PAD '.repeat(2_000)}`,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 40 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(80) }]),
          ),
        },
      });
    }
    const withActivated = selector.selectTools({
      allTools: map,
      userMessage: 'hello',
      pack: 'converse',
      recentToolNames: ['shell_execute', 'file_read'],
      activatedToolNames: ['shell_execute', 'file_read'],
    }).map((t) => t.name);

    expect(withActivated).toContain('shell_execute');
    expect(withActivated).toContain('file_read');
    expect(withActivated).toContain('discover_tools');
  });

  it('S-activated-mcp-lru: activated MCP can defer; core stays LIVE', () => {
    const selector = new ToolSelector();
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(100) }]),
      ),
    };
    const map = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
    for (const name of ALL_BUILTIN) {
      map.set(name, { name, description: `d ${name}`, inputSchema: { type: 'object', properties: {} } });
    }
    const activatedMcp: string[] = [];
    for (let i = 0; i < 25; i++) {
      const name = `feishu_tool_${i}`;
      activatedMcp.push(name);
      map.set(name, { name, description: `feishu ${i}`, inputSchema: bigSchema });
    }
    const selected = selector.selectTools({
      allTools: map,
      userMessage: 'hello',
      pack: 'converse',
      activatedToolNames: activatedMcp,
    });
    const names = selected.map((t) => t.name);
    expect(names).toContain('shell_execute');
    expect(names).toContain('file_read');
    expect(names).toContain('discover_tools');
    const deferred = selector.consumeDeferredCatalog();
    const evictedActivated = selector.consumeEvictedActivated();
    expect(deferred.some((d) => d.name.startsWith('feishu_')) || evictedActivated.some((n) => n.startsWith('feishu_'))).toBe(true);
  });

  it('CACHE: identical tool set emits byte-identical schema regardless of activation order (stable registry order)', () => {
    // Regression for slack cache hit rates: selectTools used to emit tools in the
    // per-turn insertion order of the `selected` Set (keyword hits / session
    // recentToolNames / discover activations all vary turn-to-turn), so the tool
    // JSON prefix drifted across turns and broke implicit prefix-cache.
    // Now the result is ordered by the allTools registry (Map) order, so the same
    // selected set always serializes identically.
    const selector = new ToolSelector();
    // Registry order is fixed at construction (insertion order of the Map).
    const allTools = makeToolMap([
      'agent_send_message', 'task_create', 'task_list', 'memory_save', 'shell_execute',
      'file_read', 'file_write', 'web_search', 'web_fetch', 'grep_search', 'glob_find',
    ]);
    const selFor = (msg: string, recent?: string[]) =>
      selector.selectTools({ allTools, userMessage: msg, recentToolNames: recent, isManager: false })
        .map(t => JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

    // Turn A: keyword hits shell/code (so recent order is whatever) but ends up
    // selecting the same set as turn B which hits browser keywords. To ALSO make
    // the *set* identical we pass identical recent tools that drive the set.
    const a = selFor('运行测试并读取文件', ['shell_execute', 'file_read', 'grep_search']);
    const b = selFor('用浏览器查资料', ['shell_execute', 'file_read', 'grep_search']);
    // Same selected set (core + same recents + keyword groups for each) may differ
    // in SET if keywords add different groups — so compare the ORDER of the shared
    // tools: every tool present in both must appear in the same relative order.
    const namesA = a.map(x => JSON.parse(x).name);
    const namesB = b.map(x => JSON.parse(x).name);
    const common = namesA.filter(n => namesB.includes(n));
    const orderA = namesA.filter(n => common.includes(n));
    const orderB = namesB.filter(n => common.includes(n));
    expect(orderA).toEqual(orderB);

    // discover_tools description must NOT contain a live per-turn count.
    const discover = selector.selectTools({ allTools, userMessage: 'x', isManager: true })
      .find(t => t.name === 'discover_tools');
    expect(discover!.description).not.toMatch(/You have \d+ tools active/);
  });
});
