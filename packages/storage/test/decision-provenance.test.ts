/**
 * Decision provenance must survive the round trip (real SQLite, not a mock).
 *
 * The ledger answers three questions: which turn, who decided, and what was
 * overridden. Each of those is a column, and a column that is written but not
 * selected — or selected but not written — reads back as NULL while every
 * layer above it looks correct.
 *
 * That is exactly how 226,967 decisions ended up with zero work_unit_ref:
 * recordDecision set it, the INSERT listed it, and the adapter in between
 * hand-copied fields and dropped it (measured 2026-11-18).
 *
 * Bite check: remove `source` / `overrode` / `work_unit_ref` from either the
 * INSERT column list or mapRow, and this file turns red.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqliteDecisionRepo } from '../src/sqlite-storage.js';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteDecisionRepo;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-decision-prov-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteDecisionRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const base = {
  agentId: 'agt_prov',
  decisionType: 'preempt',
  mailboxItemId: 'mbx_prov_1',
  context: { mailboxDepth: 1, queuedItemTypes: ['human_chat'] },
  reasoning: 'higher priority',
  createdAt: '2026-11-18T12:00:00.000Z',
};

describe('agent_decisions provenance round trip', () => {
  it('turn identity, source and override all read back', () => {
    repo.save({
      ...base,
      id: 'dec_prov_1',
      workUnitRef: 'session:cs_prov:r3',
      source: 'heuristic',
      overrode: 'defer',
    });

    const [row] = repo.getByAgent('agt_prov');
    expect(row.workUnitRef).toBe('session:cs_prov:r3');
    expect(row.source).toBe('heuristic');
    expect(row.overrode).toBe('defer');
  });

  it('a model judgement is distinguishable from a rule', () => {
    repo.save({ ...base, id: 'dec_prov_m', mailboxItemId: 'mbx_m', source: 'model' });
    repo.save({ ...base, id: 'dec_prov_r', mailboxItemId: 'mbx_r', source: 'rule' });

    const rows = repo.getByAgent('agt_prov');
    const byItem = new Map(rows.map(r => [r.mailboxItemId, r.source]));
    expect(byItem.get('mbx_m')).toBe('model');
    expect(byItem.get('mbx_r')).toBe('rule');
  });

  it('a pre-column epoch reads NULL, not a fabricated default', () => {
    // Simulate a legacy row written before the columns existed.
    db.prepare(
      'INSERT INTO agent_decisions (id, agent_id, decision_type, mailbox_item_id, context, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('dec_legacy', 'agt_prov', 'pick', 'mbx_legacy', '{}', '', '2026-04-11T06:54:50.630Z');

    const row = repo.getByAgent('agt_prov').find(r => r.id === 'dec_legacy');
    expect(row?.workUnitRef).toBeNull();
    expect(row?.source).toBeNull();
    expect(row?.overrode).toBeNull();
  });

  it('lookup by mailbox item carries provenance too', () => {
    repo.save({
      ...base,
      id: 'dec_prov_2',
      mailboxItemId: 'mbx_prov_2',
      workUnitRef: 'task_tsk_x_r1',
      source: 'model',
    });

    const [row] = repo.getByMailboxItemId('mbx_prov_2');
    expect(row.workUnitRef).toBe('task_tsk_x_r1');
    expect(row.source).toBe('model');
  });
});