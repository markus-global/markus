/**
 * Facts audit page — pure helpers (C9-E).
 *
 * Two deliberate mirrors live here, both with the reason written down:
 *
 *  · `FACT_SUBJECT_KINDS` mirrors `@markus/shared`'s `FactSubjectKind`. `packages/web-ui` cannot
 *    import `@markus/shared` (it is not a dependency, there is no vite alias and no tsconfig
 *    paths — 12 files in this package record the same constraint). Mirroring a *constant* is
 *    safe; mirroring an algorithm is not. The server is the authority: an unknown kind sent here
 *    simply returns no rows.
 *  · Nothing here derives "who is waiting for what" — that is C9-C's `deriveStage`, server-side.
 *    This page only renders rows it was given.
 */

export const FACT_SUBJECT_KINDS = ['task', 'requirement', 'agent', 'deliverable', 'work_unit'] as const;
export type FactSubjectKind = (typeof FACT_SUBJECT_KINDS)[number];

export interface FactVerificationView {
  result: 'pass' | 'fail';
  verifiedBy: string;
  /** 验证者名字；解析不到时回落到 id。 */
  verifiedByName?: string | null;
  evidenceRefs?: string[];
  verifiedAt?: string;
  workUnitRef?: string;
}

export interface FactRowView {
  id: string;
  subjectKind: FactSubjectKind | string;
  subjectId: string;
  /** 服务端解析出的可读名字（task.title / agent.name / …）；解析不到时回落到 id。 */
  subjectLabel?: string | null;
  predicate: string;
  value: unknown;
  workUnitRef: string;
  assertedBy: string;
  /** 断言者名字；解析不到时回落到 id。 */
  assertedByName?: string | null;
  sourceRefs: string[];
  verification: FactVerificationView | null;
  confidence: number;
  createdAt: string;
  supersededBy: string | null;
  supersededAt: string | null;
}

export interface FactsResponse {
  facts: FactRowView[];
  truncated: boolean;
  disabled?: boolean;
}

export interface FactsQueryInput {
  subjectKind?: string;
  subjectId?: string;
  predicate?: string;
  predicatePrefix?: string;
  /** `datetime-local` value (no timezone) or ISO. Empty = no bound. */
  since?: string;
  until?: string;
  includeSuperseded?: boolean;
  limit?: number;
}

/** `datetime-local` has no timezone; the browser knows which one the user meant. */
export function toIso(local: string | undefined): string | undefined {
  const raw = (local ?? '').trim();
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

/**
 * Query string for `GET /api/facts`. Empty filters are omitted (an empty `subjectId=` would be a
 * filter for the empty id, i.e. "no rows", which is not what a blank input means).
 */
export function buildFactsQuery(input: FactsQueryInput): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | undefined) => {
    const v = (value ?? '').trim();
    if (v.length > 0) params.set(key, v);
  };
  put('subjectKind', input.subjectKind);
  put('subjectId', input.subjectId);
  put('predicate', input.predicate);
  put('predicatePrefix', input.predicatePrefix);
  put('since', toIso(input.since));
  put('until', toIso(input.until));
  if (input.includeSuperseded) params.set('includeSuperseded', '1');
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    params.set('limit', String(input.limit));
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

/** Index by id so a chain can be rendered without a second fetch. */
export function indexFacts(rows: readonly FactRowView[]): Map<string, FactRowView> {
  const map = new Map<string, FactRowView>();
  for (const row of rows) map.set(row.id, row);
  return map;
}

/** Newest first; ties broken by id so two renders of the same data cannot disagree. */
export function sortFacts(rows: readonly FactRowView[]): FactRowView[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

/**
 * The supersede chain text for one row, in the reader's terms: **旧值 → 新值 → 谁在何时**.
 *
 * The superseding row is often not in the loaded set (a filter can hide it), so the text must
 * still be true when only the id is known — it then says so instead of inventing a value.
 */
export function describeSupersedeChain(
  row: FactRowView,
  byId: Map<string, FactRowView>,
): { outgoing: string | null; incoming: string | null } {
  const outgoing = row.supersededBy
    ? (() => {
        const next = byId.get(row.supersededBy);
        const when = row.supersededAt ? ` @ ${row.supersededAt}` : '';
        return next
          ? `→ ${next.id} (${next.assertedBy}${when})`
          : `→ ${row.supersededBy}${when} (not in this result set)`;
      })()
    : null;

  // Is this row itself a replacement for something? Rows are matched by supersededBy === this id.
  const previous = [...byId.values()].find(r => r.supersededBy === row.id);
  const incoming = previous ? `← replaces ${previous.id}` : null;

  return { outgoing, incoming };
}

/** True when the row carries an independent pass verdict (verifier ≠ assertor). */
export function isIndependentlyVerified(row: FactRowView): boolean {
  const v = row.verification;
  if (!v || v.result !== 'pass') return false;
  const verifier = (v.verifiedBy ?? '').trim();
  return verifier.length > 0 && verifier !== row.assertedBy;
}
