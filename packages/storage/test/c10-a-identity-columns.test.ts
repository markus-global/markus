/**
 * C10-A — Identity columns + slug ownership (card tsk_80517bb773ae1f41145ba8f3).
 * Design SSOT: docs/design/c10-a-identity-columns-2026-11-22.md
 *
 * All behavioral assertions: real SQLite files, real views, real return bodies.
 * The "legacy DB" fixture strips the C10-A objects off a fresh DB (DROP COLUMN
 * in a test fixture only — production migrations never drop), so unrelated
 * schema cannot drift from hand-copied DDL. Expected slug values are asserted
 * as literals (`org_<id>` is the frozen rule), never computed with the
 * implementation's own helper.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  openSqlite,
  closeSqlite,
  SqliteAddressBindingRepo,
  SqliteOrgRepo,
  SqliteStatusTransitionRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c10a-'));
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const MARKUS = 'markus.global';

/** Strip the C10-A objects off a fresh DB → a faithful pre-C10-A legacy DB. */
function stripToLegacy(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    DROP INDEX IF EXISTS uq_organizations_org_slug;
    ALTER TABLE organizations DROP COLUMN org_slug;
    DROP INDEX IF EXISTS uq_agents_org_alias;
    ALTER TABLE agents DROP COLUMN agent_alias;
    DROP VIEW IF EXISTS address_bindings;
    CREATE VIEW address_bindings AS
      SELECT id, org_id, address, 'agent:' || agent_id AS target_ref,
             agent_id, revoked_at, created_at
        FROM channel_bindings WHERE address IS NOT NULL;
  `);
  raw.close();
}

/** Logical column shape. Physical cid order legitimately differs between
 *  fresh-init (CREATE TABLE) and upgrade (ALTER appends) — pre-existing
 *  precedent: mailbox_items' C2 columns. The invariant is logical identity:
 *  same columns / types / nullability / defaults / PK, plus same indexes+views. */
function tableInfo(db: DatabaseSync, table: string): unknown[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function objectSql(db: DatabaseSync, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const row = db
      .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
      .get(name) as { sql: string | null } | undefined;
    out[name] = (row?.sql ?? '<absent>').replace(/\s+/g, ' ').trim();
  }
  return out;
}

const C10A_OBJECTS = [
  'address_bindings',
  'uq_organizations_org_slug',
  'uq_agents_org_alias',
  'uq_channel_bindings_address_active',
];

/** Two orgs with declared, bindable slugs (the fixture plays the registry). */
function orgsWithSlugs(db: DatabaseSync): SqliteOrgRepo {
  const orgs = new SqliteOrgRepo(db);
  orgs.createOrg({ id: 'orga', name: 'Alpha Org', ownerId: 'u1' });
  orgs.createOrg({ id: 'orgb', name: 'Beta Org', ownerId: 'u1' });
  expect(orgs.declareOrgSlug('orga', 'alpha')).toMatchObject({ ok: true });
  expect(orgs.declareOrgSlug('orgb', 'beta')).toMatchObject({ ok: true });
  return orgs;
}

describe('C10-A schema: fresh-init vs upgraded legacy DB are identical', () => {
  it('legacy DB (no org_slug / agent_alias, old view) upgrades to exactly the fresh schema', () => {
    // Legacy DB with real rows that must survive the upgrade untouched.
    const legacyPath = join(tempDir, 'legacy.db');
    const seed = openSqlite(legacyPath);
    seed
      .prepare("INSERT INTO organizations (id, name, owner_id) VALUES ('default', 'My Organization', 'u1')")
      .run();
    seed
      .prepare(
        "INSERT INTO channel_bindings (id, org_id, scope, kind, agent_id) VALUES ('cb_legacy', 'default', 'global', NULL, 'agt_x')",
      )
      .run();
    closeSqlite();
    stripToLegacy(legacyPath);

    const upgraded = openSqlite(legacyPath);
    const upgradedInfo = {
      organizations: tableInfo(upgraded, 'organizations'),
      agents: tableInfo(upgraded, 'agents'),
      channel_bindings: tableInfo(upgraded, 'channel_bindings'),
    };
    const upgradedSql = objectSql(upgraded, C10A_OBJECTS);
    const legacyRow = upgraded
      .prepare("SELECT address, revoked_at, agent_id FROM channel_bindings WHERE id = 'cb_legacy'")
      .get() as { address: string | null; revoked_at: string | null; agent_id: string };
    closeSqlite();

    const fresh = openSqlite(join(tempDir, 'fresh.db'));
    const freshInfo = {
      organizations: tableInfo(fresh, 'organizations'),
      agents: tableInfo(fresh, 'agents'),
      channel_bindings: tableInfo(fresh, 'channel_bindings'),
    };
    const freshSql = objectSql(fresh, C10A_OBJECTS);

    expect(upgradedInfo).toEqual(freshInfo);
    expect(upgradedSql).toEqual(freshSql);
    // Non-destructive: the legacy routing row is intact, new columns NULL.
    expect(legacyRow).toEqual({ address: null, revoked_at: null, agent_id: 'agt_x' });
  });
});

describe('C10-A org_slug backfill: explicit org_<id>, never derived from name', () => {
  it('two same-name historical orgs get distinct org_<id> slugs on upgrade', () => {
    const dbPath = join(tempDir, 'hist.db');
    const seed = openSqlite(dbPath);
    seed
      .prepare("INSERT INTO organizations (id, name, owner_id) VALUES ('default', 'My Organization', 'u1')")
      .run();
    seed
      .prepare(
        "INSERT INTO organizations (id, name, owner_id) VALUES ('user_4941a0558946c8e1f58962cc', 'My Organization', 'u1')",
      )
      .run();
    closeSqlite();
    stripToLegacy(dbPath);

    const db = openSqlite(dbPath);
    const rows = db
      .prepare('SELECT id, name, org_slug FROM organizations ORDER BY id')
      .all() as Array<{ id: string; name: string; org_slug: string | null }>;
    expect(rows.map((r) => r.org_slug)).toEqual([
      'org_default',
      'org_user_4941a0558946c8e1f58962cc',
    ]);
    // Same display name, different slugs — the name is provably not the source.
    expect(rows[0]!.name).toBe(rows[1]!.name);
    expect(rows[0]!.org_slug).not.toBe(rows[1]!.org_slug);
    for (const r of rows) expect(r.org_slug).not.toContain('my-organization');
  });

  it('backfill is one-time: a declared slug survives re-open untouched', () => {
    const dbPath = join(tempDir, 'reopen.db');
    const seed = openSqlite(dbPath);
    seed
      .prepare("INSERT INTO organizations (id, name, owner_id) VALUES ('default', 'My Organization', 'u1')")
      .run();
    closeSqlite();
    stripToLegacy(dbPath);

    let db = openSqlite(dbPath);
    const orgs = new SqliteOrgRepo(db);
    expect(orgs.declareOrgSlug('default', 'acme')).toMatchObject({ ok: true });
    closeSqlite();

    db = openSqlite(dbPath);
    expect(new SqliteOrgRepo(db).findOrgById('default')?.orgSlug).toBe('acme');
  });

  it('createOrg assigns org_<id> regardless of display name', () => {
    const db = openSqlite(join(tempDir, 'create.db'));
    const orgs = new SqliteOrgRepo(db);
    const org = orgs.createOrg({ id: 'newco', name: 'Acme Corp', ownerId: 'u1' });
    expect(org.orgSlug).toBe('org_newco');
    expect(org.orgSlug).not.toBe('acme-corp');
    expect(org.orgSlug).not.toBe('acmecorp');
  });
});

describe('C10-A declareOrgSlug: explicit registry write with immutability', () => {
  it('accepts a valid slug and reads it back; re-declaration before issuance is allowed', () => {
    const db = openSqlite(join(tempDir, 'declare.db'));
    const orgs = orgsWithSlugs(db);
    expect(orgs.findOrgById('orga')?.orgSlug).toBe('alpha');
    expect(orgs.declareOrgSlug('orga', 'alpha-two')).toMatchObject({ ok: true, orgSlug: 'alpha-two' });
    expect(orgs.findOrgById('orga')?.orgSlug).toBe('alpha-two');
  });

  it('rejects invalid / reserved slugs with an actionable reason (same rules as the address format)', () => {
    const db = openSqlite(join(tempDir, 'invalid.db'));
    const orgs = orgsWithSlugs(db);
    for (const bad of ['Acme', 'a_b', 'www', '', 'a--b', 'x'.repeat(31), '-lead', 'trail-']) {
      const res = orgs.declareOrgSlug('orga', bad);
      expect(res.ok, `slug ${JSON.stringify(bad)} must be rejected`).toBe(false);
      if (!res.ok) expect(res.reason).toBe('invalid_slug');
    }
    // The rejected attempts changed nothing.
    expect(orgs.findOrgById('orga')?.orgSlug).toBe('alpha');
  });

  it('rejects a slug already owned by another org (unique index adjudicates)', () => {
    const db = openSqlite(join(tempDir, 'collide.db'));
    const orgs = orgsWithSlugs(db);
    const res = orgs.declareOrgSlug('orgb', 'alpha');
    expect(res).toMatchObject({ ok: false, reason: 'conflict' });
    expect(orgs.findOrgById('orgb')?.orgSlug).toBe('beta');
  });

  it('is immutable after the first address issuance — even after that binding is revoked', () => {
    const db = openSqlite(join(tempDir, 'immutable.db'));
    const orgs = orgsWithSlugs(db);
    const repo = new SqliteAddressBindingRepo(db);
    expect(
      repo.bind({ orgId: 'orga', agentId: 'agt_a', address: `x.alpha@${MARKUS}` }),
    ).toMatchObject({ status: 'bound' });
    expect(orgs.declareOrgSlug('orga', 'alpha-two')).toMatchObject({ ok: false, reason: 'immutable' });
    // Revocation does not reopen the slug: issuance history is permanent.
    expect(repo.revoke({ orgId: 'orga', agentId: 'agt_a', address: `x.alpha@${MARKUS}` })).toMatchObject({
      status: 'revoked',
    });
    expect(orgs.declareOrgSlug('orga', 'alpha-two')).toMatchObject({ ok: false, reason: 'immutable' });
    expect(orgs.findOrgById('orga')?.orgSlug).toBe('alpha');
  });

  it('unknown org is rejected, not silently created', () => {
    const db = openSqlite(join(tempDir, 'unknown.db'));
    orgsWithSlugs(db);
    const orgs = new SqliteOrgRepo(db);
    expect(orgs.declareOrgSlug('nope', 'gamma')).toMatchObject({ ok: false, reason: 'org_not_found' });
  });
});

describe('C10-A bind slug ownership: the consumer that bites', () => {
  it('org B binding x.<orgA-slug>@ is bounced with org_slug_mismatch and an actionable hint', () => {
    const db = openSqlite(join(tempDir, 'squat.db'));
    orgsWithSlugs(db);
    const repo = new SqliteAddressBindingRepo(db);
    const res = repo.bind({ orgId: 'orgb', agentId: 'agt_b', address: `x.alpha@${MARKUS}` });
    expect(res).toMatchObject({ status: 'bounced', detail: 'org_slug_mismatch' });
    if (res.status === 'bounced') {
      expect(res.hint).toContain('beta'); // tells the agent its own slug → actionable
      expect(res.reason).toBe('unresolved_address');
    }
    // Nothing was written.
    expect(repo.findActive(`x.alpha@${MARKUS}`)).toBeUndefined();
  });

  it('org A binding its own slug passes', () => {
    const db = openSqlite(join(tempDir, 'own.db'));
    orgsWithSlugs(db);
    const repo = new SqliteAddressBindingRepo(db);
    expect(
      repo.bind({ orgId: 'orga', agentId: 'agt_a', address: `x.alpha@${MARKUS}` }),
    ).toMatchObject({ status: 'bound', targetRef: 'agent:agt_a' });
  });

  it('an org with no declared slug is fail-closed (org_slug_unset), unknown org too', () => {
    const db = openSqlite(join(tempDir, 'unset.db'));
    orgsWithSlugs(db);
    // Simulate a registry row without a slug (pre-backfill shape).
    db.prepare("INSERT INTO organizations (id, name, owner_id) VALUES ('orgc', 'C', 'u1')").run();
    const repo = new SqliteAddressBindingRepo(db);
    expect(
      repo.bind({ orgId: 'orgc', agentId: 'agt_c', address: `x.gamma@${MARKUS}` }),
    ).toMatchObject({ status: 'bounced', detail: 'org_slug_unset' });
    expect(
      repo.bind({ orgId: 'nope', agentId: 'agt_c', address: `x.gamma@${MARKUS}` }),
    ).toMatchObject({ status: 'bounced', detail: 'org_slug_unset' });
  });

  it('idempotent re-bind by the owner stays a no-op; a second agent still gets conflict', () => {
    const db = openSqlite(join(tempDir, 'idem.db'));
    orgsWithSlugs(db);
    const repo = new SqliteAddressBindingRepo(db);
    const addr = `x.alpha@${MARKUS}`;
    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({ status: 'bound' });
    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({
      status: 'bound',
      unchanged: true,
    });
    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a2', address: addr })).toMatchObject({ status: 'conflict' });
  });

  it('the format gate still runs first: external domains never reach the ownership check', () => {
    const db = openSqlite(join(tempDir, 'format.db'));
    orgsWithSlugs(db);
    const repo = new SqliteAddressBindingRepo(db);
    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a', address: 'x.alpha@evil.com' })).toMatchObject({
      status: 'bounced',
      detail: 'external_domain',
    });
  });

  it('revoke of your own binding is not locked out by the ownership gate', () => {
    const db = openSqlite(join(tempDir, 'revoke.db'));
    orgsWithSlugs(db);
    const repo = new SqliteAddressBindingRepo(db);
    const addr = `x.alpha@${MARKUS}`;
    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({ status: 'bound' });
    expect(repo.revoke({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({ status: 'revoked' });
  });
});

describe('C10-A address_bindings.kind', () => {
  it('bind writes kind=agent (frozen closed set) and the view exposes it', () => {
    const db = openSqlite(join(tempDir, 'kind.db'));
    orgsWithSlugs(db);
    const repo = new SqliteAddressBindingRepo(db);
    const addr = `x.alpha@${MARKUS}`;
    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({ status: 'bound' });
    const row = db.prepare('SELECT kind FROM address_bindings WHERE address = ?').get(addr) as { kind: string };
    expect(row.kind).toBe('agent');
    expect(repo.findActive(addr)?.kind).toBe('agent');
  });

  it('an upgraded legacy view exposes kind too (view is recreated, not left stale)', () => {
    const dbPath = join(tempDir, 'legacyview.db');
    const seed = openSqlite(dbPath);
    seed.prepare("INSERT INTO organizations (id, name, owner_id) VALUES ('orga', 'A', 'u1')").run();
    closeSqlite();
    stripToLegacy(dbPath);
    const db = openSqlite(dbPath);
    const orgs = new SqliteOrgRepo(db);
    expect(orgs.declareOrgSlug('orga', 'alpha')).toMatchObject({ ok: true });
    const repo = new SqliteAddressBindingRepo(db);
    const addr = `x.alpha@${MARKUS}`;
    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({ status: 'bound' });
    const row = db.prepare('SELECT kind FROM address_bindings WHERE address = ?').get(addr) as { kind: string };
    expect(row.kind).toBe('agent');
  });
});

describe('C10-A status_transitions: entity_type address', () => {
  it('bind / revoke / re-bind leave an address lifecycle trail; idempotent re-bind does not', () => {
    const db = openSqlite(join(tempDir, 'trans.db'));
    orgsWithSlugs(db);
    const repo = new SqliteAddressBindingRepo(db);
    const transitions = new SqliteStatusTransitionRepo(db);
    const addr = `x.alpha@${MARKUS}`;

    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({ status: 'bound' });
    let rows = transitions.getByEntity('address', addr);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromStatus: 'unbound',
      toStatus: 'bound',
      changedById: 'agt_a',
      changedByType: 'agent',
    });

    // Idempotent no-op: no state change → no transition row.
    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({ unchanged: true });
    expect(transitions.getByEntity('address', addr)).toHaveLength(1);

    expect(repo.revoke({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({ status: 'revoked' });
    rows = transitions.getByEntity('address', addr);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ fromStatus: 'bound', toStatus: 'revoked' });

    expect(repo.bind({ orgId: 'orga', agentId: 'agt_a', address: addr })).toMatchObject({ status: 'bound' });
    rows = transitions.getByEntity('address', addr);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ fromStatus: 'revoked', toStatus: 'bound' });
  });
});

describe('C10-A agent_alias: UNIQUE(org_id, agent_alias), nullable', () => {
  function seedAgents(db: DatabaseSync): void {
    orgsWithSlugs(db);
    const ins = db.prepare(
      "INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, 'role_x', 'X')",
    );
    ins.run('a1', 'A1', 'orga');
    ins.run('a2', 'A2', 'orga');
    ins.run('a3', 'A3', 'orgb');
    ins.run('a4', 'A4', 'orga');
  }

  it('two agents in one org cannot share an alias; across orgs the same alias is fine', () => {
    const db = openSqlite(join(tempDir, 'alias.db'));
    seedAgents(db);
    db.prepare("UPDATE agents SET agent_alias = 'cto' WHERE id = 'a1'").run();
    expect(() => db.prepare("UPDATE agents SET agent_alias = 'cto' WHERE id = 'a2'").run()).toThrow(
      /UNIQUE constraint failed/i,
    );
    expect(() => db.prepare("UPDATE agents SET agent_alias = 'cto' WHERE id = 'a3'").run()).not.toThrow();
  });

  it('unset aliases coexist (NULL != NULL in a partial unique index)', () => {
    const db = openSqlite(join(tempDir, 'alias-null.db'));
    seedAgents(db);
    const nulls = db
      .prepare('SELECT COUNT(*) AS c FROM agents WHERE agent_alias IS NULL')
      .get() as { c: number };
    expect(nulls.c).toBe(4);
  });
});