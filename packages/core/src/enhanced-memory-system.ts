import { MemoryStore } from './memory/store.js';
import type { IMemoryStore, MemoryEntry, ConversationSession } from './memory/types.js';
import { createLogger, getTextContent, type LLMMessage } from '@markus/shared';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const log = createLogger('enhanced-memory');

export interface KnowledgeEntry {
  id: string;
  timestamp: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  text?: string;
  category?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface MemorySummary {
  totalEntries: number;
  totalSessions: number;
  knowledgeBaseSize: number;
  recentActivity: MemoryEntry[];
  topCategories: Array<{category: string, count: number}>;
}

export interface OpenClawMemoryConfig {
  shortTerm?: number;
  mediumTerm?: number;
  longTerm?: number;
  knowledgeBase?: boolean;
  contextWindow?: number;
}

export class EnhancedMemorySystem implements IMemoryStore {
  private baseStore: MemoryStore;
  private knowledgeBaseDir: string;
  private knowledgeIndex: Map<string, KnowledgeEntry> = new Map();
  private vectorStoreDir: string;
  private memoryConfig: OpenClawMemoryConfig;
  
  constructor(dataDir: string, memoryConfig?: OpenClawMemoryConfig) {
    this.baseStore = new MemoryStore(dataDir);
    this.knowledgeBaseDir = join(dataDir, 'knowledge-base');
    this.vectorStoreDir = join(dataDir, 'vector-store');
    this.memoryConfig = memoryConfig || {};
    
    mkdirSync(this.knowledgeBaseDir, { recursive: true });
    mkdirSync(this.vectorStoreDir, { recursive: true });
    
    this.loadKnowledgeBase();
    
    // Apply memory configuration if provided
    this.applyMemoryConfig();
  }

  /**
   * Apply OpenClaw memory configuration to the memory system
   */
  private applyMemoryConfig(): void {
    const config = this.memoryConfig;
    
    if (config.shortTerm) {
      log.info(`Setting short-term memory limit to ${config.shortTerm} tokens`);
      // TODO: Implement short-term memory limit
    }
    
    if (config.mediumTerm) {
      log.info(`Setting medium-term memory limit to ${config.mediumTerm} tokens`);
      // TODO: Implement medium-term memory limit
    }
    
    if (config.longTerm) {
      log.info(`Setting long-term memory limit to ${config.longTerm} tokens`);
      // TODO: Implement long-term memory limit
    }
    
    if (config.contextWindow) {
      log.info(`Setting context window to ${config.contextWindow} tokens`);
      // TODO: Implement context window limit
    }
    
    if (config.knowledgeBase !== undefined) {
      log.info(`Knowledge base enabled: ${config.knowledgeBase}`);
      // Knowledge base is already loaded in constructor
    }
  }
  
  // --- Enhanced Memory Operations ---
  
  /**
   * Add knowledge entry to the knowledge base
   */
  addKnowledge(entry: Omit<KnowledgeEntry, 'id' | 'timestamp'>): KnowledgeEntry {
    const fullEntry: KnowledgeEntry = {
      ...entry,
      id: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };
    
    this.knowledgeIndex.set(fullEntry.id, fullEntry);
    this.saveKnowledgeEntry(fullEntry);
    
    log.debug('Knowledge entry added', { 
      id: fullEntry.id, 
      category: fullEntry.category,
      title: fullEntry.title 
    });
    
    return fullEntry;
  }
  
  /**
   * Search knowledge base with flexible querying
   */
  searchKnowledge(query: MemoryQuery): KnowledgeEntry[] {
    let results = Array.from(this.knowledgeIndex.values());
    
    // Filter by category
    if (query.category) {
      results = results.filter(entry => 
        entry.category.toLowerCase().includes(query.category!.toLowerCase())
      );
    }
    
    // Filter by tags
    if (query.tags && query.tags.length > 0) {
      results = results.filter(entry =>
        query.tags!.some(tag => entry.tags.includes(tag))
      );
    }
    
    // Filter by text content
    if (query.text) {
      const searchText = query.text.toLowerCase();
      results = results.filter(entry =>
        entry.title.toLowerCase().includes(searchText) ||
        entry.content.toLowerCase().includes(searchText) ||
        entry.tags.some(tag => tag.toLowerCase().includes(searchText))
      );
    }
    
    // Apply pagination
    const offset = query.offset || 0;
    const limit = query.limit || 50;
    results = results.slice(offset, offset + limit);
    
    return results;
  }
  
  /**
   * Get memory summary for dashboard/reporting
   */
  getMemorySummary(): MemorySummary {
    const entries = this.baseStore.getEntries();
    const sessions = this.baseStore.listSessions();
    const knowledgeEntries = Array.from(this.knowledgeIndex.values());
    
    // Calculate top categories
    const categoryCount = new Map<string, number>();
    knowledgeEntries.forEach(entry => {
      const count = categoryCount.get(entry.category) || 0;
      categoryCount.set(entry.category, count + 1);
    });
    
    const topCategories = Array.from(categoryCount.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    return {
      totalEntries: entries.length,
      totalSessions: sessions.length,
      knowledgeBaseSize: knowledgeEntries.length,
      recentActivity: entries.slice(-10).reverse(),
      topCategories,
    };
  }
  
  /**
   * Compact and summarize old conversations (OpenClaw pattern)
   */
  compactOldConversations(maxMessagesPerSession: number = 50): number {
    const sessions = this.baseStore.listSessions();
    let compactedCount = 0;
    
    for (const session of sessions) {
      if (session.messages.length > maxMessagesPerSession * 1.5) {
        // Extract key information from old messages
        const oldMessages = session.messages.slice(0, -maxMessagesPerSession);
        const summary = this.createConversationSummary(oldMessages);
        
        // Add summary to knowledge base
        this.addKnowledge({
          category: 'conversation_summary',
          title: `Conversation Summary: ${session.id}`,
          content: summary,
          tags: ['conversation', 'summary', session.agentId],
          source: 'auto-compact',
          metadata: {
            sessionId: session.id,
            agentId: session.agentId,
            originalMessageCount: oldMessages.length,
            compactedAt: new Date().toISOString(),
          },
        });
        
        // Remove old messages from session
        session.messages = session.messages.slice(-maxMessagesPerSession);
        this.saveSession(session);
        
        compactedCount++;
        log.info('Compacted conversation', { 
          sessionId: session.id, 
          messagesRemoved: oldMessages.length,
          messagesRemaining: session.messages.length 
        });
      }
    }
    
    return compactedCount;
  }
  
  /**
   * Create a summary from conversation messages
   */
  private createConversationSummary(messages: any[]): string {
    const summaryParts: string[] = [];
    let currentTopic = '';
    let messageCount = 0;
    
    for (const msg of messages) {
      if (msg.role === 'user') {
        const content = getTextContent(msg.content).slice(0, 200);
        if (content !== currentTopic) {
          summaryParts.push(`User asked about: ${content}`);
          currentTopic = content;
        }
        messageCount++;
      } else if (msg.role === 'assistant') {
        messageCount++;
      }
    }
    
    return `Summary of ${messageCount} messages:\n${summaryParts.join('\n')}`;
  }
  
  /**
   * Get context for agent based on current conversation and relevant knowledge
   */
  getAgentContext(agentId: string, query?: string): string {
    const contextParts: string[] = [];
    
    // Get recent conversations
    const latestSession = this.baseStore.getLatestSession(agentId);
    if (latestSession && latestSession.messages.length > 0) {
      const recentMessages = latestSession.messages.slice(-10);
      contextParts.push('## Recent Conversation');
      recentMessages.forEach(msg => {
        contextParts.push(`${msg.role}: ${getTextContent(msg.content).slice(0, 150)}`);
      });
    }
    
    // Get relevant knowledge if query provided
    if (query) {
      const relevantKnowledge = this.searchKnowledge({
        text: query,
        limit: 5,
      });
      
      if (relevantKnowledge.length > 0) {
        contextParts.push('\n## Relevant Deliverables');
        relevantKnowledge.forEach(kb => {
          contextParts.push(`### ${kb.title}`);
          contextParts.push(kb.content.slice(0, 200));
          if (kb.tags.length > 0) {
            contextParts.push(`Tags: ${kb.tags.join(', ')}`);
          }
        });
      }
    }
    
    // Get long-term memory
    const longTermMemory = this.baseStore.getLongTermMemory();
    if (longTermMemory) {
      contextParts.push('\n## Long-term Memory');
      // Take first 500 chars of long-term memory
      contextParts.push(longTermMemory.slice(0, 500) + '...');
    }
    
    return contextParts.join('\n\n');
  }
  
  // --- Proxy methods to base MemoryStore ---
  
  addEntry(entry: MemoryEntry): void {
    this.baseStore.addEntry(entry);
  }
  
  getEntries(type?: MemoryEntry['type'], limit?: number): MemoryEntry[] {
    return this.baseStore.getEntries(type, limit);
  }

  getEntriesByTag(tag: string, limit?: number): MemoryEntry[] {
    return this.baseStore.getEntriesByTag(tag, limit);
  }
  
  search(query: string): MemoryEntry[] {
    return this.baseStore.search(query);
  }

  removeEntries(ids: string[]): number {
    return this.baseStore.removeEntries(ids);
  }

  replaceEntries(removedIds: string[], newEntry: MemoryEntry): void {
    this.baseStore.replaceEntries(removedIds, newEntry);
  }

  getSession(sessionId: string): ConversationSession | undefined {
    return this.baseStore.getSession(sessionId);
  }
  
  listSessions(agentId?: string): ConversationSession[] {
    return this.baseStore.listSessions(agentId);
  }
  
  getLatestSession(agentId: string): ConversationSession | undefined {
    return this.baseStore.getLatestSession(agentId);
  }
  
  createSession(agentId: string): ConversationSession {
    return this.baseStore.createSession(agentId);
  }

  getOrCreateSession(agentId: string, sessionId: string): ConversationSession {
    return this.baseStore.getOrCreateSession(agentId, sessionId);
  }

  appendMessage(sessionId: string, message: LLMMessage): void {
    this.baseStore.appendMessage(sessionId, message);
  }
  
  getRecentDailyLogs(days: number = 7): string {
    return this.baseStore.getRecentDailyLogs(days);
  }
  
  addLongTermMemory(key: string, content: string): void {
    this.baseStore.addLongTermMemory(key, content);
  }
  
  getLongTermMemory(): string {
    return this.baseStore.getLongTermMemory();
  }

  getLongTermSection(sectionName: string): string {
    return this.baseStore.getLongTermSection(sectionName);
  }

  getRecentMessages(sessionId: string, limit: number): LLMMessage[] {
    return this.baseStore.getRecentMessages(sessionId, limit);
  }

  writeDailyLog(agentId: string, summary: string): void {
    this.baseStore.writeDailyLog(agentId, summary);
  }

  getDailyLog(date?: string): string {
    return this.baseStore.getDailyLog(date);
  }

  compactSession(sessionId: string, keepLast?: number): { summary: string; flushedCount: number } {
    return this.baseStore.compactSession(sessionId, keepLast);
  }

  summarizeAndTruncate(sessionId: string, keepLast: number): LLMMessage[] {
    return this.baseStore.summarizeAndTruncate(sessionId, keepLast);
  }

  /**
   * Get memory statistics with OpenClaw configuration limits
   */
  getMemoryStats(): {
    totalEntries: number;
    totalSessions: number;
    knowledgeBaseSize: number;
    configLimits: OpenClawMemoryConfig;
    usage: {
      shortTermUsage?: number;
      mediumTermUsage?: number;
      longTermUsage?: number;
      contextWindowUsage?: number;
    };
  } {
    const entries = this.baseStore.getEntries();
    const sessions = this.baseStore.listSessions();
    const knowledgeBaseSize = this.knowledgeIndex.size;

    // Calculate usage based on configuration
    const usage = {
      shortTermUsage: this.memoryConfig.shortTerm ? 
        Math.min(entries.length, this.memoryConfig.shortTerm) : undefined,
      mediumTermUsage: this.memoryConfig.mediumTerm ? 
        Math.min(sessions.length, this.memoryConfig.mediumTerm) : undefined,
      longTermUsage: this.memoryConfig.longTerm ? 
        Math.min(knowledgeBaseSize, this.memoryConfig.longTerm) : undefined,
      contextWindowUsage: undefined // Would need to track token usage
    };

    return {
      totalEntries: entries.length,
      totalSessions: sessions.length,
      knowledgeBaseSize,
      configLimits: { ...this.memoryConfig },
      usage
    };
  }

  /**
   * Check if memory usage is within configured limits
   */
  isWithinMemoryLimits(): boolean {
    const stats = this.getMemoryStats();
    const config = this.memoryConfig;

    if (config.shortTerm && stats.totalEntries > config.shortTerm) {
      return false;
    }

    if (config.mediumTerm && stats.totalSessions > config.mediumTerm) {
      return false;
    }

    if (config.longTerm && stats.knowledgeBaseSize > config.longTerm) {
      return false;
    }

    return true;
  }

  /**
   * Apply memory limits by trimming old entries if needed
   */
  applyMemoryLimits(): void {
    const config = this.memoryConfig;
    
    // TODO: Implement actual trimming logic based on configuration
    // For now, just log warnings if limits are exceeded
    const stats = this.getMemoryStats();
    
    if (config.shortTerm && stats.totalEntries > config.shortTerm) {
      log.warn(`Short-term memory limit exceeded: ${stats.totalEntries} > ${config.shortTerm}`);
    }
    
    if (config.mediumTerm && stats.totalSessions > config.mediumTerm) {
      log.warn(`Medium-term memory limit exceeded: ${stats.totalSessions} > ${config.mediumTerm}`);
    }
    
    if (config.longTerm && stats.knowledgeBaseSize > config.longTerm) {
      log.warn(`Long-term memory limit exceeded: ${stats.knowledgeBaseSize} > ${config.longTerm}`);
    }
  }
  
  // --- Private helper methods ---
  
  private loadKnowledgeBase(): void {
    try {
      const indexPath = join(this.knowledgeBaseDir, 'index.json');
      if (existsSync(indexPath)) {
        const indexData = JSON.parse(readFileSync(indexPath, 'utf-8'));
        indexData.forEach((entry: KnowledgeEntry) => {
          this.knowledgeIndex.set(entry.id, entry);
        });
        log.debug('Knowledge base loaded', { count: this.knowledgeIndex.size });
      }
    } catch (error) {
      log.error('Failed to load knowledge base', { error });
    }
  }
  
  private saveKnowledgeEntry(entry: KnowledgeEntry): void {
    try {
      // Save individual entry
      const entryPath = join(this.knowledgeBaseDir, `${entry.id}.json`);
      writeFileSync(entryPath, JSON.stringify(entry, null, 2));
      
      // Update index
      this.saveKnowledgeIndex();
    } catch (error) {
      log.error('Failed to save knowledge entry', { error, entryId: entry.id });
    }
  }
  
  private saveKnowledgeIndex(): void {
    try {
      const indexPath = join(this.knowledgeBaseDir, 'index.json');
      const indexData = Array.from(this.knowledgeIndex.values());
      writeFileSync(indexPath, JSON.stringify(indexData, null, 2));
    } catch (error) {
      log.error('Failed to save knowledge index', { error });
    }
  }
  
  private saveSession(session: ConversationSession): void {
    // This would need to be implemented based on MemoryStore's internal methods
    // For now, we'll rely on the base store's debounced saving
    log.debug('Session updated', { sessionId: session.id });
  }
}