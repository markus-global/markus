/**
 * Single source of truth for all page IDs, hash aliases, icons, and nav structure.
 * Every navigation-related constant lives here so renames only touch one file.
 */

// ── Canonical page IDs ──────────────────────────────────────────────────────

export const PAGE = {
  HOME: 'home',
  TEAM: 'team',
  WORK: 'work',
  STORE: 'store',
  BUILDER: 'builder',
  DELIVERABLES: 'deliverables',
  SETTINGS: 'settings',
  NOTIFICATIONS: 'notifications',
  SEARCH: 'search',
  /**
   * 路由台：系统做过什么决定、以及理由（实现文档 §5.4）。
   *
   * 它是 **审计面**，不是待办清单 ——
   *   行动台（Inbox）= 「现在要我做什么」；路由台 = 「系统替我做/没做什么决定」。
   * 两者语义不同，才需要两个面。不占侧栅导航（Owner 砍过导航密度），从概览进入。
   */
  ROUTER: 'router',
  /**
   * Thread 视图（实现文档 §5.3）：把「一条流的来龙去脉」合成一条按时间排序的流。
   * 与路由台的区别：路由台是**全局**决定清单（谁被接单/忽略），这里只回答**单条流**经历了什么。
   */
  THREAD: 'thread',
} as const;

export type PageId = (typeof PAGE)[keyof typeof PAGE];

const ALL_PAGE_IDS = new Set<string>(Object.values(PAGE));

// ── Hash aliases (old/alternative names → canonical) ────────────────────────

const HASH_ALIASES: Record<string, PageId> = {
  dashboard: PAGE.HOME,
  chat: PAGE.TEAM,
  projects: PAGE.WORK,
  usage: PAGE.HOME,
  reports: PAGE.HOME,
  prompts: PAGE.BUILDER,
  templates: PAGE.STORE,
  agents: PAGE.STORE,
  skills: PAGE.STORE,
  teams: PAGE.STORE,
  knowledge: PAGE.DELIVERABLES,
  governance: PAGE.SETTINGS,
};

/**
 * URL slug shown in the address bar for each page. Decoupled from the internal
 * PageId so the hash matches the visible tab name (e.g. 资产/Assets → `#assets`)
 * without renaming the ids used throughout the code. The old ids still resolve
 * (see resolvePageId) so existing bookmarks / deep links keep working.
 */
const PAGE_HASH: Record<PageId, string> = {
  [PAGE.HOME]: 'overview',
  [PAGE.TEAM]: 'team',
  [PAGE.WORK]: 'tasks',
  [PAGE.STORE]: 'explore',
  [PAGE.BUILDER]: 'assets',
  [PAGE.DELIVERABLES]: 'output',
  [PAGE.SETTINGS]: 'settings',
  [PAGE.NOTIFICATIONS]: 'notifications',
  [PAGE.SEARCH]: 'search',
  [PAGE.ROUTER]: 'router',
  [PAGE.THREAD]: 'thread',
};

const HASH_TO_PAGE: Record<string, PageId> = Object.fromEntries(
  Object.entries(PAGE_HASH).map(([id, slug]) => [slug, id as PageId]),
) as Record<string, PageId>;

/** The address-bar slug for a page (matches the visible tab name). */
export function pageToHash(page: PageId): string {
  return PAGE_HASH[page] ?? page;
}

/** Resolve any hash segment (slug, canonical id, or legacy alias) to a PageId. */
export function resolvePageId(raw: string): PageId {
  if (HASH_TO_PAGE[raw]) return HASH_TO_PAGE[raw];
  if (ALL_PAGE_IDS.has(raw)) return raw as PageId;
  return HASH_ALIASES[raw] ?? PAGE.HOME;
}

/** Read the current page from window.location.hash. */
export function getPageFromHash(): PageId {
  const hash = window.location.hash.slice(1).split('/')[0];
  return resolvePageId(hash);
}

/** Build a hash path like `#tasks/projectId`, using the address-bar slug. */
export function hashPath(page: PageId, sub?: string): string {
  const slug = pageToHash(page);
  return sub ? `#${slug}/${sub}` : `#${slug}`;
}

// ── Mobile page consolidation ───────────────────────────────────────────────

export const MOBILE_REDIRECTS: Partial<Record<PageId, PageId>> = {
  // On mobile the Store is folded into the Assets page (MobileBuilderTabs), which
  // hosts the builder plus the Discover/Agents/Teams/Skills/Installed tabs.
  [PAGE.STORE]: PAGE.BUILDER,
};

// ── SVG icon paths (shared by Sidebar + BottomNav) ──────────────────────────

export const PAGE_ICONS: Record<string, string> = {
  // 概览 Overview → dashboard grid
  [PAGE.HOME]:         'M4 3h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M15 3h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M15 12h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z M4 16h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z',
  // 任务 Tasks → clipboard checklist
  [PAGE.WORK]:         'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M12 11h4 M12 16h4 M8 11h.01 M8 16h.01',
  // 团队 Team → two conversation bubbles (agents talking to each other)
  [PAGE.TEAM]:         'M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1',
  // 产出 Output → delivered package (box)
  [PAGE.DELIVERABLES]: 'm7.5 4.27 9 5.15 M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8Z M3.3 7 12 12l8.7-5 M12 22V12',
  // 资产 Assets → stacked layers (collection of agents/teams/skills)
  [PAGE.BUILDER]:      'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12 M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17',
  // 探索 Explore → compass (discover the marketplace)
  [PAGE.STORE]:        'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88Z',
  [PAGE.SETTINGS]:      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  [PAGE.NOTIFICATIONS]: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0',
  // 路由台 → 分流节点（一条信号去了谁那儿）
  [PAGE.ROUTER]:        'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  // Thread 视图 → 竖时间线（一条流沿途的节点）
  [PAGE.THREAD]:        'M8 3v18 M8 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M8 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M8 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M13 5h8 M13 12h8 M13 19h5',
};

// ── Desktop sidebar structure ───────────────────────────────────────────────

export const SIDEBAR_SECTIONS = [
  { key: 'quick',     label: 'QUICK' },
  { key: 'workspace', label: 'WORKSPACE' },
  { key: 'build',     label: 'BUILD' },
  { key: 'system',    label: 'SYSTEM' },
] as const;

export const SIDEBAR_NAV: Array<{ id: PageId; label: string; section: string }> = [
  // 通知不再占任何导航：桌面与移动端均已移除，内容在概览「等你处理」+ 历史弹窗（Owner 2026-11-02）。
  { id: PAGE.HOME,         label: 'Overview',     section: 'workspace' },
  { id: PAGE.TEAM,         label: 'Team',         section: 'workspace' },
  // 收件箱已整合进概览页（Owner 2026-11-02）：独立页已删除，不占导航。
  { id: PAGE.WORK,         label: 'Tasks',        section: 'workspace' },
  { id: PAGE.DELIVERABLES, label: 'Output',       section: 'workspace' },
  { id: PAGE.BUILDER,      label: 'Builder',      section: 'build' },
  { id: PAGE.STORE,        label: 'Store',        section: 'build' },
  { id: PAGE.SETTINGS,     label: 'Settings',     section: 'system' },
];

/** Pages that expose an L1 pane for H/L keyboard navigation with the app rail. */
export const PAGES_WITH_L1: ReadonlySet<PageId> = new Set([
  PAGE.TEAM,
  PAGE.WORK,
  PAGE.DELIVERABLES,
  PAGE.STORE,
  PAGE.SETTINGS,
]);

/**
 * Sidebar entries that participate in L0 j/k focus.
 * Excludes notifications (popover). Settings is included — entering it focuses its L1 tab rail.
 */
export const L0_NAV_PAGES: PageId[] = SIDEBAR_NAV
  .filter(i => i.id !== PAGE.NOTIFICATIONS)
  .map(i => i.id);

// ── Mobile bottom nav structure ─────────────────────────────────────────────

export type MobileTabId = PageId;

export const MOBILE_TABS: Array<{ id: MobileTabId; label: string; group: PageId[] }> = [
  { id: PAGE.HOME,          label: 'Overview',      group: [PAGE.HOME] },
  { id: PAGE.TEAM,          label: 'Team',          group: [PAGE.TEAM] },
  // 通知页已彻底移除（Owner 2026-11-02）：桌面早已无入口，内容在概览「等你处理」+ 历史弹窗里。
  // 未读数改由概览 tab 的徽标承载。
  { id: PAGE.WORK,          label: 'Tasks',         group: [PAGE.WORK] },
  { id: PAGE.DELIVERABLES,  label: 'Output',        group: [PAGE.DELIVERABLES] },
];
