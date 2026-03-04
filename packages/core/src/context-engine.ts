import { readFileSync, existsSync } from 'node:fs';
import { createLogger, type LLMMessage, type RoleTemplate, type IdentityContext } from '@markus/shared';
import type { IMemoryStore, MemoryEntry } from './memory/types.js';
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
  let tokens = tc.countMessageTokens(msg.content, msg.role);
  if (msg.toolCalls) tokens += tc.countTokens(JSON.stringify(msg.toolCalls));
  return tokens;
}

export class ContextEngine {
  private config: ContextConfig;
  private tokenCounter: TokenCounter;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = config?.tokenCounter ?? getDefaultTokenCounter();
  }

  buildSystemPrompt(opts: {
    agentId: string;
    agentName: string;
    role: RoleTemplate;
    orgContext?: OrgContext;
    contextMdPath?: string;
    memory: IMemoryStore;
    currentQuery?: string;
    identity?: IdentityContext;
    senderIdentity?: { id: string; name: string; role: string };
    assignedTasks?: Array<{ id: string; title: string; description: string; status: string; priority: string }>;
    knowledgeContext?: string;
    environment?: EnvironmentProfile;
  }): string {
    const parts: string[] = [];

    parts.push(opts.role.systemPrompt);
    parts.push(this.buildIdentitySection(opts));

    const orgCtx = this.buildOrgContextSection(opts.orgContext, opts.contextMdPath);
    if (orgCtx) parts.push(orgCtx);

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

    const relevantMemories = this.retrieveRelevantMemories(opts.memory, opts.currentQuery);
    if (relevantMemories.length > 0) {
      parts.push('\n## Relevant Memories');
      for (const mem of relevantMemories) {
        const ts = new Date(mem.timestamp).toLocaleDateString();
        parts.push(`- [${ts}] ${mem.content}`);
      }
    }

    const dailyLog = opts.memory.getRecentDailyLogs(1);
    if (dailyLog) {
      parts.push('\n## Recent Activity Summary');
      parts.push(dailyLog.slice(0, 1500));
    }

    if (opts.assignedTasks && opts.assignedTasks.length > 0) {
      const activeTasks = opts.assignedTasks.filter(t => !['completed', 'cancelled', 'failed'].includes(t.status));
      const doneTasks = opts.assignedTasks.filter(t => ['completed', 'cancelled', 'failed'].includes(t.status));
      parts.push('\n## Your Task Board');
      if (activeTasks.length > 0) {
        parts.push('### Active Tasks (work on these):');
        for (const t of activeTasks) {
          parts.push(`- [${t.status.toUpperCase()}] **${t.title}** (ID: \`${t.id}\`, priority: ${t.priority})`);
          if (t.description) parts.push(`  ${t.description.slice(0, 200)}`);
        }
      }
      if (doneTasks.length > 0) {
        parts.push(`### Completed/Closed (${doneTasks.length} tasks)`);
      }
    } else {
      parts.push('\n## Task Board');
      parts.push('No tasks currently assigned.');
    }

    parts.push('');
    parts.push('**Task Rule:** All work must be linked to a task. Use `task_create` → `task_update(in_progress)` → `task_update(completed)`. Check `task_list` before creating duplicates.');

    parts.push('\n## Memory & Tools');
    parts.push('- `memory_save` — Persist important facts/decisions. `memory_search` — Recall past context.');
    parts.push('- Save only meaningful information (preferences, decisions, outcomes). Skip trivial data.');

    if (opts.environment) {
      parts.push(this.buildEnvironmentSection(opts.environment));
    }

    if (opts.senderIdentity) {
      parts.push(`\n## Current Conversation`);
      parts.push(`You are now talking to **${opts.senderIdentity.name}** (${opts.senderIdentity.role}).`);
      if (opts.senderIdentity.role === 'owner') {
        parts.push('This person is the organization owner. Their instructions have the highest priority. Be proactive in reporting and responsive to their needs.');
      } else if (opts.senderIdentity.role === 'admin') {
        parts.push('This person is an administrator. Cooperate actively and share progress proactively.');
      } else if (opts.senderIdentity.role === 'guest') {
        parts.push('This person is an external guest. Be polite but cautious — do not expose internal sensitive information.');
      }
    }

    return parts.join('\n');
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
      lines.push(`- Position: ${self.agentRole === 'manager' ? 'Organization Manager — you lead the AI team' : 'Team Member'}`);
      if (self.skills.length > 0) {
        lines.push(`- Skills: ${self.skills.join(', ')}`);
      }
      lines.push(`- Organization: ${opts.identity.organization.name}`);
      lines.push(`- Agent ID: ${opts.agentId}`);
      lines.push(`- Current time: ${new Date().toISOString()}`);

      if (opts.identity.manager && opts.identity.self.agentRole !== 'manager') {
        lines.push(`\n### Your Manager`);
        lines.push(`- ${opts.identity.manager.name} (AI Organization Manager) — report progress and escalate issues to them`);
      }

      if (opts.identity.colleagues.length > 0) {
        lines.push(`\n### Your Colleagues`);
        for (const c of opts.identity.colleagues) {
          const statusTag = c.status ? ` [${c.status}]` : '';
          lines.push(`- ${c.name} (${c.role}, ${c.type})${statusTag}${c.skills?.length ? ` — skills: ${c.skills.join(', ')}` : ''}`);
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
        lines.push('1. **Routing** — When receiving vague messages, determine which team member should handle it');
        lines.push('2. **Coordination** — Assign tasks to the right agents based on their skills');
        lines.push('3. **Reporting** — Proactively report team progress to human stakeholders');
        lines.push('4. **Training** — Help new agents understand their roles and the organization context');
        lines.push('5. **Escalation** — Escalate issues that require human decision to the Owner');
      }
    } else {
      lines.push(`- Name: ${opts.agentName}`);
      lines.push(`- Role: ${opts.role.name}`);
      lines.push(`- Agent ID: ${opts.agentId}`);
      lines.push(`- Current time: ${new Date().toISOString()}`);
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
    toolDefinitions?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  }): LLMMessage[] {
    const contextWindow = opts.modelContextWindow ?? 64000;
    const maxOutput = opts.modelMaxOutput ?? 4096;

    const systemTokens = estimateTokens(opts.systemPrompt, this.tokenCounter);
    const toolDefTokens = opts.toolDefinitions
      ? estimateTokens(JSON.stringify(opts.toolDefinitions), this.tokenCounter)
      : 0;
    // Budget = contextWindow - system - tools - reply - safety margin (10%)
    const safetyMargin = Math.ceil(contextWindow * 0.10);
    const messageBudget = contextWindow - systemTokens - toolDefTokens - maxOutput - safetyMargin;

    if (messageBudget < 500) {
      log.warn('Very tight message budget', { contextWindow, systemTokens, toolDefTokens, maxOutput, messageBudget });
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
        remaining: messages.length, tokens: totalTokens, budget: messageBudget,
      });
    }

    log.debug('Context assembled', {
      contextWindow, messageBudget, messageTokens: totalTokens,
      systemTokens, toolDefTokens, messageCount: messages.length,
    });

    return [
      { role: 'system', content: opts.systemPrompt },
      ...messages,
    ];
  }

  /**
   * Shrink any individual message whose content exceeds `maxChars`.
   * Tool results get a short preview; user/assistant messages get tail-trimmed.
   */
  private shrinkOversizedMessages(messages: LLMMessage[], maxChars: number): LLMMessage[] {
    return messages.map(m => {
      if (m.content.length <= maxChars) return m;
      if (m.role === 'tool') {
        const preview = m.content.slice(0, 300);
        return { ...m, content: `[Compacted tool result: ${m.content.length} chars]\n${preview}...` };
      }
      // For user/assistant, keep the beginning (context is usually front-loaded)
      return { ...m, content: m.content.slice(0, maxChars) + `\n\n[... content trimmed from ${m.content.length} chars]` };
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
    budget: number,
  ): LLMMessage[] {
    const history = messages.slice(0, currentTurnStart);
    const currentTurn = messages.slice(currentTurnStart);

    const currentTurnTokens = this.sumTokens(currentTurn);
    let historyBudget = budget - currentTurnTokens;

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
   */
  private summarizeToolBlock(block: LLMMessage[]): LLMMessage {
    const assistant = block[0]!;
    const toolCalls = assistant.toolCalls ?? [];
    const toolResults = block.slice(1);

    const summaryParts: string[] = [];
    if (assistant.content?.trim()) {
      summaryParts.push(assistant.content.trim());
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const result = toolResults[i];
      const argsStr = JSON.stringify(tc.arguments).slice(0, 100);
      let resultSummary = '';
      if (result) {
        const content = result.content;
        if (content.startsWith('Error:') || content.startsWith('{') && content.includes('"status":"error"')) {
          resultSummary = ' → error';
        } else if (content.length <= 120) {
          resultSummary = ` → ${content}`;
        } else {
          resultSummary = ` → (${content.length} chars result)`;
        }
      }
      summaryParts.push(`[Used ${tc.name}(${argsStr})${resultSummary}]`);
    }

    return {
      role: 'assistant',
      content: `[Previous action summary] ${summaryParts.join(' ')}`,
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

    lines.push(`- Resources: ${env.resources.cpuCores} CPU cores, ${env.resources.memoryMB} MB RAM, ${env.resources.diskFreeMB} MB free disk`);

    const missing = ['git', 'node', 'docker', 'python3', 'java'].filter(
      name => !env.tools.some(t => t.name === name) && !env.runtimes.some(r => r.name === name),
    );
    if (missing.length > 0) {
      lines.push(`- NOT available: ${missing.join(', ')}. Do not attempt commands that require these.`);
    }

    return lines.join('\n');
  }

  private retrieveRelevantMemories(memory: IMemoryStore, query?: string): MemoryEntry[] {
    const facts = memory.getEntries('fact', this.config.memorySearchTopK);

    if (query) {
      const searchResults = memory.search(query);
      const searchIds = new Set(searchResults.map((m) => m.id));
      const combined = [...facts.filter((f) => !searchIds.has(f.id)), ...searchResults];
      return combined.slice(0, this.config.memorySearchTopK * 2);
    }

    return facts;
  }
}
