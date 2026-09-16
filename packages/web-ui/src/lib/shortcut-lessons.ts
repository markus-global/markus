/**
 * 快捷键教学清单（需求 2：Overview 引导清单「快捷键教学」步骤）。
 *
 * 与 T3 快捷键实现（需求 3+4+5，已合入 feat/ui-optimize-0913）保持一致：
 * - 新对话 Cmd/Ctrl+N、会话 tab 切换 Ctrl+Tab / Ctrl+Shift+Tab（T3 注册表 new-conversation / cycle-session-tab / cycle-session-tab-prev；
 * - 平台修饰键差异映射 resolveTeamChatShortcut：Mac ⌘ 而非 Ctrl；Tab 切换始终 Ctrl（Mac 亦用 Ctrl）。
 * 教学清单项以「可展示 + 可按键自动勾选」的纯函数为核心，持久化 per-user localStorage。
 */
import type { ShortcutDef } from './keyboard-shortcuts.ts';

export type LessonKeyEvent = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * 教学清单：导航通用快捷键、打开/收起左右侧边栏、全局搜索/帮助、以及 T3 新增
 * Cmd/Ctrl+N（new-conversation）、Ctrl+Tab / Ctrl+Shift+Tab（cycle-session-tab / prev）。
 * 复用 KEYBOARD_SHORTCUTS 注册表条目（keyboard-shortcuts.ts）保证展示与帮助弹窗一致）。
 */
export interface ShortcutLessonItem extends ShortcutDef {
  /** 与注册表一致的 id 也作为勾选状态 key。 */
  id: string;
  /** i18n key（教学清单强约束：每一项必须有翻译，禁止新增项不带 labelKey，避免静默回落英文）。 */
  labelKey: string;
}

export const SHORTCUT_LESSONS: ShortcutLessonItem[] = [
  // ── 左侧边栏（L0 折叠/展开）─────────────────────────────────────────────
  { id: 'toggle-left', group: 'layout', keys: ['B'], label: 'Toggle left sidebar', labelKey: 'shortcuts.toggleLeft', page: 'any' },
  // ── 导航通用（vim H/J/K/L）──────────────────────────────────────────────
  { id: 'nav-l0-jk', group: 'navigation', keys: ['J / K'], label: 'L0: switch page up / down', labelKey: 'shortcuts.navL0Jk', page: 'any', bare: true },
  { id: 'nav-l0-l', group: 'navigation', keys: ['L'], label: 'L0: enter page L1', labelKey: 'shortcuts.navL0L', page: 'any', bare: true },
  { id: 'nav-l0-h', group: 'navigation', keys: ['H'], label: 'From page L1: focus app rail (L0)', labelKey: 'shortcuts.navL0H', page: 'any', bare: true },
  // ── 全局搜索 / 帮助
  { id: 'search', group: 'search', keys: ['P'], label: 'Global search', labelKey: 'shortcuts.search', page: 'any' },
  { id: 'help', group: 'help', keys: ['/'], label: 'Show keyboard shortcuts', labelKey: 'shortcuts.help', page: 'any' },
  // ── Team Chat（T3 新增）─────────────────────────────────────────────────
  { id: 'new-conversation', group: 'team', keys: ['N'], label: 'New conversation', labelKey: 'shortcuts.newConversation', page: 'team' },
  { id: 'cycle-session-tab', group: 'team', keys: ['Ctrl', 'Tab'], label: 'Next conversation tab', labelKey: 'shortcuts.cycleSessionTab', page: 'team' },
  { id: 'cycle-session-tab-prev', group: 'team', keys: ['Ctrl', 'Shift', 'Tab'], label: 'Previous conversation tab', labelKey: 'shortcuts.cycleSessionTabPrev', page: 'team' },
];

/** 教学清单的 per-user storage key（与 lib/onboarding.ts per-user 风格一致）。
 * 场景：多用户不同步勾选、清缓存不丢进度。
 */
export function shortcutLessonKey(userId: string): string {
  return `markus_shortcut_lesson_${userId}`;
}

/** 读取该用户已勾选的教学项 id 列表。 */
export function loadLessonChecked(userId: string): string[] {
  try {
    const raw = localStorage.getItem(shortcutLessonKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter((x): x is string => typeof x === 'string')) : [];
  } catch {
    return [];
  }
}

/** 持久化该用户的勾选进度。 */
export function saveLessonChecked(userId: string, checked: string[]): void {
  try {
    localStorage.setItem(shortcutLessonKey(userId), JSON.stringify(checked.filter(Boolean)));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** 该用户是否已全部勾选（全部教学项完成即该教学步骤完成）。 */
export function isLessonComplete(userId: string): boolean {
  const checked = new Set(loadLessonChecked(userId));
  return SHORTCUT_LESSONS.every((l) => checked.has(l.id));
}

/**
 * 全局静默学习（体验优化 A）：在日常使用中真实按下某个教学快捷键即自动勾选。
 * 纯函数、无副作用拦截（不 preventDefault / stopPropagation——让真实行为照常发生，
 * 教学只是「记录」）。返回勾选后是否已全部完成。
 */
export function applyLessonKeyPress(e: LessonKeyEvent, userId: string, isMac: boolean): boolean {
  const matched = SHORTCUT_LESSONS.find((l) => shortcutLessonMatches(e, l.id, isMac));
  if (!matched) return isLessonComplete(userId);
  const next = new Set(loadLessonChecked(userId));
  next.add(matched.id);
  saveLessonChecked(userId, [...next]);
  return SHORTCUT_LESSONS.every((l) => next.has(l.id));
}

/** 一键「我已掌握全部」：跳过逐键练习，直接标记全部勾选（体验优化 B）。 */
export function markAllLessonsLearned(userId: string): void {
  saveLessonChecked(userId, SHORTCUT_LESSONS.map((l) => l.id));
}

/**
 * 按键是否命中某个教学项。修饰键语义与 T3 resolveTeamChatShortcut 一致：
 *  - 平台修饰键：Mac=⌘（metaKey 且非 Ctrl）；Windows/Linux=Ctrl（且非 meta）；
 *  - Tab 切换始终 Ctrl（Mac 亦用 Ctrl）；
 *  - bare（vim）导航键 H/L/J/K 无任何修饰键。
 * 测试覆盖：Mac/Win 差异、Cmd+Shift+N 抑制、Ctrl+Tab 双向、bare 键抑制修饰。
 */
export function shortcutLessonMatches(e: LessonKeyEvent, lessonId: string, isMac: boolean): boolean {
  const mod = isMac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
  const key = e.key.toLowerCase();
  switch (lessonId) {
    case 'toggle-left':
      return mod && !e.altKey && !e.shiftKey && key === 'b';
    case 'nav-l0-jk':
      return !e.metaKey && !e.ctrlKey && !e.altKey && (key === 'j' || key === 'k');
    case 'nav-l0-l':
      return !e.metaKey && !e.ctrlKey && !e.altKey && key === 'l';
    case 'nav-l0-h':
      return !e.metaKey && !e.ctrlKey && !e.altKey && key === 'h';
    case 'search':
      return mod && !e.altKey && !e.shiftKey && key === 'p';
    case 'help':
      // Cmd/Ctrl+/（mac 也支持 Cmd+?）
      return mod && !e.altKey && (key === '/' || (!e.shiftKey && (e.code === 'Slash' || key === '/')));
    case 'new-conversation':
      return mod && !e.altKey && !e.shiftKey && key === 'n';
    case 'cycle-session-tab':
      return e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab' && !e.shiftKey;
    case 'cycle-session-tab-prev':
      return e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab' && e.shiftKey;
    default:
      return false;
  }
}