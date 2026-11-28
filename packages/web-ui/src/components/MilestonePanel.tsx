import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type MilestoneInfo } from '../api.ts';
import { ConfirmModal } from './ConfirmModal.tsx';
import { MILESTONE_ALL, MILESTONE_NONE } from '../lib/milestoneScope.ts';

interface MilestonePanelProps {
  projectId: string;
  milestones: MilestoneInfo[];
  /** `MILESTONE_ALL` | `MILESTONE_NONE` | milestone id — owned by the Work page. */
  selected: string;
  onSelect: (next: string) => void;
  /** Re-fetch the list (after create/update/delete). */
  onChanged: () => void;
  /** Notifies the page so a filter pointing at the deleted milestone can reset. */
  onDeleted: (milestoneId: string) => void;
  previewMode?: boolean;
}

interface EditorState {
  id?: string;
  name: string;
  description: string;
  dueDate: string;
}

const emptyEditor = (): EditorState => ({ name: '', description: '', dueDate: '' });

function progressOf(m: MilestoneInfo) {
  return m.progress ?? { total: 0, done: 0, active: 0, blocked: 0, percent: 0 };
}

/** Today's date (local) as YYYY-MM-DD — the unit a milestone's `dueDate` is expressed in. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Milestone section of the project detail panel: the list, the progress of each milestone, and
 * the create/edit/delete affordances.
 *
 * Progress numbers come from the API (`progress`, derived server-side by the single definition)
 * — this component never counts requirements itself. Ties to the board are made by the page via
 * `onSelect`; this component only knows which row is active.
 */
export function MilestonePanel({ projectId, milestones, selected, onSelect, onChanged, onDeleted, previewMode }: MilestonePanelProps) {
  const { t } = useTranslation(['work', 'common']);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<MilestoneInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  const today = todayIso();
  const unassignedCount = milestones.length === 0 ? 0 : undefined;

  /**
   * Errors from the server are diagnostic TEXT, not UI copy — surfacing them raw put a bare
   * English `not found` in the middle of a Chinese panel (Owner report 2026-11-28). Wrap them:
   * localized statement of what failed + the server's detail, which is still what makes a report
   * actionable.
   */
  const describeError = (e: unknown): string =>
    t('work:milestone.actionFailed', { detail: e instanceof ApiError ? e.message : String(e) });

  const openCreate = () => { setError(''); setEditor(emptyEditor()); };
  const openEdit = (m: MilestoneInfo) => {
    setError('');
    setEditor({ id: m.id, name: m.name, description: m.description ?? '', dueDate: m.dueDate ?? '' });
  };

  const save = async () => {
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) { setError(t('work:milestone.nameRequired')); return; }
    setSaving(true);
    setError('');
    try {
      if (editor.id) {
        await api.milestones.update(editor.id, {
          name,
          description: editor.description,
          // Empty input = clear the deadline (explicit null), not "leave as is".
          dueDate: editor.dueDate ? editor.dueDate : null,
        });
      } else {
        await api.milestones.create({
          projectId,
          name,
          description: editor.description || undefined,
          dueDate: editor.dueDate || null,
        });
      }
      setEditor(null);
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError('');
    try {
      await api.milestones.remove(deleteTarget.id);
      setDeleteTarget(null);
      onDeleted(deleteTarget.id);
      onChanged();
    } catch (e) {
      setError(describeError(e));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const rowClass = (active: boolean) =>
    `w-full text-left px-2.5 py-2 rounded-lg transition-all ${active ? 'bg-brand-500/15 text-fg-primary ring-1 ring-brand-500/30' : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-overlay'}`;

  return (
    <section className="bg-surface-elevated rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <h4 className="text-xs font-semibold text-fg-secondary flex-1">{t('work:milestone.title')}</h4>
        {!previewMode && (
          <button type="button" onClick={openCreate}
            className="text-xs px-2 py-1 rounded-md text-fg-secondary hover:text-fg-primary hover:bg-surface-elevated">
            + {t('work:milestone.new')}
          </button>
        )}
      </div>

      <div className="space-y-0.5">
        <button type="button" onClick={() => onSelect(MILESTONE_ALL)} className={rowClass(selected === MILESTONE_ALL)}>
          <span className="text-[13px]">{t('work:milestone.all')}</span>
        </button>
        <button type="button" onClick={() => onSelect(MILESTONE_NONE)} className={rowClass(selected === MILESTONE_NONE)}>
          <span className="text-[13px]">{t('work:milestone.unassigned')}</span>
          {unassignedCount !== undefined && <span className="ml-1 text-[11px] text-fg-tertiary">({unassignedCount})</span>}
        </button>

        {milestones.map(m => {
          const p = progressOf(m);
          const overdue = !!m.dueDate && m.dueDate < today;
          return (
            <div key={m.id} className={`group ${selected === m.id ? 'bg-surface-overlay rounded-md' : ''}`}>
              <div className="flex items-start">
                <button type="button" onClick={() => onSelect(m.id)} className={`${rowClass(selected === m.id)} flex-1 min-w-0`}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] truncate flex-1">{m.name}</span>
                    <span className="text-[11px] text-fg-tertiary tabular-nums shrink-0">{p.done}/{p.total}</span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-surface-elevated overflow-hidden">
                    <div className={`h-full rounded-full transition-[width] ${p.percent === 100 ? 'bg-status-ok' : 'bg-brand-500'}`}
                      style={{ width: `${p.percent}%` }} />
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-tertiary">
                    {m.dueDate
                      ? <span className={overdue ? 'text-status-danger' : ''}>{m.dueDate}</span>
                      : <span>{t('work:milestone.noDeadline')}</span>}
                  </div>
                </button>
                {!previewMode && (
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity pr-1">
                    <button type="button" onClick={() => openEdit(m)} title={t('work:milestone.edit')}
                      className="w-6 h-6 flex items-center justify-center rounded text-fg-tertiary hover:text-fg-primary hover:bg-surface-elevated">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                    </button>
                    <button type="button" onClick={() => { setError(''); setDeleteTarget(m); }} title={t('work:milestone.delete')}
                      className="w-6 h-6 flex items-center justify-center rounded text-fg-tertiary hover:text-status-danger hover:bg-surface-elevated">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {milestones.length === 0 && (
          <p className="px-2.5 py-1 text-[11px] text-fg-tertiary leading-relaxed">{t('work:milestone.emptyHint')}</p>
        )}
      </div>

      {error && <p className="mt-2 text-[11px] text-status-danger">{error}</p>}

      {editor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && setEditor(null)}>
          <div className="bg-surface-primary border border-border-default rounded-xl w-[26rem] max-w-full p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-fg-primary">
              {editor.id ? t('work:milestone.modalEditTitle') : t('work:milestone.modalCreateTitle')}
            </h3>
            <label className="block">
              <span className="text-[11px] text-fg-tertiary">{t('work:milestone.nameField')}</span>
              <input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })}
                placeholder={t('work:milestone.namePlaceholder')} autoFocus
                className="mt-1 w-full px-2.5 py-1.5 text-[13px] rounded-md bg-surface-secondary border border-border-default focus:outline-none focus:border-brand-500" />
            </label>
            <label className="block">
              <span className="text-[11px] text-fg-tertiary">{t('work:milestone.descriptionField')}</span>
              <textarea value={editor.description} onChange={e => setEditor({ ...editor, description: e.target.value })}
                rows={3} placeholder={t('work:milestone.descriptionPlaceholder')}
                className="mt-1 w-full px-2.5 py-1.5 text-[13px] rounded-md bg-surface-secondary border border-border-default focus:outline-none focus:border-brand-500 resize-none" />
            </label>
            <label className="block">
              <span className="text-[11px] text-fg-tertiary">{t('work:milestone.dueDateField')}</span>
              <input type="date" value={editor.dueDate} onChange={e => setEditor({ ...editor, dueDate: e.target.value })}
                className="mt-1 w-full px-2.5 py-1.5 text-[13px] rounded-md bg-surface-secondary border border-border-default focus:outline-none focus:border-brand-500" />
              <span className="block mt-1 text-[11px] text-fg-tertiary">{t('work:milestone.dueDateHint')}</span>
            </label>
            {error && <p className="text-[11px] text-status-danger">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setEditor(null)} disabled={saving}
                className="px-3 py-1.5 text-[13px] rounded-md text-fg-secondary hover:bg-surface-elevated">{t('common:cancel')}</button>
              <button type="button" onClick={() => void save()} disabled={saving}
                className="px-3 py-1.5 text-[13px] rounded-md bg-brand-500 text-on-brand hover:bg-brand-600 disabled:opacity-60">
                {saving ? t('common:saving') : (editor.id ? t('common:save') : t('common:create'))}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title={t('work:milestone.deleteTitle')}
          message={t('work:milestone.deleteConfirm', { name: deleteTarget.name, count: progressOf(deleteTarget).total })}
          confirmLabel={deleting ? t('common:saving') : t('work:milestone.delete')}
          onConfirm={() => void doDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
