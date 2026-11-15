/**
 * `#/audit/facts` — read-only facts audit trail (C9-E).
 *
 * Product rule: **a person never needs the fact layer to do their job** — the board and the inbox
 * derive everything they show. But when a conclusion is questioned ("who said this was done, on
 * what evidence, and who confirmed it?"), the chain has to be readable. That is this page, and it
 * is the only place the fact layer is exposed to a human.
 *
 * Non-negotiables:
 *  · **owner/admin only.** Not mounted for anyone else (the API answers 403 too — hiding a page is
 *    not access control).
 *  · **read-only.** No assert / supersede / verify affordance; those live behind agent tools so
 *    the audit page can never become a second writer.
 *  · **"disabled" is not "empty".** `FACTS_ENABLED=0` renders an explicit notice; an empty table
 *    would read as "no facts exist", which is a different (and false) statement.
 *
 * Read by a person under pressure — so every label answers a question a human would actually ask:
 *
 *  · 「谁」is a **name you can click**, not an id you must decode. Selecting a subject searches by
 *    name (task title / requirement / agent / deliverable) across the org, because nobody knows
 *    that the thing they are asking about is called `tsk_b06a0b33`.
 *  · 「说了什么」is 结论类型 (a conclusion type), never the word 谓词 — that is schema vocabulary,
 *    not human vocabulary. The raw id stays visible in small mono type for engineers, but it is
 *    never the only thing shown.
 *  · 主体类型 and 时间 are **flat button groups**, not dropdowns: a 5-way and a 5-way choice read
 *    faster when they are all visible at once, and both are used constantly while auditing.
 *  · Evidence and value are secondary — collapsed or de-emphasised — so the scan line stays calm.
 *
 * Everything visual resolves from the theme: `border-border-default`, `surface-*`, `fg-*`,
 * `status-ok|warn|danger` (one token per state per theme — dark / light / cyberpunk / mono).
 * No raw `dark:` utilities: this app themes by class, Tailwind's `dark:` follows the OS.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, factsAudit } from '../api.js';
import { navBus } from '../navBus.js';
import { PAGE } from '../routes.js';
import {
  FACT_SUBJECT_KINDS,
  buildFactsQuery,
  describeSupersedeChain,
  indexFacts,
  isIndependentlyVerified,
  parseSourceRef,
  parseWorkUnitRef,
  sortFacts,
  type FactRowView,
} from '../lib/factsAudit.js';

export interface AuditFactsProps {
  /** `undefined` = not signed in. Only `owner` / `admin` may see this page. */
  role?: string;
  authUser?: { id: string; role?: string } | null;
}

export function canViewFactsAudit(role: string | undefined | null): boolean {
  return role === 'owner' || role === 'admin';
}

/** Known conclusion types get a human label; anything else falls through to the raw id. */
const KNOWN_PREDICATES = [
  'task.completion_evidence',
  'task.rejection_reason',
  'requirement.acceptance_met',
  'work.defect_class',
  'agent.capability_claim',
  'memory.consolidation_suggestion',
] as const;

type RangePreset = 'all' | '24h' | '7d' | '30d' | 'custom';

/** One selectable subject: what it is, which id the query needs, and what a person calls it. */
interface SubjectOption {
  kind: string;
  id: string;
  label: string;
}

const FIELD =
  'rounded-lg border border-border-default bg-surface-primary px-2.5 py-1.5 text-[13px] text-fg-primary ' +
  'placeholder:text-fg-muted outline-none transition-colors focus:border-brand-500/60';

/** `2026-11-15T04:40:22.066Z` → `11-15 12:40` (local); full stamp stays in `title`. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `datetime-local` value for "N ms ago", used by the range presets. */
function isoLocal(offsetMs: number): string {
  const d = new Date(Date.now() - offsetMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Where a subject lives in the app, so a name in the audit trail is a door, not a dead end.
 * Routes come from the same `navBus` contract the notification bell uses (`openTask` /
 * `openRequirement` / `agentId` / `openDeliverable`) — no hash format is invented here.
 */
function openSubject(kind: string, id: string): void {
  switch (kind) {
    case 'task': return void navBus.navigate(PAGE.WORK, { openTask: id });
    case 'requirement': return void navBus.navigate(PAGE.WORK, { openRequirement: id });
    case 'agent': return void navBus.navigate(PAGE.TEAM, { agentId: id });
    case 'deliverable': return void navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: id });
    default: return;
  }
}

const NAVIGABLE_KINDS = new Set(['task', 'requirement', 'agent', 'deliverable']);

/**
 * Name index for the subject picker.
 *
 * One lean load per source (ids + names only) instead of a request per keystroke: the dropdown then
 * filters instantly and offline, and every subject kind goes through ONE code path. Capped because
 * this is an admin audit page, not a search engine — and the cap is stated in the UI rather than
 * silently truncating.
 */
function useSubjectIndex(enabled: boolean) {
  const [index, setIndex] = useState<SubjectOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!enabled || !loaded) return;
    let cancelled = false;
    void (async () => {
      const [tasks, reqs, agents, dlvs] = await Promise.allSettled([
        api.tasks.list({ lean: true, pageSize: 300 }),
        api.requirements.list({ lean: true, limit: 300 }),
        api.agents.list({ lean: true }),
        api.deliverables.search({ limit: 300 }),
      ]);
      if (cancelled) return;
      const out: SubjectOption[] = [];
      if (tasks.status === 'fulfilled') {
        for (const t of tasks.value.tasks) out.push({ kind: 'task', id: t.id, label: t.title });
      }
      if (reqs.status === 'fulfilled') {
        for (const r of reqs.value.requirements) out.push({ kind: 'requirement', id: r.id, label: r.title });
      }
      if (agents.status === 'fulfilled') {
        for (const a of agents.value.agents) out.push({ kind: 'agent', id: a.id, label: a.name });
      }
      if (dlvs.status === 'fulfilled') {
        for (const d of dlvs.value.results) out.push({ kind: 'deliverable', id: d.id, label: d.title });
      }
      setIndex(out);
    })();
    return () => { cancelled = true; };
  }, [enabled, loaded]);
  /** Called when the picker is first opened — the name index is not page-load work. */
  return { index, ensure: () => setLoaded(true) };
}

/** One flat choice in a segmented group. Selected state uses the theme's selected-* tokens. */
function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors ${
        active
          ? 'border-selected-border bg-selected-bg font-medium text-selected-fg'
          : 'border-border-default bg-surface-primary text-fg-secondary hover:text-fg-primary'
      }`}
    >
      {children}
    </button>
  );
}

/** Row label for the filter panel: one short question, small and quiet. */
function FilterLabel({ children }: { children: React.ReactNode }) {
  return <span className="w-14 shrink-0 text-[11px] text-fg-tertiary">{children}</span>;
}

export default function AuditFacts({ role, authUser }: AuditFactsProps) {
  const { t } = useTranslation('common');
  const allowed = canViewFactsAudit(role ?? authUser?.role);
  const subjectIndex = useSubjectIndex(allowed);
  const subjectPool = subjectIndex.index;

  /** Selected subject drives the query; `kind` '' = any kind. */
  const [subject, setSubject] = useState<SubjectOption | null>(null);
  const [subjectQuery, setSubjectQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [kindFilter, setKindFilter] = useState(''); // segmented: '' = 全部
  const [predicate, setPredicate] = useState('');
  const [range, setRange] = useState<RangePreset>('all');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [rows, setRows] = useState<FactRowView[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    setError(null);
    try {
      const query = buildFactsQuery({
        // A picked subject is an exact id; the search box above it is how a person finds that id.
        subjectKind: subject ? subject.kind : kindFilter,
        subjectId: subject ? subject.id : '',
        predicate,
        since,
        until,
        includeSuperseded,
        limit: 200,
      });
      const res = await factsAudit.list(query);
      setRows(sortFacts(res.facts ?? []));
      setDisabled(res.disabled === true);
      setTruncated(res.truncated === true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [allowed, subject, kindFilter, predicate, since, until, includeSuperseded]);

  useEffect(() => { void load(); }, [load]);

  const byId = useMemo(() => indexFacts(rows), [rows]);

  const stats = useMemo(() => {
    let verified = 0;
    let superseded = 0;
    for (const r of rows) {
      if (isIndependentlyVerified(r)) verified += 1;
      if (r.supersededBy) superseded += 1;
    }
    return { total: rows.length, verified, superseded };
  }, [rows]);

  /** Name search: substring match on the human label, narrowed by the kind group when one is on. */
  const matches = useMemo(() => {
    const q = subjectQuery.trim().toLowerCase();
    const pool = kindFilter ? subjectPool.filter(s => s.kind === kindFilter) : subjectPool;
    if (!q) return pool.slice(0, 30);
    return pool.filter(s => s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)).slice(0, 30);
  }, [subjectPool, subjectQuery, kindFilter]);

  const pickRange = (next: RangePreset) => {
    setRange(next);
    if (next === 'all') { setSince(''); setUntil(''); return; }
    if (next === '24h') { setSince(isoLocal(24 * 3600_000)); setUntil(''); return; }
    if (next === '7d') { setSince(isoLocal(7 * 24 * 3600_000)); setUntil(''); return; }
    if (next === '30d') { setSince(isoLocal(30 * 24 * 3600_000)); setUntil(''); return; }
  };

  const reset = () => {
    setSubject(null);
    setSubjectQuery('');
    setKindFilter('');
    setPredicate('');
    setRange('all');
    setSince('');
    setUntil('');
    setIncludeSuperseded(false);
  };

  if (!allowed) {
    // Deliberately not an error page: an unauthorized deep link must not confirm that this page
    // (or a fact) exists. It simply is not this user's page.
    return null;
  }

  const predicateLabel = (p: string): string =>
    (KNOWN_PREDICATES as readonly string[]).includes(p)
      ? t(`factsAudit.predicateName.${p.replace(/\./g, '_')}`, { defaultValue: p })
      : p;
  const kindLabel = (k: string): string => t(`factsAudit.kind.${k}`, { defaultValue: k });

  return (
    <div className="h-full overflow-y-auto" data-testid="audit-facts">
      <div className="mx-auto max-w-4xl px-6 py-7">
        <header className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight text-fg-primary">{t('factsAudit.title')}</h1>
          <p className="max-w-2xl text-[13px] leading-relaxed text-fg-secondary">{t('factsAudit.subtitle')}</p>
        </header>

        <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12px] text-fg-tertiary">
          <span>
            <span className="tabular-nums font-medium text-fg-primary">{stats.total}</span> {t('factsAudit.statTotal')}
          </span>
          <span>
            <span className="tabular-nums font-medium text-status-ok">{stats.verified}</span> {t('factsAudit.statVerified')}
          </span>
          <span>
            <span className="tabular-nums font-medium text-fg-primary">{stats.superseded}</span> {t('factsAudit.statSuperseded')}
          </span>
        </div>

        <section
          className="mt-4 space-y-2 rounded-xl border border-border-default bg-surface-secondary/50 p-3"
          data-testid="audit-facts-filters"
        >
          {/* 主体 —— 先按名字找，选中后才用 id 过滤 */}
          <div className="flex items-start gap-2">
            <FilterLabel>{t('factsAudit.fSubject')}</FilterLabel>
            <div className="relative min-w-0 flex-1">
              {subject ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-selected-border bg-selected-bg px-2.5 py-1.5">
                  <span className="shrink-0 rounded bg-surface-primary/60 px-1.5 py-0.5 text-[10px] text-fg-secondary">
                    {kindLabel(subject.kind)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-selected-fg">{subject.label}</span>
                  <button
                    type="button"
                    onClick={() => { setSubject(null); setSubjectQuery(''); }}
                    className="shrink-0 rounded px-1 text-fg-secondary transition-colors hover:text-fg-primary"
                    aria-label={t('factsAudit.clearSubject')}
                  >
                    ×
                  </button>
                </div>
              ) : (
                <>
                  <input
                    className={`${FIELD} w-full`}
                    value={subjectQuery}
                    onChange={e => { subjectIndex.ensure(); setSubjectQuery(e.target.value); setPickerOpen(true); }}
                    onFocus={() => { subjectIndex.ensure(); setPickerOpen(true); }}
                    onBlur={() => window.setTimeout(() => setPickerOpen(false), 120)}
                    placeholder={t('factsAudit.subjectSearchPlaceholder')}
                    aria-label={t('factsAudit.subjectSearchPlaceholder')}
                  />
                  {pickerOpen && (
                    <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border-default bg-surface-elevated py-1 shadow-lg">
                      {matches.length === 0 ? (
                        <p className="px-3 py-2 text-[12px] text-fg-tertiary">{t('factsAudit.subjectNoMatch')}</p>
                      ) : (
                        matches.map(m => (
                          <button
                            key={`${m.kind}:${m.id}`}
                            type="button"
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => {
                              setSubject(m);
                              setSubjectQuery('');
                              setPickerOpen(false);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-overlay"
                          >
                            <span className="shrink-0 rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] text-fg-tertiary">
                              {kindLabel(m.kind)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[13px] text-fg-primary">{m.label}</span>
                            <span className="shrink-0 font-mono text-[10px] text-fg-muted">{m.id}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 主体类型 —— 平铺按钮组 */}
          <div className="flex items-start gap-2">
            <FilterLabel>{t('factsAudit.fKind')}</FilterLabel>
            <div className="flex flex-wrap gap-1.5">
              <SegButton active={kindFilter === ''} onClick={() => { setKindFilter(''); setSubject(null); }}>
                {t('factsAudit.kindAll')}
              </SegButton>
              {FACT_SUBJECT_KINDS.map(k => (
                <SegButton
                  key={k}
                  active={kindFilter === k}
                  onClick={() => { setKindFilter(k); if (subject && subject.kind !== k) setSubject(null); }}
                >
                  {kindLabel(k)}
                </SegButton>
              ))}
            </div>
          </div>

          {/* 结论类型 —— 规整下拉（不是自由文本，也不再叫「谓词」） */}
          <div className="flex items-center gap-2">
            <FilterLabel>{t('factsAudit.fConclusion')}</FilterLabel>
            <select
              className={`${FIELD} min-w-[220px]`}
              value={predicate}
              onChange={e => setPredicate(e.target.value)}
              aria-label={t('factsAudit.fConclusion')}
            >
              <option value="">{t('factsAudit.conclusionAll')}</option>
              {KNOWN_PREDICATES.map(p => (
                <option key={p} value={p}>{predicateLabel(p)}（{p}）</option>
              ))}
            </select>
          </div>

          {/* 时间范围 —— 平铺按钮组 */}
          <div className="flex items-start gap-2">
            <FilterLabel>{t('factsAudit.fTime')}</FilterLabel>
            <div className="flex flex-wrap items-center gap-1.5">
              <SegButton active={range === 'all'} onClick={() => pickRange('all')}>{t('factsAudit.rangeAll')}</SegButton>
              <SegButton active={range === '24h'} onClick={() => pickRange('24h')}>{t('factsAudit.range24h')}</SegButton>
              <SegButton active={range === '7d'} onClick={() => pickRange('7d')}>{t('factsAudit.range7d')}</SegButton>
              <SegButton active={range === '30d'} onClick={() => pickRange('30d')}>{t('factsAudit.range30d')}</SegButton>
              <SegButton active={range === 'custom'} onClick={() => setRange('custom')}>
                {t('factsAudit.rangeCustom')}
              </SegButton>
            </div>
          </div>

          {range === 'custom' && (
            <div className="flex flex-wrap items-center gap-3 pl-16">
              <label className="flex items-center gap-2 text-[11px] text-fg-tertiary">
                {t('factsAudit.since')}
                <input type="datetime-local" className={FIELD} value={since} onChange={e => setSince(e.target.value)} />
              </label>
              <label className="flex items-center gap-2 text-[11px] text-fg-tertiary">
                {t('factsAudit.until')}
                <input type="datetime-local" className={FIELD} value={until} onChange={e => setUntil(e.target.value)} />
              </label>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-border-subtle pt-2">
            <label className="flex items-center gap-1.5 text-[12px] text-fg-secondary">
              <input
                type="checkbox"
                className="accent-current"
                checked={includeSuperseded}
                onChange={e => setIncludeSuperseded(e.target.checked)}
              />
              {t('factsAudit.includeSuperseded')}
            </label>
            <button
              type="button"
              onClick={reset}
              className="ml-auto rounded-lg px-2.5 py-1 text-[12.5px] text-fg-tertiary transition-colors hover:text-fg-primary"
            >
              {t('factsAudit.reset')}
            </button>
          </div>
        </section>

        {disabled && (
          <p
            className="mt-3 rounded-lg border border-status-warn/30 bg-status-warn/10 px-3 py-2 text-[12px] leading-relaxed text-fg-primary"
            data-testid="audit-facts-disabled"
          >
            {t('factsAudit.disabled')}
          </p>
        )}
        {error && (
          <p
            className="mt-3 rounded-lg border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-[12px] text-fg-primary"
            data-testid="audit-facts-error"
          >
            {error}
          </p>
        )}

        {loading && (
          <div className="mt-3 overflow-hidden rounded-xl border border-border-default" data-testid="audit-facts-loading">
            {[0, 1, 2].map(i => (
              <div key={i} className="border-b border-border-subtle px-4 py-3 last:border-b-0">
                <div className="h-3 w-40 animate-pulse rounded bg-surface-overlay" />
                <div className="mt-2 h-2.5 w-64 animate-pulse rounded bg-surface-overlay/70" />
              </div>
            ))}
          </div>
        )}

        {!disabled && !loading && rows.length === 0 && !error && (
          <div
            className="mt-3 rounded-xl border border-dashed border-border-default px-4 py-12 text-center"
            data-testid="audit-facts-empty"
          >
            <p className="text-[13px] text-fg-secondary">{t('factsAudit.empty')}</p>
            <p className="mt-1 text-[11px] text-fg-tertiary">{t('factsAudit.emptyHint')}</p>
          </div>
        )}

        {rows.length > 0 && (
          <div
            className="mt-3 overflow-hidden rounded-xl border border-border-default bg-surface-primary"
            data-testid="audit-facts-table"
          >
            {truncated && (
              <p className="border-b border-border-subtle bg-surface-secondary/60 px-4 py-1.5 text-[11px] text-fg-tertiary" data-testid="audit-facts-truncated">
                {t('factsAudit.truncated')}
              </p>
            )}
            {rows.map(row => {
              const chain = describeSupersedeChain(row, byId);
              const superseded = Boolean(row.supersededBy);
              const verified = isIndependentlyVerified(row);
              const wu = row.workUnitRef ? parseWorkUnitRef(row.workUnitRef) : null;
              const canOpen = NAVIGABLE_KINDS.has(row.subjectKind);
              const subjectText = row.subjectLabel || row.subjectId;
              return (
                <article
                  key={row.id}
                  id={`fact-${row.id}`}
                  className="border-b border-border-subtle px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-secondary/40"
                  data-testid="audit-facts-row"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      {/* 说了什么 —— 人话在前，原始 id 在后（留给工程排查，但绝不是唯一信息） */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[13px] font-medium text-fg-primary">{predicateLabel(row.predicate)}</span>
                        <span className="font-mono text-[11px] text-fg-muted" title={row.predicate}>{row.predicate}</span>
                      </div>
                      {/* 关于谁 —— 可点击跳到详情页 */}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-tertiary">
                        <span className="shrink-0">{kindLabel(row.subjectKind)}</span>
                        {canOpen ? (
                          <button
                            type="button"
                            onClick={() => openSubject(row.subjectKind, row.subjectId)}
                            title={t('factsAudit.openSubject', { id: row.subjectId })}
                            className="max-w-[26rem] truncate text-left text-[12px] font-medium text-brand-500 underline decoration-brand-500/30 underline-offset-2 transition-colors hover:decoration-brand-500"
                          >
                            {subjectText}
                          </button>
                        ) : (
                          <span className="max-w-[26rem] truncate text-fg-secondary" title={row.subjectId}>{subjectText}</span>
                        )}
                        <span aria-hidden>·</span>
                        <span>{t('factsAudit.by', { name: row.assertedByName || row.assertedBy })}</span>
                        <span aria-hidden>·</span>
                        <span title={row.createdAt}>{shortTime(row.createdAt)}</span>
                        {wu && (
                          <>
                            <span aria-hidden>·</span>
                            <span title={row.workUnitRef}>
                              {wu.kind === 'session'
                                ? (wu.round ? t('factsAudit.wu.sessionRound', { round: wu.round }) : t('factsAudit.wu.session'))
                                : wu.kind === 'a2a' ? t('factsAudit.wu.a2a') : wu.value}
                            </span>
                          </>
                        )}
                        <span aria-hidden>·</span>
                        <span className="tabular-nums" title={t('factsAudit.confidence')}>
                          {t('factsAudit.confidenceShort', { pct: Math.round((row.confidence ?? 0) * 100) })}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {superseded ? (
                        <span className="rounded-full border border-status-danger/30 bg-status-danger/10 px-2 py-0.5 text-[11px] font-medium text-status-danger">
                          {t('factsAudit.superseded')}
                        </span>
                      ) : row.verification ? (
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                            verified
                              ? 'border-status-ok/30 bg-status-ok/10 text-status-ok'
                              : 'border-status-warn/30 bg-status-warn/10 text-status-warn'
                          }`}
                          title={t('factsAudit.verificationTitle')}
                        >
                          {row.verification.result} · {row.verification.verifiedByName || row.verification.verifiedBy}
                          {row.verification.verifiedAt ? ` · ${shortTime(row.verification.verifiedAt)}` : ''}
                        </span>
                      ) : (
                        <span className="rounded-full border border-border-default bg-surface-secondary px-2 py-0.5 text-[11px] text-fg-tertiary">
                          {t('factsAudit.unverified')}
                        </span>
                      )}
                      {chain.outgoing && (
                        <span
                          className="text-[10.5px] text-fg-tertiary"
                          title={chain.outgoing.factId}
                          data-testid="audit-facts-chain-out"
                        >
                          {chain.outgoing.missing
                            ? t('factsAudit.chain.replacedByUnknown')
                            : t('factsAudit.chain.replacedBy', { time: shortTime(chain.outgoing.at ?? '') })}
                        </span>
                      )}
                      {chain.incoming && (
                        <span
                          className="text-[10.5px] text-fg-tertiary"
                          title={chain.incoming.factId}
                          data-testid="audit-facts-chain-in"
                        >
                          {t('factsAudit.chain.replaces', { time: shortTime(chain.incoming.at ?? '') })}
                        </span>
                      )}
                    </div>
                  </div>

                  {row.sourceRefs?.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[10.5px] uppercase tracking-wide text-fg-muted">{t('factsAudit.evidence')}</span>
                      {row.sourceRefs.map(ref => {
                        const src = parseSourceRef(ref);
                        const text =
                          src.kind === 'commit' ? t('factsAudit.src.commit', { hash: src.hash })
                          : src.kind === 'probe' ? t('factsAudit.src.probe')
                          : src.kind === 'task' ? t('factsAudit.src.task')
                          : src.kind === 'deliverable' ? t('factsAudit.src.deliverable')
                          : src.value;
                        const openable =
                          (src.kind === 'task' && ref.startsWith('task:')) ||
                          (src.kind === 'deliverable' && ref.startsWith('deliverable:'));
                        const refId = ref.slice(ref.indexOf(':') + 1);
                        const chip = 'rounded border border-border-subtle bg-surface-secondary px-1.5 py-0.5 text-[10.5px] text-fg-secondary';
                        return openable ? (
                          <button
                            key={ref}
                            type="button"
                            title={ref}
                            onClick={() => openSubject(src.kind, refId)}
                            className={`${chip} underline decoration-fg-muted/40 underline-offset-2 transition-colors hover:text-fg-primary`}
                          >
                            {text}
                          </button>
                        ) : (
                          <span key={ref} title={ref} className={chip}>{text}</span>
                        );
                      })}
                    </div>
                  )}

                  <details className="group mt-1.5">
                    <summary className="cursor-pointer select-none text-[11px] text-fg-tertiary transition-colors hover:text-fg-secondary">
                      {t('factsAudit.colValue')}
                    </summary>
                    <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-border-subtle bg-surface-secondary/60 p-2.5 font-mono text-[11px] leading-relaxed text-fg-secondary">
{JSON.stringify(row.value, null, 2)}
                    </pre>
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
