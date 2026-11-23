/**
 * C10-C — cross_org_policy: default 'observe', single writer, dual-write schema.
 * Card tsk_bcf3988a624bca685574aad8 · design SSOT:
 * docs/design/c10-c-trust-boundary-2026-11-23.md §2.1.
 *
 * Real SQLite files only (no mocks). The legacy fixture strips the C10-C column
 * off a fresh DB (DROP COLUMN in a TEST FIXTURE only — production migrations
 * never drop), mirroring the C10-A discipline: fresh-init and upgraded DBs must
 * have the identical LOGICAL column shape (sorted name/type/notnull/default/pk).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, closeSqlite, SqliteOrgRepo } from '../src/sqlite-storage.js';

let tempDir: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c10c-policy-'));
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function tableInfo(db: DatabaseSync, table: string): unknown[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

describe('cross_org_policy — fresh DB defaults', () => {
  it('organizations has cross_org_policy NOT NULL DEFAULT observe', () => {
    const db = openSqlite(join(tempDir, 'fresh.db'));
    const col = (db.prepare('PRAGMA table_info(organizations)').all() as Array<Record<string, unknown>>)
      .find(c => c['name'] === 'cross_org_policy');
    expect(col).toBeDefined();
    expect(col!['type']).toBe('TEXT');
    expect(col!['notnull']).toBe(1);
    expect(String(col!['dflt_value'])).toContain('observe');
  });

  it('a newly created org reads crossOrgPolicy=observe without any explicit write', () => {
    const db = openSqlite(join(tempDir, 'fresh2.db'));
    const orgs = new SqliteOrgRepo(db);
    orgs.createOrg({ id: 'orgc1', name: 'C10-C Org', ownerId: 'u1' });
    const org = orgs.findOrgById('orgc1') as { crossOrgPolicy?: string } | undefined;
    expect(org).toBeDefined();
    expect(org!.crossOrgPolicy).toBe('observe');
  });
});

describe('cross_org_policy — single writer round-trip', () => {
  it('setCrossOrgPolicy elevates to auto and back to observe', () => {
    const db = openSqlite(join(tempDir, 'rw.db'));
    const orgs = new SqliteOrgRepo(db);
    orgs.createOrg({ id: 'orgc2', name: 'C10-C RW', ownerId: 'u1' });
    (orgs as unknown as { setCrossOrgPolicy: (id: string, p: string) => void })
      .setCrossOrgPolicy('orgc2', 'auto');
    expect((orgs.findOrgById('orgc2') as { crossOrgPolicy?: string }).crossOrgPolicy).toBe('auto');
    (orgs as unknown as { setCrossOrgPolicy: (id: string, p: string) => void })
      .setCrossOrgPolicy('orgc2', 'observe');
    expect((orgs.findOrgById('orgc2') as { crossOrgPolicy?: string }).crossOrgPolicy).toBe('observe');
  });
});

describe('cross_org_policy — legacy upgrade (no data migration, no DROP in production)', () => {
  it('a pre-C10-C DB upgrades: column appears, existing rows read observe, logical shape == fresh', () => {
    const legacyPath = join(tempDir, 'legacy.db');
    const seed = openSqlite(legacyPath);
    seed.prepare(
      "INSERT INTO organizations (id, name, owner_id) VALUES ('orgold', 'Legacy Org', 'u1')",
    ).run();
    closeSqlite();

    // Test fixture only: strip the C10-C column to simulate a pre-C10-C DB.
    const raw = new DatabaseSync(legacyPath);
    raw.exec('ALTER TABLE organizations DROP COLUMN cross_org_policy');
    raw.close();

    const upgraded = openSqlite(legacyPath); // runs the migration array
    const orgs = new SqliteOrgRepo(upgraded);
    const org = orgs.findOrgById('orgold') as { crossOrgPolicy?: string } | undefined;
    expect(org).toBeDefined();
    expect(org!.crossOrgPolicy).toBe('observe'); // default backfills, row untouched otherwise

    // openSqlite is a module singleton: closeSqlite() invalidates `upgraded`
    // too. Capture the shape BEFORE closing, then compare against a fresh DB.
    const upgradedShape = tableInfo(upgraded, 'organizations');
    closeSqlite();
    const fresh = openSqlite(join(tempDir, 'freshcmp.db'));
    expect(upgradedShape).toEqual(tableInfo(fresh, 'organizations'));
  });
});