import { createLogger } from '@markus/shared';
import type { LLMTool } from '@markus/shared';

const log = createLogger('tool-selector');

/**
 * Tool group definitions. Each group has activation keywords that trigger
 * its tools to be included in the LLM context.
 *
 * Design based on the 3-layer architecture pattern:
 * - Base tools: always included (~8 tools)
 * - Group tools: activated by keyword matching on the current context
 * - discover_tools meta-tool: always included, lets the agent request more
 */

export interface ToolGroup {
  name: string;
  keywords: string[];
  toolNames: string[];
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    name: 'git',
    keywords: ['git', 'commit', 'branch', 'merge', 'pull', 'push', 'diff', 'repo', '仓库', '代码库', '提交', '分支'],
    toolNames: ['git_status', 'git_diff', 'git_log', 'git_branch'],
  },
  {
    name: 'code',
    keywords: ['code', 'search', 'file', 'read', 'write', 'edit', 'project', 'structure', 'directory',
      '代码', '文件', '搜索', '目录', '编辑', '读取', '写入', '项目结构'],
    toolNames: ['code_search', 'project_structure', 'code_stats', 'file_read', 'file_write', 'file_edit'],
  },
  {
    name: 'shell',
    keywords: ['shell', 'command', 'terminal', 'run', 'execute', 'bash', 'npm', 'pip', 'install', 'build', 'test',
      '命令', '终端', '执行', '运行', '编译', '安装', '测试'],
    toolNames: ['shell_execute'],
  },
  {
    name: 'browser',
    keywords: ['browser', 'web', 'url', 'http', 'navigate', 'screenshot', 'click', 'page',
      '浏览器', '网页', '网站', '截图', '链接'],
    toolNames: ['browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_extract', 'browser_evaluate',
      'web_search', 'web_fetch'],
  },
  {
    name: 'gui',
    keywords: ['gui', 'screen', 'mouse', 'keyboard', 'window', 'desktop', 'click', 'type',
      '桌面', '鼠标', '键盘', '窗口', '屏幕'],
    toolNames: ['gui_screenshot', 'gui_click', 'gui_double_click', 'gui_type', 'gui_key_press',
      'gui_scroll', 'gui_get_window_title', 'gui_analyze_screen', 'gui_find_element',
      'gui_click_element', 'gui_type_to_element', 'gui_automate_task'],
  },
  {
    name: 'structured-a2a',
    keywords: ['delegate', 'collaborate', 'resource', 'broadcast', 'capability', 'progress',
      '委派', '协作', '资源', '广播', '能力', '进度'],
    toolNames: ['agent_request_resource', 'agent_sync_progress', 'agent_discover_capabilities',
      'agent_broadcast_status', 'agent_delegate_task', 'agent_request_collaboration'],
  },
  {
    name: 'group-chat',
    keywords: ['group', 'channel', 'chat', 'broadcast', '群聊', '频道', '群组'],
    toolNames: ['agent_send_group_message', 'agent_create_group_chat', 'agent_list_group_chats'],
  },
  {
    name: 'manager',
    keywords: ['team', 'delegate', 'status', 'manage', 'assign', 'route',
      '团队', '管理', '委派', '分配', '路由'],
    toolNames: ['team_list', 'team_status', 'delegate_message', 'create_task'],
  },
  {
    name: 'feishu',
    keywords: ['feishu', 'lark', '飞书', 'approval', '审批', '文档'],
    toolNames: ['feishu_send_message', 'feishu_send_card', 'feishu_search_docs',
      'feishu_read_doc', 'feishu_create_approval', 'feishu_approval_status'],
  },
  {
    name: 'todo',
    keywords: ['todo', 'plan', 'checklist', '待办', '计划', '清单'],
    toolNames: ['todo_write', 'todo_read'],
  },
  {
    name: 'knowledge',
    keywords: ['knowledge', 'knowledge base', 'contribute', 'convention', 'architecture decision',
      'gotcha', 'troubleshooting', 'best practice', 'lesson', 'pattern',
      '知识', '知识库', '贡献', '约定', '架构决策', '最佳实践', '经验'],
    toolNames: ['knowledge_contribute', 'knowledge_search', 'knowledge_browse', 'knowledge_flag_outdated'],
  },
];

/**
 * Base tools that are ALWAYS included in every LLM call.
 * These are universally useful and represent the minimum viable toolset.
 */
const BASE_TOOL_NAMES = new Set([
  // Communication (essential for any agent interaction)
  'agent_send_message',
  'agent_list_colleagues',
  // Task management (mandatory per system prompt)
  'task_create',
  'task_list',
  'task_update',
  // Memory (critical for context continuity)
  'memory_save',
  'memory_search',
  // Knowledge (shared team knowledge)
  'knowledge_search',
]);

export class ToolSelector {
  private groups: ToolGroup[];
  private baseToolNames: Set<string>;

  constructor(customGroups?: ToolGroup[]) {
    this.groups = customGroups ?? TOOL_GROUPS;
    this.baseToolNames = new Set(BASE_TOOL_NAMES);
  }

  /**
   * Select which tools to include in the LLM context based on:
   * 1. Base tools (always included)
   * 2. A `discover_tools` meta-tool (always included) so agent can request more
   * 3. Tools from groups whose keywords match the context
   * 4. Tools the agent used in recent messages (keep those active)
   */
  selectTools(opts: {
    allTools: Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>;
    userMessage: string;
    recentToolNames?: string[];
    isManager?: boolean;
    isTaskExecution?: boolean;
  }): LLMTool[] {
    const selected = new Set<string>();

    // 1. Always include base tools
    for (const name of this.baseToolNames) {
      if (opts.allTools.has(name)) selected.add(name);
    }

    // 2. Manager tools are always available for managers
    if (opts.isManager) {
      const managerGroup = this.groups.find(g => g.name === 'manager');
      if (managerGroup) {
        for (const name of managerGroup.toolNames) {
          if (opts.allTools.has(name)) selected.add(name);
        }
      }
    }

    // 3. Task execution gets code + shell + task tools by default
    if (opts.isTaskExecution) {
      for (const group of this.groups) {
        if (['code', 'shell', 'git'].includes(group.name)) {
          for (const name of group.toolNames) {
            if (opts.allTools.has(name)) selected.add(name);
          }
        }
      }
      // Also include full task management tools
      for (const name of ['task_get', 'task_note', 'task_assign']) {
        if (opts.allTools.has(name)) selected.add(name);
      }
    }

    // 4. Keyword matching: activate groups whose keywords appear in context
    const contextLower = opts.userMessage.toLowerCase();
    for (const group of this.groups) {
      if (group.toolNames.some(n => selected.has(n))) continue; // already activated
      const matched = group.keywords.some(kw => contextLower.includes(kw));
      if (matched) {
        for (const name of group.toolNames) {
          if (opts.allTools.has(name)) selected.add(name);
        }
        log.debug('Tool group activated by keyword', { group: group.name });
      }
    }

    // 5. Keep tools that were recently used (agent might need them in tool chains)
    if (opts.recentToolNames) {
      for (const name of opts.recentToolNames) {
        if (opts.allTools.has(name)) selected.add(name);
      }
    }

    // 6. Build the final tool list
    const result: LLMTool[] = [];
    for (const name of selected) {
      const tool = opts.allTools.get(name);
      if (tool) {
        result.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      }
    }

    // 7. Always add the discover_tools meta-tool so agent can request more
    result.push(this.buildDiscoverTool(opts.allTools, selected));

    log.debug('Tool selection complete', {
      total: opts.allTools.size,
      selected: result.length,
      groups: this.groups.filter(g => g.toolNames.some(n => selected.has(n))).map(g => g.name),
    });

    return result;
  }

  /**
   * A meta-tool that lists all available tool groups and their tools.
   * The agent can call this to discover what other tools exist and
   * request them by describing what it needs to do.
   */
  private buildDiscoverTool(
    allTools: Map<string, { name: string; description: string }>,
    alreadySelected: Set<string>,
  ): LLMTool {
    // Build a compact catalog of available (but not currently loaded) tools
    const unloaded: string[] = [];
    for (const [name, tool] of allTools) {
      if (!alreadySelected.has(name)) {
        unloaded.push(`${name}: ${tool.description.slice(0, 60)}`);
      }
    }

    return {
      name: 'discover_tools',
      description: `List additional tools not currently loaded. You have ${alreadySelected.size} tools active. ` +
        `${unloaded.length} more available:\n${unloaded.join('\n')}\n\n` +
        `Call this with the names of tools you need, and they will be activated for your next response.`,
      inputSchema: {
        type: 'object',
        properties: {
          tool_names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of tools to activate',
          },
        },
        required: ['tool_names'],
      },
    };
  }
}
