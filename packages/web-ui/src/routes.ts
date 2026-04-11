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
  REPORTS: 'reports',
  SETTINGS: 'settings',
} as const;

export type PageId = (typeof PAGE)[keyof typeof PAGE];

const ALL_PAGE_IDS = new Set<string>(Object.values(PAGE));

// ── Hash aliases (old/alternative names → canonical) ────────────────────────

const HASH_ALIASES: Record<string, PageId> = {
  dashboard: PAGE.HOME,
  overview: PAGE.HOME,
  chat: PAGE.TEAM,
  projects: PAGE.WORK,
  tasks: PAGE.WORK,
  usage: PAGE.REPORTS,
  prompts: PAGE.BUILDER,
  templates: PAGE.STORE,
  agents: PAGE.STORE,
  skills: PAGE.STORE,
  teams: PAGE.STORE,
  knowledge: PAGE.DELIVERABLES,
  governance: PAGE.SETTINGS,
};

/** Resolve any hash segment (canonical or legacy alias) to a PageId. */
export function resolvePageId(raw: string): PageId {
  if (ALL_PAGE_IDS.has(raw)) return raw as PageId;
  return HASH_ALIASES[raw] ?? PAGE.HOME;
}

/** Read the current page from window.location.hash. */
export function getPageFromHash(): PageId {
  const hash = window.location.hash.slice(1).split('/')[0];
  return resolvePageId(hash);
}

/** Build a hash path like `#work/projectId`. */
export function hashPath(page: PageId, sub?: string): string {
  return sub ? `#${page}/${sub}` : `#${page}`;
}

// ── Mobile page consolidation ───────────────────────────────────────────────

export const MOBILE_REDIRECTS: Partial<Record<PageId, PageId>> = {
  [PAGE.STORE]: PAGE.BUILDER,
  [PAGE.REPORTS]: PAGE.SETTINGS,
};

// ── SVG icon paths (shared by Sidebar + BottomNav) ──────────────────────────

export const PAGE_ICONS: Record<string, string> = {
  [PAGE.HOME]:         'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  [PAGE.WORK]:         'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  [PAGE.TEAM]:         'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  [PAGE.REPORTS]:      'M18 20V10 M12 20V4 M6 20v-6',
  [PAGE.DELIVERABLES]: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z',
  [PAGE.BUILDER]:      'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  [PAGE.STORE]:        'M6 2L3 7v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-3-5z M3 7h18 M16 11a4 4 0 0 1-8 0',
  [PAGE.SETTINGS]:     'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
};

// ── Desktop sidebar structure ───────────────────────────────────────────────

export const SIDEBAR_SECTIONS = [
  { key: 'workspace', label: 'WORKSPACE' },
  { key: 'build',     label: 'BUILD' },
  { key: 'system',    label: 'SYSTEM' },
] as const;

export const SIDEBAR_NAV: Array<{ id: PageId; label: string; section: string }> = [
  { id: PAGE.HOME,         label: 'Home',         section: 'workspace' },
  { id: PAGE.TEAM,         label: 'Team',         section: 'workspace' },
  { id: PAGE.DELIVERABLES, label: 'Deliverables', section: 'workspace' },
  { id: PAGE.BUILDER,      label: 'Builder',      section: 'build' },
  { id: PAGE.STORE,        label: 'Store',        section: 'build' },
  { id: PAGE.REPORTS,      label: 'Reports',      section: 'system' },
  { id: PAGE.SETTINGS,     label: 'Settings',     section: 'system' },
];

// ── Mobile bottom nav structure ─────────────────────────────────────────────

export const MOBILE_TABS: Array<{ id: PageId; label: string; group: PageId[] }> = [
  { id: PAGE.HOME,         label: 'Home',         group: [PAGE.HOME] },
  { id: PAGE.TEAM,         label: 'Team',         group: [PAGE.TEAM] },
  { id: PAGE.WORK,         label: 'Work',         group: [PAGE.WORK] },
  { id: PAGE.DELIVERABLES, label: 'Deliverables', group: [PAGE.DELIVERABLES] },
  { id: PAGE.BUILDER,      label: 'Builder',      group: [PAGE.BUILDER, PAGE.STORE] },
  { id: PAGE.SETTINGS,     label: 'Settings',     group: [PAGE.SETTINGS, PAGE.REPORTS] },
];
