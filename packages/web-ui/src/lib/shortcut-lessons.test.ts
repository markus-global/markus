import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SHORTCUT_LESSONS,
  shortcutLessonKey,
  loadLessonChecked,
  saveLessonChecked,
  isLessonComplete,
  shortcutLessonMatches,
  applyLessonKeyPress,
  markAllLessonsLearned,
  type LessonKeyEvent,
} from './shortcut-lessons.ts';
import enCommon from '../locales/en/common.json';
import zhCommon from '../locales/zh-CN/common.json';

const ALL_LESSON_IDS = SHORTCUT_LESSONS.map(l => l.id);

// Node test env has no localStorage — provide a tiny in-memory shim.
function installStorageShim() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  vi.stubGlobal('localStorage', stub);
  return () => store.clear();
}

function ev(partial: Partial<LessonKeyEvent> = {}): LessonKeyEvent {
  return {
    key: '',
    code: undefined,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe('SHORTCUT_LESSONS teaching checklist', () => {
  installStorageShim();

  it('covers navigation, sidebar, and the T3-added team shortcuts', () => {
    // 教学清单必须包含 T3 新增快捷键（需求 3+4+5）：Cmd/Ctrl+N 与 Ctrl+Tab 切换
    expect(ALL_LESSON_IDS).toContain('new-conversation');
    expect(ALL_LESSON_IDS).toContain('cycle-session-tab');
    expect(ALL_LESSON_IDS).toContain('cycle-session-tab-prev');
    // 导航通用 + 左右侧边栏
    expect(ALL_LESSON_IDS.some(id => id.startsWith('nav-'))).toBe(true);
    expect(ALL_LESSON_IDS).toContain('toggle-left');
  });

  it('exposes unique ids (no duplicate checklist entries)', () => {
    expect(new Set(ALL_LESSON_IDS).size).toBe(ALL_LESSON_IDS.length);
  });
});

describe('shortcutLessonMatches', () => {
  // Mac：⌘ 修饰键
  it('Mac ⌘B toggles left sidebar', () => {
    expect(shortcutLessonMatches(ev({ key: 'b', metaKey: true }), 'toggle-left', true)).toBe(true);
    // Ctrl+B 在 Mac 上不算 ⌘B
    expect(shortcutLessonMatches(ev({ key: 'b', ctrlKey: true }), 'toggle-left', true)).toBe(false);
  });

  it('Windows/Linux Ctrl+B toggles left sidebar', () => {
    expect(shortcutLessonMatches(ev({ key: 'b', ctrlKey: true }), 'toggle-left', false)).toBe(true);
    // Meta+B 在 Windows 上不算 Ctrl+B
    expect(shortcutLessonMatches(ev({ key: 'b', metaKey: true }), 'toggle-left', false)).toBe(false);
  });

  it('Mac ⌘N matches new conversation (T3)', () => {
    expect(shortcutLessonMatches(ev({ key: 'n', metaKey: true }), 'new-conversation', true)).toBe(true);
    expect(shortcutLessonMatches(ev({ key: 'n', ctrlKey: true }), 'new-conversation', true)).toBe(false);
    // ⌘Shift+N 不匹配（避免浏览器无痕窗口误触教学）
    expect(shortcutLessonMatches(ev({ key: 'n', metaKey: true, shiftKey: true }), 'new-conversation', true)).toBe(false);
  });

  it('Windows/Linux Ctrl+N matches new conversation (T3)', () => {
    expect(shortcutLessonMatches(ev({ key: 'n', ctrlKey: true }), 'new-conversation', false)).toBe(true);
  });

  it('Ctrl+Tab matches next session tab — Ctrl on both platforms (T3)', () => {
    expect(shortcutLessonMatches(ev({ key: 'Tab', ctrlKey: true }), 'cycle-session-tab', true)).toBe(true);
    expect(shortcutLessonMatches(ev({ key: 'Tab', ctrlKey: true }), 'cycle-session-tab', false)).toBe(true);
    expect(shortcutLessonMatches(ev({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'cycle-session-tab', true)).toBe(false);
  });

  it('Ctrl+Shift+Tab matches previous session tab (T3)', () => {
    expect(shortcutLessonMatches(ev({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'cycle-session-tab-prev', true)).toBe(true);
    expect(shortcutLessonMatches(ev({ key: 'Tab', ctrlKey: true }), 'cycle-session-tab-prev', true)).toBe(false);
  });

  it('bare vim nav keys (J/K) match without any modifier', () => {
    const jk = SHORTCUT_LESSONS.find(l => l.id === 'nav-l0-jk');
    expect(jk).toBeDefined();
    expect(shortcutLessonMatches(ev({ key: 'j' }), 'nav-l0-jk', true)).toBe(true);
    expect(shortcutLessonMatches(ev({ key: 'K' }), 'nav-l0-jk', true)).toBe(true);
    // 带修饰键时不匹配 bare 键
    expect(shortcutLessonMatches(ev({ key: 'j', ctrlKey: true }), 'nav-l0-jk', true)).toBe(false);
    expect(shortcutLessonMatches(ev({ key: 'j', metaKey: true }), 'nav-l0-jk', true)).toBe(false);
  });

  it('help (Cmd/Ctrl+/) matches slash', () => {
    expect(shortcutLessonMatches(ev({ key: '/', metaKey: true }), 'help', true)).toBe(true);
    expect(shortcutLessonMatches(ev({ key: '/', ctrlKey: true }), 'help', false)).toBe(true);
  });

  it('does not match unrelated shortcuts', () => {
    expect(shortcutLessonMatches(ev({ key: 'x', metaKey: true }), 'toggle-left', true)).toBe(false);
    expect(shortcutLessonMatches(ev({ key: 'Tab', ctrlKey: true }), 'new-conversation', true)).toBe(false);
    expect(shortcutLessonMatches(ev({ key: 'n', metaKey: true }), 'cycle-session-tab', true)).toBe(false);
  });
});

describe('per-user shortcut lesson state', () => {
  installStorageShim();
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('uses a per-user storage key', () => {
    expect(shortcutLessonKey('user-a')).toBe('markus_shortcut_lesson_user-a');
    expect(shortcutLessonKey('user-b')).toBe('markus_shortcut_lesson_user-b');
  });

  it('loads empty checked list for a fresh user', () => {
    expect(loadLessonChecked('user-a')).toEqual([]);
    expect(isLessonComplete('user-a')).toBe(false);
  });

  it('saves and reloads checked ids independently per user', () => {
    saveLessonChecked('user-a', ['toggle-left', 'new-conversation']);
    saveLessonChecked('user-b', ['cycle-session-tab']);
    expect(loadLessonChecked('user-a')).toEqual(['toggle-left', 'new-conversation']);
    expect(loadLessonChecked('user-b')).toEqual(['cycle-session-tab']);
    expect(isLessonComplete('user-a')).toBe(false);
  });

  it('isLessonComplete is true only when every lesson is checked', () => {
    saveLessonChecked('user-a', ALL_LESSON_IDS);
    expect(isLessonComplete('user-a')).toBe(true);
  });

  it('tolerates corrupt JSON in storage', () => {
    localStorage.setItem(shortcutLessonKey('user-a'), 'not-json{');
    expect(loadLessonChecked('user-a')).toEqual([]);
    expect(isLessonComplete('user-a')).toBe(false);
  });
});

describe('i18n integrity (no silent English fallback)', () => {
  it('every lesson item has a labelKey and it resolves in both en + zh-CN common.json', () => {
    for (const item of SHORTCUT_LESSONS) {
      expect(item.labelKey, `lesson ${item.id} must define labelKey`).toBeTruthy();
      // labelKey 形如 "shortcuts.toggleLeft" → common.json.shortcuts.toggleLeft
      const resolve = (root: unknown): unknown => {
        let cur: unknown = root;
        for (const seg of item.labelKey.split('.')) {
          cur = (cur as Record<string, unknown> | undefined)?.[seg];
        }
        return cur;
      };
      expect(typeof resolve(enCommon), `en missing ${item.labelKey}`).toBe('string');
      expect(typeof resolve(zhCommon), `zh-CN missing ${item.labelKey}`).toBe('string');
    }
  });
});

describe('applyLessonKeyPress (background silent learning)', () => {
  installStorageShim();
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('ticks the matched lesson and persists', () => {
    applyLessonKeyPress(ev({ key: 'b', metaKey: true }), 'user-a', true);
    expect(loadLessonChecked('user-a')).toContain('toggle-left');
    expect(isLessonComplete('user-a')).toBe(false);
  });

  it('ignores unrelated keys (no false positive)', () => {
    applyLessonKeyPress(ev({ key: 'x', metaKey: true }), 'user-a', true);
    expect(loadLessonChecked('user-a')).toEqual([]);
  });

  it('returns true once the last missing lesson is checked', () => {
    saveLessonChecked('user-a', ALL_LESSON_IDS.filter(id => id !== 'toggle-left'));
    const complete = applyLessonKeyPress(ev({ key: 'b', metaKey: true }), 'user-a', true);
    expect(complete).toBe(true);
    expect(isLessonComplete('user-a')).toBe(true);
  });

  it('is per-user isolated', () => {
    applyLessonKeyPress(ev({ key: 'b', metaKey: true }), 'user-a', true);
    expect(loadLessonChecked('user-b')).toEqual([]);
  });
});

describe('markAllLessonsLearned (skip / already know)', () => {
  installStorageShim();
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('marks every lesson checked for the target user', () => {
    markAllLessonsLearned('user-a');
    expect(isLessonComplete('user-a')).toBe(true);
    expect(loadLessonChecked('user-b')).toEqual([]);
  });
});