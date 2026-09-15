import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SHORTCUT_LESSONS,
  loadLessonChecked,
  saveLessonChecked,
  isLessonComplete,
  shortcutLessonMatches,
  type LessonKeyEvent,
} from '../lib/shortcut-lessons.ts';
import { formatShortcutKeys } from '../lib/keyboard-shortcuts.ts';

interface Props {
  open: boolean;
  userId?: string;
  onClose: () => void;
  /** 全部教学项勾选完成时回调（Home 将其视为该引导 step 完成）。 */
  onCompleted: () => void;
}

const GROUP_ORDER = ['layout', 'navigation', 'search', 'help', 'team'] as const;

export function ShortcutLessonModal({ open, userId, onClose, onCompleted }: Props) {
  const { t } = useTranslation(['home', 'common']);
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
  const [checked, setChecked] = useState<Set<string>>(() => new Set(userId ? loadLessonChecked(userId) : []));

  // 用户切换时重载该用户的勾选进度（同一会话登录不同用户）。
  useEffect(() => {
    if (open && userId) setChecked(new Set(loadLessonChecked(userId)));
  }, [open, userId]);

  // 全部勾选 → 持久化完成状态并通知 Home，本步骤即完成。
  const allChecked = SHORTCUT_LESSONS.every(l => checked.has(l.id));
  const checkedCount = checked.size;

  useEffect(() => {
    if (!open || !userId) return;
    if (allChecked && isLessonComplete(userId)) onCompleted();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId, allChecked]);

  const grouped = useMemo(() => {
    return GROUP_ORDER.map(group => ({
      group,
      items: SHORTCUT_LESSONS.filter(l => l.group === group),
    })).filter(g => g.items.length > 0);
  }, []);

  useEffect(() => {
    if (!open || !userId) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc 关闭弹窗
      if (e.key === 'Escape') { onClose(); return; }
      const evt: LessonKeyEvent = {
        key: e.key,
        code: e.code,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      };
      const matched = SHORTCUT_LESSONS.find(l => shortcutLessonMatches(evt, l.id, isMac));
      if (!matched) return;
      // bare 键（输入法/普通输入）不 preventDefault，避免劫持正常编辑；修饰组合键则拦截，
      // 防止教学期间触发页面快捷键副作用（如 Cmd+P 打开搜索）。
      if (e.metaKey || e.ctrlKey || e.altKey) e.preventDefault();
      e.stopPropagation(); // 教学监听优先：勾选后不放行给页面快捷键（避免弹窗期间副作用）
      setChecked(prev => {
        if (prev.has(matched.id)) return prev;
        const next = new Set(prev);
        next.add(matched.id);
        if (userId) saveLessonChecked(userId, [...next]);
        return next;
      });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, userId, isMac, onClose]);

  if (!open) return null;

  const handleToggle = (id: string) => {
    if (!userId) return;
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveLessonChecked(userId, [...next]);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 backdrop-blur-[1px] p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={t('home:checklist.shortcutLesson.title')}
    >
      <div className="w-full max-w-md max-h-[80vh] overflow-auto rounded-xl border border-border-default bg-surface-primary shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 border-b border-border-default bg-surface-primary">
          <h2 className="text-sm font-semibold text-fg-primary">{t('checklist.shortcutLesson.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated"
            aria-label={t('common:shortcuts.close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-4 py-3">
          <p className="text-xs text-fg-secondary mb-3">{t('checklist.shortcutLesson.subtitle')}</p>

          {allChecked ? (
            <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3 mb-4">
              <span className="text-green-600 text-base">&#10003;</span>
              <span className="text-sm font-medium text-green-600">{t('checklist.shortcutLesson.allDone')}</span>
            </div>
          ) : (
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 rounded-full transition-all duration-300"
                  style={{ width: `${(checkedCount / SHORTCUT_LESSONS.length) * 100}%` }}
                />
              </div>
              <span className="text-[11px] text-fg-secondary font-medium shrink-0">
                {t('checklist.progress', { done: checkedCount, total: SHORTCUT_LESSONS.length })}
              </span>
            </div>
          )}

          <div className="space-y-4">
            {grouped.map(({ group, items }) => (
              <section key={group}>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">
                  {t(`common:shortcuts.groups.${group}`, { defaultValue: group })}
                </h3>
                <ul className="space-y-1">
                  {items.map(s => {
                    const done = checked.has(s.id);
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => handleToggle(s.id)}
                          className="w-full flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-elevated/60 transition-colors"
                        >
                          <span className="flex items-center gap-2.5 min-w-0">
                            <span className={`shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${done ? 'bg-green-500 border-green-500' : 'border-border-default'}`}>
                              {done && (
                                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </span>
                            <span className={`text-sm min-w-0 ${done ? 'text-fg-tertiary line-through' : 'text-fg-primary'}`}>
                              {t(s.labelKey ?? s.label, { defaultValue: s.label })}
                            </span>
                          </span>
                          <kbd className="shrink-0 px-1.5 py-0.5 rounded bg-surface-elevated border border-border-default text-[11px] font-medium text-fg-primary font-mono">
                            {formatShortcutKeys(s.keys, isMac, s.bare)}
                          </kbd>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>

        <div className="sticky bottom-0 border-t border-border-default bg-surface-primary px-4 py-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className={`px-4 py-2 text-sm rounded-xl transition-colors font-medium ${allChecked ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-brand-600 hover:bg-brand-500 text-white'}`}
          >
            {allChecked ? t('checklist.shortcutLesson.done') : t('common:close')}
          </button>
        </div>
      </div>
    </div>
  );
}