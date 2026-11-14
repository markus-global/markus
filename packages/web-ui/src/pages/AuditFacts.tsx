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

  if (!allowed) {
    // Deliberately not an error page: an unauthorized deep link must not confirm that this page
    // (or a fact) exists. It simply is not this user's page.
    return null;
  }

  return (
    <div className="p-6 space-y-4" data-testid="audit-facts">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-fg-primary">{t('factsAudit.title')}</h1>
        <p className="text-sm text-fg-tertiary">{t('factsAudit.subtitle')}</p>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="audit-facts-filters">
        <label className="text-xs text-fg-tertiary">
          {t('factsAudit.subjectKind')}
          <select
            className="mt-1 w-full rounded border border-line bg-surface-primary px-2 py-1 text-sm text-fg-primary"
            value={subjectKind}
            onChange={e => setSubjectKind(e.target.value)}
          >
            <option value="">{t('factsAudit.any')}</option>
            {FACT_SUBJECT_KINDS.map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-fg-tertiary">
          {t('factsAudit.subjectId')}
          <input
            className="mt-1 w-full rounded border border-line bg-surface-primary px-2 py-1 text-sm text-fg-primary"
            value={subjectId}
            onChange={e => setSubjectId(e.target.value)}
            placeholder="tsk_… / agt_…"
          />
        </label>
        <label className="text-xs text-fg-tertiary">
          {t('factsAudit.predicate')}
          <input
            className="mt-1 w-full rounded border border-line bg-surface-primary px-2 py-1 text-sm text-fg-primary"
            value={predicate}
            onChange={e => setPredicate(e.target.value)}
            placeholder="task.completion_evidence"
          />
        </label>
        <label className="text-xs text-fg-tertiary">
          {t('factsAudit.since')}
          <input
            type="datetime-local"
            className="mt-1 w-full rounded border border-line bg-surface-primary px-2 py-1 text-sm text-fg-primary"
            value={since}
            onChange={e => setSince(e.target.value)}
          />
        </label>
        <label className="text-xs text-fg-tertiary">
          {t('factsAudit.until')}
          <input
            type="datetime-local"
            className="mt-1 w-full rounded border border-line bg-surface-primary px-2 py-1 text-sm text-fg-primary"
            value={until}
            onChange={e => setUntil(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-tertiary md:col-span-3">
          <input
            type="checkbox"
            checked={includeSuperseded}
            onChange={e => setIncludeSuperseded(e.target.checked)}
          />
          {t('factsAudit.includeSuperseded')}
        </label>
      </section>

      {disabled && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="audit-facts-disabled">
          {t('factsAudit.disabled')}
        </div>
      )}
      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm" data-testid="audit-facts-error">
          {error}
        </div>
      )}
      {loading && <div className="text-sm text-fg-tertiary">{t('loading')}</div>}
      {truncated && !loading && (
        <div className="text-xs text-fg-tertiary" data-testid="audit-facts-truncated">
          {t('factsAudit.truncated')}
        </div>
      )}

      {!disabled && !loading && rows.length === 0 && !error && (
        <div className="text-sm text-fg-tertiary" data-testid="audit-facts-empty">
          {t('factsAudit.empty')}
        </div>
      )}

      {rows.length > 0 && (
        <table className="w-full text-left text-sm" data-testid="audit-facts-table">
          <thead className="text-xs uppercase text-fg-tertiary">
            <tr>
              <th className="py-1">{t('factsAudit.colPredicate')}</th>
              <th className="py-1">{t('factsAudit.colSubject')}</th>
              <th className="py-1">{t('factsAudit.colAsserted')}</th>
              <th className="py-1">{t('factsAudit.colVerification')}</th>
              <th className="py-1">{t('factsAudit.colChain')}</th>
              <th className="py-1">{t('factsAudit.colValue')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const chain = describeSupersedeChain(row, byId);
              return (
                <tr key={row.id} className="border-t border-line align-top" data-testid="audit-facts-row" id={`fact-${row.id}`}>
                  <td className="py-2 pr-2 font-mono text-xs">{row.predicate}</td>
                  <td className="py-2 pr-2 font-mono text-xs">{row.subjectKind}:{row.subjectId}</td>
                  <td className="py-2 pr-2 text-xs">
                    <div>{row.assertedBy}</div>
                    <div className="text-fg-tertiary">{row.createdAt}</div>
                    <div className="font-mono text-[10px] text-fg-tertiary">{row.workUnitRef}</div>
                    {row.sourceRefs?.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.sourceRefs.map(ref => (
                          <span key={ref} className="rounded bg-surface-secondary px-1 text-[10px]">{ref}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-xs">
                    {row.verification ? (
                      <span className={isIndependentlyVerified(row) ? 'text-emerald-500' : 'text-amber-500'}>
                        {row.verification.result} · {row.verification.verifiedBy}
                        {row.verification.verifiedAt ? ` · ${row.verification.verifiedAt}` : ''}
                      </span>
                    ) : (
                      <span className="text-fg-tertiary">{t('factsAudit.unverified')}</span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-xs">
                    {chain.outgoing && <div data-testid="audit-facts-chain-out">{chain.outgoing}</div>}
                    {chain.incoming && <div className="text-fg-tertiary" data-testid="audit-facts-chain-in">{chain.incoming}</div>}
                    {!chain.outgoing && !chain.incoming && <span className="text-fg-tertiary">—</span>}
                  </td>
                  <td className="py-2 text-xs">
                    <pre className="max-w-md overflow-x-auto whitespace-pre-wrap font-mono text-[10px]">
{JSON.stringify(row.value, null, 2)}
                    </pre>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
