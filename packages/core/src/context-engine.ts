import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMMessage, RoleTemplate } from '@markus/shared';
import { createLogger } from '@markus/shared';
import type { MemoryStore, MemoryEntry } from './memory/store.js';

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
    memory: MemoryStore;
    currentQuery?: string;
  }): string {
    const parts: string[] = [];

    // 1. Role definition (highest priority)
    parts.push(opts.role.systemPrompt);

    // 2. Organization context from CONTEXT.md or OrgContext
    const orgCtx = this.buildOrgContextSection(opts.orgContext, opts.contextMdPath);
    if (orgCtx) parts.push(orgCtx);

    // 3. Policies
    if (opts.role.defaultPolicies.length > 0) {
      parts.push('\n## Policies');
      for (const policy of opts.role.defaultPolicies) {
        parts.push(`### ${policy.name}`);
        for (const rule of policy.rules) {
          parts.push(`- ${rule}`);
        }
      }
    }

    // 4. Long-term memory (MEMORY.md)
    const longTermMem = opts.memory.getLongTermMemory();
    if (longTermMem) {
      parts.push('\n## Long-term Knowledge');
      parts.push(longTermMem.slice(0, 3000));
    }

    // 5. Relevant memories (fact-based retrieval)
    const relevantMemories = this.retrieveRelevantMemories(opts.memory, opts.currentQuery);
    if (relevantMemories.length > 0) {
      parts.push('\n## Relevant Memories');
      for (const mem of relevantMemories) {
        const ts = new Date(mem.timestamp).toLocaleDateString();
        parts.push(`- [${ts}] ${mem.content}`);
      }
    }

    // 6. Recent daily log summary (medium-term memory)
    const dailyLog = opts.memory.getRecentDailyLogs(1);
    if (dailyLog) {
      parts.push('\n## Recent Activity Summary');
      parts.push(dailyLog.slice(0, 1500));
    }

    // 7. Agent identity
    parts.push('\n## Agent Identity');
    parts.push(`- Name: ${opts.agentName}`);
    parts.push(`- Role: ${opts.role.name}`);
    parts.push(`- Agent ID: ${opts.agentId}`);
    parts.push(`- Current time: ${new Date().toISOString()}`);

    return parts.join('\n');
  }

  prepareMessages(opts: {
    systemPrompt: string;
    sessionMessages: LLMMessage[];
    memory: MemoryStore;
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
   * Ensures tool role messages always follow an assistant message with toolCalls.
   * Orphaned tool messages (from trimming) are dropped to prevent LLM API errors.
   */
  private sanitizeMessageSequence(messages: LLMMessage[]): LLMMessage[] {
    const result: LLMMessage[] = [];
    const pendingToolCallIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          pendingToolCallIds.add(tc.id);
        }
        result.push(msg);
      } else if (msg.role === 'tool') {
        if (msg.toolCallId && pendingToolCallIds.has(msg.toolCallId)) {
          pendingToolCallIds.delete(msg.toolCallId);
          result.push(msg);
        } else {
          log.debug('Dropping orphaned tool message', { toolCallId: msg.toolCallId });
        }
      } else {
        result.push(msg);
      }
    }

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

  private retrieveRelevantMemories(memory: MemoryStore, query?: string): MemoryEntry[] {
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
