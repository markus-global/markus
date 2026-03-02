import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMMessage, RoleTemplate, IdentityContext } from '@markus/shared';
import { createLogger } from '@markus/shared';
import type { IMemoryStore, MemoryEntry } from './memory/types.js';

const log = createLogger('context-engine');

export interface ContextConfig {
  maxContextTokens: number;
  maxRecentMessages: number;
  summarizeThreshold: number;
  memorySearchTopK: number;
}

const DEFAULT_CONFIG: ContextConfig = {
  maxContextTokens: 100_000,
  maxRecentMessages: 40,
  summarizeThreshold: 60,
  memorySearchTopK: 5,
};

export interface OrgContext {
  orgName: string;
  teamName?: string;
  colleagues?: Array<{ name: string; role: string; id: string }>;
  projects?: Array<{ name: string; description: string }>;
  customContext?: string;
}

export class ContextEngine {
  private config: ContextConfig;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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
    /** Pre-built knowledge context from EnhancedMemorySystem.getAgentContext() */
    knowledgeContext?: string;
  }): string {
    const parts: string[] = [];

    // 1. Role definition (highest priority)
    parts.push(opts.role.systemPrompt);

    // 2. Identity & organizational awareness
    parts.push(this.buildIdentitySection(opts));

    // 3. Organization context from CONTEXT.md or OrgContext
    const orgCtx = this.buildOrgContextSection(opts.orgContext, opts.contextMdPath);
    if (orgCtx) parts.push(orgCtx);

    // 4. Policies
    if (opts.role.defaultPolicies.length > 0) {
      parts.push('\n## Policies');
      for (const policy of opts.role.defaultPolicies) {
        parts.push(`### ${policy.name}`);
        for (const rule of policy.rules) {
          parts.push(`- ${rule}`);
        }
      }
    }

    // 5. Long-term memory (MEMORY.md)
    const longTermMem = opts.memory.getLongTermMemory();
    if (longTermMem) {
      parts.push('\n## Long-term Knowledge');
      parts.push(longTermMem.slice(0, 3000));
    }

    // 6. Knowledge base context (from EnhancedMemorySystem if available)
    if (opts.knowledgeContext) {
      parts.push('\n## Knowledge Base');
      parts.push(opts.knowledgeContext.slice(0, 3000));
    }

    // 7. Relevant memories (fact-based retrieval)
    const relevantMemories = this.retrieveRelevantMemories(opts.memory, opts.currentQuery);
    if (relevantMemories.length > 0) {
      parts.push('\n## Relevant Memories');
      for (const mem of relevantMemories) {
        const ts = new Date(mem.timestamp).toLocaleDateString();
        parts.push(`- [${ts}] ${mem.content}`);
      }
    }

    // 7. Recent daily log summary (medium-term memory)
    const dailyLog = opts.memory.getRecentDailyLogs(1);
    if (dailyLog) {
      parts.push('\n## Recent Activity Summary');
      parts.push(dailyLog.slice(0, 1500));
    }

    // 8. Assigned tasks (task board context)
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
      parts.push('');
      parts.push('**MANDATORY RULE: Every piece of work you perform MUST be linked to a task.**');
      parts.push('- Before starting any work, check if an existing task covers it. If not, call `task_create` first.');
      parts.push('- Immediately after creating or identifying the relevant task, call `task_update` to set its status to `in_progress`.');
      parts.push('- When the work is complete, call `task_update` to mark it `completed`.');
      parts.push('- Never do meaningful work without a corresponding task entry.');
    } else {
      parts.push('\n## Task Management');
      parts.push('You have no tasks currently assigned.');
      parts.push('');
      parts.push('**MANDATORY RULE: Every piece of work you perform MUST be linked to a task.**');
      parts.push('- Before starting any work, call `task_create` to register the task, then immediately set it to `in_progress`.');
      parts.push('- Use `task_list` to check whether a relevant task already exists on the team board before creating a duplicate.');
      parts.push('- When complete, call `task_update` to mark the task `completed`.');
      parts.push('- Never do meaningful work without a corresponding task entry.');
    }

    // 10. Current conversation context
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

  prepareMessages(opts: {
    systemPrompt: string;
    sessionMessages: LLMMessage[];
    memory: IMemoryStore;
    sessionId: string;
  }): LLMMessage[] {
    let recentMessages = opts.sessionMessages;

    // Smart window management: if we have too many messages, summarize older ones
    if (recentMessages.length > this.config.summarizeThreshold) {
      log.info('Session exceeds threshold, triggering summarization', {
        messageCount: recentMessages.length,
        threshold: this.config.summarizeThreshold,
      });
      recentMessages = opts.memory.summarizeAndTruncate(
        opts.sessionId,
        this.config.maxRecentMessages,
      );
    }

    // Trim to max recent messages
    if (recentMessages.length > this.config.maxRecentMessages) {
      recentMessages = recentMessages.slice(-this.config.maxRecentMessages);
    }

    // Estimate token count and further trim if needed
    const estimatedTokens = this.estimateTokens(opts.systemPrompt, recentMessages);
    if (estimatedTokens > this.config.maxContextTokens) {
      const ratio = this.config.maxContextTokens / estimatedTokens;
      const targetMessages = Math.max(4, Math.floor(recentMessages.length * ratio));
      recentMessages = recentMessages.slice(-targetMessages);
      log.info('Trimmed messages to fit token budget', {
        originalTokens: estimatedTokens,
        targetMessages,
      });
    }

    // Sanitize: ensure no orphaned tool messages appear without their preceding tool_calls
    recentMessages = this.sanitizeMessageSequence(recentMessages);

    return [
      { role: 'system', content: opts.systemPrompt },
      ...recentMessages,
    ];
  }

  /**
   * Ensures every assistant+toolCalls message is followed by ALL its tool_result messages.
   * - Orphaned tool_result messages (no preceding toolCalls) are dropped.
   * - Incomplete assistant+toolCalls blocks (some tool_results trimmed away) are also dropped
   *   entirely — sending a partial sequence causes LLM API 400 errors.
   */
  private sanitizeMessageSequence(messages: LLMMessage[]): LLMMessage[] {
    const result: LLMMessage[] = [];

    // Buffer for an in-progress assistant+toolCalls block
    let pendingAssistant: LLMMessage | null = null;
    const pendingIds = new Set<string>();
    const collectedResults: LLMMessage[] = [];

    const flushPending = (drop = false) => {
      if (!pendingAssistant) return;
      if (!drop && pendingIds.size === 0) {
        // All tool_results arrived — safe to commit
        result.push(pendingAssistant, ...collectedResults);
      } else {
        log.debug('Dropping incomplete assistant toolCalls block', {
          missing: [...pendingIds],
        });
      }
      pendingAssistant = null;
      pendingIds.clear();
      collectedResults.length = 0;
    };

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // A new toolCalls block starts — flush any previous incomplete one first
        flushPending(true);
        pendingAssistant = msg;
        for (const tc of msg.toolCalls) pendingIds.add(tc.id);
      } else if (msg.role === 'tool') {
        if (pendingAssistant && msg.toolCallId && pendingIds.has(msg.toolCallId)) {
          pendingIds.delete(msg.toolCallId);
          collectedResults.push(msg);
          if (pendingIds.size === 0) flushPending(); // Complete — commit now
        } else {
          log.debug('Dropping orphaned tool message', { toolCallId: msg.toolCallId });
        }
      } else {
        // Any non-tool message while waiting for tool_results → block is incomplete
        flushPending(pendingIds.size > 0);
        result.push(msg);
      }
    }

    // End of messages — flush whatever remains
    flushPending(pendingIds.size > 0);

    return result;
  }

  private buildOrgContextSection(orgContext?: OrgContext, contextMdPath?: string): string | null {
    // Try loading CONTEXT.md file first
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

  private retrieveRelevantMemories(memory: IMemoryStore, query?: string): MemoryEntry[] {
    // Get recent facts
    const facts = memory.getEntries('fact', this.config.memorySearchTopK);

    // If there's a query, also search for relevant memories
    if (query) {
      const searchResults = memory.search(query);
      const searchIds = new Set(searchResults.map((m) => m.id));
      const combined = [...facts.filter((f) => !searchIds.has(f.id)), ...searchResults];
      return combined.slice(0, this.config.memorySearchTopK * 2);
    }

    return facts;
  }

  /**
   * Rough token estimation: ~4 chars per token for English, ~2 chars per token for CJK.
   * This is intentionally conservative to avoid overflowing the context window.
   */
  private estimateTokens(systemPrompt: string, messages: LLMMessage[]): number {
    let totalChars = systemPrompt.length;
    for (const msg of messages) {
      totalChars += msg.content.length + 20; // overhead per message
      if (msg.toolCalls) {
        totalChars += JSON.stringify(msg.toolCalls).length;
      }
    }
    // Use 3 chars per token as a middle ground
    return Math.ceil(totalChars / 3);
  }
}
