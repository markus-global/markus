export type ShortcutGroupId = 'layout' | 'search' | 'rightPanel' | 'terminal' | 'help';

export type ShortcutDef = {
  id: string;
  group: ShortcutGroupId;
  /** Keys without platform modifier — e.g. ['B'] or ['Shift', ']'] */
  keys: string[];
  /** i18n default English label */
  label: string;
  labelKey?: string;
};

export const KEYBOARD_SHORTCUTS: ShortcutDef[] = [
  { id: 'toggle-left', group: 'layout', keys: ['B'], label: 'Toggle left sidebar', labelKey: 'shortcuts.toggleLeft' },
  { id: 'toggle-browser', group: 'layout', keys: ['L'], label: 'Toggle right panel · Browser', labelKey: 'shortcuts.toggleBrowser' },
  { id: 'toggle-terminal', group: 'layout', keys: ['J'], label: 'Toggle right panel · Terminal', labelKey: 'shortcuts.toggleTerminal' },
  { id: 'search', group: 'search', keys: ['P'], label: 'Global search', labelKey: 'shortcuts.search' },
  { id: 'next-tab', group: 'rightPanel', keys: ['Shift', ']'], label: 'Next right-panel tab', labelKey: 'shortcuts.nextTab' },
  { id: 'prev-tab', group: 'rightPanel', keys: ['Shift', '['], label: 'Previous right-panel tab', labelKey: 'shortcuts.prevTab' },
  { id: 'tab-n', group: 'rightPanel', keys: ['1…9'], label: 'Jump to Nth right-panel tab', labelKey: 'shortcuts.tabN' },
  { id: 'close-tab', group: 'rightPanel', keys: ['W'], label: 'Close right-panel tab', labelKey: 'shortcuts.closeTab' },
  { id: 'new-tab', group: 'rightPanel', keys: ['T'], label: 'New browser tab / shell', labelKey: 'shortcuts.newTab' },
  { id: 'help', group: 'help', keys: ['/'], label: 'Show keyboard shortcuts', labelKey: 'shortcuts.help' },
  { id: 'term-search', group: 'terminal', keys: ['F'], label: 'Search in terminal', labelKey: 'shortcuts.termSearch' },
  { id: 'term-to-chat', group: 'terminal', keys: ['Shift', 'A'], label: 'Add terminal selection to chat', labelKey: 'shortcuts.termToChat' },
];

export function formatShortcutKeys(keys: string[], isMac: boolean): string {
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
