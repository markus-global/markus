import { readFileSync, existsSync } from 'node:fs';
import {
  createLogger,
  getTextContent,
  type LLMMessage,
  type RoleTemplate,
  type IdentityContext,
  SYSTEM_MY_TASKS_MAX,
  SYSTEM_TEAM_TASKS_MAX,
  SYSTEM_TASK_DESC_CHARS,
  SYSTEM_SOPS_CHARS,
  SYSTEM_LONGTERM_MEMORY_CHARS,
  SYSTEM_LESSON_ENTRIES_MAX,
  SYSTEM_BEST_PRACTICE_ENTRIES_MAX,
  SYSTEM_DELIVERABLES_CHARS,
  SYSTEM_DAILY_LOG_CHARS,
  SYSTEM_DAILY_LOG_DAYS,
  SYSTEM_USER_PROFILE_CHARS,
  SYSTEM_PROJECT_DESC_CHARS,
  SYSTEM_DELIVERABLE_PREVIEW_CHARS,
  SYSTEM_MAILBOX_MERGED_CHARS,
  SYSTEM_MAILBOX_ITEM_PREVIEW_CHARS,
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
    scenario?: 'chat' | 'task_execution' | 'heartbeat' | 'a2a' | 'comment_response' | 'memory_consolidation' | 'review';
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
      if (project.description) parts.push(`- ${project.description.slice(0, SYSTEM_PROJECT_DESC_CHARS)}`);
      if (repositories?.length) {
        for (const repo of repositories) {
          parts.push(
            `- Repository: \`${repo.localPath}\` (${repo.role}, default branch: \`${repo.defaultBranch}\`)`
          );
        }
      }
      parts.push('');
      parts.push('Some git operations (switching to existing branches, pushing to protected branches, merge, rebase) require human approval — the system will pause and ask the reviewer. If denied, you will receive a reason; read it and adjust your approach.');
      if (teamRole) parts.push(`- Your role: ${teamRole}`);
      if (governanceRules) parts.push(`- Governance: ${governanceRules}`);
    }

    // ── Workspace Info ──────────────────────────────────────────────────
    if (opts.agentWorkspace) {
      parts.push('\n## Your Workspace');
      parts.push(`- Working directory: \`${opts.agentWorkspace.primaryWorkspace}\``);
      if (opts.agentWorkspace.sharedWorkspace) {
        parts.push(`- Shared workspace: \`${opts.agentWorkspace.sharedWorkspace}\` (all agents can read/write here)`);
      }
      const artifactsDir = opts.agentWorkspace.builderArtifactsDir ?? '~/.markus/builder-artifacts';
      if (opts.agentWorkspace.builderArtifactsDir) {
        parts.push(`- Builder artifacts directory: \`${artifactsDir}/\``);
        parts.push('  When creating agents, teams, or skills, place them in the correct subdirectory:');
        parts.push(`  - Agents → \`${artifactsDir}/agents/{agent-name}/\``);
        parts.push(`  - Teams → \`${artifactsDir}/teams/{team-name}/\``);
        parts.push(`  - Skills → \`${artifactsDir}/skills/{skill-name}/\``);
        parts.push('  The Builder page and install system ONLY recognize these paths.');
      }
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
            parts.push(userProfile.slice(0, SYSTEM_USER_PROFILE_CHARS));
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
        parts.push(`- **[${k.category}]** ${k.title}: ${k.content.slice(0, SYSTEM_DELIVERABLE_PREVIEW_CHARS)}`);
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

    // SOPs get their own dedicated section — always fully loaded, not truncated by the
    // general MEMORY.md cap, so agents reliably see their accumulated procedures.
    const sops = opts.memory.getLongTermSection('sops');
    if (sops) {
      parts.push('\n## Your SOPs (Standard Operating Procedures)');
      parts.push('These are your proven, repeatable workflows. Follow them when the trigger matches.');
      parts.push(sops.slice(0, SYSTEM_SOPS_CHARS));
    }

    // Exclude sections already loaded separately (SOPs) to avoid duplication
    const longTermMem = opts.memory.getLongTermMemoryExcluding(['sops']);
    if (longTermMem) {
      parts.push('\n## Long-term Knowledge');
      parts.push(longTermMem.slice(0, SYSTEM_LONGTERM_MEMORY_CHARS));
    }

    const lessons = opts.memory.getEntriesByTag('lesson', SYSTEM_LESSON_ENTRIES_MAX);
    if (lessons.length > 0) {
      parts.push('\n## Lessons from Past Experience');
      for (const lesson of lessons) {
        const ts = lesson.timestamp ? new Date(lesson.timestamp).toLocaleDateString() : '';
        parts.push(`- [${ts}] ${lesson.content}`);
      }
    }

    const bestPractices = opts.memory.getEntriesByTag('best-practice', SYSTEM_BEST_PRACTICE_ENTRIES_MAX);
    if (bestPractices.length > 0) {
      parts.push('\n## Best Practices');
      parts.push('Proven approaches from your completed tasks. Apply when relevant.');
      for (const bp of bestPractices) {
        const ts = bp.timestamp ? new Date(bp.timestamp).toLocaleDateString() : '';
        parts.push(`- [${ts}] ${bp.content}`);
      }
    }

    // Collect IDs already shown in Lessons / Best Practices to avoid duplication in Relevant Memories
    const alreadyShownIds = new Set<string>([
      ...lessons.map(e => e.id),
      ...bestPractices.map(e => e.id),
    ]);

    // During task execution, actively surface lessons/best-practices matching the task
    if (opts.scenario === 'task_execution' && opts.currentQuery) {
      const taskLessons = this.matchLessonsForTask(opts.memory, opts.currentQuery, alreadyShownIds);
      if (taskLessons.length > 0) {
        parts.push('\n## Applicable Lessons for This Task');
        parts.push('These lessons from past experience are relevant to the current task. Apply them proactively.');
        for (const lesson of taskLessons) {
          parts.push(`- ${lesson.content}`);
          alreadyShownIds.add(lesson.id);
        }
      }
    }

    const isDream = opts.scenario === 'memory_consolidation';

    if (!isDream && (opts.deliverableContext || opts.knowledgeContext)) {
      parts.push('\n## Shared Deliverables');
      parts.push((opts.deliverableContext ?? opts.knowledgeContext ?? '').slice(0, SYSTEM_DELIVERABLES_CHARS));
    }

    if (!isDream) {
      const relevantMemories = await this.retrieveRelevantMemories(opts.memory, opts.currentQuery, opts.agentId, alreadyShownIds);
      if (relevantMemories.length > 0) {
        parts.push('\n## Relevant Memories');
        for (const mem of relevantMemories) {
          const ts = mem.timestamp ? new Date(mem.timestamp).toLocaleDateString() : '';
          parts.push(`- [${ts}] ${mem.content}`);
        }
      }
    }

    if (!isDream) {
      const dailyLog = opts.memory.getRecentDailyLogs(SYSTEM_DAILY_LOG_DAYS);
      if (dailyLog) {
        parts.push('\n## Recent Activity Summary');
        parts.push(dailyLog.slice(0, SYSTEM_DAILY_LOG_CHARS));
      }
    }

    if (!isDream) {
      if (opts.assignedTasks && opts.assignedTasks.length > 0) {
        const priorityOrder = ['critical', 'high', 'medium', 'low'];
        const byPriority = (a: { priority?: string }, b: { priority?: string }) =>
          (priorityOrder.indexOf(a.priority ?? 'medium')) - (priorityOrder.indexOf(b.priority ?? 'medium'));

        const myTasks = opts.assignedTasks.filter(t => t.assignedAgentId === opts.agentId);
        const otherTasks = opts.assignedTasks.filter(t => t.assignedAgentId !== opts.agentId);

        const myActive = myTasks.filter(t => !['completed', 'cancelled', 'failed'].includes(t.status)).sort(byPriority);
        const myDone = myTasks.filter(t => ['completed', 'cancelled', 'failed'].includes(t.status));

        const MY_TASK_LIMIT = SYSTEM_MY_TASKS_MAX;
        const TEAM_TASK_LIMIT = SYSTEM_TEAM_TASKS_MAX;

        parts.push('\n## Task Board');

        parts.push('### My Tasks (assigned to you):');
        if (myActive.length > 0) {
          const shown = myActive.slice(0, MY_TASK_LIMIT);
          for (const t of shown) {
            parts.push(
              `- [${t.status.toUpperCase()}] **${t.title}** (ID: \`${t.id}\`, priority: ${t.priority})`
            );
            if (t.description) parts.push(`  ${t.description.slice(0, SYSTEM_TASK_DESC_CHARS)}`);
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
      parts.push('### Task & Requirement Workflow');
      parts.push('');
      parts.push('**Requirements** (governance gate):');
      parts.push('- `requirement_propose` → pending human approval → approved → link tasks via `requirement_id`');
      parts.push('- When governance requires it, every task MUST reference an approved `requirement_id`.');
      parts.push('');
      parts.push('**Task lifecycle** — Create → Execute → Review → Complete:');
      parts.push('- **Create**: `task_create` (REQUIRED: `assigned_agent_id`, `reviewer_agent_id`). Check `task_list` first to avoid duplicates.');
      parts.push('- **Execute**: Decompose with `subtask_create` → work through subtasks → `task_submit_review` with summary + deliverables (MANDATORY). System auto-fills `task_id` and `reviewer`.');
      parts.push('- **Review**: Reviewer approves with `task_update(status:"completed")` or rejects with `task_update(status:"in_progress", note:"what needs to change")` (auto-restarts execution). Workers MUST NOT set status=completed on their own tasks.');
      parts.push('- **Blockers**: Use `task_update(status:"blocked", note:"reason")` when unable to proceed.');
      parts.push('');
      parts.push('**Dependencies & DAG decomposition**:');
      parts.push('- **CRITICAL**: Use `blocked_by` to express ALL dependency relationships. If task B needs output from task A, B **MUST** include A\'s ID in `blocked_by`. Without this, tasks run in parallel and downstream tasks lack upstream deliverables.');
      parts.push('- For complex goals, create a DAG of tasks. Assign each to the best team member (`team_list`). Independent tasks run in parallel; dependent tasks wait for predecessors.');
      parts.push('- If consolidated output is needed, create a final synthesis task assigned to a manager, `blocked_by` ALL prerequisites.');
      parts.push('');
      parts.push('**Work discovery**: `list_projects` → `requirement_list` → `task_list`. Use `memory_save`/`memory_search` for personal notes; `deliverable_create`/`deliverable_search` for shared outputs.');
      parts.push('');
      parts.push('**Automatic status notifications** (do NOT duplicate manually):');
      parts.push('- When task status changes, the system **automatically** handles all side effects: execution start/cancel, reviewer notification, dependency unblocking.');
      parts.push('- Task status notifications are placed in assignees\' mailboxes as **informational context only**.');
      parts.push('- Do NOT send A2A messages to notify about task status changes — only send A2A when you have substantive coordination needs beyond the status change itself.');
      parts.push('');
      parts.push('**Communicating with the user**:');
      parts.push('- `notify_user` — proactive message to user: status updates, progress reports, findings, alerts. Appears in chat and notification bell. User may reply. Write comprehensive body with full context.');
      parts.push('- `request_user_approval` — when you need a user decision, approval, or input. BLOCKS until the user responds. Supports custom options and freeform text. Do NOT use for routine updates.');
      parts.push('- `recall_activity` — query your own past execution logs by task or activity type. Use when you need to review what you did previously (e.g., to answer a follow-up question).');
    }

    if (opts.environment) {
      parts.push(this.buildEnvironmentSection(opts.environment));
    }

    if (!isDream && opts.senderIdentity) {
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

    if (!isDream) {
      parts.push('\n## Tool Usage Rules');
      parts.push('**File editing discipline**: You MUST use `file_write` and `file_edit` for all file creation and modification. NEVER use `shell_execute` with `cat`, `echo`, `printf`, `tee`, pipes (`|`), output redirection (`>`, `>>`), heredocs (`<<`), or `sed`/`awk` to write or modify files — these bypass file access controls. `shell_execute` is for running commands (build, test, git, etc.), not for writing files.');
      parts.push('**Large file writing**: NEVER write a document >200 lines in a single `file_write` call. Write section by section: `file_write` the first section, then `file_edit` to append each subsequent section.');
      parts.push('**Error handling**: If a tool call fails, analyze the error and try a different approach — do NOT repeat the same failing action.');
      parts.push('**Subagent delegation**: For heavy subtasks needing many tool calls or lots of file reading, delegate to `spawn_subagent` to keep your context lean. Use `spawn_subagents` to run independent subtasks in parallel.');
      parts.push('**Built-in tools over CLI**: ALWAYS prefer built-in tools (`task_create`, `task_assign`, `team_hire_agent`, `builder_install`, `agent_send_message`, `memory_save`, etc.) over running `markus` CLI commands via `shell_execute`. The CLI is for human operators — agents must use their native tool interface. Only fall back to CLI if no built-in tool exists for the operation.');
      parts.push('**No auto-install/deploy**: NEVER automatically install or deploy agents, teams, or skills via `builder_install`, `team_hire_agent`, or `hub_install` unless the user explicitly requests it (e.g., "install", "deploy", "hire", "start"). Creating an artifact (writing files to `builder-artifacts/`) is separate from deploying it into the live organization.');
    }

    // --- Mailbox & attention context ---
    if (!isDream && opts.mailboxContext) {
      parts.push(this.buildMailboxSection(opts.mailboxContext));
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
        lines.push(`  - [${q.type}] p${q.priority}: ${q.summary.slice(0, SYSTEM_MAILBOX_ITEM_PREVIEW_CHARS)}`);
      }
    }

    if (ctx.recentDecisions && ctx.recentDecisions.length > 0) {
      lines.push('**Recent attention decisions**:');
      for (const d of ctx.recentDecisions.slice(-5)) {
        lines.push(`  - ${d.type}: ${d.reasoning.slice(0, SYSTEM_MAILBOX_ITEM_PREVIEW_CHARS)}`);
      }
    }

    if (ctx.mergedContent) {
      lines.push(`**Merged context** (absorbed into current work):\n${ctx.mergedContent.slice(0, SYSTEM_MAILBOX_MERGED_CHARS)}`);
    }

    return lines.join('\n');
  }

  private buildScenarioSection(scenario: 'chat' | 'task_execution' | 'heartbeat' | 'a2a' | 'comment_response' | 'memory_consolidation' | 'review'): string {
    const lines: string[] = ['\n## Current Interaction Mode'];

    switch (scenario) {
      case 'chat':
        lines.push('You are in a **human chat session**.');
        lines.push('');
        lines.push('**Do inline**: answer questions, status updates, searches, file lookups, and any work the user needs an immediate answer for. Follow role-specific chat workflows if defined.');
        lines.push('**Create tasks for**: sustained implementation work, multi-file code changes, or work that benefits from subtask decomposition, review, and team collaboration. Follow the Task Workflow above.');
        lines.push('');
        lines.push('**After creating tasks, STOP.** Do NOT execute the task work yourself. The task runs in its own isolated context after user approval. Reply with a summary of created tasks, assignees, and dependency structure. Tell the user to review and approve.');
        lines.push('');
        lines.push('Keep responses concise and human-friendly. The user should not see raw tool outputs or complex operations.');
        break;

      case 'task_execution':
        lines.push('You are in **task execution mode** — an isolated session for focused, thorough work.');
        lines.push('');
        lines.push('**Context awareness:**');
        lines.push('- This session is ISOLATED from chat — the user monitors progress through task logs');
        lines.push('- If there is `⚠ USER FEEDBACK` above, READ IT FIRST and adjust your approach');
        lines.push('- If there are dependency tasks, review ALL their deliverables before starting (`file_read` + `task_get`)');
        lines.push('');
        lines.push('**Workspace setup**: Before modifying project code, set up an isolated workspace (e.g., `git worktree add` into your workspace directory). Some git operations require human approval — if denied, read the reason and adjust.');
        lines.push('');
        lines.push('**Execution protocol** (follow the Task Workflow above):');
        lines.push('1. **Decompose**: `subtask_create` to break the task into concrete, verifiable steps');
        lines.push('2. **Execute**: Work through subtasks in order. `subtask_complete` each. `task_note` after significant steps.');
        lines.push('3. **Stay focused**: No unrelated work. No new top-level tasks — only subtasks within your assigned task.');
        lines.push('4. **Delegate**: Use `spawn_subagent`/`spawn_subagents` for heavy or independent subtasks (see Tool Usage Rules). Workflow: `subtask_create` → `spawn_subagent` → verify → `subtask_complete`.');
        lines.push('5. **Submit**: When done, `task_submit_review` with summary + deliverables (MANDATORY).');
        break;

      case 'heartbeat':
        lines.push('You are in **heartbeat mode** — a brief periodic check-in. NOT a work session.');
        lines.push('');
        lines.push('**Priority actions (in order):**');
        lines.push('1. **Review duty**: Check `task_list` for tasks in `review` status where you are the reviewer. Approve/reject per the Task Workflow above. Unreviewed tasks block the team.');
        lines.push('2. **Status check**: Compare current state against last heartbeat. Report only changes.');
        lines.push('3. **Failed task recovery**: Retry `failed` tasks via `task_update(status:"in_progress", note:"...")` — auto-restarts execution.');
        lines.push('4. **Daily report (managers, after 20:00)**: If prompted, produce the report as top priority after reviews.');
        lines.push('5. **Self-evolution**: Record specific, actionable lessons learned since last heartbeat.');
        lines.push('6. **Do NOT** start complex implementation work or do deep research in heartbeat.');
        lines.push('   - You MAY create tasks via `task_create` if you spot something that needs doing, and propose requirements via `requirement_propose`.');
        lines.push('   - You MUST NOT execute the work yourself — just triage, create/assign, and move on.');
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
        lines.push('- Do NOT use A2A for routine task status notifications or acknowledgments — the system handles all status-triggered side effects automatically');
        lines.push('- Only send A2A when you have substantive coordination needs: sharing context, asking questions, or providing instructions that go beyond a status change');
        lines.push('');
        lines.push('**Work delegation:**');
        lines.push('- A2A messages are for: quick coordination, simple questions, sharing file references, substantive instructions');
        lines.push('- For substantial work requests: create a `task_create` assigned to the target agent — do NOT ask them to do complex work via chat');
        lines.push('- For multi-agent work: decompose into a task DAG with `blocked_by` dependencies, assign each to the right agent');
        lines.push('- If you cannot help, explain why and suggest who can');
        break;

      case 'comment_response':
        lines.push('You are responding to a **comment on a task or requirement**. You MUST follow the context-first protocol below.');
        lines.push('');
        lines.push('**MANDATORY context-gathering protocol (do this BEFORE writing any reply):**');
        lines.push('1. **Fetch the full item**: Call `task_get` (for task comments) or `requirement_get` (for requirement comments) to retrieve the complete current state — title, description, status, assignee, linked items, comments, and all fields');
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
        lines.push('- Reply immediately without calling `task_get`/`requirement_get` first');
        lines.push('- Give a generic acknowledgment like "Got it, will look into it" without substantive content');
        lines.push('- Ignore prior comments that provide important context for the current discussion');
        lines.push('');
        lines.push('**Conversation termination — when NOT to reply:**');
        lines.push('- The comment is just an acknowledgment ("Got it", "Will do", "Thanks", "Agreed") — do NOT reply');
        lines.push('- Both parties have reached agreement or the discussion is resolved — do NOT reply');
        lines.push('- Your reply would only be "Sounds good", "Agreed", or similar zero-information response — do NOT reply');
        lines.push('- The comment does not ask a question, request action, or contain information you need to correct — do NOT reply');
        lines.push('- **Principle**: only comment when your reply adds **new information** or requests a **decision**. Avoid comment ping-pong.');
        break;

      case 'review':
        lines.push('You are in **task review mode** — you have been asked to review a completed task.');
        lines.push('');
        lines.push('**MANDATORY review protocol:**');
        lines.push('1. **Understand the task**: Call `task_get` with the task ID to see the full task state, description, deliverables, and notes');
        lines.push('2. **Inspect deliverables**: Use `file_read` to examine ALL deliverable files listed in the task');
        lines.push('3. **Check git changes**: If a task branch exists, use `shell_execute` to run `git diff` and review code changes');
        lines.push('4. **Verify quality**: Check that deliverables match the task requirements and are functionally correct');
        lines.push('');
        lines.push('**After completing your review, you MUST take one of these actions:**');
        lines.push('- **Approve**: `task_update` with `status: "completed"` and a `note` summarizing your review findings. If there is a task branch, merge it first.');
        lines.push('- **Request revision**: `task_update` with `status: "in_progress"` and a `note` explaining what needs to change. This auto-restarts the task with your feedback.');
        lines.push('');
        lines.push('**CRITICAL: You MUST call `task_update` to finalize the review.** Simply writing a text response is NOT sufficient — the task will remain stuck in "review" status until you explicitly call `task_update` with either "completed" or "in_progress".');
        lines.push('Do NOT review or change the status of any task other than the one you were asked to review.');
        break;

      case 'memory_consolidation':
        lines.push('You are in **memory consolidation mode** (dream cycle) — a background introspective process.');
        lines.push('You are NOT executing tasks, NOT chatting with users, NOT in a heartbeat check-in.');
        lines.push('');
        lines.push('Your ONLY job is to review the memory entries provided in the user message and output a JSON consolidation plan.');
        lines.push('Do NOT call any tools. Do NOT take any actions. Do NOT discuss tasks or projects.');
        lines.push('Respond with ONLY the JSON object as specified in the user message.');
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
        lines.push(`  Use \`discover_tools({ name: ["skill-name"] })\` to load a skill's full instructions when needed.`);
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
        lines.push('6. **Hiring & Team Building** — Two phases: CREATE then INSTALL (only when user requests).');
        lines.push('   a) *Creating* (design the artifact): activate `agent-building` or `team-building` skill → write artifact files. Or `hub_search` to browse community packages.');
        lines.push('   b) *Installing* (deploy into org — ONLY when user explicitly asks to install/deploy/hire):');
        lines.push('      - Quick hire from template: `team_list_templates` → `team_hire_agent`');
        lines.push('      - Install artifact: `builder_install` (for custom-built or Hub-downloaded packages)');
        lines.push('      - Hub one-step: `hub_install` (download + install)');
        lines.push('   c) After install: onboard via `agent_send_message` (project context) → `task_create` (initial work)');
        lines.push('   **IMPORTANT**: NEVER auto-install. Creating an artifact does NOT mean deploying it. Wait for explicit user request.');
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

  /**
   * Match lesson/best-practice entries against the current task description
   * using keyword overlap. Returns entries whose content shares significant
   * words with the task, ranked by overlap score.
   */
  private matchLessonsForTask(
    memory: IMemoryStore,
    taskDescription: string,
    excludeIds: Set<string>,
  ): MemoryEntry[] {
    const lessons = memory.getEntriesByTag('lesson');
    const bestPractices = memory.getEntriesByTag('best-practice');
    const candidates = [...lessons, ...bestPractices].filter(e => !excludeIds.has(e.id));
    if (candidates.length === 0) return [];

    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or', 'not',
      'this', 'that', 'it', 'as', 'if', 'but', 'do', 'does', 'did', 'has', 'have', 'had',
      'will', 'would', 'could', 'should', 'can', 'may', 'must', 'use', 'task', 'using']);
    const tokenize = (text: string) => {
      const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      return new Set(words.filter(w => !stopWords.has(w)));
    };

    const taskTokens = tokenize(taskDescription);
    if (taskTokens.size === 0) return [];

    const scored = candidates.map(entry => {
      const entryTokens = tokenize(entry.content);
      let overlap = 0;
      for (const t of entryTokens) {
        if (taskTokens.has(t)) overlap++;
      }
      return { entry, score: overlap };
    }).filter(s => s.score >= 2);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map(s => s.entry);
  }

  private async retrieveRelevantMemories(
    memory: IMemoryStore,
    query?: string,
    agentId?: string,
    excludeIds?: Set<string>,
  ): Promise<MemoryEntry[]> {
    const exclude = excludeIds ?? new Set<string>();
    const facts = memory.getEntries('fact', this.config.memorySearchTopK)
      .filter(f => !exclude.has(f.id));

    if (query && this.semanticSearch?.isEnabled()) {
      try {
        const semResults = await this.semanticSearch.search(query, {
          agentId,
          topK: this.config.memorySearchTopK,
        });
        const semEntries = semResults.map(r => r.entry).filter(e => !exclude.has(e.id));
        const semIds = new Set(semEntries.map(e => e.id));
        const combined = [...facts.filter(f => !semIds.has(f.id)), ...semEntries];
        return combined.slice(0, this.config.memorySearchTopK * 2);
      } catch {
        // fall through to substring search
      }
    }

    if (query) {
      try {
        const searchResults = memory.search(query).filter(e => !exclude.has(e.id));
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
