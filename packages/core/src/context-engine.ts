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

export class ContextEngine {
  private config: ContextConfig;
  private tokenCounter: TokenCounter;
  private semanticSearch?: SemanticMemorySearch;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = config?.tokenCounter ?? getDefaultTokenCounter();
  }

  setSemanticSearch(ss: SemanticMemorySearch): void {
    this.semanticSearch = ss;
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
    environment?: EnvironmentProfile;
    // Governance context extensions
    projectContext?: {
      project: { id: string; name: string; description: string; status: string };
      iteration?: { id: string; name: string; goal?: string; status: string; endDate?: string };
      repositories?: Array<{ localPath: string; defaultBranch: string; role: string }>;
      governanceRules?: string;
      teamRole?: string;
    };
    currentWorkspace?: {
      branch: string;
      worktreePath: string;
      baseBranch: string;
    };
    announcements?: Array<{
      type: string;
      priority: string;
      title: string;
      content: string;
    }>;
    trustLevel?: { level: string; score: number };
    projectKnowledge?: Array<{
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
    scenario?: 'chat' | 'task_execution' | 'heartbeat' | 'a2a';
  }): Promise<string> {
    const parts: string[] = [];

    parts.push(opts.role.systemPrompt);
    parts.push(this.buildIdentitySection(opts));

    const orgCtx = this.buildOrgContextSection(opts.orgContext, opts.contextMdPath);
    if (orgCtx) parts.push(orgCtx);

    // ── Governance: Project Context (P1 priority) ────────────────────────
    if (opts.projectContext) {
      const { project, iteration, repositories, governanceRules, teamRole } = opts.projectContext;
      parts.push('\n## Current Project');
      parts.push(`- Project: **${project.name}** (${project.status})`);
      if (project.description) parts.push(`- ${project.description.slice(0, 200)}`);
      if (iteration) {
        parts.push(
          `- Iteration: ${iteration.name} — "${iteration.goal ?? ''}" (${iteration.status}${iteration.endDate ? `, ends ${iteration.endDate}` : ''})`
        );
      }
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
      parts.push(`- Working directory: ${opts.currentWorkspace.worktreePath}`);
      parts.push(`- Base branch: ${opts.currentWorkspace.baseBranch}`);
      parts.push('- IMPORTANT: All file operations are restricted to this directory');
    }

    // ── Governance: Trust Level (P2 priority) ──────────────────────────
    if (opts.trustLevel) {
      parts.push('\n## Your Trust Level');
      parts.push(`- Level: **${opts.trustLevel.level}** (score: ${opts.trustLevel.score})`);
      if (opts.trustLevel.level === 'probation') {
        parts.push('- You are on probation. All your task creations require human approval. Focus on quality to build trust.');
      } else if (opts.trustLevel.level === 'junior') {
        parts.push('- You are a junior agent. Most task creations require manager approval.');
      } else if (opts.trustLevel.level === 'standard') {
        parts.push('- You are a standard-level agent. Routine tasks may auto-approve; significant tasks need manager approval.');
      } else if (opts.trustLevel.level === 'senior') {
        parts.push('- You are a senior agent. You have higher autonomy. Routine tasks auto-approve.');
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

    // ── Governance: Project Knowledge (P1 priority) ──────────────────────
    if (opts.projectKnowledge?.length) {
      parts.push('\n## Project Knowledge Base (key entries)');
      for (const k of opts.projectKnowledge) {
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
      parts.push(longTermMem.slice(0, 3000));
    }

    if (opts.knowledgeContext) {
      parts.push('\n## Knowledge Base');
      parts.push(opts.knowledgeContext.slice(0, 3000));
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
      const myTasks = opts.assignedTasks.filter(t => t.assignedAgentId === opts.agentId);
      const otherTasks = opts.assignedTasks.filter(t => t.assignedAgentId !== opts.agentId);

      const myActive = myTasks.filter(t => !['completed', 'cancelled', 'failed'].includes(t.status));
      const myDone = myTasks.filter(t => ['completed', 'cancelled', 'failed'].includes(t.status));

      parts.push('\n## Task Board');

      parts.push('### My Tasks (assigned to you):');
      if (myActive.length > 0) {
        for (const t of myActive) {
          parts.push(
            `- [${t.status.toUpperCase()}] **${t.title}** (ID: \`${t.id}\`, priority: ${t.priority})`
          );
          if (t.description) parts.push(`  ${t.description.slice(0, 200)}`);
        }
      } else {
        parts.push('No active tasks assigned to you.');
      }
      if (myDone.length > 0) {
        parts.push(`_(${myDone.length} completed/closed tasks)_`);
      }

      if (otherTasks.length > 0) {
        const otherActive = otherTasks.filter(t => !['completed', 'cancelled', 'failed'].includes(t.status));
        const otherDone = otherTasks.filter(t => ['completed', 'cancelled', 'failed'].includes(t.status));
        if (otherActive.length > 0) {
          parts.push('### Team Tasks (assigned to others):');
          for (const t of otherActive) {
            const owner = t.assignedAgentName ?? t.assignedAgentId ?? 'unassigned';
            parts.push(
              `- [${t.status.toUpperCase()}] **${t.title}** (ID: \`${t.id}\`, assignee: ${owner}, priority: ${t.priority})`
            );
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
    parts.push(
      '**Task Rule:** All work must be linked to a task. Worker flow: `task_create` → `task_update(in_progress)` → `task_submit_review` (never `task_update(completed)` yourself). After submitting, notify the reviewer and PM via `agent_send_message`, then call `agent_broadcast_status`. Reviewer flow: `task_update(accepted)` or `task_update(revision)` → `task_update(completed)` when fully resolved. Check `task_list` before creating duplicates.'
    );
    parts.push(
      '**Assignee Rule:** Every task MUST have an assignee (`assigned_agent_id`). Call `team_list` first to identify the right agent by role and skills. Only create an unassigned task when it is genuinely unclear who should own it — in that case you MUST provide `reason_unassigned`.'
    );

    parts.push('\n## Work Discovery (Project → Requirement → Task)');
    parts.push(
      'To understand the full scope of work, navigate the hierarchy in order:'
    );
    parts.push('1. `list_projects` — See all projects in the organization');
    parts.push('2. `requirement_list` with `project_id` — See approved requirements for a project');
    parts.push('3. `task_list` with `requirement_id` — See all tasks under a specific requirement');
    parts.push(
      '**Never browse the filesystem to discover project structure.** Always use these tools first.'
    );

    parts.push('\n## Memory & Tools');
    parts.push(
      '- `memory_save` — Persist important facts/decisions. `memory_search` — Recall past context.'
    );
    parts.push(
      '- Save only meaningful information (preferences, decisions, outcomes). Skip trivial data.'
    );

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

    // --- Manus-inspired: Attention Recitation ---
    // For complex multi-step tasks, maintaining a running plan prevents
    // "lost-in-the-middle" issues and keeps the model focused on its goals.
    parts.push('\n## Working Strategy');
    parts.push('For complex tasks requiring multiple steps:');
    parts.push(
      '1. **Plan first**: Before acting, outline your approach. For long tasks, create a `todo.md` in the workspace to track progress.'
    );
    parts.push(
      '2. **Update progress**: After completing each step, update your plan — check off done items, note blockers.'
    );
    parts.push(
      '3. **Recite objectives**: Before each action, briefly restate what you are trying to achieve. This keeps your focus sharp.'
    );
    parts.push(
      '4. **Learn from errors**: If a tool call fails, analyze why before retrying. Do NOT repeat the exact same action — try a different approach.'
    );
    parts.push(
      '5. **Offload large data**: If a tool returns very large output, save it to a file and reference the file path instead of keeping it all in context.'
    );

    // --- Scenario-specific behavioral guidance ---
    const scenario = opts.scenario ?? 'chat';
    parts.push(this.buildScenarioSection(scenario));

    // --- KV-Cache optimization: timestamp at end, date-only precision ---
    // Placing time at the end of the system prompt preserves cache for the
    // stable prefix (identity, role, policies, memory) which rarely changes.
    parts.push(`\n---\nCurrent date: ${new Date().toISOString().split('T')[0]}`);

    return parts.join('\n');
  }

  private buildScenarioSection(scenario: 'chat' | 'task_execution' | 'heartbeat' | 'a2a'): string {
    const lines: string[] = ['\n## Current Interaction Mode'];

    switch (scenario) {
      case 'chat':
        lines.push('You are in a **human conversation**. Follow these behavioral rules:');
        lines.push('- Be conversational, responsive, and helpful.');
        lines.push('- Focus on understanding intent and providing clear, concise answers.');
        lines.push('- **Do NOT execute long-running work inline.** If a request requires more than ~3 tool calls or significant work (writing code, running tests, file modifications), create a task via `task_create` and let the task execution handle it.');
        lines.push('- After creating a task, briefly explain what was created and that the agent will work on it asynchronously.');
        lines.push('- Quick lookups, simple questions, and short status checks are fine to handle inline.');
        lines.push('- Report progress and results proactively when the human asks about ongoing work.');
        break;

      case 'task_execution':
        lines.push('You are in **task execution** mode. Follow these behavioral rules:');
        lines.push('- Be thorough and methodical — this is your dedicated work time.');
        lines.push('- Complete all steps of the task before submitting for review.');
        lines.push('- Update task notes with progress after each significant step using `task_note`.');
        lines.push('- Use all available tools to deliver high-quality output.');
        lines.push('- Follow the full task lifecycle: work → test → document → `task_submit_review`.');
        lines.push('- If you discover blockers, update the task status to `blocked` with a clear explanation.');
        lines.push('- Stay focused on the assigned task — do not wander into unrelated work.');
        break;

      case 'heartbeat':
        lines.push('You are in **heartbeat** mode. Follow these behavioral rules:');
        lines.push('- Be brief and efficient — this is a periodic check-in, not a work session.');
        lines.push('- Only check task statuses and correct stale states.');
        lines.push('- NEVER execute actual work (writing code, making changes, calling external services).');
        lines.push('- NEVER create new tasks or start working on existing tasks.');
        lines.push('- Minimize tool calls — aim for 5 or fewer.');
        lines.push('- Propose untracked needs via `requirement_propose` if you notice gaps.');
        break;

      case 'a2a':
        lines.push('You are in an **agent-to-agent conversation**. Follow these behavioral rules:');
        lines.push('- Be concise and structured — your colleague agent needs actionable information.');
        lines.push('- Focus on the specific request or question from your colleague.');
        lines.push('- Respond with clear, factual information. Avoid conversational filler.');
        lines.push('- **Do NOT start long tasks inline.** If work is needed, create a task via `task_create` and inform your colleague of the task ID.');
        lines.push('- If you cannot help, explain why clearly and suggest who might be able to help.');
        lines.push('- Keep responses focused on collaboration and coordination.');
        break;
    }

    return lines.join('\n');
  }

  private buildIdentitySection(opts: {
    agentId: string;
    agentName: string;
    role: RoleTemplate;
    identity?: IdentityContext;
  }): string {
    const lines: string[] = ['\n## Your Identity'];

    if (opts.identity) {
      const self = opts.identity.self;
      lines.push(`- Name: ${self.name}`);
      lines.push(`- Role: ${opts.role.name} (${opts.role.description})`);
      lines.push(
        `- Position: ${self.agentRole === 'manager' ? 'Organization Manager — you lead the AI team' : 'Team Member'}`
      );
      if (self.skills.length > 0) {
        lines.push(`- Skills: ${self.skills.join(', ')}`);
      }
      lines.push(`- Organization: ${opts.identity.organization.name}`);
      lines.push(`- Agent ID: ${opts.agentId}`);
      // KV-Cache optimization: move timestamp to end of context (not prefix),
      // and only use date precision to avoid invalidating cache every second.
      // See: Manus "Context Engineering" — keep prefix stable for cache hits.

      if (opts.identity.manager && opts.identity.self.agentRole !== 'manager') {
        lines.push(`\n### Your Manager`);
        lines.push(
          `- ${opts.identity.manager.name} (AI Organization Manager) — report progress and escalate issues to them`
        );
      }

      if (opts.identity.colleagues.length > 0) {
        lines.push(`\n### Your Colleagues`);
        for (const c of opts.identity.colleagues) {
          const statusTag = c.status ? ` [${c.status}]` : '';
          lines.push(
            `- ${c.name} (${c.role}, ${c.type})${statusTag}${c.skills?.length ? ` — skills: ${c.skills.join(', ')}` : ''}`
          );
        }
      }

      if (opts.identity.humans.length > 0) {
        lines.push(`\n### Human Team Members`);
        for (const h of opts.identity.humans) {
          const tag = h.role === 'owner' ? ' ★ Owner' : h.role === 'admin' ? ' Admin' : '';
          lines.push(`- ${h.name}${tag}`);
        }
      }

      if (opts.identity.self.agentRole === 'manager') {
        lines.push(`\n### Manager Responsibilities`);
        lines.push('As Organization Manager, you are responsible for:');
        lines.push(
          '1. **Routing** — When receiving vague messages, determine which team member should handle it'
        );
        lines.push('2. **Coordination** — Assign tasks to the right agents based on their skills');
        lines.push('3. **Reporting** — Proactively report team progress to human stakeholders');
        lines.push(
          '4. **Training** — Help new agents understand their roles and the organization context'
        );
        lines.push('5. **Escalation** — Escalate issues that require human decision to the Owner');
      }
    } else {
      lines.push(`- Name: ${opts.agentName}`);
      lines.push(`- Role: ${opts.role.name}`);
      lines.push(`- Agent ID: ${opts.agentId}`);
    }

    return lines.join('\n');
  }

  /**
   * Intelligent context assembly. Instead of hardcoded limits, this method:
   * 1. Queries the model's actual context window to derive a token budget
   * 2. Reserves space for system prompt, tool definitions, and reply
   * 3. Fills remaining budget with messages, newest first
   * 4. Compacts old tool-call turns into summaries instead of truncating
   */
  prepareMessages(opts: {
    systemPrompt: string;
    sessionMessages: LLMMessage[];
    memory: IMemoryStore;
    sessionId: string;
    modelContextWindow?: number;
    modelMaxOutput?: number;
    toolDefinitions?: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
  }): LLMMessage[] {
    const contextWindow = opts.modelContextWindow ?? 64000;
    const maxOutput = opts.modelMaxOutput ?? 4096;

    const systemTokens = estimateTokens(opts.systemPrompt, this.tokenCounter);
    const toolDefTokens = opts.toolDefinitions
      ? estimateTokens(JSON.stringify(opts.toolDefinitions), this.tokenCounter)
      : 0;
    // Budget = contextWindow - system - tools - reply - safety margin (10%)
    const safetyMargin = Math.ceil(contextWindow * 0.1);
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

    // Step 1: Summarize very old sessions if memory supports it
    if (messages.length > 60) {
      messages = opts.memory.summarizeAndTruncate(opts.sessionId, 40);
    }

    // Step 2: Shrink oversized individual messages. Any single message
    // that exceeds 1/8 of the budget is likely a huge tool result or
    // dumped data — compact it to a short summary in-place.
    const perMessageCap = Math.max(2000, Math.floor(messageBudget / 8));
    messages = this.shrinkOversizedMessages(messages, perMessageCap);

    // Step 3: Sanitize message sequence (fix orphaned tool results)
    messages = this.sanitizeMessageSequence(messages);

    // Step 4: Identify the "current turn" — the most recent user message and
    // any tool-call chain following it. This is never compacted.
    const currentTurnStart = this.findCurrentTurnStart(messages);

    // Step 5: Compact old turns to fit budget.
    // Work from oldest to newest: compact tool-call blocks in history
    // into one-line summaries. Stop compacting once we fit the budget.
    let totalTokens = this.sumTokens(messages);

    if (totalTokens > messageBudget) {
      messages = this.compactOldTurns(messages, currentTurnStart, messageBudget);
      totalTokens = this.sumTokens(messages);
    }

    // Step 6: If still over budget (e.g. huge current turn), trim oldest messages
    if (totalTokens > messageBudget) {
      messages = this.trimToFitBudget(messages, messageBudget);
      totalTokens = this.sumTokens(messages);
      log.info('Trimmed oldest messages to fit budget', {
        remaining: messages.length,
        tokens: totalTokens,
        budget: messageBudget,
      });
    }

    log.debug('Context assembled', {
      contextWindow,
      messageBudget,
      messageTokens: totalTokens,
      systemTokens,
      toolDefTokens,
      messageCount: messages.length,
    });

    return [{ role: 'system', content: opts.systemPrompt }, ...messages];
  }

  /**
   * Shrink any individual message whose content exceeds `maxChars`.
   * Tool results get a short preview; user/assistant messages get tail-trimmed.
   */
  private shrinkOversizedMessages(messages: LLMMessage[], maxChars: number): LLMMessage[] {
    return messages.map(m => {
      const text = getTextContent(m.content);
      if (text.length <= maxChars) return m;
      if (m.role === 'tool') {
        const previewSize = Math.min(1000, maxChars);
        const preview = text.slice(0, previewSize);
        return {
          ...m,
          content: `[Tool result compacted for context budget: showing first ${previewSize} of ${text.length} chars. This is NOT the full output — the complete result was available when the tool ran.]\n${preview}\n[... ${text.length - previewSize} more chars omitted ...]`,
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

    // Parse history into "blocks": a tool-call block is [assistant+toolCalls, tool, tool, ...]
    // Everything else is a standalone message.
    const blocks = this.parseIntoBlocks(history);

    // Process from oldest to newest: compact the oldest blocks first
    const compactedBlocks: LLMMessage[][] = [];
    let usedTokens = 0;

    // First pass: estimate what fits without compaction
    for (const block of blocks) {
      const blockTokens = this.sumTokens(block);
      if (usedTokens + blockTokens <= historyBudget) {
        compactedBlocks.push(block);
        usedTokens += blockTokens;
      } else {
        // This block doesn't fit; compact it
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
      // Deterministic serialization: sorted keys prevent cache-busting from key order differences
      const argsStr = JSON.stringify(tc.arguments, Object.keys(tc.arguments ?? {}).sort()).slice(
        0,
        100
      );
      let resultSummary = '';
      if (result) {
        const content = getTextContent(result.content);
        if (
          content.startsWith('Error:') ||
          (content.startsWith('{') && content.includes('"status":"error"'))
        ) {
          // Preserve error details for self-correction (don't just say "error")
          const errorPreview = content.slice(0, 200);
          resultSummary = ` → ERROR: ${errorPreview}`;
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
   * Last-resort trimming: drop oldest messages to fit the budget.
   * Keeps at least the last 4 messages.
   */
  private trimToFitBudget(messages: LLMMessage[], budget: number): LLMMessage[] {
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
        result.push(msg);
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
      const searchResults = memory.search(query);
      const searchIds = new Set(searchResults.map(m => m.id));
      const combined = [...facts.filter(f => !searchIds.has(f.id)), ...searchResults];
      return combined.slice(0, this.config.memorySearchTopK * 2);
    }

    return facts;
  }
}
