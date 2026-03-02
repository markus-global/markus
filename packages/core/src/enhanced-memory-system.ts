import { MemoryStore, MemoryEntry, ConversationSession } from './memory/store.js';
import { createLogger } from '@markus/shared';
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

export class EnhancedMemorySystem {
  private baseStore: MemoryStore;
  private knowledgeBaseDir: string;
  private knowledgeIndex: Map<string, KnowledgeEntry> = new Map();
  private vectorStoreDir: string;
  
  constructor(dataDir: string) {
    this.baseStore = new MemoryStore(dataDir);
    this.knowledgeBaseDir = join(dataDir, 'knowledge-base');
    this.vectorStoreDir = join(dataDir, 'vector-store');
    
    mkdirSync(this.knowledgeBaseDir, { recursive: true });
    mkdirSync(this.vectorStoreDir, { recursive: true });
    
    this.loadKnowledgeBase();
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
        const content = msg.content.slice(0, 200);
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
        contextParts.push(`${msg.role}: ${msg.content.slice(0, 150)}`);
      });
    }
    
    // Get relevant knowledge if query provided
    if (query) {
      const relevantKnowledge = this.searchKnowledge({
        text: query,
        limit: 5,
      });
      
      if (relevantKnowledge.length > 0) {
        contextParts.push('\n## Relevant Knowledge');
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
  
  search(query: string): MemoryEntry[] {
    return this.baseStore.search(query);
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
  
  appendMessage(sessionId: string, message: any): void {
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