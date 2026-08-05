export type ShortcutGroupId = 'layout' | 'navigation' | 'search' | 'rightPanel' | 'terminal' | 'tasks' | 'team' | 'help';

export type ShortcutDef = {
  id: string;
  group: ShortcutGroupId;
  /** Keys without platform modifier — e.g. ['B'] or ['Shift', ']'] */
  keys: string[];
  /** i18n default English label */
  label: string;
  labelKey?: string;
  /**
   * When set, shortcut help only shows this entry on the matching page.
   * `any` (default) = always shown. Bare keys (no ⌘) that collide with page-local
   * Cmd shortcuts are scoped to avoid confusion in the help modal.
   */
  page?: 'team' | 'work' | 'deliverables' | 'store' | 'any';
  /** If true, keys are shown without ⌘/Ctrl prefix (vim-style bare keys). */
  bare?: boolean;
};

export const KEYBOARD_SHORTCUTS: ShortcutDef[] = [
  // ── Layout (modifier) ────────────────────────────────────────────────────
  { id: 'toggle-left', group: 'layout', keys: ['B'], label: 'Toggle left sidebar (L0 + page L1)', labelKey: 'shortcuts.toggleLeft', page: 'any' },
  { id: 'help', group: 'help', keys: ['/'], label: 'Show keyboard shortcuts', labelKey: 'shortcuts.help', page: 'any' },
  { id: 'search', group: 'search', keys: ['P'], label: 'Global search', labelKey: 'shortcuts.search', page: 'any' },

  // ── Pane navigation (vim H/J/K/L) ─────────────────────────────────────────
  { id: 'nav-l0-jk', group: 'navigation', keys: ['J / K'], label: 'L0: switch page up / down', labelKey: 'shortcuts.navL0Jk', page: 'any', bare: true },
  { id: 'nav-l0-l', group: 'navigation', keys: ['L'], label: 'L0: enter page L1 (Team / Tasks / Output / Store / Settings)', labelKey: 'shortcuts.navL0L', page: 'any', bare: true },
  { id: 'nav-l0-h', group: 'navigation', keys: ['H'], label: 'From page L1: focus app rail (L0)', labelKey: 'shortcuts.navL0H', page: 'any', bare: true },
  { id: 'settings-back', group: 'navigation', keys: ['H'], label: 'Settings: go back to previous page', labelKey: 'shortcuts.settingsBack', page: 'any', bare: true },
  { id: 'nav-jk-settings', group: 'navigation', keys: ['J / K'], label: 'Settings L1: switch settings tabs', labelKey: 'shortcuts.navJkSettings', page: 'any', bare: true },
  { id: 'nav-hl-work', group: 'navigation', keys: ['H / L'], label: 'Tasks: item list ↔ project L1 ↔ app rail', labelKey: 'shortcuts.navHlWork', page: 'work', bare: true },
  { id: 'nav-jk-work', group: 'navigation', keys: ['J / K'], label: 'Tasks: move project / item selection', labelKey: 'shortcuts.navJkWork', page: 'work', bare: true },
  { id: 'nav-hl-team', group: 'navigation', keys: ['H / L'], label: 'Team: L0 ↔ L1 ↔ L2 (L ignored on deepest pane)', labelKey: 'shortcuts.navHlTeam', page: 'team', bare: true },
  { id: 'nav-jk-team', group: 'navigation', keys: ['J / K'], label: 'Team L1: move roster selection', labelKey: 'shortcuts.navJkTeam', page: 'team', bare: true },
  { id: 'nav-jk-team-l2', group: 'navigation', keys: ['J / K'], label: 'Team L2: move team member selection', labelKey: 'shortcuts.navJkTeamL2', page: 'team', bare: true },
  { id: 'nav-jk-deliverables', group: 'navigation', keys: ['J / K'], label: 'Output L1: move deliverable selection', labelKey: 'shortcuts.navJkDeliverables', page: 'deliverables', bare: true },
  { id: 'nav-jk-store', group: 'navigation', keys: ['J / K'], label: 'Store L1: switch store tabs', labelKey: 'shortcuts.navJkStore', page: 'store', bare: true },

  // ── Tasks (page-local Cmd) ───────────────────────────────────────────────
  { id: 'toggle-project-detail', group: 'tasks', keys: ['J'], label: 'Toggle project detail (Tasks)', labelKey: 'shortcuts.toggleProjectDetail', page: 'work' },
  { id: 'toggle-item-detail', group: 'tasks', keys: ['L'], label: 'Toggle task / requirement detail (Tasks)', labelKey: 'shortcuts.toggleItemDetail', page: 'work' },
  { id: 'cycle-board', group: 'tasks', keys: ['Ctrl', 'Tab'], label: 'Cycle Tasks views', labelKey: 'shortcuts.cycleBoard', page: 'work', bare: true },

  // ── Team Chat (page-local Cmd) ───────────────────────────────────────────
  { id: 'toggle-browser', group: 'team', keys: ['L'], label: 'Toggle right panel · Browser', labelKey: 'shortcuts.toggleBrowser', page: 'team' },
  { id: 'toggle-terminal', group: 'team', keys: ['J'], label: 'Toggle right panel · Terminal', labelKey: 'shortcuts.toggleTerminal', page: 'team' },
  { id: 'next-tab', group: 'rightPanel', keys: ['Shift', ']'], label: 'Next right-panel tab', labelKey: 'shortcuts.nextTab', page: 'team' },
  { id: 'prev-tab', group: 'rightPanel', keys: ['Shift', '['], label: 'Previous right-panel tab', labelKey: 'shortcuts.prevTab', page: 'team' },
  { id: 'tab-n', group: 'rightPanel', keys: ['1…9'], label: 'Jump to Nth right-panel tab', labelKey: 'shortcuts.tabN', page: 'team' },
  { id: 'close-tab', group: 'rightPanel', keys: ['W'], label: 'Close right-panel tab', labelKey: 'shortcuts.closeTab', page: 'team' },
  { id: 'new-tab', group: 'rightPanel', keys: ['T'], label: 'New browser tab / shell', labelKey: 'shortcuts.newTab', page: 'team' },
  { id: 'term-search', group: 'terminal', keys: ['F'], label: 'Search in terminal', labelKey: 'shortcuts.termSearch', page: 'team' },
  { id: 'term-to-chat', group: 'terminal', keys: ['Shift', 'A'], label: 'Add terminal selection to chat', labelKey: 'shortcuts.termToChat', page: 'team' },
];

export function formatShortcutKeys(keys: string[], isMac: boolean, bare?: boolean): string {
  if (bare || keys[0] === 'Ctrl' || keys[0] === 'Tab' || keys[0] === 'J / K' || keys[0] === 'H / L') {
    return keys.join(keys[0] === 'Ctrl' ? '+' : ' ');
  }
  // Single bare letter entries that are vim keys (H/L/J/K alone with bare flag)
  if (keys.length === 1 && (keys[0] === 'H' || keys[0] === 'L' || keys[0] === 'J' || keys[0] === 'K')) {
    return keys[0]!;
  }
  const mod = isMac ? '⌘' : 'Ctrl';
  return [mod, ...keys].join(isMac ? '' : '+');
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return target.closest('.xterm') !== null;
}

export function isXtermTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('.xterm') !== null;
}
