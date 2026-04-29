/**
 * memory/interfaces.ts — Three-layer memory system type definitions
 *
 * Based on Tulving's cognitive classification:
 * - Semantic Memory:  factual knowledge, MEMORY.md, observations
 * - Episodic Memory:  personal experiences, conversation sessions
 * - Procedural Memory: skills, ROLE.md, know-how
 */

import type { LLMMessage } from '@markus/shared';

// =============================================================================
// Shared types
// =============================================================================

/** A single memory entry in the semantic store */
export interface MemoryEntry {
  id: string;
  type: 'fact' | 'note' | 'observation' | 'task_result' | 'conversation';
  content: string;
  timestamp: string;
  /** Optional tags for discoverability */
  tags?: string[];
  /** Agent that owns this entry */
  agentId?: string;
  /** Source identifier (e.g. "memory_save", "consolidation", "migration") */
  source?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/** Options for the search() method */
export interface MemorySearchOptions {
  type?: MemoryEntry['type'];
  tags?: string[];
  agentId?: string;
  limit?: number;
  offset?: number;
}

/** Result of a consolidate() call */
export interface ConsolidationResult {
  /** Number of entries that were promoted to long-term (MEMORY.md) */
  promoted: number;
  /** Number of entries that were pruned/removed */
  pruned: number;
}

/** Stats snapshot of the semantic store */
export interface MemoryStats {
  totalEntries: number;
  byType: Record<string, number>;
  sizeBytes: number;
  dataDir: string;
  agentId: string;
}

// =============================================================================
// Semantic Memory — factual / declarative knowledge
// =============================================================================

export interface ISemanticMemory {
  /** Save a new memory entry. Auto-assigns id and timestamp. */
  save(entry: Omit<MemoryEntry, 'id' | 'timestamp'> & { agentId?: string }): Promise<MemoryEntry>;

  /** Semantic search across entries */
  search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]>;

  /** List all entries, optionally filtered by type */
  list(type?: MemoryEntry['type'], limit?: number): Promise<MemoryEntry[]>;

  /** Find entries by tag */
  getByTag(tag: string, limit?: number): Promise<MemoryEntry[]>;

  /** Remove entries by ID */
  remove(ids: string[]): Promise<number>;

  /** Atomically replace entries — used by consolidation */
  replace(
    removedIds: string[],
    newEntry: Omit<MemoryEntry, 'id' | 'timestamp'> & { agentId?: string },
  ): Promise<{ removed: MemoryEntry[]; created: MemoryEntry }>;

  /** Get full MEMORY.md content */
  getKnowledgeMd(): Promise<string>;

  /** Get a specific section from MEMORY.md */
  getSection(section: string): Promise<string | null>;

  /** Update or create a section in MEMORY.md */
  updateSection(section: string, content: string): Promise<void>;

  /** Merge duplicate observations, promote important ones to MEMORY.md */
  consolidate(opts?: { minSimilarity?: number; minCount?: number }): Promise<ConsolidationResult>;

  /** Get store statistics */
  getStats(): Promise<MemoryStats>;
}

// =============================================================================
// Episodic Memory — conversation sessions / experiences
// =============================================================================

export interface ConversationSession {
  id: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  summary?: string;
}

export interface IEpisodicMemory {
  // ---- Session lifecycle ------------------------------------------------

  /** Create a new session for an agent */
  createSession(agentId: string): Promise<ConversationSession>;

  /** Get an existing session or create one if it doesn't exist */
  getOrCreateSession(agentId: string, sessionId?: string): Promise<ConversationSession>;

  /** Get a session by ID */
  getSession(sessionId: string): Promise<ConversationSession | undefined>;

  /** List sessions, optionally filtered by agent */
  listSessions(agentId?: string): Promise<ConversationSession[]>;

  /** Get the most recent session for an agent */
  getLatestSession(agentId: string): Promise<ConversationSession | undefined>;

  // ---- Messages ---------------------------------------------------------

  /** Append a message to a session */
  appendMessage(sessionId: string, msg: LLMMessage): Promise<void>;

  /** Get the most recent messages from a session */
  getRecentMessages(sessionId: string, limit?: number): Promise<LLMMessage[]>;

  // ---- Compaction -------------------------------------------------------

  /** Compact old messages into a summary, keep only the most recent */
  compactSession(
    sessionId: string,
    keepLast?: number,
  ): Promise<{ summary: string; flushedCount: number }>;

  /** Summarize and truncate — returns the remaining messages */
  summarizeAndTruncate(sessionId: string, keepLast?: number): Promise<LLMMessage[]>;
}

// =============================================================================
// Procedural Memory — skills, ROLE.md, know-how
// =============================================================================

export interface ProceduralMemoryConfig {
  rolePath: string;
  heartbeatPath: string;
  skillPaths: string[];
  /** Additional directories to scan for skill manifests */
  additionalScanDirs?: string[];
}

export interface SkillDef {
  name: string;
  version?: string;
  description: string;
  triggers?: string[];
  handler?: string;
  /** Source file path (for tool loading) */
  sourcePath?: string;
}

export interface ProceduralMemory {
  /** Full ROLE.md content */
  role: string;
  /** Full HEARTBEAT.md content */
  heartbeat: string;
  /** List of discovered skills */
  skills: SkillDef[];
  /** Configuration used to load this memory */
  config: ProceduralMemoryConfig;
}
