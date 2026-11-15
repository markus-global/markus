/**
 * `#/audit/facts` — read-only facts audit trail (C9-E).
 *
 * Product rule: **a person never needs the fact layer to do their job** — the board and the inbox
 * derive everything they show. But when a conclusion is questioned ("who said this was done, on
 * what evidence, and who confirmed it?"), the chain has to be readable. That is this page, and it
 * is the only place the fact layer is exposed to a human.
 *
 * Non-negotiables encoded here:
 *
 *  · **owner/admin only.** The page is not mounted for anyone else (and the API answers 403 as
 *    well — hiding a page is not access control).
 *  · **read-only.** There is no assert / supersede / verify affordance; those live behind agent
 *    tools so the audit page can never become a second writer.
 *  · **"disabled" is not "empty".** `FACTS_ENABLED=0` renders an explicit notice; an empty table
 *    would read as "no facts exist", which is a different (and false) statement.
 *
 * Layout intent (2026-11-15, Owner: "很丑"): the audit trail is *read by a person under pressure*,
 * so the hierarchy must answer three questions top-down — 谁的结论（谓词 + 主体）→ 凭什么（证据 /
 * 验证）→ 具体值是什么（折叠，默认不展开）。Filters are one compact row; the value blob never
 * competes with the headline. Everything below is presentation only: no query semantics live here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { factsAudit } from '../api.js';
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

const FIELD =
  'mt-1 w-full rounded-md border border-line bg-surface-primary px-2.5 py-1.5 text-sm text-fg-primary ' +
  'outline-none transition-colors focus:border-fg-tertiary/50';
const LABEL = 'block text-[11px] font-medium uppercase tracking-wide text-fg-tertiary';

/** `2026-11-15T04:40:22.066Z` → `11-15 12:40` (local), with the full stamp kept in `title`. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AuditFacts({ role, authUser }: AuditFactsProps) {
  const { t } = useTranslation('common');
  const allowed = canViewFactsAudit(role ?? authUser?.role);

  const [subjectKind, setSubjectKind] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [predicate, setPredicate] = useState('');
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
      const query = buildFactsQuery({ subjectKind, subjectId, predicate, since, until, includeSuperseded, limit: 200 });
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
  }, [allowed, subjectKind, subjectId, predicate, since, until, includeSuperseded]);

  useEffect(() => { void load(); }, [load]);

  const byId = useMemo(() => indexFacts(rows), [rows]);

  const reset = () => {
    setSubjectKind('');
    setSubjectId('');
    setPredicate('');
    setSince('');
    setUntil('');
    setIncludeSuperseded(false);
  };

  if (!allowed) {
    // Deliberately not an error page: an unauthorized deep link must not confirm that this page
    // (or a fact) exists. It simply is not this user's page.
    return null;
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="audit-facts">
      <div className="mx-auto max-w-5xl px-6 py-6 space-y-5">
        <header className="flex items-start justify-between gap-4 border-b border-line pb-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-fg-primary">{t('factsAudit.title')}</h1>
            <p className="max-w-2xl text-sm leading-relaxed text-fg-tertiary">{t('factsAudit.subtitle')}</p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-2xl font-semibold tabular-nums text-fg-primary">{rows.length}</div>
            <div className="text-[11px] uppercase tracking-wide text-fg-tertiary">{t('factsAudit.countLabel')}</div>
          </div>
        </header>

        <section className="rounded-xl border border-line bg-surface-secondary/40 p-3" data-testid="audit-facts-filters">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <label className={LABEL}>
              {t('factsAudit.subjectKind')}
              <select className={FIELD} value={subjectKind} onChange={e => setSubjectKind(e.target.value)}>
                <option value="">{t('factsAudit.any')}</option>
                {FACT_SUBJECT_KINDS.map(k => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className={`${LABEL} col-span-2`}>
              {t('factsAudit.subjectId')}
              <input
                className={`${FIELD} font-mono text-xs`}
                value={subjectId}
                onChange={e => setSubjectId(e.target.value)}
                placeholder="tsk_… / agt_…"
              />
            </label>
            <label className={`${LABEL} col-span-2`}>
              {t('factsAudit.predicate')}
              <input
                className={`${FIELD} font-mono text-xs`}
                value={predicate}
                onChange={e => setPredicate(e.target.value)}
                placeholder="task.completion_evidence"
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={reset}
                className="w-full rounded-md border border-line px-2.5 py-1.5 text-sm text-fg-secondary transition-colors hover:bg-surface-secondary hover:text-fg-primary"
              >
                {t('factsAudit.reset')}
              </button>
            </div>
            <label className={LABEL}>
              {t('factsAudit.since')}
              <input type="datetime-local" className={FIELD} value={since} onChange={e => setSince(e.target.value)} />
            </label>
            <label className={LABEL}>
              {t('factsAudit.until')}
              <input type="datetime-local" className={FIELD} value={until} onChange={e => setUntil(e.target.value)} />
            </label>
            <label className="col-span-2 flex items-center gap-2 self-end text-xs text-fg-secondary md:col-span-4">
              <input
                type="checkbox"
                className="accent-current"
                checked={includeSuperseded}
                onChange={e => setIncludeSuperseded(e.target.checked)}
              />
              {t('factsAudit.includeSuperseded')}
            </label>
          </div>
        </section>

        {disabled && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-fg-primary" data-testid="audit-facts-disabled">
            {t('factsAudit.disabled')}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-fg-primary" data-testid="audit-facts-error">
            {error}
          </div>
        )}
        {loading && <div className="text-sm text-fg-tertiary">{t('loading')}</div>}
        {truncated && !loading && (
          <div className="text-xs text-fg-tertiary" data-testid="audit-facts-truncated">{t('factsAudit.truncated')}</div>
        )}

        {!disabled && !loading && rows.length === 0 && !error && (
          <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-fg-tertiary" data-testid="audit-facts-empty">
            {t('factsAudit.empty')}
          </div>
        )}

        {rows.length > 0 && (
          <div className="space-y-2.5" data-testid="audit-facts-table">
            {rows.map(row => {
              const chain = describeSupersedeChain(row, byId);
              const superseded = Boolean(row.supersededBy);
              const verified = isIndependentlyVerified(row);
              return (
                <article
                  key={row.id}
                  id={`fact-${row.id}`}
                  className="rounded-xl border border-line bg-surface-primary p-3.5 transition-colors hover:bg-surface-secondary/30"
                  data-testid="audit-facts-row"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-surface-secondary px-2 py-0.5 font-mono text-xs font-medium text-fg-primary">
                      {row.predicate}
                    </span>
                    {row.verification ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          verified
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                            : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {row.verification.result} · {row.verification.verifiedByName || row.verification.verifiedBy}
                        {row.verification.verifiedAt ? ` · ${shortTime(row.verification.verifiedAt)}` : ''}
                      </span>
                    ) : (
                      <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] text-fg-tertiary">
                        {t('factsAudit.unverified')}
                      </span>
                    )}
                    {superseded && (
                      <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] text-fg-tertiary">
                        {t('factsAudit.superseded')}
                      </span>
                    )}
                    <span
                      className="ml-auto max-w-[45%] truncate text-[11px] text-fg-secondary"
                      title={`${row.subjectKind}:${row.subjectId}`}
                    >
                      {row.subjectLabel || `${row.subjectKind}:${row.subjectId}`}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-tertiary">
                    <span title={row.createdAt}>{shortTime(row.createdAt)}</span>
                    <span title={row.assertedBy}>{row.assertedByName || row.assertedBy}</span>
                    {row.workUnitRef && (
                      <span className="opacity-80" title={row.workUnitRef}>
                        {(() => {
                          const wu = parseWorkUnitRef(row.workUnitRef);
                          if (wu.kind === 'session') {
                            return wu.round
                              ? t('factsAudit.wu.sessionRound', { round: wu.round })
                              : t('factsAudit.wu.session');
                          }
                          if (wu.kind === 'a2a') return t('factsAudit.wu.a2a');
                          return wu.value;
                        })()}
                      </span>
                    )}
                    <span className="tabular-nums">{Math.round((row.confidence ?? 0) * 100)}%</span>
                    {chain.outgoing && <span data-testid="audit-facts-chain-out">{chain.outgoing}</span>}
                    {chain.incoming && <span data-testid="audit-facts-chain-in">{chain.incoming}</span>}
                  </div>

                  {row.sourceRefs?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {row.sourceRefs.map(ref => {
                        const src = parseSourceRef(ref);
                        const text =
                          src.kind === 'commit' ? t('factsAudit.src.commit', { hash: src.hash })
                          : src.kind === 'probe' ? t('factsAudit.src.probe')
                          : src.kind === 'task' ? t('factsAudit.src.task')
                          : src.kind === 'deliverable' ? t('factsAudit.src.deliverable')
                          : src.value;
                        return (
                          <span
                            key={ref}
                            title={ref}
                            className="rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] text-fg-secondary"
                          >
                            {text}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <details className="group mt-2">
                    <summary className="cursor-pointer select-none text-[11px] text-fg-tertiary hover:text-fg-secondary">
                      {t('factsAudit.colValue')}
                    </summary>
                    <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg bg-surface-secondary/60 p-2.5 font-mono text-[11px] leading-relaxed text-fg-secondary">
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
