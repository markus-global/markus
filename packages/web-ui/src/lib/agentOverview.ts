/**
 * Derivation logic for the agent overview panel, kept pure so it can be tested
 * without a DOM.
 *
 * The panel used to render whatever `AgentDetail` happened to carry, which
 * produced two numbers that were wrong on the live org:
 *
 * - "Tokens Today" rendered `agent.state.tokensUsedToday` and read **0** for an
 *   agent whose persisted counter held 104,450,959 for the same day. A zero is
 *   indistinguishable from "no work today", so it silently misinformed.
 * - The storage block relabelled buckets it did not own (`memory` for what is
 *   actually `sessions/`) and summed a hand-picked subset to produce a headline
 *   that was not the directory total.
 *
 * Both fixes are selection rules rather than formatting, so they live here
 * instead of inline in JSX.
 */

/** The subset of {@link AgentUsageInfo} this panel needs. */
export interface OverviewUsageCounters {
  tokensUsedToday?: number;
  totalTokens?: number;
  requestCount?: number;
  toolCalls?: number;
}

export interface StorageBucket {
  name: string;
  size: number;
}

/** The subset of `StorageAgentItem` this panel needs. */
export interface OverviewStorageUsage {
  size?: number;
  subItems?: StorageBucket[];
  /**
   * Set by the server when the directory walk hit its depth cap, i.e. `size` is
   * a lower bound. Rendering a bounded walk as an exact figure is how
   * `workspace/` came to display 109 MB against 309 MB on disk.
   */
  depthLimited?: boolean;
}

/**
 * Resolve the figure to display as "tokens today".
 *
 * Prefers the usage endpoint's counter over the value carried on the agent
 * detail, because only the former is the persisted daily counter that the usage
 * page and billing already read, and it rolls over on a real date boundary
 * (`todayCutoffDate` inside the metrics collector) rather than on a scheduler
 * tick. The agent-detail counter is process-local and restored from a database
 * row, so it can read 0 while real usage exists — the failure that motivated
 * this function.
 *
 * The agent-detail value is still used as a fallback so the panel shows
 * something sensible before `/api/usage/agents` resolves.
 */
export function resolveTokensToday(
  usage: OverviewUsageCounters | null | undefined,
  agentStateTokensToday: number | undefined,
): number {
  if (usage && typeof usage.tokensUsedToday === 'number' && Number.isFinite(usage.tokensUsedToday)) {
    return usage.tokensUsedToday;
  }
  return typeof agentStateTokensToday === 'number' && Number.isFinite(agentStateTokensToday)
    ? agentStateTokensToday
    : 0;
}

/**
 * Buckets worth rendering: non-empty, largest first.
 *
 * Sorting is explicit rather than inherited from the server so a future change
 * to server ordering cannot reshuffle the UI. Zero-byte buckets are dropped
 * because an agent that has never run still has an empty `role/` and a row of
 * `0 B` tells the reader nothing.
 */
export function visibleStorageBuckets(subItems: StorageBucket[] | undefined): StorageBucket[] {
  if (!subItems) return [];
  return subItems
    .filter(b => b && typeof b.size === 'number' && b.size > 0)
    .slice()
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

/**
 * Buckets we ship a translated label for. Everything else falls back to the
 * directory name, which is the point of the server change: labels are the real
 * entry names, so a new directory shows up named correctly instead of being
 * silently omitted (or, worse, shown under someone else's name).
 */
const TRANSLATED_BUCKETS = new Set([
  'workspace',
  'sessions',
  'tool-outputs',
  'daily-logs',
  'role',
  'subagent-logs',
  'worktrees',
]);

/** i18n key for a bucket, or `null` to render the raw directory name. */
export function storageBucketLabelKey(name: string): string | null {
  return TRANSLATED_BUCKETS.has(name)
    ? `agent:profilePage.overview.storageBuckets.${name}`
    : null;
}

// ─── Process status presentation ─────────────────────────────────────────────

export type AgentStatusTone = 'ok' | 'busy' | 'warn' | 'danger' | 'muted';

export interface AgentStatusPresentation {
  tone: AgentStatusTone;
  /** Tailwind classes for the status dot. */
  dotClass: string;
  /** Tailwind classes for a pill/chip (background + border). */
  chipClass: string;
  /** Tailwind classes for the label text. */
  textClass: string;
  /** i18n key under `common:`, or `null` when the status is unrecognised. */
  labelKey: string | null;
  /** True only while the process is up — i.e. it can still do work. */
  running: boolean;
}

const STATUS_TABLE: Record<string, AgentStatusPresentation> = {
  idle: {
    tone: 'ok', dotClass: 'bg-green-400', running: true,
    chipClass: 'bg-green-500/10 border border-green-500/20', textClass: 'text-green-600',
    labelKey: 'common:status.idle',
  },
  working: {
    tone: 'busy', dotClass: 'bg-blue-400 animate-pulse', running: true,
    chipClass: 'bg-blue-500/10 border border-blue-500/20', textClass: 'text-blue-500',
    labelKey: 'common:status.working',
  },
  error: {
    tone: 'danger', dotClass: 'bg-red-400 animate-pulse', running: true,
    chipClass: 'bg-red-500/10 border border-red-500/20', textClass: 'text-red-500',
    labelKey: 'common:status.error',
  },
  paused: {
    tone: 'warn', dotClass: 'bg-amber-400', running: false,
    chipClass: 'bg-amber-500/10 border border-amber-500/20', textClass: 'text-amber-600',
    labelKey: 'common:status.paused',
  },
  offline: {
    tone: 'muted', dotClass: 'bg-gray-400', running: false,
    chipClass: 'bg-gray-500/10 border border-border-default', textClass: 'text-fg-tertiary',
    labelKey: 'common:status.offline',
  },
};

/**
 * Single source of truth for how a process status is presented.
 *
 * The chat header badge and the profile page each used to derive their own dot
 * colour and label from `agent.state.status`, and neither derivation had an
 * `offline` branch: a stopped agent fell through to the green "idle" default, so
 * the UI insisted the agent was idle — i.e. running — immediately after it was
 * stopped. Two independent derivations could also disagree with each other. One
 * table means a status can only be mis-rendered in a single place, and the
 * regression is unit-testable without a DOM.
 *
 * An unrecognised status keeps the muted styling but reports `labelKey: null`,
 * so callers render the raw value instead of quietly claiming "offline".
 */
export function agentStatusPresentation(status: string | null | undefined): AgentStatusPresentation {
  const known = status ? STATUS_TABLE[status] : undefined;
  if (known) return known;
  return { ...STATUS_TABLE.offline!, labelKey: null };
}

// ─── Recent activity rows ────────────────────────────────────────────────────

/**
 * How many rows an overview activity card shows before deferring to its total.
 * The card header keeps the honest total, so the body can stay short.
 */
export const OVERVIEW_ACTIVITY_LIMIT = 5;

/**
 * Newest-first, capped view of an activity list.
 *
 * `/api/agents/:id/recent-activities` returns `liveActivities()`, which sorts
 * **ascending** by `startedAt` (the server's own `getCurrentActivity()` reads the
 * *last* element as the current one). Rendering that array directly put the
 * oldest entry at the top of a card titled "最近心跳" — the opposite of what the
 * title promises. The same array was also rendered in full while the header was
 * labelled with that same length, so the label said nothing and the page grew
 * with the agent's history.
 *
 * `total` is the untruncated length, which is what the card header should show.
 */
export function recentActivityRows<T extends { startedAt: string }>(
  list: T[] | undefined | null,
  limit: number = OVERVIEW_ACTIVITY_LIMIT,
): { shown: T[]; total: number } {
  const all = Array.isArray(list) ? list : [];
  const sorted = all
    .slice()
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return { shown: sorted.slice(0, Math.max(0, limit)), total: all.length };
}
