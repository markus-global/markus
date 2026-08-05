import { useTranslation } from 'react-i18next';
import type { ProjectInfo } from '../api.ts';

export interface ProjectSidebarProps {
  projects: ProjectInfo[];
  selectedProjectId: string | null;
  /** When true, the "All" row is selected (no single project). */
  allSelected?: boolean;
  taskCounts: Record<string, number>;
  totalTaskCount?: number;
  onSelectAll?: () => void;
  onSelectProject: (projectId: string) => void;
  onCreateProject: () => void;
  onCollapse?: () => void;
  width?: number;
  onResizeStart?: (e: React.MouseEvent) => void;
  hidden?: boolean;
  focused?: boolean;
}

export function ProjectSidebar({
  projects,
  selectedProjectId,
  allSelected,
  taskCounts,
  totalTaskCount,
  onSelectAll,
  onSelectProject,
  onCreateProject,
  onCollapse,
  width,
  onResizeStart,
  hidden,
  focused,
}: ProjectSidebarProps) {
  const { t } = useTranslation(['work', 'common']);
  const allIsSelected = allSelected ?? selectedProjectId == null;

  return (
    <>
      <div
        className="bg-surface-primary flex flex-col shrink-0 border-r border-border-default/60"
        style={hidden ? { display: 'none' } : width != null ? { width } : undefined}
      >
        <div data-electron-drag className="px-3 h-14 flex items-center shrink-0 gap-2">
          {onCollapse && (
            <button
              type="button"
              data-no-drag
              onClick={onCollapse}
              className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors shrink-0 bg-brand-500/15 text-brand-500 hover:bg-brand-500/25"
              title={t('common:shortcuts.toggleLeft')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
          )}
          <h2 className="text-sm font-semibold text-fg-primary truncate">
            {t('work:task.projects', { defaultValue: 'Projects' })}
          </h2>
          <button
            type="button"
            data-no-drag
            onClick={onCreateProject}
            className="ml-auto w-7 h-7 flex items-center justify-center rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated transition-colors"
            title={t('work:project.newProject')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
          {projects.length === 0 ? (
            <div className="px-2 py-8 text-center space-y-3">
              <div className="w-10 h-10 mx-auto rounded-xl bg-brand-500/10 flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-brand-500">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p className="text-[11px] text-fg-tertiary leading-relaxed px-1">
                {t('work:task.emptyNoProjectsHint')}
              </p>
              <button
                type="button"
                onClick={onCreateProject}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg font-medium transition-colors"
              >
                {t('work:project.newProject')}
              </button>
            </div>
          ) : (
            <>
              {onSelectAll && (
                <button
                  type="button"
                  data-project-id="__all__"
                  onClick={onSelectAll}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                    allIsSelected
                      ? focused
                        ? 'bg-brand-500/20 ring-1 ring-brand-500/40 text-brand-500'
                        : 'bg-brand-500/15 text-brand-600'
                      : 'text-fg-secondary hover:bg-surface-elevated hover:text-fg-primary'
                  }`}
                >
                  <span className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                    allIsSelected ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-secondary'
                  }`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                      <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium truncate">{t('work:task.all')}</span>
                  </span>
                  {(totalTaskCount ?? 0) > 0 && (
                    <span className="text-[10px] text-fg-tertiary tabular-nums shrink-0">{totalTaskCount}</span>
                  )}
                </button>
              )}
              {projects.map(p => {
                const selected = !allIsSelected && p.id === selectedProjectId;
                const count = taskCounts[p.id] ?? 0;
                const paused = p.status === 'paused';
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-project-id={p.id}
                    onClick={() => onSelectProject(p.id)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                      selected
                        ? focused
                          ? 'bg-brand-500/20 ring-1 ring-brand-500/40 text-brand-500'
                          : 'bg-brand-500/15 text-brand-600'
                        : 'text-fg-secondary hover:bg-surface-elevated hover:text-fg-primary'
                    }`}
                  >
                    <span className={`w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0 ${
                      selected ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-secondary'
                    }`}>
                      {p.name[0]?.toUpperCase() ?? '?'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium truncate">{p.name}</span>
                      {paused && (
                        <span className="block text-[10px] text-amber-500/80">{t('work:project.statusPaused')}</span>
                      )}
                    </span>
                    {count > 0 && (
                      <span className="text-[10px] text-fg-tertiary tabular-nums shrink-0">{count}</span>
                    )}
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
      {!hidden && onResizeStart && (
        <div
          className="w-1.5 shrink-0 cursor-col-resize group relative flex items-center justify-center"
          onMouseDown={onResizeStart}
        >
          <div className="w-px h-2/3 border-l border-dashed border-transparent group-hover:border-border-default group-active:border-fg-tertiary transition-colors" />
        </div>
      )}
    </>
  );
}
