import { createLogger, type LLMTool } from '@markus/shared';
import type { SkillManifest } from './skills/types.js';

const log = createLogger('tool-selector');

/**
 * Tool group definitions. Each group has activation keywords that trigger
 * its tools to be included in the LLM context.
 *
 * Tool names must correspond to actual tools from createBuiltinTools() or
 * other tool providers (A2A, task, memory, etc.).
 */

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
    name: 'a2a-extended',
    keywords: ['delegate', 'broadcast', 'group', 'channel', 'chat',
      '委派', '广播', '群聊', '频道', '群组'],
    toolNames: ['agent_broadcast_status', 'agent_delegate_task',
      'agent_send_group_message', 'agent_create_group_chat', 'agent_list_group_chats'],
  },
  {
    name: 'manager',
    keywords: ['team', 'delegate', 'status', 'manage', 'assign', 'route',
      '团队', '管理', '委派', '分配', '路由'],
    toolNames: ['team_list', 'team_status', 'delegate_message', 'team_hire_agent', 'team_list_templates'],
  },
  {
    name: 'deliverables',
    keywords: ['deliverable', 'deliverables', 'output', 'artifact', 'convention', 'architecture decision',
      'gotcha', 'troubleshooting', 'best practice', 'lesson', 'pattern', 'report', 'document',
      '产出物', '产出', '交付物', '知识', '知识库', '贡献', '约定', '架构决策', '最佳实践', '经验'],
    toolNames: ['deliverable_create', 'deliverable_search', 'deliverable_list', 'deliverable_update'],
  },
];

/**
 * Base tools that are ALWAYS included in every LLM call.
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
  'deliverable_create',
  'spawn_subagent',
  'spawn_subagents',
]);

export class ToolSelector {
  private groups: ToolGroup[];
  private baseToolNames: Set<string>;

  constructor(customGroups?: ToolGroup[]) {
    this.groups = customGroups ?? TOOL_GROUPS;
    this.baseToolNames = new Set(BASE_TOOL_NAMES);
  }

  selectTools(opts: {
    allTools: Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>;
    userMessage: string;
    recentToolNames?: string[];
    isManager?: boolean;
    isTaskExecution?: boolean;
    isReview?: boolean;
    skillCatalog?: SkillManifest[];
  }): LLMTool[] {
    const selected = new Set<string>();

    for (const name of this.baseToolNames) {
      if (opts.allTools.has(name)) selected.add(name);
    }

    if (opts.isManager) {
      const managerGroup = this.groups.find(g => g.name === 'manager');
      if (managerGroup) {
        for (const name of managerGroup.toolNames) {
          if (opts.allTools.has(name)) selected.add(name);
        }
      }
    }

    if (opts.isTaskExecution) {
      for (const group of this.groups) {
        if (['code', 'shell'].includes(group.name)) {
          for (const name of group.toolNames) {
            if (opts.allTools.has(name)) selected.add(name);
          }
        }
      }
      for (const name of [
        'task_get', 'task_note', 'task_assign',
        'subtask_create', 'subtask_complete', 'subtask_list',
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

    const contextLower = opts.userMessage.toLowerCase();
    for (const group of this.groups) {
      if (group.toolNames.some(n => selected.has(n))) continue;
      const matched = group.keywords.some(kw => contextLower.includes(kw));
      if (matched) {
        for (const name of group.toolNames) {
          if (opts.allTools.has(name)) selected.add(name);
        }
        log.debug('Tool group activated by keyword', { group: group.name });
      }
    }

    if (opts.recentToolNames) {
      for (const name of opts.recentToolNames) {
        if (opts.allTools.has(name)) selected.add(name);
      }
    }

    const result: LLMTool[] = [];
    for (const name of selected) {
      const tool = opts.allTools.get(name);
      if (tool) {
        result.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      }
    }

    result.push(this.buildDiscoverTool(opts.allTools, selected, opts.skillCatalog));

    result.push({
      name: 'notify_user',
      description: 'Send a notification to the user. Use for status updates, reports, alerts, and findings that do not require user input. The notification appears in the user notification bell.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short headline (1 line)' },
          body: { type: 'string', description: 'Full notification content' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Default: normal' },
          related_task_id: { type: 'string', description: 'If related to a task, include the task ID for deep-linking' },
        },
        required: ['title', 'body'],
      },
    });

    result.push({
      name: 'request_user_approval',
      description: 'Request a decision or approval from the user. The tool BLOCKS until the user responds. Use when you need human approval, a choice between options, or any user decision/input. Default options: Approve / Reject (reject requires a reason). You can provide custom options and optionally allow freeform text input.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short headline for the approval request' },
          description: { type: 'string', description: 'Detailed context for the decision' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['id', 'label'],
            },
            description: 'Custom options. If omitted, defaults to Approve/Reject.',
          },
          allow_freeform: { type: 'boolean', description: 'Allow user to type a custom text response in addition to options. Default: false' },
          related_task_id: { type: 'string', description: 'If related to a task, include the task ID for deep-linking' },
          priority: { type: 'string', enum: ['normal', 'high', 'urgent'], description: 'Default: normal' },
        },
        required: ['title', 'description'],
      },
    });

    log.debug('Tool selection complete', {
      total: opts.allTools.size,
      selected: result.length,
      groups: this.groups.filter(g => g.toolNames.some(n => selected.has(n))).map(g => g.name),
    });

    return result;
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
    parts.push(`You have ${alreadySelected.size} tools active.`);

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

    const unloaded: string[] = [];
    for (const [name, tool] of allTools) {
      if (!alreadySelected.has(name)) {
        unloaded.push(`${name}: ${tool.description.slice(0, 60)}`);
      }
    }
    if (unloaded.length > 0) {
      parts.push(`\nInactive tools (${unloaded.length}):`);
      parts.push(unloaded.join('\n'));
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
