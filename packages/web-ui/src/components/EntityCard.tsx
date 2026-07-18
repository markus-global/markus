import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { DeliverableInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { DeliverableDetailModal } from './DeliverableDetailModal.tsx';

// ─── Entity types & metadata ─────────────────────────────────────────────────

export type EntityType = 'task' | 'requirement' | 'project' | 'deliverable' | 'agent' | 'team';

const PREFIX_TO_TYPE: Record<string, EntityType> = {
  tsk: 'task', req: 'requirement', proj: 'project', dlv: 'deliverable', agt: 'agent', team: 'team',
};

/** Chip href type name (e.g. `task:tsk_…`) → canonical entity type. */
export function chipTypeToEntityType(chipType: string): EntityType | undefined {
  const map: Record<string, EntityType> = {
    task: 'task', requirement: 'requirement', project: 'project',
    deliverable: 'deliverable', agent: 'agent', team: 'team',
  };
  return map[chipType];
}

export const ENTITY_TYPE_ICON: Record<EntityType, string> = {
  task: '📋', requirement: '📝', project: '📁', deliverable: '📦', agent: '🤖', team: '👥',
};

export const ENTITY_TYPE_LABEL: Record<EntityType, string> = {
  task: 'Task', requirement: 'Requirement', project: 'Project', deliverable: 'Deliverable', agent: 'Agent', team: 'Team',
};

const ENTITY_ID_RE = /^(tsk|req|proj|dlv|agt|team)_[a-f0-9]{6,}$/i;

export function looksLikeEntityId(text: string): boolean {
  return ENTITY_ID_RE.test(text.trim());
}

export function entityTypeFromId(id: string): EntityType | undefined {
  const prefix = id.split('_')[0]?.toLowerCase();
  return prefix ? PREFIX_TO_TYPE[prefix] : undefined;
}

/** Navigate to the in-app page for a given entity id (hash routing via navBus). */
export function navigateToEntity(id: string): void {
  if (id.startsWith('tsk_')) navBus.navigate(PAGE.WORK, { openTask: id });
  else if (id.startsWith('req_')) navBus.navigate(PAGE.WORK, { openRequirement: id });
  else if (id.startsWith('proj_')) navBus.navigate(PAGE.WORK, { projectId: id });
  else if (id.startsWith('dlv_')) navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: id });
  else if (id.startsWith('agt_')) navBus.navigate(PAGE.TEAM, { agentId: id });
  else if (id.startsWith('team_')) navBus.navigate(PAGE.TEAM, { selectTeam: id });
}

// ─── Async resolution (cached) ───────────────────────────────────────────────

export interface ResolvedEntity {
  id: string;
  type: EntityType;
  title: string;
  status?: string;
  summary?: string;
  loading: boolean;
  notFound?: boolean;
  deliverable?: DeliverableInfo;
}

const cache = new Map<string, ResolvedEntity>();
const inflight = new Map<string, Promise<ResolvedEntity>>();

async function fetchEntity(id: string, type: EntityType): Promise<ResolvedEntity> {
  const base: ResolvedEntity = { id, type, title: id, loading: false };
  try {
    switch (type) {
      case 'task': { const r = await api.tasks.get(id); return { ...base, title: r.task.title, status: r.task.status }; }
      case 'requirement': { const r = await api.requirements.get(id); return { ...base, title: r.requirement.title, status: r.requirement.status }; }
      case 'project': { const r = await api.projects.get(id); return { ...base, title: r.project.name, status: r.project.status, summary: r.project.description }; }
      case 'deliverable': { const r = await api.deliverables.get(id); return { ...base, title: r.deliverable.title, status: r.deliverable.status, summary: r.deliverable.summary, deliverable: r.deliverable }; }
      case 'agent': { const r = await api.agents.get(id); return { ...base, title: r.name, summary: r.role }; }
      case 'team': { const r = await api.teams.list(); const t = r.teams.find(x => x.id === id); return { ...base, title: t?.name ?? id, notFound: !t }; }
    }
  } catch { /* fallthrough to notFound */ }
  return { ...base, notFound: true };
}

/** Resolve an entity's display metadata, cached across the session. */
export function useEntityMeta(id: string, typeHint?: EntityType): ResolvedEntity {
  const type = typeHint ?? entityTypeFromId(id);
  const [meta, setMeta] = useState<ResolvedEntity>(() =>
    cache.get(id) ?? { id, type: type ?? 'task', title: id, loading: !!type });

  useEffect(() => {
    if (!type) { setMeta({ id, type: 'task', title: id, loading: false, notFound: true }); return; }
    const cached = cache.get(id);
    if (cached) { setMeta(cached); return; }
    setMeta(m => ({ ...m, type, loading: true }));
    let active = true;
    let p = inflight.get(id);
    if (!p) { p = fetchEntity(id, type); inflight.set(id, p); }
    p.then(res => {
      cache.set(id, res); inflight.delete(id);
      if (active) setMeta(res);
    }).catch(() => {
      inflight.delete(id);
      if (active) setMeta({ id, type, title: id, loading: false, notFound: true });
    });
    return () => { active = false; };
  }, [id, type]);

  return meta;
}

function shortId(id: string): string {
  const prefixLen = (id.split('_')[0]?.length ?? 3) + 1;
  return id.length > prefixLen + 8 ? `${id.slice(0, prefixLen + 8)}…` : id;
}

// ─── Inline chip ─────────────────────────────────────────────────────────────

/**
 * Inline chip for an internal resource reference. Resolves and displays the
 * entity's title; falls back to a truncated id while loading / when unresolved.
 * Pass `label` to force a display string (e.g. for titled `[Title](task:id)` links).
 */
export function EntityChip({ id, type: typeHint, label }: { id: string; type?: EntityType; label?: React.ReactNode }) {
  const meta = useEntityMeta(id, typeHint);
  const icon = ENTITY_TYPE_ICON[meta.type] ?? '🔗';
  const display = label ?? (meta.loading || meta.notFound ? shortId(id) : meta.title);
  return (
    <span
      data-entity-link={id}
      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-brand-500/10 text-brand-500 text-xs font-medium cursor-pointer hover:bg-brand-500/20 transition-colors align-baseline"
      onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); navigateToEntity(id); }}
      title={`${ENTITY_TYPE_LABEL[meta.type]}: ${meta.notFound ? id : meta.title} (${id})`}
    >
      <span className="text-[10px]">{icon}</span>
      <span className="truncate max-w-[240px] align-baseline">{display}</span>
    </span>
  );
}

// ─── Block card ──────────────────────────────────────────────────────────────

/**
 * Rich block-level card for an internal resource reference that appears alone on
 * its own line/paragraph. Deliverables open a detail modal; others navigate.
 */
export function EntityCard({ id, type: typeHint, label }: { id: string; type?: EntityType; label?: string }) {
  const meta = useEntityMeta(id, typeHint);
  const [showDeliverable, setShowDeliverable] = useState(false);
  const icon = ENTITY_TYPE_ICON[meta.type] ?? '🔗';

  const handleClick = () => {
    if (meta.type === 'deliverable' && meta.deliverable) { setShowDeliverable(true); return; }
    navigateToEntity(id);
  };

  const title = meta.loading
    ? shortId(id)
    : (label || (meta.notFound ? id : meta.title));

  return (
    <span className="not-prose block my-2">
      <button
        type="button"
        onClick={handleClick}
        className="w-full max-w-md text-left rounded-xl border border-border-default bg-surface-elevated/30 hover:border-brand-500/40 hover:bg-surface-elevated/50 transition-colors px-3 py-2.5 flex items-start gap-2.5"
      >
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-sm shrink-0 bg-brand-500/10">{icon}</span>
        <span className="flex-1 min-w-0 block">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-fg-tertiary font-medium">{ENTITY_TYPE_LABEL[meta.type]}</span>
            {meta.status && <span className="px-1.5 py-0.5 text-[10px] rounded font-medium bg-brand-500/10 text-brand-500">{meta.status}</span>}
          </span>
          <span className={`block text-sm font-medium truncate mt-0.5 ${meta.notFound ? 'font-mono text-fg-tertiary' : 'text-fg-primary'}`}>{title}</span>
          {meta.summary && meta.summary.trim() !== meta.title.trim() && <span className="block text-xs text-fg-tertiary mt-0.5 line-clamp-1">{meta.summary}</span>}
        </span>
        <svg className="w-4 h-4 text-fg-tertiary shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {showDeliverable && meta.deliverable && (
        <DeliverableDetailModal
          item={meta.deliverable}
          onClose={() => setShowDeliverable(false)}
          onOpenInPage={(did) => { setShowDeliverable(false); navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: did }); }}
        />
      )}
    </span>
  );
}
