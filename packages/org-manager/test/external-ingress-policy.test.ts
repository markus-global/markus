/**
 * C10-F — organization-level external ingress policy (Owner ruling, 2026-11-26).
 *
 * The invariant under test: **whether an organization takes outside input, and
 * what an accepted signal may do, is decided in exactly one place** — the single
 * ingest point — and that decision is the org's, not the agent's and not the
 * sender's.
 *
 * Why each case is written the way it is (a weaker assertion would be a fake
 * green):
 *
 *  · `off` asserts **both** the HTTP refusal and `queuedSignals() === 0`. Only
 *    the status code would still pass if the item were stored and then filtered;
 *    only the row count would still pass if the caller were told "ok".
 *  · `observe` asserts the persisted **envelope intent is `deliver`**, not just
 *    that something arrived. The whole difference between observe and accept is
 *    "does this owe a turn"; asserting arrival would make the two states
 *    indistinguishable, and a regression that collapses them would stay green.
 *  · Policy isolation is asserted across two orgs in the same database: a global
 *    "last write wins" implementation would pass a single-org test and leak a
 *    closed org's traffic open.
 *
 * Pre-change these tests fail at the first step: `ExternalSourceService` had no
 * policy input at all, so `off` could not refuse and `observe` could not lower
 * the intent floor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as storage from '../../storage/src/sqlite-storage.js';
import { AgentMailbox, EventBus } from '@markus/core';
import { WorkUnitService } from '../src/work-unit-service.js';
import { ExternalSourceService } from '../src/external-source-service.js';

const ORG = 'acme';
const OTHER_ORG = 'globex';
const OWNER = 'agt_owner';
const ADDR = 'hook.acme@markus.global';
const OTHER_ADDR = 'hook.globex@markus.global';

let tempDir: string;
let db: ReturnType<typeof storage.openSqlite>;
let orgRepo: storage.SqliteOrgRepo;
let sources: storage.SqliteExternalSourceRepo;
let bindings: storage.SqliteAddressBindingRepo;
let mbRepo: storage.SqliteMailboxRepo;
let service: ExternalSourceService;
let boxes: Map<string, AgentMailbox>;

function persistenceFor(repo: storage.SqliteMailboxRepo) {
  const row = (item: any, status: string, messageId: string | null, dropReason: string | null) => ({
    id: item.id, agentId: item.agentId, sourceType: item.sourceType,
    priority: item.priority, status,
    payload: item.payload as Record<string, unknown>,
    metadata: (item.metadata ?? {}) as Record<string, unknown>,
    queuedAt: item.queuedAt, dedupKey: undefined,
    envelope: item.envelope ? JSON.stringify(item.envelope) : null,
    messageId,
    signalClass: item.envelope?.signalClass ?? null,
    intent: item.envelope?.intent ?? null,
    dropReason, bounceTarget: item.bounceTarget ?? null,
    workUnitRef: item.workUnitRef ?? null,
  });
  return {
    save: (item: any, dedupKey?: string) => repo.save({ ...row(item, item.status, item.envelope?.messageId ?? null, item.dropReason ?? null), dedupKey }),
    updateStatus: (id: string, status: string, extra?: Record<string, unknown>) => repo.updateStatus(id, status, extra),
    findByMessageId: (aid: string, mid: string) => repo.findByMessageId(aid, mid),
    saveBounced: (item: any, dropReason: string) => { repo.save(row(item, 'bounced', null, dropReason)); },
    getStatus: (id: string) => repo.getStatus(id),
  };
}

beforeEach(() => {
  storage.closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-ingress-'));
  db = storage.openSqlite(join(tempDir, 'data.db'));
  db.prepare("INSERT INTO organizations (id, name, owner_id, org_slug) VALUES (?, ?, 'usr_o', ?)").run(ORG, ORG, ORG);
  db.prepare("INSERT INTO organizations (id, name, owner_id, org_slug) VALUES (?, ?, 'usr_o', ?)").run(OTHER_ORG, OTHER_ORG, OTHER_ORG);
  db.prepare("INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, 'role_w', 'worker')").run(OWNER, OWNER, ORG);
  orgRepo = new storage.SqliteOrgRepo(db);
  sources = new storage.SqliteExternalSourceRepo(db);
  bindings = new storage.SqliteAddressBindingRepo(db);
  mbRepo = new storage.SqliteMailboxRepo(db);
  const workUnits = new WorkUnitService({ repo: new storage.SqliteWorkUnitRepo(db) });
  boxes = new Map();
  const mailboxOf = (aid: string) => {
    let mb = boxes.get(aid);
    if (!mb) {
      mb = new AgentMailbox(aid, new EventBus(), persistenceFor(mbRepo) as any);
      mb.setAddressLookup({ findActive: (addr: string) => bindings.findActive(addr) });
      mb.setIdentityPort({ ensureIdentity: (seed: any) => workUnits.ensure(seed) !== null });
      boxes.set(aid, mb);
    }
    return mb;
  };
  service = new ExternalSourceService({
    sources,
    findActive: (addr: string) => bindings.findActive(addr),
    mailboxOf,
    // The production read port (cli/start.ts) does exactly this: read the column,
    // treat anything unexpected as 'off'. A test that hard-coded the policy would
    // not prove the column is actually what governs ingress.
    ingressPolicy: (orgId) => {
      const row = orgRepo.findOrgById(orgId) as { externalIngress?: string } | undefined;
      const policy = row?.externalIngress;
      return policy === 'accept' || policy === 'observe' ? policy : 'off';
    },
    now: () => new Date('2026-11-26T10:00:00Z'),
  });
});

afterEach(() => {
  service.stopPolling();
  storage.closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const queuedSignals = () =>
  (db.prepare("SELECT COUNT(*) c FROM mailbox_items WHERE source_type='external_signal' AND status='queued'").get() as { c: number }).c;

const lastEnvelope = () => {
  const row = db
    .prepare("SELECT envelope FROM mailbox_items WHERE source_type='external_signal' ORDER BY rowid DESC LIMIT 1")
    .get() as { envelope: string } | undefined;
  return row ? (JSON.parse(row.envelope) as Record<string, unknown>) : undefined;
};

function registerWebhook(orgId = ORG, agentId = `agt_${orgId}`, address = ADDR): { id: string; secret: string } {
  db.prepare("INSERT OR IGNORE INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, 'role_w', 'worker')")
    .run(agentId, agentId, orgId);
  // The address must be bound to the source's owner — the register gate reads the
  // binding, so a test that skipped it would be asserting a path that cannot happen.
  const bound = bindings.bind({ orgId, agentId, address });
  expect(bound.status, JSON.stringify(bound)).toBe('bound');
  // Register through the SERVICE, not the repo: the service is what mints the
  // shared secret. A repo-level fixture would build a tokenless source, and every
  // request would 401 before reaching the policy gate — testing the wrong door.
  const out = service.registerSource({ orgId, agentId, kind: 'webhook', address });
  expect(out.status).toBe('registered');
  expect(out.secret).toBeTruthy();
  return { id: out.source!.id, secret: out.secret! };
}

const webhookBody = (over: Record<string, unknown> = {}) => ({
  messageId: 'wh-1', from: 'sender@external.example', subject: 'Hello', content: 'body', ...over,
});

describe('C10-F: organization external ingress policy is the single gate', () => {
  it('defaults to off: a fresh organization refuses inbound and stores nothing', () => {
    const { id: sourceId, secret: token } = registerWebhook();
    // The column default, not a fixture override — this is what an upgrading
    // install lands on.
    expect((orgRepo.findOrgById(ORG) as { externalIngress?: string }).externalIngress).toBe('off');

    const out = service.receiveWebhook(sourceId, webhookBody(), token);

    expect(out.http).toBe(403);
    expect(out.body['status']).toBe('refused');
    expect(out.body['reason']).toBe('org_ingress_off');
    expect(queuedSignals()).toBe(0);
  });

  it('observe accepts but lowers the intent floor to deliver (records, does not owe a turn)', () => {
    const { id: sourceId, secret: token } = registerWebhook();
    orgRepo.setExternalIngress(ORG, 'observe');

    const out = service.receiveWebhook(sourceId, webhookBody(), token);

    expect(out.http).toBe(200);
    expect((out.body as { status: string }).status).toBe('ingested');
    expect(queuedSignals()).toBe(1);
    // The only observable difference between observe and accept.
    expect(lastEnvelope()?.['intent']).toBe('deliver');
  });

  it('accept owes a turn: intent is action_required', () => {
    const { id: sourceId, secret: token } = registerWebhook();
    orgRepo.setExternalIngress(ORG, 'accept');

    const out = service.receiveWebhook(sourceId, webhookBody(), token);

    expect(out.http).toBe(200);
    expect(lastEnvelope()?.['intent']).toBe('action_required');
  });

  it('the policy belongs to the org: closing one must not close another', () => {
    const closed = registerWebhook(ORG, 'agt_acme', ADDR);
    orgRepo.setExternalIngress(ORG, 'off');
    const open = registerWebhook(OTHER_ORG, 'agt_globex', OTHER_ADDR);
    orgRepo.setExternalIngress(OTHER_ORG, 'accept');

    expect(service.receiveWebhook(closed.id, webhookBody({ messageId: 'a' }), closed.secret).http).toBe(403);
    expect(service.receiveWebhook(open.id, webhookBody({ messageId: 'b' }), open.secret).http).toBe(200);
    expect(queuedSignals()).toBe(1);
  });

  it('the gate covers every entry path, including operator delivery (one gate, not three)', () => {
    const { id: sourceId } = registerWebhook();
    orgRepo.setExternalIngress(ORG, 'off');

    const out = service.deliverAsOperator({
      orgId: ORG, agentId: 'agt_acme', sourceId, address: ADDR, body: webhookBody(),
    });

    expect(out.status).toBe('refused');
    expect(queuedSignals()).toBe(0);
  });

  it('RSS polling stops on refusal instead of hammering a closed org', async () => {
    sources.register({ orgId: ORG, agentId: 'agt_rss', kind: 'rss', address: 'feed.acme@markus.global', config: { feedUrl: 'https://example.com/feed.xml' } } as never);
    db.prepare("INSERT OR IGNORE INTO agents (id, name, org_id, role_id, role_name) VALUES ('agt_rss', 'rss', ?, 'role_w', 'worker')").run(ORG);
    bindings.bind({ orgId: ORG, agentId: 'agt_rss', address: 'feed.acme@markus.global' });
    orgRepo.setExternalIngress(ORG, 'off');

    // No fetchText dep: if polling got as far as fetching, this would throw and
    // the test would fail loudly rather than silently reporting 0.
    const out = await service.pollRss(sources.listByAgent(ORG, 'agt_rss')[0]!.id);
    expect(out).toEqual({ fetched: 0, ingested: 0 });
    expect(queuedSignals()).toBe(0);
  });
});

describe('C10-F: webhook secret rotation', () => {
  it('rotating replaces the secret, invalidates the old one, and never echoes the full secret in the list', () => {
    const { id: sourceId, secret: before } = registerWebhook();
    orgRepo.setExternalIngress(ORG, 'accept');

    const rotated = service.rotateSecret({ orgId: ORG, agentId: 'agt_acme', sourceId });
    expect(rotated.status).toBe('rotated');
    const after = rotated.secret!;
    expect(after).not.toBe(before);

    // Old secret must stop working immediately — rotation is not advisory.
    expect(service.receiveWebhook(sourceId, webhookBody({ messageId: 'old' }), before).http).toBe(401);
    expect(service.receiveWebhook(sourceId, webhookBody({ messageId: 'new' }), after).http).toBe(200);

    const listed = service.listSources(ORG, 'agt_acme').find((s) => s.id === sourceId)!;
    expect(listed.hasSecret).toBe(true);
    expect(listed.secretPreview).toBe(`••••${after.slice(-4)}`);
    expect(JSON.stringify(listed)).not.toContain(after);
  });

  it('refuses to rotate a source that is not yours', () => {
    const { id: sourceId } = registerWebhook(ORG, 'agt_acme', ADDR);
    const out = service.rotateSecret({ orgId: ORG, agentId: 'agt_someone_else', sourceId });
    expect(out.status).toBe('forbidden');
  });
});

describe('C10-F: the policy column is a closed set with one writer', () => {
  it('writes and reads back through the repo writer only', () => {
    orgRepo.setExternalIngress(ORG, 'observe');
    expect((orgRepo.findOrgById(ORG) as { externalIngress?: string }).externalIngress).toBe('observe');
    // The other org is untouched — the writer is keyed by org, not global.
    expect((orgRepo.findOrgById(OTHER_ORG) as { externalIngress?: string }).externalIngress).toBe('off');
  });
});
