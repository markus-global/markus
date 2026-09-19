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

/** The presentation shown while an agent is actively producing output. */
export const WORKING_STATUS: AgentStatusPresentation = STATUS_TABLE.working!;

/**
 * Effective presentation for an agent, folding in a *streaming* signal.
 *
 * `agent.status` and "is this agent streaming a reply right now" are two
 * different clocks. The server only flips the process status to `working` for
 * long-running work it knows about, and it lags a chat reply (often staying
 * `idle` for the whole answer); the client, meanwhile, knows the instant a
 * stream opens (chatStore). Deriving the chat-header chip from `agent.status`
 * alone therefore made the header claim "空闲" while the L1 sidebar — which did
 * fold in the streaming set — said "工作中", for the same agent at the same
 * instant. Every surface now goes through this one resolver.
 *
 * Authoritative stop still wins: an offline / paused agent can never be busy,
 * even if a stale streaming mark survived a missed endStream. Likewise an agent
 * in `error` keeps its red chip — "it crashed" is more useful than "it's busy".
 */
export function resolveAgentStatus(
  status: string | null | undefined,
  streaming: boolean,
): AgentStatusPresentation {
  const base = agentStatusPresentation(status);
  if (!streaming) return base;
  // Not running (offline / paused), or already carrying a stronger signal.
  if (!base.running || base.tone === 'danger' || base.tone === 'busy') return base;
  return WORKING_STATUS;
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

// ─── Recent activity: which source, and which type means what ────────────────

/**
 * How many persisted activity rows the 最近活动 panel pulls before it splits them
 * into groups. One fetch, then filter locally — asking the server once per type
 * would make the two lists disagree about their window (two queries, two instants).
 */
export const RECENT_ACTIVITY_FETCH_LIMIT = 100;

/**
 * Split persisted activity history into the two groups the panel shows.
 *
 * 【为什么 A2A 组只认 'a2a'，不认 'chat'】旧实现在内存活动上过滤 `type === 'chat'`，
 * 于是「最近 A2A 通信」这一栏列出的其实是**和人类的对话**（label 形如
 * "Chat with …"），而真正 sourceType='a2a_message' 的活动（库里 331 条）被静默丢掉。
 * 两个类型是不同的东西，不能互换：'chat' = 老板/人类发起，'a2a' = 同事 agent 发起。
 * 人类会话在「聊天」tab 里有完整历史，这里重复列一遍只会让标题说谎。
 */
export function splitRecentActivity<T extends { type: string }>(
  list: T[] | undefined | null,
): { heartbeats: T[]; comms: T[] } {
  const all = Array.isArray(list) ? list : [];
  return {
    heartbeats: all.filter(a => a.type === 'heartbeat'),
    comms: all.filter(a => a.type === 'a2a'),
  };
}

// ─── Overview sections (sub-tabs) ────────────────────────────────────────────

/**
 * The overview's grouped bodies. They render as **sub-tabs**, not collapsible
 * blocks.
 *
 * 【为什么从折叠块改成子 tab】折叠块要求「展开 A → 看完 → 收起 A → 向下滚很远 →
 * 展开 B」：分组越多越痛，看第二组之前先做两次无意义操作，滚动位置还得重新找。
 * 子 tab 让每一组都在一次点击之外，且当前组始终出现在同一个位置。
 *
 * 【顺序 = 信息意图的排序，不是遥测优先】首屏回答「这个 agent 是谁、在干什么」，
 * 统计数字回答「它烧了多少」，后者是偶发好奇、不是每次打开都要看的东西——所以
 * `files` 打头（人设 / 心跳 / 长期记忆 / 工作记忆：改人设、查记忆都会先来这里），
 * `usage` 殿后。「用量」不是被删掉，是退到后面：首屏已经有一行紧凑的用量概览，
 * 需要细节时多点一次即可。
 */
export type OverviewSectionId = 'files' | 'mind' | 'recent' | 'tools' | 'memory' | 'usage';

/**
 * Canonical order of the overview sub-tabs. The page maps over this array, so the
 * bar and the panels cannot disagree about which groups exist — an i18n label that
 * is missing for one of these ids is a visible defect, not a silent omission.
 *
 * 【顺序即首屏】子 tab 栅按此数组渲染，所以「哪个是打开时的默认组」由
 * `DEFAULT_OVERVIEW_SECTION`（= 第一项）决定，而不是另写一份顺序——两处顺序
 * 一旦各写一遍，迟早会出现「默认高亮的是第 4 个」这类只有肉眼能发现的错位。
 */
export const OVERVIEW_SECTION_IDS: readonly OverviewSectionId[] = [
  'files', 'mind', 'recent', 'tools', 'memory', 'usage',
];

/** 打开概览时落在哪一组：与 `OVERVIEW_SECTION_IDS[0]` 同源，见上方注释。 */
export const DEFAULT_OVERVIEW_SECTION: OverviewSectionId = OVERVIEW_SECTION_IDS[0];

/**
 * Which overview sub-tab should be active.
 *
 * - `highlightMailboxId` wins: the caller is deep-linking to one mailbox item,
 *   which only exists inside 运行与注意力. Landing anywhere else would hide the very
 *   thing the link promised.
 * - `initialSection` (legacy `profileTab:'mind'` …) next — unknown ids are ignored
 *   rather than trusted, so a stale link cannot render an empty panel.
 * - otherwise the first group.
 *
 * 【为什么提成纯函数】旧实现把「落到哪一组」编码成折叠块的 `defaultOpen`，只在挂载
 * 时生效，所以同一深链第二次点击毫无反应；而且优先级没有任何测试能锁住。
 */
export function resolveOverviewSection(
  initialSection?: string | null,
  highlightMailboxId?: string | null,
): OverviewSectionId {
  if (highlightMailboxId) return 'mind';
  const known = OVERVIEW_SECTION_IDS.find(id => id === initialSection);
  return known ?? DEFAULT_OVERVIEW_SECTION;
}

// ─── Deliverable click routing ───────────────────────────────────────────────

/**
 * Where a click on a deliverable in an agent's 产出 tab should land.
 *
 * 【为什么判据是 hostAvailable 而不是「openRightPanel 是否存在」】后者永远为真
 * （它是 LayoutContext 上的常量），而「宿主页面此刻是否真的渲染右侧栏」是另一件事：
 * Team 页在移动端把 `hostAvailable` 设成 false
 * （`setHostAvailable(isActive && !isMobile)`）。旧的判断因此**总是**走右侧栏分支
 * ——移动端点击只是往一个不存在的面板里塞了个 tab，表现就是「点了没反应」。
 *
 * 桌面端（有宿主）→ 'right-panel'：原地预览，不离开当前页。
 * 移动端 / 无宿主 → 'page'：跳到该产出物自己的页面（那里有完整的详情与操作）。
 */
export function deliverableClickTarget(hostAvailable: boolean | undefined): 'right-panel' | 'page' {
  return hostAvailable ? 'right-panel' : 'page';
}
