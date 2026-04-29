/**
 * memory-service.ts — Unified MemoryService facade
 *
 * Wraps SemanticMemory, EpisodicMemory, and ProceduralMemory into a single
 * service that the Agent and ContextEngine can use. Provides convenience
 * methods for common operations across all three layers.
 *
 * Architecture:
 *   MemoryService
 *     ├── SemanticMemory      — factual knowledge, MEMORY.md, observations
 *     ├── EpisodicMemory      — conversation sessions, messages
 *     └── loadProceduralMemory — skills, ROLE.md, HEARTBEAT.md (on-demand)
 */

import { createLogger, type LLMMessage } from '@markus/shared';
import { SemanticMemory } from './semantic-memory.js';
import { EpisodicMemory } from './episodic-memory.js';
import { loadProceduralMemory, refreshProceduralMemory } from './procedural-memory.js';
import type {
  ISemanticMemory,
  IEpisodicMemory,
  MemoryEntry,
  MemorySearchOptions,
  ConsolidationResult,
  MemoryStats,
  ConversationSession,
  ProceduralMemoryConfig,
  ProceduralMemory,
  SkillDef,
} from './interfaces.js';

const log = createLogger('memory-service');

// =============================================================================
// MemoryService
// =============================================================================

export interface MemoryServiceConfig {
  /** Directory for semantic memory (observations.json, MEMORY.md) */
  dataDir: string;
  /** Optional procedural memory config — if omitted, procedural loading is a no-op */
  proceduralConfig?: ProceduralMemoryConfig;
}

export interface AgentContext {
  semantic: {
    recentEntries: MemoryEntry[];
    knowledgeMd: string;
    stats: MemoryStats;
  };
  episodic: {
    activeSession: ConversationSession | undefined;
    recentSessions: ConversationSession[];
  };
}

export class MemoryService {
  public readonly semantic: ISemanticMemory;
  public readonly episodic: IEpisodicMemory;
  private proceduralConfig?: ProceduralMemoryConfig;

  constructor(config: MemoryServiceConfig) {
    this.semantic = new SemanticMemory({ dataDir: config.dataDir });
    this.episodic = new EpisodicMemory({ dataDir: config.dataDir });
    this.proceduralConfig = config.proceduralConfig;
    log.info('MemoryService initialized', { dataDir: config.dataDir });
  }

  // ---------------------------------------------------------------------------
  // Semantic convenience methods
  // ---------------------------------------------------------------------------

  /** Save a memory entry (delegates to SemanticMemory.save) */
  async memorySave(
    entry: Omit<MemoryEntry, 'id' | 'timestamp'> & { agentId?: string },
  ): Promise<MemoryEntry> {
    return this.semantic.save(entry);
  }

  /** Semantic search across entries */
  async memorySearch(
    query: string,
    opts?: MemorySearchOptions,
  ): Promise<MemoryEntry[]> {
    return this.semantic.search(query, opts);
  }

  /** List entries, optionally filtered by type */
  async memoryList(
    type?: MemoryEntry['type'],
    limit?: number,
  ): Promise<MemoryEntry[]> {
    return this.semantic.list(type, limit);
  }

  /** Remove entries by ID */
  async memoryRemove(ids: string[]): Promise<number> {
    return this.semantic.remove(ids);
  }

  // ---------------------------------------------------------------------------
  // Long-term memory (MEMORY.md)
  // ---------------------------------------------------------------------------

  /** Get full MEMORY.md content */
  async getKnowledgeMd(): Promise<string> {
    return this.semantic.getKnowledgeMd();
  }

  /** Get a specific section from MEMORY.md */
  async getSection(section: string): Promise<string | null> {
    return this.semantic.getSection(section);
  }

  /** Update or create a section in MEMORY.md */
  async updateSection(section: string, content: string): Promise<void> {
    return this.semantic.updateSection(section, content);
  }

  // ---------------------------------------------------------------------------
  // Episode / Session convenience methods
  // ---------------------------------------------------------------------------

  /** Prepare a new session for an agent */
  async prepareSession(agentId: string): Promise<ConversationSession> {
    return this.episodic.createSession(agentId);
  }

  /** Get or create a session */
  async getOrCreateSession(
    agentId: string,
    sessionId?: string,
  ): Promise<ConversationSession> {
    return this.episodic.getOrCreateSession(agentId, sessionId);
  }

  /** Append a message to a session */
  async appendMessage(
    sessionId: string,
    msg: LLMMessage,
  ): Promise<void> {
    return this.episodic.appendMessage(sessionId, msg);
  }

  /** Get recent messages from a session */
  async getRecentMessages(
    sessionId: string,
    limit?: number,
  ): Promise<LLMMessage[]> {
    return this.episodic.getRecentMessages(sessionId, limit);
  }

  /** Compact all sessions */
  async compactAllSessions(): Promise<{ compacted: number }> {
    const sessions = await this.episodic.listSessions();
    let compacted = 0;
    for (const s of sessions) {
      const result = await this.episodic.compactSession(s.id, 10);
      if (result.flushedCount > 0) compacted++;
    }
    return { compacted };
  }

  // ---------------------------------------------------------------------------
  // Consolidation
  // ---------------------------------------------------------------------------

  /** Merge duplicate observations, promote important ones to MEMORY.md */
  async consolidate(): Promise<ConsolidationResult> {
    return this.semantic.consolidate();
  }

  // ---------------------------------------------------------------------------
  // Procedural memory (on-demand)
  // ---------------------------------------------------------------------------

  /** Load procedural memory (ROLE.md, HEARTBEAT.md, skills) */
  async loadProcedural(): Promise<ProceduralMemory | null> {
    if (!this.proceduralConfig) {
      log.warn('Procedural config not set — cannot load procedural memory');
      return null;
    }
    return loadProceduralMemory(this.proceduralConfig);
  }

  /** Refresh procedural memory from disk */
  async refreshProcedural(): Promise<ProceduralMemory | null> {
    if (!this.proceduralConfig) {
      log.warn('Procedural config not set — cannot refresh procedural memory');
      return null;
    }
    return refreshProceduralMemory(this.proceduralConfig);
  }

  // ---------------------------------------------------------------------------
  // Agent context
  // ---------------------------------------------------------------------------

  /**
   * Build a full agent context snapshot by gathering data from all three
   * memory layers. This is designed for ContextEngine integration.
   */
  async getAgentContext(
    agentId: string,
    query?: string,
  ): Promise<AgentContext> {
    const [recentEntries, knowledgeMd, stats, activeSession, allSessions] =
      await Promise.all([
        this.semantic.search(query ?? '', { limit: 10 }).catch(() => []),
        this.semantic.getKnowledgeMd().catch(() => ''),
        this.semantic.getStats().catch(() => ({
          totalEntries: 0,
          byType: {},
          sizeBytes: 0,
          dataDir: '',
          agentId: '',
        })),
        this.episodic.getLatestSession(agentId).catch(() => undefined),
        this.episodic.listSessions(agentId).catch(() => []),
      ]);

    return {
      semantic: {
        recentEntries: recentEntries.slice(0, 10),
        knowledgeMd,
        stats,
      },
      episodic: {
        activeSession,
        recentSessions: allSessions.slice(0, 5),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /** Get semantic memory stats */
  async getStats(): Promise<MemoryStats> {
    return this.semantic.getStats();
  }
}
