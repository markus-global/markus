/**
 * C9-E · `#/audit/facts` — the page's own contract.
 *
 * What must be true (each assertion fails if the behaviour is removed):
 *  1. Only `owner` / `admin` get the page, and for anyone else **no request is issued** (hiding a
 *     page is not access control, but an unauthorized client must not learn anything either).
 *  2. `FACTS_ENABLED=0` (server `disabled: true`) renders an explicit notice — an empty table
 *     would read as "no facts exist", which is a different and false statement.
 *  3. The supersede chain is readable (old → new → who/when).
 *  4. Empty filters are omitted from the query string (an empty `subjectId=` means "id is empty").
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  buildFactsQuery,
  describeSupersedeChain,
  indexFacts,
  isIndependentlyVerified,
  sortFacts,
  type FactRowView,
} from '../lib/factsAudit.js';

const row = (over: Partial<FactRowView> = {}): FactRowView => ({
  id: 'fact_1',
  subjectKind: 'task',
  subjectId: 'tsk_1',
  predicate: 'task.completion_evidence',
  value: { summary: 'done', evidence_refs: ['dlv_1'] },
  workUnitRef: 'task:tsk_1:r1',
  assertedBy: 'agt_worker',
  sourceRefs: ['dlv_1'],
  verification: null,
  confidence: 1,
  createdAt: '2026-11-15T01:00:00.000Z',
  supersededBy: null,
  supersededAt: null,
  ...over,
});

describe('buildFactsQuery', () => {
  it('omits empty filters', () => {
    expect(buildFactsQuery({})).toBe('');
    expect(buildFactsQuery({ subjectKind: '', subjectId: '  ', predicate: '' })).toBe('');
  });

  it('carries the filters that were set, including the superseded toggle', () => {
    const qs = buildFactsQuery({
      subjectKind: 'task',
      subjectId: 'tsk_1',
      includeSuperseded: true,
      limit: 50,
    });
    const params = new URLSearchParams(qs);
    expect(params.get('subjectKind')).toBe('task');
    expect(params.get('subjectId')).toBe('tsk_1');
    expect(params.get('includeSuperseded')).toBe('1');
    expect(params.get('limit')).toBe('50');
    // a datetime-local input becomes a real ISO instant
    expect(new URLSearchParams(buildFactsQuery({ since: '2026-11-15T09:30' })).get('since')).toMatch(/Z$/);
  });

  it('ignores an unparseable datetime', () => {
    expect(buildFactsQuery({ since: 'not-a-date' })).toBe('');
  });
});

describe('supersede chain', () => {
  it('renders old → new → who/when when the replacement is loaded', () => {
    const oldRow = row({ id: 'fact_old', supersededBy: 'fact_new', supersededAt: '2026-11-15T02:00:00.000Z' });
    const newRow = row({ id: 'fact_new', assertedBy: 'agt_reviewer', createdAt: '2026-11-15T02:00:00.000Z' });
    const chain = describeSupersedeChain(oldRow, indexFacts([oldRow, newRow]));
    expect(chain.outgoing).toContain('fact_new');
    expect(chain.outgoing).toContain('agt_reviewer');
    expect(chain.outgoing).toContain('2026-11-15T02:00:00.000Z');
    expect(chain.incoming).toBeNull();

    const back = describeSupersedeChain(newRow, indexFacts([oldRow, newRow]));
    expect(back.incoming).toContain('fact_old');
  });

  it('says the replacement is outside the result set instead of inventing it', () => {
    const only = row({ id: 'fact_old', supersededBy: 'fact_missing', supersededAt: '2026-11-15T02:00:00.000Z' });
    const chain = describeSupersedeChain(only, indexFacts([only]));
    expect(chain.outgoing).toContain('not in this result set');
  });

  it('has no chain on a plain current row', () => {
    const chain = describeSupersedeChain(row(), indexFacts([row()]));
    expect(chain.outgoing).toBeNull();
    expect(chain.incoming).toBeNull();
  });
});

describe('isIndependentlyVerified / sortFacts', () => {
  it('only an independent pass counts', () => {
    expect(isIndependentlyVerified(row({
      verification: { result: 'pass', verifiedBy: 'agt_reviewer' },
    }))).toBe(true);
    expect(isIndependentlyVerified(row({
      verification: { result: 'pass', verifiedBy: 'agt_worker' },
    }))).toBe(false);
    expect(isIndependentlyVerified(row({
      verification: { result: 'fail', verifiedBy: 'agt_reviewer' },
    }))).toBe(false);
    expect(isIndependentlyVerified(row())).toBe(false);
  });

  it('sorts newest first, deterministically on ties', () => {
    const a = row({ id: 'a', createdAt: '2026-11-15T01:00:00.000Z' });
    const b = row({ id: 'b', createdAt: '2026-11-15T03:00:00.000Z' });
    expect(sortFacts([a, b]).map(r => r.id)).toEqual(['b', 'a']);
    const c = row({ id: 'c', createdAt: '2026-11-15T01:00:00.000Z' });
    expect(sortFacts([a, c]).map(r => r.id)).toEqual(['c', 'a']);
  });
});

// ─── page behaviour ─────────────────────────────────────────────────────────────────────────

const listMock = vi.fn();
vi.mock('../api.js', () => ({
  factsAudit: { list: (q: string) => listMock(q) },
}));

describe('AuditFacts page', () => {
  beforeEach(() => { listMock.mockReset(); });
  afterEach(() => { cleanup(); });

  it('renders nothing and issues no request for a non-admin', async () => {
    const { default: AuditFacts } = await import('./AuditFacts.js');
    const { container } = render(<AuditFacts role="member" authUser={{ id: 'u1', role: 'member' }} />);
    expect(container.textContent).toBe('');
    expect(listMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('audit-facts')).toBeNull();
  });

  it('renders the disabled notice instead of an empty table when the layer is off', async () => {
    listMock.mockResolvedValue({ facts: [], truncated: false, disabled: true });
    const { default: AuditFacts } = await import('./AuditFacts.js');
    render(<AuditFacts role="owner" authUser={{ id: 'u0', role: 'owner' }} />);
    await waitFor(() => expect(screen.getByTestId('audit-facts-disabled')).toBeTruthy());
    expect(screen.queryByTestId('audit-facts-empty')).toBeNull();
    expect(screen.queryByTestId('audit-facts-table')).toBeNull();
  });

  it('renders rows with their chain and verification for an owner', async () => {
    const oldRow = row({ id: 'fact_old', supersededBy: 'fact_new', supersededAt: '2026-11-15T02:00:00.000Z' });
    const newRow = row({
      id: 'fact_new', createdAt: '2026-11-15T02:00:00.000Z', assertedBy: 'agt_reviewer',
      verification: { result: 'pass', verifiedBy: 'agt_reviewer' },
    });
    listMock.mockResolvedValue({ facts: [oldRow, newRow], truncated: false });
    const { default: AuditFacts } = await import('./AuditFacts.js');
    render(<AuditFacts role="admin" authUser={{ id: 'u0', role: 'admin' }} />);
    await waitFor(() => expect(screen.getAllByTestId('audit-facts-row')).toHaveLength(2));
    expect(screen.getAllByTestId('audit-facts-chain-out').length).toBeGreaterThan(0);
    expect(screen.getByText(/pass · agt_reviewer/)).toBeTruthy();
  });
});
