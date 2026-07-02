/**
 * FTS5 full-text search types — result, query, and unified search interfaces.
 */

/** Source of a search result item. */
export type FtsResultSource = 'chat_message' | 'channel_message' | 'memory' | 'activity';

/** Input parameters for a full-text search query. */
export interface FtsSearchQuery {
  /** The search query string (required, minimum 2 characters). */
  query: string;
  /** Maximum number of results to return (default: 30, max: 100). */
  limit?: number;
  /** Optional source filter — restricts search to a specific source type. */
  source?: FtsResultSource | 'all';
  /** Optional agent ID filter — restricts search to a specific agent's data. */
  agentId?: string;
  /** Optional session ID filter — restricts search to a specific chat session. */
  sessionId?: string;
  /** Optional channel name filter — restricts search to a specific channel. */
  channel?: string;
}

/** A single result from a full-text search across messages. */
export interface FtsSearchResult {
  id: string;
  source: FtsResultSource;
  text: string;
  rank: number;
  /** For chat_message results: the session this message belongs to. */
  sessionId?: string;
  /** For chat_message results: agent who owns the session. */
  agentId?: string;
  /** For chat_message results: message role (user / assistant). */
  role?: string;
  /** For channel_message results: channel name. */
  channel?: string;
  /** For memory results: memory type (conversation / fact / task_result / note). */
  memoryType?: string;
  /** For activity results: activity type label. */
  activityType?: string;
  /** For activity results: associated task ID. */
  activityTaskId?: string;
  /** Human-readable sender or source name. */
  senderName?: string;
  createdAt: string;
}

/** Unified result wrapper returned by the search API. */
export interface FtsSearchResponse {
  results: FtsSearchResult[];
  total: number;
  /** The query that produced these results. */
  query: string;
}
