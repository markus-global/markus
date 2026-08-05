export type ShortcutGroupId = 'layout' | 'search' | 'rightPanel' | 'terminal' | 'tasks' | 'help';

export type ShortcutDef = {
  id: string;
  group: ShortcutGroupId;
  /** Keys without platform modifier — e.g. ['B'] or ['Shift', ']'] */
  keys: string[];
  /** i18n default English label */
  label: string;
  labelKey?: string;
  /** When set, shortcut help only shows this entry on the matching page. */
  page?: 'team' | 'work' | 'any';
};

export const KEYBOARD_SHORTCUTS: ShortcutDef[] = [
  { id: 'toggle-left', group: 'layout', keys: ['B'], label: 'Toggle left sidebar', labelKey: 'shortcuts.toggleLeft', page: 'any' },
  { id: 'toggle-browser', group: 'layout', keys: ['L'], label: 'Toggle right panel · Browser (Team Chat)', labelKey: 'shortcuts.toggleBrowser', page: 'team' },
  { id: 'toggle-terminal', group: 'layout', keys: ['J'], label: 'Toggle right panel · Terminal (Team Chat)', labelKey: 'shortcuts.toggleTerminal', page: 'team' },
  { id: 'toggle-project-detail', group: 'tasks', keys: ['J'], label: 'Toggle project detail (Tasks)', labelKey: 'shortcuts.toggleProjectDetail', page: 'work' },
  { id: 'toggle-item-detail', group: 'tasks', keys: ['L'], label: 'Toggle task / requirement detail (Tasks)', labelKey: 'shortcuts.toggleItemDetail', page: 'work' },
  { id: 'cycle-board', group: 'tasks', keys: ['Ctrl', 'Tab'], label: 'Cycle Tasks views', labelKey: 'shortcuts.cycleBoard', page: 'work' },
  { id: 'nav-jk', group: 'tasks', keys: ['J / K'], label: 'Move selection (projects or items)', labelKey: 'shortcuts.navJk', page: 'work' },
  { id: 'focus-items', group: 'tasks', keys: ['Tab'], label: 'Focus item list from project sidebar', labelKey: 'shortcuts.focusItems', page: 'work' },
  { id: 'search', group: 'search', keys: ['P'], label: 'Global search', labelKey: 'shortcuts.search', page: 'any' },
  { id: 'next-tab', group: 'rightPanel', keys: ['Shift', ']'], label: 'Next right-panel tab', labelKey: 'shortcuts.nextTab', page: 'team' },
  { id: 'prev-tab', group: 'rightPanel', keys: ['Shift', '['], label: 'Previous right-panel tab', labelKey: 'shortcuts.prevTab', page: 'team' },
  { id: 'tab-n', group: 'rightPanel', keys: ['1…9'], label: 'Jump to Nth right-panel tab', labelKey: 'shortcuts.tabN', page: 'team' },
  { id: 'close-tab', group: 'rightPanel', keys: ['W'], label: 'Close right-panel tab', labelKey: 'shortcuts.closeTab', page: 'team' },
  { id: 'new-tab', group: 'rightPanel', keys: ['T'], label: 'New browser tab / shell', labelKey: 'shortcuts.newTab', page: 'team' },
  { id: 'help', group: 'help', keys: ['/'], label: 'Show keyboard shortcuts', labelKey: 'shortcuts.help', page: 'any' },
  { id: 'term-search', group: 'terminal', keys: ['F'], label: 'Search in terminal', labelKey: 'shortcuts.termSearch', page: 'team' },
  { id: 'term-to-chat', group: 'terminal', keys: ['Shift', 'A'], label: 'Add terminal selection to chat', labelKey: 'shortcuts.termToChat', page: 'team' },
];

export function formatShortcutKeys(keys: string[], isMac: boolean): string {
  if (keys[0] === 'Ctrl') return keys.join('+');
  if (keys[0] === 'Tab' || keys[0] === 'J / K') return keys.join(' ');
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
