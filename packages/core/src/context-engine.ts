import { readFileSync, existsSync } from 'node:fs';
import {
  createLogger,
  getTextContent,
  type LLMMessage,
  type RoleTemplate,
  type IdentityContext,
} from '@markus/shared';
import type { IMemoryStore, MemoryEntry } from './memory/types.js';
import type { SemanticMemorySearch } from './memory/semantic-search.js';
import { getDefaultTokenCounter, type TokenCounter } from './token-counter.js';
import type { EnvironmentProfile } from './environment-profile.js';

const log = createLogger('context-engine');

export interface ContextConfig {
  memorySearchTopK: number;
  tokenCounter?: TokenCounter;
}

const DEFAULT_CONFIG: ContextConfig = {
  memorySearchTopK: 5,
};

export interface OrgContext {
  orgName: string;
  teamName?: string;
  colleagues?: Array<{ name: string; role: string; id: string }>;
  projects?: Array<{ name: string; description: string }>;
  customContext?: string;
}

export interface ContextUsageStats {
  contextWindow: number;
  systemTokens: number;
  toolDefTokens: number;
  messageTokens: number;
  maxOutputReserved: number;
  safetyMargin: number;
  totalUsed: number;
  available: number;
  usagePercent: number;
}

export interface PreparedContext {
  messages: LLMMessage[];
  usage: ContextUsageStats;
}

function estimateTokens(text: string, counter?: TokenCounter): number {
  return (counter ?? getDefaultTokenCounter()).countTokens(text);
}

function estimateMessageTokens(msg: LLMMessage, counter?: TokenCounter): number {
  const tc = counter ?? getDefaultTokenCounter();
  const textContent = getTextContent(msg.content);
  let tokens = tc.countMessageTokens(textContent, msg.role);
  if (Array.isArray(msg.content)) {
    const imageCount = msg.content.filter(p => p.type === 'image_url').length;
    tokens += imageCount * 1000;
  }
  if (msg.toolCalls) tokens += tc.countTokens(JSON.stringify(msg.toolCalls));
  return tokens;
}

/**
 * Callback type for LLM-powered conversation summarization.
 * Given a list of messages, returns a concise summary string.
 * Used by ContextEngine when compacting old conversation history.
 */
export type LLMSummarizer = (messages: LLMMessage[]) => Promise<string>;

export class ContextEngine {
  private config: ContextConfig;
  private tokenCounter: TokenCounter;
  private semanticSearch?: SemanticMemorySearch;
  private llmSummarizer?: LLMSummarizer;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = config?.tokenCounter ?? getDefaultTokenCounter();
  }

  setSemanticSearch(ss: SemanticMemorySearch): void {
    this.semanticSearch = ss;
  }

  setLLMSummarizer(summarizer: LLMSummarizer): void {
    this.llmSummarizer = summarizer;
  }

  async buildSystemPrompt(opts: {
    agentId: string;
    agentName: string;
    role: RoleTemplate;
    orgContext?: OrgContext;
    contextMdPath?: string;
    memory: IMemoryStore;
    currentQuery?: string;
    identity?: IdentityContext;
    senderIdentity?: { id: string; name: string; role: string };
    assignedTasks?: Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      assignedAgentId?: string;
      assignedAgentName?: string;
    }>;
    knowledgeContext?: string;
    deliverableContext?: string;
    environment?: EnvironmentProfile;
    // Governance context extensions
    projectContext?: {
      project: { id: string; name: string; description: string; status: string };
      repositories?: Array<{ localPath: string; defaultBranch: string; role: string }>;
      governanceRules?: string;
      teamRole?: string;
    };
    currentWorkspace?: {
      branch: string;
      workingDirectory: string;
      baseBranch: string;
    };
    announcements?: Array<{
      type: string;
      priority: string;
      title: string;
      content: string;
    }>;
    trustLevel?: { level: string; score: number };
    projectDeliverables?: Array<{
      category: string;
      title: string;
      content: string;
    }>;
    recentFeedback?: Array<{
      authorName: string;
      priority: string;
      content: string;
      anchor?: { section: string; itemId?: string };
    }>;
    scenario?: 'chat' | 'task_execution' | 'heartbeat' | 'a2a' | 'comment_response';
    agentWorkspace?: {
      primaryWorkspace: string;
      sharedWorkspace?: string;
      builderArtifactsDir?: string;
    };
    agentDataDir?: string;
    dynamicContext?: string;
    teamAnnouncements?: string;
    teamNorms?: string;
    teamDataDir?: string;
    isTeamManager?: boolean;
    availableSkills?: Array<{ name: string; description: string; category: string }>;
    mailboxContext?: {
      currentFocus?: { type: string; label: string; elapsedMs: number; taskId?: string };
      queueDepth: number;
      topQueued?: Array<{ type: string; priority: number; summary: string }>;
      recentDecisions?: Array<{ type: string; reasoning: string }>;
      mergedContent?: string;
    };
    chatSessions?: Array<{ id: string; title?: string; lastMessageAt: string; lastMessagePreview?: string }>;
  }): Promise<string> {
    const parts: string[] = [];

    parts.push(opts.role.systemPrompt);

    if (opts.dynamicContext) {
      parts.push(opts.dynamicContext);
    }

    parts.push(this.buildIdentitySection(opts));

    const orgCtx = this.buildOrgContextSection(opts.orgContext, opts.contextMdPath);
    if (orgCtx) parts.push(orgCtx);

    // ── Team Announcements & Norms ───────────────────────────────────────
    if (opts.teamAnnouncements?.trim()) {
      parts.push('\n## Team Announcements\n' + opts.teamAnnouncements.trim());
    }
    if (opts.teamNorms?.trim()) {
      parts.push('\n## Team Working Norms\n' + opts.teamNorms.trim());
    }
    if (opts.teamDataDir) {
      const lines = ['\n## Team Data Directory', `Path: \`${opts.teamDataDir}\``, 'Files:', '- `ANNOUNCEMENT.md` — team announcements', '- `NORMS.md` — team working norms'];
      if (opts.isTeamManager) {
        lines.push('\nAs team manager, you can update these files using `file_write` to communicate guidelines and announcements to your team.');
      } else {
        lines.push('\nRead and follow the announcements and norms above. If you need changes, ask the team manager.');
      }
      parts.push(lines.join('\n'));
    }

    // ── Governance: Project Context (P1 priority) ────────────────────────
    if (opts.projectContext) {
      const { project, repositories, governanceRules, teamRole } = opts.projectContext;
      parts.push('\n## Current Project');
      parts.push(`- Project: **${project.name}** (${project.status})`);
      if (project.description) parts.push(`- ${project.description.slice(0, 200)}`);
      if (repositories?.length) {
        for (const repo of repositories) {
          parts.push(
            `- Repository: ${repo.localPath} (${repo.role}, branch: ${repo.defaultBranch})`
          );
        }
      }
      if (teamRole) parts.push(`- Your role: ${teamRole}`);
      if (governanceRules) parts.push(`- Governance: ${governanceRules}`);
    }

    // ── Governance: Workspace Info (P0 priority) ─────────────────────────
    if (opts.currentWorkspace) {
      parts.push('\n## Your Workspace');
      parts.push(`- Branch: \`${opts.currentWorkspace.branch}\``);
      parts.push(`- Working directory: \`${opts.currentWorkspace.workingDirectory}\``);
      parts.push(`- Base branch: ${opts.currentWorkspace.baseBranch}`);
      if (opts.agentWorkspace?.sharedWorkspace) {
        parts.push(`- Shared workspace: \`${opts.agentWorkspace.sharedWorkspace}\` (all agents can read/write here)`);
      }
      parts.push('- Builder artifacts directory: `~/.markus/builder-artifacts/`');
      parts.push('  **CRITICAL**: When creating agents, teams, or skills, you MUST place them in the correct subdirectory:');
      parts.push('  - Agents → `~/.markus/builder-artifacts/agents/{agent-name}/`');
      parts.push('  - Teams → `~/.markus/builder-artifacts/teams/{team-name}/`');
      parts.push('  - Skills → `~/.markus/builder-artifacts/skills/{skill-name}/`');
      parts.push('  The Builder page and install system ONLY recognize these paths. Writing artifacts anywhere else will make them invisible.');
      if (opts.agentDataDir) {
        parts.push(`- Agent data directory: \`${opts.agentDataDir}\` (your ROLE.md, MEMORY.md, and personal files)`);
      }
      parts.push('- IMPORTANT: Always use **absolute paths** in file operations. Relative paths are error-prone.');
    } else if (opts.agentWorkspace) {
      parts.push('\n## Your Workspace');
      parts.push(`- Working directory: \`${opts.agentWorkspace.primaryWorkspace}\``);
      if (opts.agentWorkspace.sharedWorkspace) {
        parts.push(`- Shared workspace: \`${opts.agentWorkspace.sharedWorkspace}\` (all agents can read/write here)`);
      }
      parts.push('- Builder artifacts directory: `~/.markus/builder-artifacts/`');
      parts.push('  **CRITICAL**: When creating agents, teams, or skills, you MUST place them in the correct subdirectory:');
      parts.push('  - Agents → `~/.markus/builder-artifacts/agents/{agent-name}/`');
      parts.push('  - Teams → `~/.markus/builder-artifacts/teams/{team-name}/`');
      parts.push('  - Skills → `~/.markus/builder-artifacts/skills/{skill-name}/`');
      parts.push('  The Builder page and install system ONLY recognize these paths. Writing artifacts anywhere else will make them invisible.');
      if (opts.agentDataDir) {
        parts.push(`- Agent data directory: \`${opts.agentDataDir}\` (your ROLE.md, MEMORY.md, and personal files)`);
      }
      parts.push('- IMPORTANT: Always use **absolute paths** in file operations. Relative paths are error-prone.');
      parts.push('- You can directly read files in the shared workspace using `file_read` — no need to request them from other agents.');
    } else if (opts.agentDataDir) {
      parts.push('\n## Your Workspace');
      parts.push(`- Agent data directory: \`${opts.agentDataDir}\` (your ROLE.md, MEMORY.md, and personal files)`);
      parts.push('- IMPORTANT: Always use **absolute paths** in file operations. Relative paths are error-prone.');
    }

    // ── Shared User Profile (loaded from shared workspace USER.md) ─────
    // Like OpenClaw's USER.md: loaded every session for every agent.
    // Secretary maintains this file; all agents benefit from knowing the owner.
    if (opts.agentWorkspace?.sharedWorkspace) {
      const userMdPath = `${opts.agentWorkspace.sharedWorkspace}/USER.md`;
      try {
        if (existsSync(userMdPath)) {
          const userProfile = readFileSync(userMdPath, 'utf-8').trim();
          if (userProfile) {
            parts.push('\n## About the Owner');
            parts.push(userProfile.slice(0, 1500));
            parts.push('\n_This profile is maintained by the Secretary. If you notice new preferences or patterns from the owner, mention them to the Secretary via `agent_send_message`._');
          }
        }
      } catch {
        // Silently ignore — file may not exist yet
      }
    }

    // ── Governance: Trust Level (P2 priority) ──────────────────────────
    if (opts.trustLevel) {
      parts.push('\n## Your Trust Level');
      parts.push(`- Level: **${opts.trustLevel.level}** (score: ${opts.trustLevel.score})`);
      if (opts.trustLevel.level === 'probation') {
        parts.push('- You are on probation. All your task creations require human approval. Focus on quality to build trust.');
      } else if (opts.trustLevel.level === 'standard') {
        parts.push('- You are a standard-level agent. Routine tasks may auto-approve; significant tasks need manager approval.');
      } else if (opts.trustLevel.level === 'trusted') {
        parts.push('- You are a trusted agent. You have a proven track record and higher autonomy.');
      } else if (opts.trustLevel.level === 'senior') {
        parts.push('- You are a senior agent. You have the highest autonomy. Routine tasks auto-approve.');
      }
    }

    // ── Governance: System Announcements (P1 urgent, P2 others) ──────────
    if (opts.announcements?.length) {
      parts.push('\n## System Announcements');
      for (const a of opts.announcements) {
        const prefix =
          a.priority === 'urgent' ? '[URGENT] ' : a.priority === 'high' ? '[HIGH] ' : '[INFO] ';
        parts.push(`- ${prefix}${a.title}: ${a.content}`);
      }
    }

    // ── Governance: Human Feedback (P1 priority) ─────────────────────────
    if (opts.recentFeedback?.length) {
      parts.push('\n## Human Feedback (recent)');
      for (const fb of opts.recentFeedback) {
        const urgency =
          fb.priority === 'critical'
            ? '[CRITICAL] '
            : fb.priority === 'important'
              ? '[IMPORTANT] '
              : '';
        const anchor = fb.anchor
          ? ` (re: ${fb.anchor.section}${fb.anchor.itemId ? '/' + fb.anchor.itemId : ''})`
          : '';
        parts.push(`- ${urgency}**${fb.authorName}**${anchor}: ${fb.content}`);
      }
    }

    // ── Governance: Project Deliverables (P1 priority) ─────────────────────
    if (opts.projectDeliverables?.length) {
      parts.push('\n## Project Deliverables (key entries)');
      for (const k of opts.projectDeliverables) {
        parts.push(`- **[${k.category}]** ${k.title}: ${k.content.slice(0, 200)}`);
      }
    }

    if (opts.role.defaultPolicies.length > 0) {
      parts.push('\n## Policies');
      for (const policy of opts.role.defaultPolicies) {
        parts.push(`### ${policy.name}`);
        for (const rule of policy.rules) {
          parts.push(`- ${rule}`);
        }
      }
    }

    const longTermMem = opts.memory.getLongTermMemory();
    if (longTermMem) {
      parts.push('\n## Long-term Knowledge');
      parts.push(longTermMem.slice(0, 5000));
    }

    const lessons = opts.memory.getEntriesByTag('lesson', 10);
    if (lessons.length > 0) {
      parts.push('\n## Lessons from Past Experience');
      for (const lesson of lessons) {
        const ts = lesson.timestamp ? new Date(lesson.timestamp).toLocaleDateString() : '';
        parts.push(`- [${ts}] ${lesson.content}`);
      }
    }

    if (opts.deliverableContext || opts.knowledgeContext) {
      parts.push('\n## Shared Deliverables');
      parts.push((opts.deliverableContext ?? opts.knowledgeContext ?? '').slice(0, 3000));
    }

    const relevantMemories = await this.retrieveRelevantMemories(opts.memory, opts.currentQuery, opts.agentId);
    if (relevantMemories.length > 0) {
      parts.push('\n## Relevant Memories');
      for (const mem of relevantMemories) {
        const ts = mem.timestamp ? new Date(mem.timestamp).toLocaleDateString() : '';
        parts.push(`- [${ts}] ${mem.content}`);
      }
    }

    const dailyLog = opts.memory.getRecentDailyLogs(1);
    if (dailyLog) {
      parts.push('\n## Recent Activity Summary');
      parts.push(dailyLog.slice(0, 1500));
    }

    if (opts.assignedTasks && opts.assignedTasks.length > 0) {
      const priorityOrder = ['critical', 'high', 'medium', 'low'];
      const byPriority = (a: { priority?: string }, b: { priority?: string }) =>
        (priorityOrder.indexOf(a.priority ?? 'medium')) - (priorityOrder.indexOf(b.priority ?? 'medium'));

      const myTasks = opts.assignedTasks.filter(t => t.assignedAgentId === opts.agentId);
      const otherTasks = opts.assignedTasks.filter(t => t.assignedAgentId !== opts.agentId);

      const myActive = myTasks.filter(t => !['completed', 'cancelled', 'failed'].includes(t.status)).sort(byPriority);
      const myDone = myTasks.filter(t => ['completed', 'cancelled', 'failed'].includes(t.status));

      const MY_TASK_LIMIT = 15;
      const TEAM_TASK_LIMIT = 10;

      parts.push('\n## Task Board');

      parts.push('### My Tasks (assigned to you):');
      if (myActive.length > 0) {
        const shown = myActive.slice(0, MY_TASK_LIMIT);
        for (const t of shown) {
          parts.push(
            `- [${t.status.toUpperCase()}] **${t.title}** (ID: \`${t.id}\`, priority: ${t.priority})`
          );
          if (t.description) parts.push(`  ${t.description.slice(0, 150)}`);
        }
        if (myActive.length > MY_TASK_LIMIT) {
          parts.push(`_(${myActive.length - MY_TASK_LIMIT} more active tasks not shown — use \`task_list\` for full list)_`);
        }
      } else {
        parts.push('No active tasks assigned to you.');
      }
      if (myDone.length > 0) {
        parts.push(`_(${myDone.length} completed/closed tasks)_`);
      }

      if (otherTasks.length > 0) {
        const otherActive = otherTasks.filter(t => !['completed', 'cancelled', 'failed'].includes(t.status)).sort(byPriority);
        const otherDone = otherTasks.filter(t => ['completed', 'cancelled', 'failed'].includes(t.status));
        if (otherActive.length > 0) {
          parts.push('### Team Tasks (assigned to others):');
          const shown = otherActive.slice(0, TEAM_TASK_LIMIT);
          for (const t of shown) {
            const owner = t.assignedAgentName ?? t.assignedAgentId ?? 'unassigned';
            parts.push(
              `- [${t.status.toUpperCase()}] **${t.title}** (ID: \`${t.id}\`, assignee: ${owner}, priority: ${t.priority})`
            );
          }
          if (otherActive.length > TEAM_TASK_LIMIT) {
            parts.push(`_(${otherActive.length - TEAM_TASK_LIMIT} more team tasks not shown)_`);
          }
        }
        if (otherDone.length > 0) {
          parts.push(`_(${otherDone.length} other completed/closed tasks)_`);
        }
      }
    } else {
      parts.push('\n## Task Board');
      parts.push('No tasks on the board.');
    }

    parts.push('');
    parts.push('### Task Workflow');
    parts.push('- **Create**: `task_create` (with `assigned_agent_id`, `reviewer_agent_id`). Check `task_list` first to avoid duplicates.');
    parts.push('- **Execute**: Decompose with `subtask_create` → work through subtasks → `task_submit_review` (MANDATORY). System auto-fills task_id/reviewer/branch.');
    parts.push('- **Review**: Reviewer approves `task_update(status:"completed")` or rejects `task_update(note:"...")` (auto-restarts). Workers MUST NOT set status=completed.');
    parts.push('- **CRITICAL — `blocked_by` dependencies**: When creating multiple tasks, you **MUST** use `blocked_by` to express ALL dependency relationships. If task B needs output or deliverables from task A, then B **MUST** include A\'s task ID in its `blocked_by` array. Without `blocked_by`, tasks execute in parallel and downstream tasks will NOT have upstream deliverables. Think about the dependency graph BEFORE creating any tasks.');
    parts.push('- **DAG decomposition**: For complex goals, create multiple tasks forming a directed acyclic graph (DAG). Assign each task to the most appropriate team member based on their role and skills. Use `team_list` to identify the right agent. Independent tasks (no dependency) will run in parallel; dependent tasks will wait for predecessors to complete.');
    parts.push('- **Manager coordination**: If the goal requires synthesized output from multiple tasks, create a final summarization task assigned to a manager or senior agent, `blocked_by` ALL prerequisite tasks. The manager task reviews deliverables from dependencies and produces the consolidated output.');
    parts.push('- **Work Discovery**: `list_projects`→`requirement_list`→`task_list`. Use memory tools for personal notes; deliverable tools for shared outputs.');

    if (opts.environment) {
      parts.push(this.buildEnvironmentSection(opts.environment));
    }

    if (opts.senderIdentity) {
      parts.push(`\n## Current Conversation`);
      parts.push(
        `You are now talking to **${opts.senderIdentity.name}** (${opts.senderIdentity.role}).`
      );
      if (opts.senderIdentity.role === 'owner') {
        parts.push(
          'This person is the organization owner. Their instructions have the highest priority. Be proactive in reporting and responsive to their needs.'
        );
      } else if (opts.senderIdentity.role === 'admin') {
        parts.push(
          'This person is an administrator. Cooperate actively and share progress proactively.'
        );
      } else if (opts.senderIdentity.role === 'guest') {
        parts.push(
          'This person is an external guest. Be polite but cautious — do not expose internal sensitive information.'
        );
      }
    }

    parts.push('\n## Working Strategy');
    parts.push('For multi-step tasks: (1) Plan first — outline approach, use `todo.md` for long tasks. (2) Update progress after each step. (3) Restate objectives before each action. (4) On errors, analyze before retrying — try a different approach. (5) Offload large tool output to files. (6) For heavy subtasks that need many tool calls or lots of file reading, delegate to `spawn_subagent` to keep your own context lean. Use `spawn_subagents` to run independent subtasks in parallel.');
    parts.push('**CRITICAL — Large file writing**: NEVER attempt to write a large document (>200 lines or >4000 characters) in a single `file_write` call. This causes LLM output truncation, token limit errors, and tool call timeouts. Instead: (a) Write the file **section by section** — first call `file_write` with the initial section, then use `file_edit` to append subsequent sections, or (b) Split the deliverable into multiple smaller files. Plan the document structure first, then write each section in a separate tool call.');

    // --- Mailbox & attention context ---
    if (opts.mailboxContext) {
      parts.push(this.buildMailboxSection(opts.mailboxContext));
    }

    // --- Chat session context for session-aware user communication ---
    if (opts.chatSessions && opts.chatSessions.length > 0) {
      const sessionLines = ['\n## Your Chat Sessions with the User'];
      for (const s of opts.chatSessions.slice(0, 5)) {
        const preview = s.lastMessagePreview ? `: "${s.lastMessagePreview}"` : '';
        const title = s.title ? ` (${s.title})` : '';
        sessionLines.push(`- Session ${s.id}${title} (last active: ${s.lastMessageAt})${preview}`);
      }
      sessionLines.push('');
      sessionLines.push('When using `request_user_chat`, you can provide the `session_id` of an existing session to continue that conversation thread.');
      parts.push(sessionLines.join('\n'));
    }

    // --- Scenario-specific behavioral guidance ---
    const scenario = opts.scenario ?? 'chat';
    parts.push(this.buildScenarioSection(scenario));

    // Timestamp at the end of the system prompt preserves KV-cache for the
    // stable prefix (identity, role, policies, memory) which rarely changes.
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = now.getTimezoneOffset();
    const sign = offset <= 0 ? '+' : '-';
    const absH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const absM = String(Math.abs(offset) % 60).padStart(2, '0');
    const pad = (n: number) => String(n).padStart(2, '0');
    const localStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    parts.push(`\n---\nCurrent date and time: ${localStr} (${tz}, UTC${sign}${absH}:${absM})`);

    return parts.join('\n');
  }

  private buildMailboxSection(ctx: NonNullable<Parameters<ContextEngine['buildSystemPrompt']>[0]['mailboxContext']>): string {
    const lines: string[] = ['\n## Your Attention State'];

    if (ctx.currentFocus) {
      const elapsed = Math.round(ctx.currentFocus.elapsedMs / 1000);
      lines.push(`**Current focus**: [${ctx.currentFocus.type}] ${ctx.currentFocus.label} (${elapsed}s elapsed)`);
      if (ctx.currentFocus.taskId) {
        lines.push(`  Task: ${ctx.currentFocus.taskId}`);
      }
    } else {
      lines.push('**Current focus**: idle (no active work)');
    }

    lines.push(`**Mailbox queue**: ${ctx.queueDepth} item(s) waiting`);
    if (ctx.topQueued && ctx.topQueued.length > 0) {
      lines.push('You MUST review all waiting items and prioritize user chat/comments above everything else:');
      for (const q of ctx.topQueued) {
        lines.push(`  - [${q.type}] p${q.priority}: ${q.summary.slice(0, 120)}`);
      }
    }

    if (ctx.recentDecisions && ctx.recentDecisions.length > 0) {
      lines.push('**Recent attention decisions**:');
      for (const d of ctx.recentDecisions.slice(-5)) {
        lines.push(`  - ${d.type}: ${d.reasoning.slice(0, 120)}`);
      }
    }

    if (ctx.mergedContent) {
      lines.push(`**Merged context** (absorbed into current work):\n${ctx.mergedContent.slice(0, 500)}`);
    }

    return lines.join('\n');
  }

  private buildScenarioSection(scenario: 'chat' | 'task_execution' | 'heartbeat' | 'a2a' | 'comment_response'): string {
    const lines: string[] = ['\n## Current Interaction Mode'];

    switch (scenario) {
      case 'chat':
        lines.push('You are in a **human chat session**. This context is for CONVERSATION ONLY — not for executing complex work.');
        lines.push('');
        lines.push('**What to do inline** (directly in this conversation):');
        lines.push('- Answer questions, explain concepts, provide status updates');
        lines.push('- Quick lookups: check task status, read a file, simple searches (≤3 tool calls)');
        lines.push('- If your **role instructions** define a specific chat-mode workflow (e.g. builder agents creating artifacts), follow that workflow');
        lines.push('');
        lines.push('**What MUST become a task** (NEVER do these inline):');
        lines.push('- Any work requiring research, code changes, file modifications, or >3 tool calls');
        lines.push('- Any request the user describes as a "task", "project", or multi-step work');
        lines.push('- Any work that would benefit from subtask decomposition or team collaboration');
        lines.push('');
        lines.push('**How to create tasks from chat:**');
        lines.push('1. Analyze the user\'s request and identify the work needed');
        lines.push('2. If the work is complex, decompose into multiple tasks. **Plan the dependency graph first** — identify which tasks produce outputs that other tasks consume');
        lines.push('3. Create tasks in dependency order (create upstream tasks first so you have their IDs for `blocked_by`). **CRITICAL**: Every task that depends on another task\'s output MUST include that task\'s ID in `blocked_by`. Without this, tasks run in parallel and downstream tasks will fail due to missing inputs.');
        lines.push('4. Assign each task to the most appropriate team member (use `team_list` to find agents by role/skills)');
        lines.push('5. If the goal requires consolidated output, create a final summarization task assigned to a manager agent, `blocked_by` ALL prerequisite tasks');
        lines.push('6. Create the tasks via `task_create`. Then STOP — do NOT start executing the work yourself.');
        lines.push('7. Reply to the user with a summary: what tasks were created, who they are assigned to, and their **dependency structure** (which tasks block which)');
        lines.push('8. Tell the user: "Please review and approve the tasks. Once approved, they will execute automatically in the task execution context."');
        lines.push('');
        lines.push('**CRITICAL — STOP AFTER CREATING TASKS:**');
        lines.push('After calling `task_create`, your job in this chat is DONE for that request. Do NOT:');
        lines.push('- Call tools to start executing the task work (no file_read, file_write, web_search, etc. for the task itself)');
        lines.push('- Try to "help" by doing part of the task inline');
        lines.push('- Continue with research or implementation related to the created task');
        lines.push('The task will execute in its own isolated context AFTER the user approves it. The user will see execution progress in the task execution view, NOT here.');
        lines.push('');
        lines.push('**IMPORTANT**: The user sees this chat context. They should NOT see raw tool calls, long research outputs, or complex agent operations here. Keep chat responses concise and human-friendly.');
        break;

      case 'task_execution':
        lines.push('You are in **task execution mode**. This is your dedicated workspace for focused, thorough work.');
        lines.push('');
        lines.push('**Context awareness:**');
        lines.push('- This session is ISOLATED from chat — the user monitors your progress through task logs and the execution view');
        lines.push('- If there is `⚠ USER FEEDBACK` above, READ IT FIRST and adjust your approach accordingly');
        lines.push('- If there are dependency tasks, review ALL their deliverables before starting (use `file_read` + `task_get`)');
        lines.push('');
        lines.push('**Execution protocol:**');
        lines.push('1. **Decompose first**: Use `subtask_create` to break the task into concrete steps BEFORE starting work. Each subtask should be a verifiable unit of work.');
        lines.push('2. **Work systematically**: Execute subtasks in order. Mark each done with `subtask_complete`. Record progress via `task_note` after significant steps.');
        lines.push('3. **Stay focused**: Do NOT wander into unrelated work. Do NOT create new top-level tasks — only subtasks within your assigned task.');
        lines.push('4. **Handle blockers**: If you cannot proceed, set status to `blocked` with a clear explanation.');
        lines.push('5. **Submit for review**: When ALL subtasks are complete, call `task_submit_review` with summary + deliverables (MANDATORY — the task does NOT complete without this).');
        lines.push('');
        lines.push('**Delegating subtasks to subagents (`spawn_subagent` / `spawn_subagents`):**');
        lines.push('');
        lines.push('Subagents are lightweight child loops with independent context windows. They inherit your tools but do NOT pollute your conversation history. Use them strategically:');
        lines.push('');
        lines.push('*DELEGATE to a subagent when the subtask is:*');
        lines.push('- **Deep exploration / analysis**: reading and cross-referencing many files (>5), codebase-wide searches, architecture analysis — a subagent keeps your own context clean');
        lines.push('- **Independent code modifications**: editing files in separate modules that don\'t depend on each other — perfect for `spawn_subagents` (parallel)');
        lines.push('- **Research & information gathering**: web searches, reading long documents, comparing alternatives — heavy context that you don\'t need to retain');
        lines.push('- **Test generation**: writing tests for already-implemented code — self-contained work with clear inputs/outputs');
        lines.push('- **Documentation / content generation**: producing docs, READMEs, changelogs from existing code — doesn\'t need your live reasoning context');
        lines.push('- **Repetitive multi-file refactoring**: renaming, format migrations, pattern replacements across many files — especially in parallel');
        lines.push('');
        lines.push('*Do NOT delegate when:*');
        lines.push('- The subtask is quick (≤3 tool calls) — overhead of spawning a subagent is not worth it');
        lines.push('- The next subtask depends on detailed intermediate reasoning from this one — keep it in your own context');
        lines.push('- The subtask requires back-and-forth decisions that depend on your overall plan');
        lines.push('');
        lines.push('*Parallel execution pattern (`spawn_subagents`):*');
        lines.push('When you have N independent subtasks, use `spawn_subagents` with an array of tasks to run them all concurrently. Example: implementing separate API endpoints, writing tests for different modules, analyzing different components.');
        lines.push('');
        lines.push('*Workflow:* `subtask_create` (track) → `spawn_subagent`/`spawn_subagents` (execute) → verify result → `subtask_complete` (mark done).');
        lines.push('');
        lines.push('**Quality standards:**');
        lines.push('- Use all available tools to produce thorough, high-quality output');
        lines.push('- If a tool call fails, analyze the error and try a different approach — do NOT repeat the same failing action');
        lines.push('- Large outputs should be saved to files and referenced by path in deliverables');
        lines.push('- **NEVER write a large file in one shot.** If the output is >200 lines or >4000 chars, write it section by section: `file_write` the first section (with a heading/skeleton), then `file_edit` to append each subsequent section. This prevents LLM output truncation and tool call timeouts.');
        lines.push('');
        lines.push('**Communicating with the user:**');
        lines.push('- Use `notify_user` for status updates and progress reports (one-way, no response expected)');
        lines.push('- Use `request_user_chat` ONLY when you are genuinely blocked and need a human decision (e.g., unclear requirements, conflicting constraints, access issues)');
        lines.push('- Do NOT use `request_user_chat` for routine updates — use `notify_user` instead');
        break;

      case 'heartbeat':
        lines.push('You are in **heartbeat mode** — a brief periodic check-in. This is NOT a work session.');
        lines.push('');
        lines.push('**Priority actions (in order):**');
        lines.push('1. **Review duty**: Check `task_list` for tasks in `review` status where you are the reviewer. For each:');
        lines.push('   - `task_get` → inspect deliverables/notes → `file_read` on artifacts');
        lines.push('   - Approve: `task_update(status:"completed")` with review note');
        lines.push('   - Reject: `task_update(status:"in_progress", note:"what needs to change")` — sends the task back for revision with a new execution round');
        lines.push('   - Unreviewed tasks block the team — review is your #1 responsibility');
        lines.push('2. **Status check**: Compare current state against last heartbeat. Report only changes.');
        lines.push('3. **Failed task recovery**: If any task assigned to you is in `failed` status, retry it via `task_update(status:"in_progress")` with a note — this auto-restarts execution.');
        lines.push('4. **Daily report (managers, after 20:00)**: If the prompt includes a "Daily Report Required" section, produce the report as your top priority after reviews.');
        lines.push('5. **Self-evolution**: Reflect briefly — record specific, actionable lessons learned since last heartbeat.');
        lines.push('6. **Do NOT**: Create new tasks, start work, or do research during heartbeat (exception: daily report creation and failed task retry).');
        lines.push('');
        lines.push('');
        lines.push('**Communicating with the user:**');
        lines.push('- Use `notify_user` for findings and reports (e.g., "Daily report: completed 3 tasks today")');
        lines.push('- Use `request_user_chat` ONLY if you need the user to make a decision or provide input');
        lines.push('- Do NOT use `request_user_chat` for routine status updates');
        lines.push('');
        lines.push('If nothing needs attention, respond with exactly: HEARTBEAT_OK');
        break;

      case 'a2a':
        lines.push('You are in an **agent-to-agent (A2A) conversation**. This context is for COORDINATION, not for executing work.');
        lines.push('');
        lines.push('**Communication rules:**');
        lines.push('- Be concise and structured — your colleague needs actionable information');
        lines.push('- Always use **absolute file paths** when referencing files or deliverables');
        lines.push('- Respond with clear facts. No conversational filler.');
        lines.push('');
        lines.push('**Work delegation:**');
        lines.push('- A2A messages are for: status updates, quick coordination, simple questions, sharing file references');
        lines.push('- For substantial work requests: create a `task_create` assigned to the target agent — do NOT ask them to do complex work via chat');
        lines.push('- For multi-agent work: decompose into a task DAG with `blocked_by` dependencies, assign each to the right agent');
        lines.push('- If you cannot help, explain why and suggest who can');
        break;

      case 'comment_response':
        lines.push('You are responding to a **comment on a task or requirement**. You MUST follow the context-first protocol below.');
        lines.push('');
        lines.push('**MANDATORY context-gathering protocol (do this BEFORE writing any reply):**');
        lines.push('1. **Fetch the full item**: Call `task_get` (for task comments) or `requirement_list` (for requirement comments) to retrieve the complete current state — title, description, status, assignee, linked items, and all fields');
        lines.push('2. **Read ALL previous comments**: Review the entire comment thread to understand the conversation history, who said what, and what has already been discussed or decided');
        lines.push('3. **Identify the commenter\'s intent**: Is it a question? A request for action? Feedback? A status inquiry? An objection?');
        lines.push('4. **Check related context**: If the comment references other tasks, requirements, or files, look them up too');
        lines.push('');
        lines.push('**Only AFTER completing steps 1-4**, formulate your reply using `task_comment` or `requirement_comment`.');
        lines.push('');
        lines.push('**Reply quality standards:**');
        lines.push('- Reference specific details from the task/requirement state and prior comments to show you understood the context');
        lines.push('- Address the commenter\'s actual concern, not just the surface-level text of the latest comment');
        lines.push('- If action is needed, state what you will do (or have done) concretely');
        lines.push('- If the comment is unclear, ask a clarifying question rather than guessing');
        lines.push('');
        lines.push('**NEVER do this:**');
        lines.push('- Reply immediately without calling `task_get`/`requirement_list` first');
        lines.push('- Give a generic acknowledgment like "Got it, will look into it" without substantive content');
        lines.push('- Ignore prior comments that provide important context for the current discussion');
        break;
    }

    return lines.join('\n');
  }

  private buildIdentitySection(opts: {
    agentId: string;
    agentName: string;
    role: RoleTemplate;
    identity?: IdentityContext;
    availableSkills?: Array<{ name: string; description: string; category: string }>;
    currentQuery?: string;
  }): string {
    const lines: string[] = ['\n## Your Identity'];

    if (opts.identity) {
      const self = opts.identity.self;
      const teamName = opts.identity.team?.name;
      lines.push(`- Name: ${self.name}`);
      lines.push(`- Role: ${opts.role.name} (${opts.role.description})`);
      if (self.agentRole === 'manager' && teamName) {
        lines.push(`- Position: Team Manager of **${teamName}**`);
      } else if (self.agentRole === 'manager') {
        lines.push(`- Position: Team Manager`);
      } else if (teamName) {
        lines.push(`- Position: Member of **${teamName}**`);
      } else {
        lines.push(`- Position: Team Member`);
      }
      if (opts.availableSkills && opts.availableSkills.length > 0) {
        const filtered = this.filterSkillsByRelevance(opts.availableSkills, opts.currentQuery);
        const activeSet = new Set(self.skills);
        lines.push(`- Installed Skills:`);
        for (const s of filtered) {
          const tag = activeSet.has(s.name) ? ' ✦' : '';
          lines.push(`  - **${s.name}** [${s.category}]: ${s.description}${tag}`);
        }
        if (filtered.length < opts.availableSkills.length) {
          lines.push(`  _(${opts.availableSkills.length - filtered.length} more skills installed — use \`discover_tools({ mode: "list_skills" })\` to see all)_`);
        }
        lines.push(`  Use \`discover_tools({ tool_names: ["skill-name"] })\` to load a skill's full instructions when needed.`);
      } else if (self.skills.length > 0) {
        lines.push(`- Active Skills: ${self.skills.join(', ')}`);
      }
      lines.push(`- Organization: ${opts.identity.organization.name}`);
      lines.push(`- Agent ID: ${opts.agentId}`);

      if (opts.identity.manager && opts.identity.self.agentRole !== 'manager') {
        lines.push(`\n### Your Manager`);
        lines.push(
          `- ${opts.identity.manager.name} (Team Manager) — report progress and escalate issues to them`
        );
      }

      if (opts.identity.colleagues.length > 0) {
        lines.push(teamName ? `\n### Your Team — ${teamName}` : '\n### Your Team');
        for (const c of opts.identity.colleagues) {
          const statusTag = c.status ? ` [${c.status}]` : '';
          lines.push(
            `- ${c.name} (${c.role})${statusTag}${c.skills?.length ? ` — skills: ${c.skills.join(', ')}` : ''}`
          );
        }
      }

      if (opts.identity.otherTeams && opts.identity.otherTeams.length > 0) {
        lines.push('\n### Other Teams (for cross-team coordination)');
        for (const t of opts.identity.otherTeams) {
          lines.push(`- **${t.name}**: ${t.members.map(m => `${m.name} (${m.role})`).join(', ')}`);
        }
      }

      if (opts.identity.humans.length > 0) {
        lines.push(`\n### Human Users`);
        for (const h of opts.identity.humans) {
          const tag = h.role === 'owner' ? ' ★ Owner' : h.role === 'admin' ? ' Admin' : '';
          lines.push(`- ${h.name}${tag}`);
        }
      }

      if (opts.identity.self.agentRole === 'manager') {
        lines.push(`\n### Manager Responsibilities`);
        lines.push(`You manage${teamName ? ` the **${teamName}** team` : ' your team'}. Your scope is your own team members listed above.`);
        lines.push('1. **Routing** — Determine which team member should handle incoming requests');
        lines.push('2. **Coordination** — Assign tasks to team members based on their skills and availability');
        lines.push('3. **Reporting** — Report your team\'s progress to human stakeholders');
        lines.push('4. **Cross-team** — Coordinate with other team managers via `agent_send_message` when work crosses team boundaries');
        lines.push('5. **Escalation** — Escalate issues that require human decision to the Owner');
      }
    } else {
      lines.push(`- Name: ${opts.agentName}`);
      lines.push(`- Role: ${opts.role.name}`);
      lines.push(`- Agent ID: ${opts.agentId}`);
    }

    return lines.join('\n');
  }

  private filterSkillsByRelevance(
    skills: Array<{ name: string; description: string; category: string }>,
    query?: string,
    maxResults = 30,
  ): Array<{ name: string; description: string; category: string }> {
    if (!query || skills.length <= maxResults) return skills;

    const keywords = query.toLowerCase().split(/[\s\-_.,;:!?()\[\]{}]+/).filter(w => w.length > 2);
    if (keywords.length === 0) return skills.slice(0, maxResults);

    const scored = skills.map(s => {
      const haystack = `${s.name} ${s.description} ${s.category}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (haystack.includes(kw)) score++;
      }
      return { skill: s, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(s => s.skill);
  }

  /**
   * Intelligent context assembly. Instead of hardcoded limits, this method:
   * 1. Queries the model's actual context window to derive a token budget
   * 2. Reserves space for system prompt, tool definitions, and reply
   * 3. Fills remaining budget with messages, newest first
   * 4. Compacts old tool-call turns into summaries instead of truncating
   */
  async prepareMessages(opts: {
    systemPrompt: string;
    sessionMessages: LLMMessage[];
    memory: IMemoryStore;
    sessionId: string;
    agentId?: string;
    modelContextWindow?: number;
    modelMaxOutput?: number;
    toolDefinitions?: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
  }): Promise<PreparedContext> {
    const contextWindow = opts.modelContextWindow ?? 64000;
    const rawMaxOutput = opts.modelMaxOutput ?? 16384;
    const maxOutput = Math.min(rawMaxOutput, Math.floor(contextWindow * 0.4));

    const systemTokens = estimateTokens(opts.systemPrompt, this.tokenCounter);
    const toolDefTokens = opts.toolDefinitions
      ? estimateTokens(JSON.stringify(opts.toolDefinitions), this.tokenCounter)
      : 0;
    const safetyMargin = Math.ceil(Math.min(contextWindow * 0.15, 30000));
    const messageBudget = contextWindow - systemTokens - toolDefTokens - maxOutput - safetyMargin;

    if (messageBudget < 500) {
      log.warn('Very tight message budget', {
        contextWindow,
        systemTokens,
        toolDefTokens,
        maxOutput,
        messageBudget,
      });
    }

    let messages = opts.sessionMessages;

    // ── Stage 1: Count-based summarization (too many messages) ──────────
    if (messages.length > 60) {
      messages = await this.smartSummarizeAndTruncate(opts.memory, opts.sessionId, messages, 40, opts.agentId);
    }

    // ── Stage 2: Per-message size cap (shrink oversized individual messages) ─
    const perMessageCap = Math.max(2000, Math.floor(messageBudget / 8));
    messages = this.shrinkOversizedMessages(messages, perMessageCap);
    messages = this.sanitizeMessageSequence(messages);

    const currentTurnStart = this.findCurrentTurnStart(messages);
    let totalTokens = this.sumTokens(messages);

    const preCompressionUsed = systemTokens + toolDefTokens + totalTokens;
    const effectiveBudget = contextWindow - maxOutput;
    const preCompressionPct = effectiveBudget > 0 ? (preCompressionUsed / effectiveBudget) * 100 : 0;

    // ── Stage 3: Token-budget-driven compression ────────────────────────
    // Progressive compression: try lighter methods first, escalate as needed.
    if (totalTokens > messageBudget) {
      // 3a: Compact old tool-call blocks into summaries
      const compactBoundary = preCompressionPct > 80 ? messages.length : currentTurnStart;
      messages = this.compactOldTurns(messages, compactBoundary, messageBudget);
      messages = this.sanitizeMessageSequence(messages);
      totalTokens = this.sumTokens(messages);
    }

    if (totalTokens > messageBudget && messages.length > 15) {
      // 3b: LLM-powered or heuristic summarization of older messages.
      // This is the generic compression path — works for ALL providers.
      const keepCount = Math.max(10, Math.min(20, Math.floor(messages.length * 0.4)));
      log.info('Triggering generic compression (token budget exceeded)', {
        usagePercent: preCompressionPct.toFixed(1),
        messageCount: messages.length,
        keepLast: keepCount,
      });
      messages = await this.smartSummarizeAndTruncate(opts.memory, opts.sessionId, messages, keepCount, opts.agentId);
      messages = this.sanitizeMessageSequence(messages);
      totalTokens = this.sumTokens(messages);
    }

    if (totalTokens > messageBudget && messages.length > 10) {
      // 3c: Aggressive summarization — keep fewer messages
      log.warn('Context still over budget, aggressive summarization', {
        totalTokens,
        messageBudget,
        messageCount: messages.length,
      });
      messages = await this.smartSummarizeAndTruncate(opts.memory, opts.sessionId, messages, Math.max(6, Math.floor(messages.length * 0.3)), opts.agentId);
      messages = this.sanitizeMessageSequence(messages);
      // Re-shrink after summarization in case the summary itself is large
      messages = this.shrinkOversizedMessages(messages, perMessageCap);
      totalTokens = this.sumTokens(messages);
    }

    // ── Stage 4: Last-resort trimming ───────────────────────────────────
    if (totalTokens > messageBudget) {
      messages = this.trimToFitBudget(messages, messageBudget);
      messages = this.sanitizeMessageSequence(messages);
      totalTokens = this.sumTokens(messages);
      log.info('Trimmed oldest messages to fit budget', {
        remaining: messages.length,
        tokens: totalTokens,
        budget: messageBudget,
      });
    }

    const totalUsed = systemTokens + toolDefTokens + totalTokens;
    const available = Math.max(0, messageBudget - totalTokens);
    const usagePercent = effectiveBudget > 0 ? (totalUsed / effectiveBudget) * 100 : 0;

    log.debug('Context assembled', {
      contextWindow,
      messageBudget,
      messageTokens: totalTokens,
      systemTokens,
      toolDefTokens,
      messageCount: messages.length,
      usagePercent: usagePercent.toFixed(1),
    });

    if (usagePercent > 80) {
      log.warn('Context usage above 80%', { usagePercent: usagePercent.toFixed(1), totalUsed, effectiveBudget });
    }

    return {
      messages: [{ role: 'system', content: opts.systemPrompt }, ...messages],
      usage: {
        contextWindow,
        systemTokens,
        toolDefTokens,
        messageTokens: totalTokens,
        maxOutputReserved: maxOutput,
        safetyMargin,
        totalUsed,
        available,
        usagePercent: Math.round(usagePercent * 10) / 10,
      },
    };
  }

  /**
   * Attempt LLM-powered summarization, falling back to heuristic truncation.
   * When an LLM summarizer is available, the older messages are summarized
   * by the model into a concise summary that preserves key decisions and context.
   *
   * The first user message is protected if it contains task instructions
   * (TASK EXECUTION marker) — it gets preserved verbatim before the summary.
   */
  private async smartSummarizeAndTruncate(
    memory: IMemoryStore,
    sessionId: string,
    messages: LLMMessage[],
    keepLast: number,
    agentId?: string,
  ): Promise<LLMMessage[]> {
    if (messages.length <= keepLast) return messages;

    // Protect the first message if it's a task prompt
    const firstMsg = messages[0];
    const isTaskPrompt = firstMsg?.role === 'user' &&
      (getTextContent(firstMsg.content).includes('TASK EXECUTION') ||
       getTextContent(firstMsg.content).includes('task_submit_review'));
    const protectedPrefix: LLMMessage[] = isTaskPrompt ? [firstMsg] : [];
    const compactableMessages = isTaskPrompt ? messages.slice(1) : messages;

    if (compactableMessages.length <= keepLast) {
      return [...protectedPrefix, ...compactableMessages];
    }

    if (this.llmSummarizer) {
      try {
        const older = compactableMessages.slice(0, -keepLast);
        const retained = compactableMessages.slice(-keepLast);
        const summary = await this.llmSummarizer(older);
        if (summary && summary.length > 0) {
          log.info('LLM-powered summarization succeeded', {
            sessionId,
            compactedMessages: older.length,
            summaryLength: summary.length,
            taskPromptPreserved: isTaskPrompt,
          });
          const summaryMessage: LLMMessage = {
            role: 'user',
            content: `[Conversation history summary — ${older.length} earlier messages were compacted by LLM]\n${summary}\n[End of summary. The conversation continues below.]`,
          };
          memory.writeDailyLog(agentId ?? sessionId, summary);
          return [...protectedPrefix, summaryMessage, ...retained];
        }
      } catch (err) {
        log.warn('LLM summarization failed, falling back to heuristic', { error: String(err) });
      }
    }

    // Heuristic fallback: build a simple summary from older messages
    const older = compactableMessages.slice(0, -keepLast);
    const retained = compactableMessages.slice(-keepLast);
    const heuristicSummary = this.buildHeuristicSummary(older);
    if (heuristicSummary) {
      const summaryMessage: LLMMessage = {
        role: 'user',
        content: `[Conversation history summary — ${older.length} earlier messages were compacted]\n${heuristicSummary}\n[End of summary.]`,
      };
      return [...protectedPrefix, summaryMessage, ...retained];
    }

    // Last resort: try memory store's summarizeAndTruncate (may not preserve task prompt)
    if (!isTaskPrompt) {
      return memory.summarizeAndTruncate(sessionId, keepLast);
    }
    return [...protectedPrefix, ...retained];
  }

  /**
   * Build a heuristic summary from a list of messages.
   * Extracts key information without requiring an LLM call.
   */
  private buildHeuristicSummary(messages: LLMMessage[]): string | null {
    if (messages.length === 0) return null;

    const parts: string[] = [];
    let toolCallCount = 0;
    const toolNames = new Set<string>();
    const errors: string[] = [];
    const keyDecisions: string[] = [];

    for (const msg of messages) {
      const text = getTextContent(msg.content);
      if (msg.role === 'assistant') {
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            toolCallCount++;
            toolNames.add(tc.name);
          }
        }
        // Extract short assistant reasoning (non-tool-call text)
        const trimmed = text.trim();
        if (trimmed.length > 20 && trimmed.length < 500 && !msg.toolCalls?.length) {
          keyDecisions.push(trimmed.slice(0, 200));
        }
      } else if (msg.role === 'tool') {
        if (text.startsWith('Error:') || text.includes('"status":"error"')) {
          errors.push(text.slice(0, 150));
        }
      }
    }

    if (toolCallCount > 0) {
      parts.push(`Executed ${toolCallCount} tool calls: ${[...toolNames].join(', ')}`);
    }
    if (errors.length > 0) {
      parts.push(`Errors encountered (${errors.length}):`);
      for (const e of errors.slice(0, 3)) {
        parts.push(`  - ${e}`);
      }
    }
    if (keyDecisions.length > 0) {
      parts.push('Key points:');
      for (const d of keyDecisions.slice(0, 5)) {
        parts.push(`  - ${d}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  /**
   * Lightweight in-place shrinking for local message arrays (e.g. subagent loops)
   * that don't go through the full prepareMessages pipeline.
   * Caps each message size and drops oldest non-system messages when over budget.
   */
  shrinkMessages(messages: LLMMessage[], contextWindow: number): LLMMessage[] {
    const maxPerMsg = Math.max(3000, Math.floor(contextWindow / 20));
    let result = this.shrinkOversizedMessages(messages, maxPerMsg);

    const totalChars = result.reduce((sum, m) => sum + getTextContent(m.content).length, 0);
    const estimatedTokens = totalChars / 3.5;
    const budget = contextWindow * 0.7;
    if (estimatedTokens > budget) {
      const system = result.filter(m => m.role === 'system');
      const nonSystem = result.filter(m => m.role !== 'system');
      while (nonSystem.length > 2 && (nonSystem.reduce((s, m) => s + getTextContent(m.content).length, 0) / 3.5) > budget) {
        nonSystem.shift();
      }
      result = [...system, ...nonSystem];
    }
    return result;
  }

  /**
   * Shrink any individual message whose content exceeds `maxChars`.
   * Tool results get head+tail preview; user/assistant messages get tail-trimmed.
   */
  private shrinkOversizedMessages(messages: LLMMessage[], maxChars: number): LLMMessage[] {
    return messages.map(m => {
      const text = getTextContent(m.content);
      if (text.length <= maxChars) return m;
      if (m.role === 'tool') {
        // Research tool results (web_search, browser snapshots) carry information
        // the agent needs for reasoning. Give them a higher cap than generic tools.
        const isResearch = m.toolCallId && this.isResearchToolResult(text);
        const effectiveCap = isResearch ? Math.max(maxChars, 6000) : maxChars;
        if (text.length <= effectiveCap) return m;

        const headSize = Math.min(Math.floor(effectiveCap * 0.65), isResearch ? 4000 : 1500);
        const tailSize = Math.min(Math.floor(effectiveCap * 0.25), isResearch ? 1500 : 800);
        const head = text.slice(0, headSize);
        const tail = text.slice(-tailSize);
        const omitted = text.length - headSize - tailSize;
        return {
          ...m,
          content: `[Tool result compacted: showing ${headSize} head + ${tailSize} tail of ${text.length} chars.]\n${head}\n[... ${omitted} chars omitted ...]\n${tail}`,
        };
      }
      if (Array.isArray(m.content)) return m;
      return {
        ...m,
        content:
          text.slice(0, maxChars) + `\n\n[... content trimmed from ${text.length} chars]`,
      };
    });
  }

  private isResearchToolResult(content: string): boolean {
    const markers = [
      'search_results', 'web_search', 'SearchResult',
      'accessibility tree', 'snapshot', 'page_content',
      '<title>', '<meta', 'README', '```markdown',
      'http://', 'https://',
    ];
    const prefix = content.slice(0, 500).toLowerCase();
    return markers.some(m => prefix.includes(m.toLowerCase()));
  }

  /**
   * Find where the current turn begins (last user message index).
   * Everything from here to the end is the "active" turn and should not be compacted.
   */
  private findCurrentTurnStart(messages: LLMMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') return i;
    }
    return 0;
  }

  /**
   * Compact historical tool-call blocks (before currentTurnStart) into summaries.
   * Each block = assistant(toolCalls) + tool results → replaced with a single
   * assistant message summarizing what happened.
   * The first block is protected if it's a task prompt (user message with
   * TASK EXECUTION marker) — it's always kept verbatim.
   */
  private compactOldTurns(
    messages: LLMMessage[],
    currentTurnStart: number,
    budget: number
  ): LLMMessage[] {
    const history = messages.slice(0, currentTurnStart);
    const currentTurn = messages.slice(currentTurnStart);

    const currentTurnTokens = this.sumTokens(currentTurn);
    const historyBudget = budget - currentTurnTokens;

    const blocks = this.parseIntoBlocks(history);

    const compactedBlocks: LLMMessage[][] = [];
    let usedTokens = 0;

    for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
      const block = blocks[blockIdx]!;
      const blockTokens = this.sumTokens(block);

      // Protect the first block if it's a task prompt
      if (blockIdx === 0 && block.length === 1 && block[0]!.role === 'user') {
        const text = getTextContent(block[0]!.content);
        if (text.includes('TASK EXECUTION') || text.includes('task_submit_review')) {
          compactedBlocks.push(block);
          usedTokens += blockTokens;
          continue;
        }
      }

      if (usedTokens + blockTokens <= historyBudget) {
        compactedBlocks.push(block);
        usedTokens += blockTokens;
      } else {
        const summary = this.summarizeToolBlock(block);
        const summaryTokens = estimateMessageTokens(summary, this.tokenCounter);
        if (usedTokens + summaryTokens <= historyBudget) {
          compactedBlocks.push([summary]);
          usedTokens += summaryTokens;
        }
        // If even the summary doesn't fit, drop the block entirely
      }
    }

    return [...compactedBlocks.flat(), ...currentTurn];
  }

  /**
   * Parse messages into logical blocks:
   * - A tool-call block: [assistant(with toolCalls), tool, tool, ...]
   * - A standalone message: [user] or [assistant(no toolCalls)]
   */
  private parseIntoBlocks(messages: LLMMessage[]): LLMMessage[][] {
    const blocks: LLMMessage[][] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i]!;
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Collect the entire tool-call block
        const block: LLMMessage[] = [msg];
        i++;
        while (i < messages.length && messages[i]!.role === 'tool') {
          block.push(messages[i]!);
          i++;
        }
        blocks.push(block);
      } else {
        blocks.push([msg]);
        i++;
      }
    }
    return blocks;
  }

  /**
   * Compress a tool-call block into a single assistant summary message.
   * Preserves the intent (what tool was called and why) without the raw output.
   *
   * Manus insight: uses template variation to break few-shot repetition patterns.
   * The model mimics patterns from context — uniform summaries cause behavioral drift.
   */
  private summarizeToolBlock(block: LLMMessage[]): LLMMessage {
    const assistant = block[0]!;
    const toolCalls = assistant.toolCalls ?? [];
    const toolResults = block.slice(1);

    const summaryParts: string[] = [];
    const assistantText = getTextContent(assistant.content);
    if (assistantText.trim()) {
      summaryParts.push(assistantText.trim());
    }

    const RESEARCH_TOOLS = new Set([
      'web_search', 'web_fetch',
      'navigate_page', 'take_snapshot', 'take_screenshot',
      'click', 'fill', 'type_text',
      'list_network_requests', 'evaluate_script',
      'file_read',
    ]);

    // Manus: serialization diversity — vary summary templates to avoid few-shot ruts
    const templates = [
      (name: string, args: string, res: string) => `[Called ${name}(${args})${res}]`,
      (name: string, args: string, res: string) => `[Tool: ${name} | args: ${args}${res}]`,
      (name: string, args: string, res: string) => `[${name}(${args})${res}]`,
      (name: string, args: string, res: string) => `[Action: ${name}, input: ${args}${res}]`,
    ];

    // Manus: keep error details in summaries — they help the model learn from failures
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const result = toolResults[i];
      const baseName = tc.name.includes('__') ? tc.name.split('__').pop()! : tc.name;
      const isResearch = RESEARCH_TOOLS.has(baseName);
      // Deterministic serialization: sorted keys prevent cache-busting from key order differences
      const argsStr = JSON.stringify(tc.arguments, Object.keys(tc.arguments ?? {}).sort()).slice(
        0,
        isResearch ? 200 : 100
      );
      let resultSummary = '';
      if (result) {
        const content = getTextContent(result.content);
        if (
          content.startsWith('Error:') ||
          (content.startsWith('{') && content.includes('"status":"error"'))
        ) {
          const errorPreview = content.slice(0, 200);
          resultSummary = ` → ERROR: ${errorPreview}`;
        } else if (isResearch) {
          // Research tools: preserve key findings so the agent retains knowledge
          const previewLen = Math.min(content.length, 500);
          resultSummary = ` → ${content.slice(0, previewLen)}${content.length > previewLen ? '...' : ''}`;
        } else if (content.length <= 120) {
          resultSummary = ` → ${content}`;
        } else {
          resultSummary = ` → (${content.length} chars)`;
        }
      }
      const template = templates[(i + block.length) % templates.length]!;
      summaryParts.push(template(tc.name, argsStr, resultSummary));
    }

    const prefixes = ['[Previous step]', '[Earlier action]', '[History]', '[Past step]'];
    const prefix = prefixes[block.length % prefixes.length]!;

    return {
      role: 'assistant',
      content: `${prefix} ${summaryParts.join(' ')}`,
    };
  }

  /**
   * Last-resort trimming: drop old messages to fit the budget.
   * Protects index 0 (often the task description with critical instructions like
   * task_submit_review) and keeps at least 4 recent messages.
   * When index 0 is a user message (task prompt), it is preserved and a
   * compacted version is used if the original is too large.
   */
  private trimToFitBudget(messages: LLMMessage[], budget: number): LLMMessage[] {
    if (messages.length <= 4 || this.sumTokens(messages) <= budget) return messages;

    // Preserve the first message if it looks like a task prompt (user role)
    const firstMsg = messages[0]!;
    const protectFirst = firstMsg.role === 'user' &&
      (getTextContent(firstMsg.content).includes('TASK EXECUTION') ||
       getTextContent(firstMsg.content).includes('task_submit_review'));

    if (protectFirst) {
      // Keep first message + trim from position 1 onward
      let middle = messages.slice(1);
      while (middle.length > 3 && this.sumTokens([firstMsg, ...middle]) > budget) {
        middle = middle.slice(1);
      }
      const result = [firstMsg, ...middle];
      // If still over budget, compact the first message itself
      if (this.sumTokens(result) > budget) {
        const text = getTextContent(firstMsg.content);
        const maxFirstChars = Math.max(800, Math.floor(budget * 2));
        const compactedFirst: LLMMessage = {
          ...firstMsg,
          content: text.slice(0, maxFirstChars) + '\n\n[... task description trimmed. REMEMBER: Call `task_submit_review` when done.]',
        };
        return [compactedFirst, ...middle];
      }
      return result;
    }

    // Default: drop from the oldest end
    let result = messages;
    while (result.length > 4 && this.sumTokens(result) > budget) {
      result = result.slice(1);
    }
    return result;
  }

  private sumTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const m of messages) total += estimateMessageTokens(m, this.tokenCounter);
    return total;
  }

  /**
   * Ensures every assistant+toolCalls message is followed by ALL its tool_result messages.
   * Orphaned or incomplete blocks are dropped to prevent LLM API errors.
   */
  private sanitizeMessageSequence(messages: LLMMessage[]): LLMMessage[] {
    const result: LLMMessage[] = [];

    let pendingAssistant: LLMMessage | null = null;
    const pendingIds = new Set<string>();
    const collectedResults: LLMMessage[] = [];

    const flushPending = (drop = false) => {
      if (!pendingAssistant) return;
      if (!drop && pendingIds.size === 0) {
        result.push(pendingAssistant, ...collectedResults);
      } else {
        log.debug('Dropping incomplete assistant toolCalls block', { missing: [...pendingIds] });
      }
      pendingAssistant = null;
      pendingIds.clear();
      collectedResults.length = 0;
    };

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        flushPending(true);
        pendingAssistant = msg;
        for (const tc of msg.toolCalls) pendingIds.add(tc.id);
      } else if (msg.role === 'tool') {
        if (pendingAssistant && msg.toolCallId && pendingIds.has(msg.toolCallId)) {
          pendingIds.delete(msg.toolCallId);
          collectedResults.push(msg);
          if (pendingIds.size === 0) flushPending();
        } else {
          log.debug('Dropping orphaned tool message', { toolCallId: msg.toolCallId });
        }
      } else {
        flushPending(pendingIds.size > 0);
        // Merge consecutive user messages only if neither is system-injected.
        // System injections (loop warnings, reminders) start with "[SYSTEM]" or
        // "[Conversation history summary" and must stay separate to avoid confusing
        // the model about what the human actually said.
        const prev = result[result.length - 1];
        const msgText = typeof msg.content === 'string' ? msg.content : '';
        const prevText = prev ? (typeof prev.content === 'string' ? prev.content : '') : '';
        const isSystemInjected = (t: string) =>
          t.startsWith('[SYSTEM]') || t.startsWith('[Conversation history summary');
        if (
          prev && prev.role === msg.role && msg.role === 'user' &&
          !isSystemInjected(msgText) && !isSystemInjected(prevText)
        ) {
          prev.content = prev.content + '\n\n' + msg.content;
        } else {
          result.push(msg);
        }
      }
    }

    flushPending(pendingIds.size > 0);
    return result;
  }

  private buildOrgContextSection(orgContext?: OrgContext, contextMdPath?: string): string | null {
    if (contextMdPath && existsSync(contextMdPath)) {
      try {
        const content = readFileSync(contextMdPath, 'utf-8');
        return `\n## Organization Context\n${content}`;
      } catch {
        log.warn('Failed to read CONTEXT.md', { path: contextMdPath });
      }
    }

    if (!orgContext) return null;

    const parts: string[] = ['\n## Organization Context'];
    parts.push(`- Organization: ${orgContext.orgName}`);
    if (orgContext.teamName) parts.push(`- Team: ${orgContext.teamName}`);

    if (orgContext.colleagues?.length) {
      parts.push('\n### Colleagues');
      for (const c of orgContext.colleagues) {
        parts.push(`- ${c.name} (${c.role}) [ID: ${c.id}]`);
      }
    }

    if (orgContext.projects?.length) {
      parts.push('\n### Active Projects');
      for (const p of orgContext.projects) {
        parts.push(`- **${p.name}**: ${p.description}`);
      }
    }

    if (orgContext.customContext) {
      parts.push(`\n### Additional Context\n${orgContext.customContext}`);
    }

    return parts.join('\n');
  }

  private buildEnvironmentSection(env: EnvironmentProfile): string {
    const lines: string[] = ['\n## Your Environment'];
    lines.push(`- OS: ${env.os.platform} ${env.os.release} (${env.os.arch})`);
    lines.push(`- Shell: ${env.shell}`);
    lines.push(`- Working Directory: ${env.workdir}`);

    if (env.tools.length > 0) {
      const toolList = env.tools.map(t => `${t.name} ${t.version}`).join(', ');
      lines.push(`- Available Tools: ${toolList}`);
    }

    if (env.browsers.length > 0) {
      lines.push(`- Browsers: ${env.browsers.map(b => b.name).join(', ')}`);
    }

    if (env.runtimes.length > 0) {
      const rtList = env.runtimes.map(r => `${r.name} ${r.version}`).join(', ');
      lines.push(`- Runtimes: ${rtList}`);
    }

    if (env.packageManagers.length > 0) {
      lines.push(`- Package Managers: ${env.packageManagers.join(', ')}`);
    }

    lines.push(
      `- Resources: ${env.resources.cpuCores} CPU cores, ${env.resources.memoryMB} MB RAM, ${env.resources.diskFreeMB} MB free disk`
    );

    const missing = ['git', 'node', 'docker', 'python3', 'java'].filter(
      name => !env.tools.some(t => t.name === name) && !env.runtimes.some(r => r.name === name)
    );
    if (missing.length > 0) {
      lines.push(
        `- NOT available: ${missing.join(', ')}. Do not attempt commands that require these.`
      );
    }

    return lines.join('\n');
  }

  private async retrieveRelevantMemories(memory: IMemoryStore, query?: string, agentId?: string): Promise<MemoryEntry[]> {
    const facts = memory.getEntries('fact', this.config.memorySearchTopK);

    if (query && this.semanticSearch?.isEnabled()) {
      try {
        const semResults = await this.semanticSearch.search(query, {
          agentId,
          topK: this.config.memorySearchTopK,
        });
        const semEntries = semResults.map(r => r.entry);
        const semIds = new Set(semEntries.map(e => e.id));
        const combined = [...facts.filter(f => !semIds.has(f.id)), ...semEntries];
        return combined.slice(0, this.config.memorySearchTopK * 2);
      } catch {
        // fall through to substring search
      }
    }

    if (query) {
      try {
        const searchResults = memory.search(query);
        const searchIds = new Set(searchResults.map(m => m.id));
        const combined = [...facts.filter(f => !searchIds.has(f.id)), ...searchResults];
        return combined.slice(0, this.config.memorySearchTopK * 2);
      } catch {
        // fall through to facts-only
      }
    }

    return facts;
  }
}
