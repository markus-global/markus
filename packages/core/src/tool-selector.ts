import { createLogger, type LLMTool } from '@markus/shared';
import type { SkillManifest } from './skills/types.js';
import {
  type CapabilityPack,
  allowsWorkContextBoundTools,
  CONVERSE_FORBIDDEN_DEFAULT,
  evictToolsToBudget,
  getReflexAllowlist,
  isSkillOrMcpToolName,
  isWorkContextBoundTool,
  packToolDefBudget,
  TOOL_DEF_CORE_KEEP,
  TOOL_DEF_PROTECTED,
} from './capability-packs.js';

const log = createLogger('tool-selector');

/**
 * Tool group definitions. Each group has activation keywords that trigger
 * its tools to be included in the LLM context.
 *
 * Tool names must correspond to actual tools from createBuiltinTools() or
 * other tool providers (A2A, task, memory, etc.).
 */

/** Evicted-tool catalog from the last selectTools call (Afford.S2 side channel). */
type DeferredCatalogEntry = { name: string; description: string };

export interface ToolGroup {
  name: string;
  keywords: string[];
  toolNames: string[];
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    name: 'shell',
    keywords: ['shell', 'command', 'terminal', 'run', 'execute', 'bash', 'npm', 'pip', 'install', 'build', 'test',
      'git', 'commit', 'branch', 'merge', 'pull', 'push', 'diff', 'repo',
      '命令', '终端', '执行', '运行', '编译', '安装', '测试', '仓库', '代码库', '提交', '分支'],
    toolNames: ['shell_execute'],
  },
  {
    name: 'code',
    keywords: ['code', 'search', 'file', 'read', 'write', 'edit', 'project', 'structure', 'directory',
      '代码', '文件', '搜索', '目录', '编辑', '读取', '写入', '项目结构'],
    toolNames: ['file_read', 'file_write', 'file_edit', 'grep_search', 'glob_find', 'list_directory', 'apply_patch'],
  },
  {
    name: 'browser',
    keywords: ['browser', 'web', 'url', 'http', 'navigate', 'page', 'fetch', 'scrape',
      '浏览器', '网页', '网站', '链接'],
    toolNames: ['web_fetch', 'web_search', 'web_extract'],
  },
  {
    name: 'llm-settings',
    keywords: ['model', 'provider', 'llm', 'switch model', 'change model', 'default model', 'api key',
      'openai', 'anthropic', 'claude', 'gpt', 'gemini', 'deepseek', 'openrouter', 'ollama',
      '模型', '切换模型', '换模型', '大模型', '提供商', '默认模型', '模型配置', '模型路由'],
    toolNames: ['llm_list_providers', 'llm_switch_model', 'llm_switch_default_provider',
      'llm_add_provider', 'llm_edit_provider', 'llm_add_model', 'llm_set_capability_routing'],
  },
  {
    name: 'image-generation',
    keywords: ['image', 'picture', 'photo', 'draw', 'paint', 'illustration', 'generate image', 'dall-e', 'dalle',
      'stable diffusion', 'flux', 'midjourney', 'cogview', 'imagen',
      '图片', '画图', '生成图', '画一', '图像', '插图', '绘画', '绘图', '照片'],
    toolNames: ['generate_image'],
  },
  {
    name: 'audio-video',
    keywords: ['speech', 'voice', 'audio', 'tts', 'stt', 'transcribe', 'speak', 'read aloud',
      'video', 'animate', 'clip',
      '语音', '朗读', '转语音', '听写', '转文字', '视频', '动画'],
    toolNames: ['text_to_speech', 'speech_to_text', 'generate_video'],
  },
  {
    name: 'a2a-extended',
    keywords: ['delegate', 'broadcast', 'group', 'channel', 'chat',
      '委派', '广播', '群聊', '频道', '群组'],
    toolNames: ['agent_broadcast_status', 'agent_delegate_task',
      'agent_send_group_message', 'agent_create_group_chat', 'agent_list_group_chats',
      'recall_context'],
  },
  {
    name: 'manager',
    keywords: ['team', 'delegate', 'status', 'manage', 'assign', 'route', 'stop', 'start', 'wake', 'shutdown',
      '团队', '管理', '委派', '分配', '路由', '停止', '启动', '唤醒', '关闭'],
    toolNames: ['team_list', 'team_status', 'delegate_message', 'agent_stop', 'agent_start'],
  },
  {
    name: 'secretary',
    keywords: ['stop', 'start', 'wake', 'shutdown', 'team', 'manage', 'hire', 'create team',
      '停止', '启动', '唤醒', '关闭', '团队', '管理', '招聘', '建队', '创建团队'],
    toolNames: ['list_teams', 'team_stop', 'team_start'],
  },
  {
    name: 'deliverables',
    keywords: ['deliverable', 'deliverables', 'output', 'artifact', 'convention', 'architecture decision',
      'gotcha', 'troubleshooting', 'best practice', 'lesson', 'pattern', 'report', 'document',
      'knowledge base', 'knowledge', 'kb', 'synced document',
      '产出物', '产出', '交付物', '知识', '知识库', '贡献', '约定', '架构决策', '最佳实践', '经验'],
    toolNames: ['deliverable_create', 'deliverable_search', 'deliverable_list', 'deliverable_update',
      'knowledge_search', 'knowledge_list', 'knowledge_read'],
  },
  {
    name: 'office',
    keywords: ['office', 'word', 'docx', 'excel', 'xlsx', 'spreadsheet', 'powerpoint', 'pptx', 'pdf',
      'generate document', 'generate report', 'create word', 'create excel', 'create powerpoint',
      '办公', '文档', '表格', '演示', '幻灯片', '报告', '生成文档', '生成报告', '生成表格', '生成演示', '生成PDF'],
    toolNames: ['office_generate'],
  },
  {
    name: 'packages',
    keywords: ['builder', 'artifact', 'deploy', 'skill', 'package', 'hub', 'hire', 'install agent', 'install team',
      '部署', '工件', '技能包', '招聘', '安装', 'builder-artifacts'],
    toolNames: ['package_list', 'package_install', 'hub_search', 'hub_install'],
  },
  {
    name: 'coding',
    keywords: [
      'code', 'coding', 'program', 'develop', 'implement', 'refactor',
      'debug', 'fix bug', 'feature', 'repository', 'repo',
      'claude code', 'codex', 'cursor',
      '编程', '编码', '开发', '实现', '重构', '调试',
    ],
    toolNames: ['invoke_coding_tool', 'coding_tool_apply'],
  },
];

/**
 * Converse/execute base tools (spawn_subagents / deliverable_create are
 * discover-only per AGENT-RUNTIME §2.3 — not in the default set).
 */
const BASE_TOOL_NAMES = new Set([
  'agent_send_message',
  'agent_list_colleagues',
  'task_create',
  'task_list',
  'task_update',
  'task_comment',
  'requirement_comment',
  'memory_save',
  'memory_search',
  'deliverable_search',
  'spawn_subagent',
  'session',
]);

export class ToolSelector {
  private groups: ToolGroup[];
  private baseToolNames: Set<string>;
  /** Side channel: tools evicted in the last selectTools (inject into system Tier 3). */
  private lastDeferredCatalog: DeferredCatalogEntry[] = [];
  /** Activated skill/MCP names deferred under budget (caller should prune sticky set). */
  private lastEvictedActivated: string[] = [];

  constructor(customGroups?: ToolGroup[]) {
    this.groups = customGroups ?? TOOL_GROUPS;
    this.baseToolNames = new Set(BASE_TOOL_NAMES);
  }

  /** Consume deferred catalog from the last selectTools (clears after read). */
  consumeDeferredCatalog(): DeferredCatalogEntry[] {
    const catalog = this.lastDeferredCatalog;
    this.lastDeferredCatalog = [];
    return catalog;
  }

  /** Consume activated names that were LRU-deferred (clears after read). */
  consumeEvictedActivated(): string[] {
    const names = this.lastEvictedActivated;
    this.lastEvictedActivated = [];
    return names;
  }

  selectTools(opts: {
    allTools: Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; getDescription?(): string; getInputSchema?(): Record<string, unknown> }>;
    userMessage: string;
    recentToolNames?: string[];
    isManager?: boolean;
    /** Secretary always gets org team + package hire tools (not keyword-gated). */
    isSecretary?: boolean;
    isTaskExecution?: boolean;
    isReview?: boolean;
    /** Team Chat (DM) — enables right-panel layout tools. */
    isChat?: boolean;
    skillCatalog?: SkillManifest[];
    /** Scenario capability pack (AGENT-RUNTIME §2). Default converse. */
    pack?: CapabilityPack;
    /** AgentScenario name — used with pack to allow work-context-bound tools. */
    scenario?: string;
    /**
     * Tools activated via discover_tools this session — must stay in the schema
     * (never evicted). Without this, activation is a no-op after budget eviction
     * and the model spins on discover_tools forever.
     */
    activatedToolNames?: Iterable<string>;
  }): LLMTool[] {
    const pack: CapabilityPack = opts.pack
      ?? (opts.isTaskExecution ? 'execute' : opts.isReview ? 'govern' : 'converse');
    const scenario = opts.scenario
      ?? (opts.isTaskExecution ? 'task_execution' : opts.isReview ? 'review' : undefined);
    const allowWorkCtx = allowsWorkContextBoundTools(pack, scenario);
    const selected = new Set<string>();

    if (pack === 'reflex') {
      for (const name of getReflexAllowlist(!!opts.isManager)) {
        if (opts.allTools.has(name)) selected.add(name);
      }
    } else {
      for (const name of this.baseToolNames) {
        if (opts.allTools.has(name)) selected.add(name);
      }
      // Always-on Markus core (shell/file/task/…) — progressive disclosure applies
      // to skill/MCP schemas, not to these. Never leave them deferred behind Feishu.
      for (const name of TOOL_DEF_CORE_KEEP) {
        if (opts.allTools.has(name)) selected.add(name);
      }
    }

    const activated = new Set(opts.activatedToolNames ?? []);

    // Manager/secretary package unions — not in reflex (discover only).
    if (pack !== 'reflex' && opts.isManager) {
      for (const group of this.groups) {
        if (group.name === 'manager' || group.name === 'packages') {
          for (const name of group.toolNames) {
            if (opts.allTools.has(name)) selected.add(name);
          }
        }
      }
    }

    if (pack !== 'reflex' && opts.isSecretary) {
      for (const group of this.groups) {
        if (group.name === 'secretary' || group.name === 'packages') {
          for (const name of group.toolNames) {
            if (opts.allTools.has(name)) selected.add(name);
          }
        }
      }
    }

    if (opts.isTaskExecution) {
      for (const group of this.groups) {
        if (['code', 'shell', 'coding'].includes(group.name)) {
          for (const name of group.toolNames) {
            if (opts.allTools.has(name)) selected.add(name);
          }
        }
      }
      for (const name of [
        'task_get', 'task_note', 'task_assign',
        'subtask_create', 'subtask_complete', 'subtask_cancel', 'subtask_list',
        'task_submit_review',
        'requirement_get', 'requirement_update', 'requirement_resubmit',
      ]) {
        if (opts.allTools.has(name)) selected.add(name);
      }
    }

    if (opts.isReview) {
      for (const group of this.groups) {
        if (['code', 'shell'].includes(group.name)) {
          for (const name of group.toolNames) {
            if (opts.allTools.has(name)) selected.add(name);
          }
        }
      }
      for (const name of [
        'task_get', 'task_note',
        'requirement_get',
      ]) {
        if (opts.allTools.has(name)) selected.add(name);
      }
    }

    // Keyword / recent are accelerators — skipped for reflex (slim patrol pack).
    if (pack !== 'reflex') {
      const contextLower = (opts.userMessage ?? '').toLowerCase();
      for (const group of this.groups) {
        // Only skip keyword activation when the WHOLE group is already in — a
        // partially-present group must still be able to add the rest (e.g.
        // deliverable_search is base-always-on, so a keyword hit must still
        // surface knowledge_search/list/read).
        if (group.toolNames.length > 0 && group.toolNames.every(n => selected.has(n))) continue;
        const matched = group.keywords.some(kw => contextLower.includes(kw));
        if (matched) {
          for (const name of group.toolNames) {
            if (opts.allTools.has(name)) selected.add(name);
          }
          log.debug('Tool group activated by keyword', { group: group.name });
        }
      }

      // Sticky recent: Markus tools only. Skill/MCP schemas enter LIVE solely via
      // discover_tools activation — never by sticky/recent alone.
      // Work-context-bound tools (submit/subtask/note) sticky only in entity
      // sessions (execute / review / comment / requirement / workflow) — not chat.
      if (opts.recentToolNames) {
        for (const name of opts.recentToolNames) {
          if (!opts.allTools.has(name)) continue;
          if (isSkillOrMcpToolName(name) && !activated.has(name)) continue;
          if (isWorkContextBoundTool(name) && !allowWorkCtx) continue;
          selected.add(name);
        }
      }
      for (const name of activated) {
        if (!opts.allTools.has(name)) continue;
        if (isWorkContextBoundTool(name) && !allowWorkCtx) continue;
        selected.add(name);
      }
    }

    const result: LLMTool[] = [];
    // Cache-friendly: emit selected tools in REGISTRY order (allTools is a Map
    // that preserves registration order), NOT in the per-turn insertion order of
    // the `selected` Set (= userMessage keyword hits, session recentToolNames,
    // discover_tools activations). A deterministic, order-stable tool schema is
    // what keeps the implicit prefix-cache (OpenAI/DeepSeek/OpenRouter) key
    // stable across turns — identical tool sets produce byte-identical JSON even
    // when the activation *order* differed between turns.
    for (const name of opts.allTools.keys()) {
      if (!selected.has(name)) continue;
      // Defense in depth: skill/MCP never LIVE unless explicitly activated
      if (isSkillOrMcpToolName(name) && !activated.has(name)) continue;
      // Defense in depth: work-context tools stay out of free chat / reflex
      if (isWorkContextBoundTool(name) && !allowWorkCtx) continue;
      const tool = opts.allTools.get(name);
      if (tool) {
        result.push({
          name: tool.name,
          description: tool.getDescription?.() ?? tool.description,
          inputSchema: tool.getInputSchema?.() ?? tool.inputSchema,
        });
      }
    }

    const seen = new Set(result.map(t => t.name));

    result.push(this.buildDiscoverTool(opts.allTools, selected, opts.skillCatalog));
    seen.add('discover_tools');

    const pushUnique = (tool: LLMTool) => {
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        result.push(tool);
      }
    };

    pushUnique({
      name: 'notify_user',
      description: 'Send a notification to a human team member. The message appears in the agent chat and as a notification. Write a comprehensive body — the user sees the full content and may reply. Use for status updates, reports, alerts, and findings.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short headline (1 line)' },
          body: { type: 'string', description: 'Full message content. Be thorough — this is what the recipient reads in chat.' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Default: normal' },
          related_task_id: { type: 'string', description: 'If related to a task, include the task ID for deep-linking' },
          target_user_id: { type: 'string', description: 'User ID to send the message to. If omitted, sends to the user you are currently interacting with (or the team owner).' },
        },
        required: ['title', 'body'],
      },
    });

    // Team Chat only: open/collapse the right-side preview panel (deliverable / file / url).
    if (opts.isChat) {
      pushUnique({
        name: 'open_right_panel',
        description:
          'Open the user\'s Team Chat right-side panel and show content. Use to display a webpage, a local file, or a deliverable while chatting. '
          + 'Provide exactly one of: url, path, or deliverable_id. Collapse with collapse_right_panel (does not destroy tabs).',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Webpage URL to open in the embedded browser (e.g. https://example.com)' },
            path: { type: 'string', description: 'Local/workspace file path to preview' },
            deliverable_id: { type: 'string', description: 'Deliverable ID to preview' },
            title: { type: 'string', description: 'Optional tab title' },
          },
        },
      });
      pushUnique({
        name: 'collapse_right_panel',
        description:
          'Collapse (hide) the Team Chat right-side panel without closing/destroying its tabs. '
          + 'The user can restore them later. Use after you no longer need the panel visible.',
        inputSchema: { type: 'object', properties: {} },
      });
    }

    // Shared schema for request_user_input (and its deprecated alias request_user_approval).
    // Supports one OR multiple questions, and Markdown in question prompts and option labels.
    const userInputSchema = {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short headline shown to the user' },
        description: { type: 'string', description: 'Optional overall context (Markdown supported). For a single simple decision you may put the full prompt here.' },
        questions: {
          type: 'array',
          description: 'One or more questions to ask. When omitted, a single decision derived from title/description (plus options, if any, else Approve/Reject) is shown. The UI lets the user page through all questions and submit once all required ones are answered.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id used to key this question\'s answer. Auto-generated if omitted.' },
              prompt: { type: 'string', description: 'The question text. Markdown supported (use it for rich formatting, code, lists).' },
              input_type: { type: 'string', enum: ['choice', 'text'], description: 'choice = pick from options; text = freeform answer. Defaults to choice when options are given, otherwise text.' },
              options: {
                type: 'array',
                description: 'Choices for a choice question. label and description support Markdown, so options can carry rich content.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
              allow_multiple: { type: 'boolean', description: 'REQUIRED for choice questions (no default): set false for single-select or true for multi-select. The call is rejected if this is omitted for a choice question.' },
              allow_freeform: { type: 'boolean', description: 'REQUIRED for choice questions (no default): set true to also allow a freeform text answer in addition to the options, or false for options-only. The call is rejected if this is omitted for a choice question.' },
            },
            required: ['prompt'],
          },
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['label'],
          },
          description: 'Shorthand for a single choice question (back-compat). Prefer questions[] for anything richer. If omitted and no questions are given, defaults to Approve/Reject.',
        },
        allow_multiple: { type: 'boolean', description: 'REQUIRED when using the `options` shorthand (no default): set false for single-select or true for multi-select. The call is rejected if omitted.' },
        allow_freeform: { type: 'boolean', description: 'REQUIRED when using the `options` shorthand (no default): set true to also allow a custom text response in addition to options, or false for options-only. The call is rejected if omitted.' },
        related_task_id: { type: 'string', description: 'If related to a task, include the task ID for deep-linking' },
        priority: { type: 'string', enum: ['normal', 'high', 'urgent'], description: 'Default: normal' },
      },
      required: ['title'],
    };

    pushUnique({
      name: 'request_user_input',
      description: 'Request input or a decision from a human that is NOT already covered by a built-in UI. BLOCKS until they respond. Use for preferences, ambiguous choices, collecting facts, quizzes, or irreversible actions outside entity cards. Supports MULTIPLE questions via questions[], and Markdown in prompts/option labels. If neither questions nor options are provided, defaults to Approve/Reject (reject requires a reason). Do NOT use to approve requirements or tasks — those already have system Approve/Reject buttons (and creation already notifies the human). Do NOT use for routine status updates (use notify_user, or nothing if the system already notified).',
      inputSchema: userInputSchema,
    });

    // Deprecated alias — kept so existing prompts/flows referring to the old name keep working.
    pushUnique({
      name: 'request_user_approval',
      description: 'DEPRECATED alias of request_user_input. Prefer request_user_input. Same rules: do NOT use for requirement/task approval (built-in buttons exist).',
      inputSchema: userInputSchema,
    });

    pushUnique({
      name: 'schedule_wakeup',
      description: 'Schedule a future self-check-in ("wake me up later"). Prefer this over relying on frequent heartbeats: register a wakeup for the exact time you need to follow up (e.g. re-check a task in 2h, remind yourself tomorrow at 9am), then stop working. When it fires you receive a mailbox item and can act. This saves tokens by avoiding constant polling. Provide EITHER in_seconds OR an ISO `at` timestamp.',
      inputSchema: {
        type: 'object',
        properties: {
          in_seconds: { type: 'number', description: 'Fire after this many seconds from now. Use for relative delays (e.g. 7200 = 2 hours).' },
          at: { type: 'string', description: 'ISO 8601 timestamp to fire at (absolute time). Use in the user\'s timezone when relevant.' },
          note: { type: 'string', description: 'Optional but strongly recommended — why you are waking up / what to do when it fires, since future-you needs the context. If omitted, a generic note is used.' },
          recurring_seconds: { type: 'number', description: 'If set (>0), re-arm the wakeup this many seconds after each firing (recurring reminder). Omit for a one-shot.' },
          delivery: { type: 'string', enum: ['mailbox', 'in_session'], description: 'mailbox (default) = a fresh attention cycle; in_session = resume the current conversation. Use mailbox for autonomous follow-ups.' },
        },
        required: [],
      },
    });

    pushUnique({
      name: 'cancel_wakeup',
      description: 'Cancel a previously scheduled wakeup by its id (returned from schedule_wakeup). Use when a follow-up is no longer needed.',
      inputSchema: {
        type: 'object',
        properties: {
          wakeup_id: { type: 'string', description: 'The wakeup id returned by schedule_wakeup.' },
        },
        required: ['wakeup_id'],
      },
    });

    pushUnique({
      name: 'set_heartbeat_interval',
      description: 'Adjust your own heartbeat (periodic safety-net patrol) interval. The heartbeat is a coarse fallback — prefer schedule_wakeup for precise follow-ups. Increase the interval to save tokens when you are idle; decrease it if you need to patrol more often. The value is clamped to a safe range (5 minutes – 24 hours) and applied immediately. Provide EITHER interval_minutes OR interval_ms.',
      inputSchema: {
        type: 'object',
        properties: {
          interval_minutes: { type: 'number', description: 'New patrol interval in minutes (e.g. 360 = every 6 hours). Preferred, human-readable form.' },
          interval_ms: { type: 'number', description: 'New patrol interval in milliseconds. Use interval_minutes instead unless you need sub-minute precision.' },
        },
      },
    });

    pushUnique({
      name: 'recall_activity',
      description: [
        'Look up your own past execution history.',
        '• Recent: {} or { "limit": 10 }',
        '• Details: { "activity_id": "act-..." }',
        '• Search: { "query": "keywords" }',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          activity_id: { type: 'string', description: 'If set, return detailed logs for this activity.' },
          query: { type: 'string', description: 'If set (no activity_id), search summaries by keywords. Omit both to list recent.' },
          task_id: { type: 'string', description: 'Optional list filter: only this task.' },
          type: { type: 'string', description: 'Optional list filter: activity kind (chat, task, heartbeat).' },
          limit: { type: 'number', description: 'Max results for list/search (default 5, max 20).' },
          operation: {
            type: 'string',
            enum: ['list', 'get', 'search'],
            description: 'Optional legacy override. Prefer activity_id / query / empty args.',
          },
        },
        required: [],
      },
    });

    pushUnique({
      name: 'complete_deliberation',
      description: 'Finalize your mailbox deliberation. Declare which item(s) to process next, which to defer/drop, and which you handled inline. Supports batch processing: pass multiple IDs in process_item_ids to handle related items together in one session. Only available in deliberation mode.',
      inputSchema: {
        type: 'object',
        properties: {
          process_item_id: { type: 'string', description: 'ID of the primary mailbox item to process next. Required unless process_item_ids is provided.' },
          process_item_ids: { type: 'array', items: { type: 'string' }, description: 'Batch mode: IDs of multiple items to process together in one session. Use for related items (same channel, same topic). Overrides process_item_id when length > 1.' },
          batch_context: { type: 'string', description: 'When using batch mode, optional synthesis/instruction for how to handle the batch together.' },
          defer_item_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of items to defer for later' },
          drop_item_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of stale/redundant items to drop' },
          inline_completed_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of items you already handled inline during this deliberation (e.g., sent a notification, posted a comment)' },
          reasoning: { type: 'string', description: '1-2 sentence explanation of your decision' },
          situational_awareness: { type: 'string', description: 'Your current understanding of the situation — injected into future prompts for continuity' },
          memory_updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['working', 'longterm'], description: 'working = volatile per-session memory, longterm = persisted to knowledge.md' },
                key: { type: 'string', description: 'Memory key/section name' },
                content: { type: 'string', description: 'Content to store' },
              },
              required: ['type', 'key', 'content'],
            },
            description: 'Memory updates to apply after deliberation. Use to record observations, team decisions, or context for future cycles.',
          },
        },
        required: ['reasoning'],
      },
    });

    // check_mailbox / defer / drop / prioritize are available via DELIBERATION_ALLOWED_TOOLS
    // only — they are NOT always-on during normal processing to prevent the agent
    // from getting distracted by the full backlog instead of focusing on the
    // current item.

    pushUnique({
      name: 'update_working_memory',
      description: 'Upsert a keyed entry in your working memory. Use to track priorities, context, decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Label for this entry' },
          content: { type: 'string', description: 'The content to store' },
        },
        required: ['key', 'content'],
      },
    });

    pushUnique({
      name: 'clear_working_memory',
      description: 'Remove a working memory entry by key, or clear all entries.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to clear. Omit to clear all.' },
          all: { type: 'boolean', description: 'Set true to clear all entries' },
        },
      },
    });

    // Converse: spawn_subagents / deliverable_create are discover-only.
    if (pack === 'converse' || pack === 'govern') {
      for (let i = result.length - 1; i >= 0; i--) {
        const n = result[i]?.name;
        if (n && CONVERSE_FORBIDDEN_DEFAULT.has(n)) result.splice(i, 1);
      }
    }

    // Reflex: keep only allowlist + protected HITL/discover (drop extras pushed below).
    if (pack === 'reflex') {
      const allow = getReflexAllowlist(!!opts.isManager);
      for (const p of TOOL_DEF_PROTECTED) allow.add(p);
      for (let i = result.length - 1; i >= 0; i--) {
        const n = result[i]?.name;
        if (n && !allow.has(n)) result.splice(i, 1);
      }
    }

    const budget = packToolDefBudget(pack);
    // HITL/discover + Markus core are eviction-immune.
    // Activated skill/MCP are LIVE but LRU-evictable under budget (progressive disclosure).
    const protectedNames = new Set<string>([...TOOL_DEF_PROTECTED, ...TOOL_DEF_CORE_KEEP]);
    for (const name of activated) {
      if (!isSkillOrMcpToolName(name)) protectedNames.add(name);
    }
    const { tools: capped, evicted } = evictToolsToBudget(
      result,
      budget,
      protectedNames,
      TOOL_DEF_CORE_KEEP,
    );
    // Afford.S2: catalog goes to system Tier 3 via consumeDeferredCatalog — NOT tool schema.
    this.lastDeferredCatalog = evicted.map((e) => ({
      name: e.name,
      description: (e.description || '').slice(0, 40),
    }));
    this.lastEvictedActivated = evicted
      .map((e) => e.name)
      .filter((n) => activated.has(n) && isSkillOrMcpToolName(n));
    if (evicted.length) {
      log.info('Tool defs capped to pack budget', {
        pack,
        budget,
        kept: capped.length,
        evicted: evicted.map((e) => e.name),
        evictedActivated: this.lastEvictedActivated,
      });
    }

    log.debug('Tool selection complete', {
      total: opts.allTools.size,
      selected: capped.length,
      pack,
      groups: this.groups.filter(g => g.toolNames.some(n => selected.has(n))).map(g => g.name),
    });

    return capped;
  }

  /**
   * Build the discover_tools meta-tool description.
   * Lists inactive tools and available skills (prompt-based instruction packages).
   */
  private buildDiscoverTool(
    allTools: Map<string, { name: string; description: string }>,
    alreadySelected: Set<string>,
    skillCatalog?: SkillManifest[],
  ): LLMTool {
    const parts: string[] = [];
    // Cache-friendly: avoid embedding a per-turn count ("N tools active") in the
    // schema — N changes every turn, which would shift the discover_tools
    // schema prefix and break implicit prefix-cache across turns.
    parts.push('Discover and activate tools/skills by name (schemas for inactive ones are omitted here).');

    if (skillCatalog && skillCatalog.length > 0) {
      const maxSkills = 30;
      const shown = skillCatalog.slice(0, maxSkills);
      parts.push(`\nSkills available (activate by name to load instructions into your context):`);
      for (const skill of shown) {
        const desc = skill.description.slice(0, 80);
        const tag = skill.instructions ? 'has instructions' : 'no instructions';
        parts.push(`  [${skill.name}] ${desc} (${tag})`);
      }
      if (skillCatalog.length > maxSkills) {
        parts.push(`  ... and ${skillCatalog.length - maxSkills} more (use mode="list_skills" to see all)`);
      }
    }

    // Progressive disclosure: aggregate skill/MCP namespaces; list lone tools briefly.
    const unloaded: string[] = [];
    for (const [name] of allTools) {
      if (!alreadySelected.has(name)) unloaded.push(name);
    }
    if (unloaded.length > 0) {
      const groups = new Map<string, string[]>();
      const singles: string[] = [];
      for (const name of unloaded) {
        if (name.includes('__')) {
          const ns = name.split('__')[0] + '__*';
          const list = groups.get(ns) ?? [];
          list.push(name);
          groups.set(ns, list);
        } else if (name.startsWith('feishu_')) {
          const list = groups.get('feishu_*') ?? [];
          list.push(name);
          groups.set('feishu_*', list);
        } else if (name.startsWith('chrome-devtools') || name.startsWith('chrome_')) {
          const list = groups.get('chrome-devtools*') ?? [];
          list.push(name);
          groups.set('chrome-devtools*', list);
        } else {
          singles.push(name);
        }
      }
      parts.push('\nOptional extras (not LIVE yet — core shell/file/task tools do not need this):');
      for (const [ns, names] of groups) {
        parts.push(`  ${ns} (${names.length}) e.g. ${names.slice(0, 2).join(', ')}`);
      }
      if (singles.length > 0) {
        parts.push(`  other: ${singles.slice(0, 15).join(', ')}${singles.length > 15 ? ` … +${singles.length - 15}` : ''}`);
      }
    }

    parts.push('\nUsage: pass skill/tool names in "name" to activate them. Works in all modes.');
    parts.push('Skills inject instructions into your context; tools become callable.');
    parts.push('Use mode="list_skills" to get full skill details.');
    parts.push('Use mode="search_registry" with query to search remote skill registries (SkillHub, skills.sh) for uninstalled skills.');
    parts.push('Use mode="install" with name to install a skill from a remote registry.');

    return {
      name: 'discover_tools',
      description: parts.join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'array',
            items: { type: 'string' },
            description: 'Skill or tool name(s) to activate or install. E.g. ["team-building"] or ["shell_execute", "file_read"].',
          },
          mode: {
            type: 'string',
            enum: ['activate', 'list_skills', 'search_registry', 'install'],
            description: 'Mode: "activate" (default) activates tools/skills, "list_skills" browses installed skills, "search_registry" searches remote registries, "install" installs from registry',
          },
          query: {
            type: 'string',
            description: 'Search query for mode="search_registry"',
          },
          source: { type: 'string', description: 'Source registry for install: "skillhub" or "skillssh"' },
          slug: { type: 'string', description: 'Slug identifier for SkillHub install' },
          githubRepo: { type: 'string', description: 'GitHub repo (owner/repo) for skills.sh install' },
          githubSkillPath: { type: 'string', description: 'Skill path within GitHub repo' },
        },
      },
    };
  }
}
