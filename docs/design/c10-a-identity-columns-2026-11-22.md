# C10-A — Identity columns, envelope slots, slug-ownership enforcement

Card: `tsk_80517bb773ae1f41145ba8f3`. SSOT for problem/fix/acceptance:
`docs/design/c10-external-adapters-plan-2026-11-19.md` §A (frozen field semantics:
master plan §4.9.6). This document records the implementation decisions and the
evidence plan; it does not restate the card.

Base: `origin/feat/refactor-plan` @ `708d9fa3` (re-read at card start).
Worktree: `/Users/liuqian/mycode/worktrees/c10-a`, branch `task/c10-a`.

## 1. Measured starting point (2026-11-22 21:44 CST, read-only on `~/.markus/data.db`)

- `organizations`: 2 rows — `default` and `user_4941a0558946c8e1f58962cc`, both
  named `My Organization` (the name collision is exactly why slugs must never be
  derived from `name`).
- `agents`: 240. `channel_bindings`: 1 row, `address IS NULL` (zero live address
  bindings). `status_transitions.entity_type` ∈ {task, requirement, work_unit}.
- `address_bindings` is a **view** over `channel_bindings` (C6); the base table
  already has `kind TEXT` since its creation (`f91d064a`), but the view does not
  expose it, and `bind()` writes `kind='mail'` — outside the frozen closed set
  `kind ∈ {agent, role, platform}` (master plan §4.9.6).
- `EnvelopeAuth` (shared `mail.ts`) already exists as a reserved slot with three
  non-null enum fields; §A freezes **four nullable fields** `{spf, dkim, dmarc,
  verified}`. No consumer reads `auth` today (grep: only `mail.ts`).

## 2. Decisions

### D1 — `organizations.org_slug` (nullable column, real consumer)

- `ALTER TABLE organizations ADD COLUMN org_slug TEXT` (migrations array) + the
  same column in `SCHEMA_SQL`; partial unique index
  `uq_organizations_org_slug ON organizations(org_slug) WHERE org_slug IS NOT NULL`
  created **after** migrations (never in `SCHEMA_SQL`).
- **Single derivation point** `registryOrgSlug(orgId) = 'org_' + orgId` (exported
  from `sqlite-storage.ts`). Two callers, one rule: `createOrg` assigns it at
  INSERT (new orgs are never slug-less — §4.9.6 "NOT NULL for new orgs" as a
  write-path discipline, the column itself stays nullable), and a **one-time
  explicit backfill** runs only when this upgrade adds the column
  (`addedColumns.includes('organizations.org_slug')`, same pattern as
  `tasks.status_changed_at`). The backfill is id-based, never name-based; it never
  overwrites a declared value on re-open.
- **Explicit declaration path** `SqliteOrgRepo.declareOrgSlug(orgId, slug)`:
  validates through the single segment validator shared with
  `formatAddress`/`parseAddress` (new export `checkOrgSlug` in `shared/address.ts`
  — no second rule set), rejects once the org has **ever issued an address**
  (`channel_bindings` row with `address IS NOT NULL`, revoked rows included —
  "immutable after first address issuance"), and lets the unique index adjudicate
  cross-org collisions. Rationale: `org_<id>` contains `_`, which is not a legal
  address segment, so without a declaration path no real org could ever pass the
  ownership check and the L5 gate ("binds the address … no human UI clicks")
  would be structurally dead. Declaration is the registry write; it never reads
  `name`.
- `_mapOrg` exposes `orgSlug` (read side).

### D2 — bind-time slug ownership (the consumer that bites)

In `SqliteAddressBindingRepo.bind`, after the existing format gate
(`rejectUnbindable`, unchanged and still shared with `revoke`):

1. `parseAddress(address)` (the single parser) → `orgSlug` segment.
2. Read `organizations.org_slug` for `input.orgId`.
3. Org missing or slug NULL → `{status:'bounced', detail:'org_slug_unset'}`;
   mismatch → `{status:'bounced', detail:'org_slug_mismatch'}` — both with an
   actionable hint. `reason` stays `unresolved_address` (the existing
   `BounceReason` closed set is **not** extended; precision lives in `detail`,
   exactly like `platform_reserved` / `external_domain`).
4. Match → INSERT; the global partial unique index still adjudicates collisions
   (no check-then-insert for uniqueness).

`revoke` deliberately does **not** gain the ownership gate: releasing your own
historical binding must not be locked out by registry state. Two new members in
`AddressBindRejectDetail` (shared): `org_slug_unset`, `org_slug_mismatch`.

### D3 — `agents.agent_alias` (reserved column, no writer this card)

Nullable column + partial unique index
`uq_agents_org_alias ON agents(org_id, agent_alias) WHERE agent_alias IS NOT NULL`.
No writer and no bind-time enforcement in this card: the issuance/revocation
lifecycle (unset = no mail address, change revokes old binding + isolation
period) needs an issuance tool that does not exist yet; enforcing it at `bind`
now would kill `bind_address` for all 240 agents before any alias could be
issued. §A lists the alias lifecycle as a later consumer; the column + constraint
are this card's seam. `role_slug`: name stays reserved, no table (per §A).

### D4 — `envelope.auth` slot shape

`EnvelopeAuth` becomes `{spf, dkim, dmarc: 'pass'|'fail'|'none'|null; verified:
boolean|null}` — four nullable fields. `buildDeliveryEnvelope` still writes
`auth: null` (no values until an adapter actually verifies — C10-D);
`parseEnvelope` passes the slot through unchanged. `auth.verified` is the
adapter's authentication verdict; it is **not** `fromVerified` (the routing trust
bit, H1) — two different facts, commented as such.

### D5 — `address_bindings.kind`

The view is recreated (`DROP VIEW IF EXISTS` + `CREATE VIEW`) in the
post-migration transaction so upgraded DBs expose `kind` too — a view holds zero
rows, so this is non-destructive (the card's no-DROP rule protects data, and no
table/column is dropped). `bind()` writes `kind='agent'` (frozen closed set;
zero live address rows, so no existing-row impact). `AddressBindingRow` + `mapRow` expose
`kind`.

### D6 — `status_transitions.entity_type` gains `address`

No schema change (TEXT column). The `entityType` unions of
`SqliteStatusTransitionRepo.record` / `getByEntity` gain `'address'`; `bind`
(success, not the idempotent no-op) records `unbound|revoked → bound` and
`revoke` records `bound → revoked`, through the existing single execution point
(`record`), `changedByType:'agent'`, `changedById:agentId`.

## 3. Migration discipline

DDL + migrations-array entry both; indexes/uniques after migrations; nullable
only; no observation-log backfill; the only data write is the explicit
`org_slug` backfill (D1). Fresh-init and upgraded DBs must end with identical
schema — tested by comparing `sqlite_master` (normalized) + `PRAGMA table_info`
for the touched tables between a fresh DB and a legacy DB upgraded through
`openSqlite`.

## 4. Evidence plan (acceptance ↔ proof)

| Acceptance | Proof |
|---|---|
| fresh vs upgraded schema identical | `c10-a-identity-columns.test.ts` schema-consistency test + real-DB-copy probe readings |
| ownership check bites | org B binds `x.<orgA-slug>@` → bounced `org_slug_mismatch`; org A binds own slug → bound; **falsification**: delete the gate → tests red, restore → green |
| no slug derived from name | two same-name orgs get distinct `org_<id>` slugs; `createOrg('Acme Corp')` → `org_<id>`, never a slugified name |
| two historical orgs assigned | probe on a **copy** of `~/.markus/data.db` (serving DB untouched — the view recreation would break the old build's read path): SELECT readback with timestamp |
| tests not empty shells | new tests copied back to base commit `708d9fa3` → red at base, green at head |
| CI-equivalent regression | plan §3.1 layer-2 order: typecheck → lint → architecture-guard → identity-audit --self-test → test:json → test:web-ui → test:skipped-audit (+ security-guard as a labelled local extra). Windows storage matrix **not covered locally**. |

Existing `address-bindings.test.ts` fixtures insert orgs without slugs; they are
updated to declare `org_slug` explicitly (the fixture plays the registry) — the
ownership gate is a real behavior change and the fixtures must state the org's
slug, not bypass the gate.

## 5. Boundaries

Files: `shared/src/{address,mail}.ts`, `storage/src/{sqlite-storage,types}.ts`,
their tests, docs. No intersection with C10-0G (audit mechanism files). No data
migration beyond the explicit backfill, no DROP of tables/columns, no restart of
the serving instance, no merge to main, no release.

## 6. Evidence (measured 2026-11-22, all times CST)

- **Red first** (21:58, base implementation + new tests): 2 files, 23 red / 3 green
  (the 3 green are invariant-behavior assertions: `auth` stays null, builder shape).
- **Green after implementation** (22:08): `c10-a-identity-columns.test.ts` (20) +
  `c10-a-slots.test.ts` (6) + `address-bindings.test.ts` (26) = **52/52 green**;
  `pnpm typecheck` exit 0.
- **Falsification A — the gate bites** (22:10): with both ownership branches
  disabled, exactly 3 tests go red (squat → `org_slug_mismatch`, fail-closed →
  `org_slug_unset`, cross-org rebind in the C6 file); gate restored → 52/52 green.
- **Falsification B — tests are not empty shells** (22:12): the new test files
  copied into a clean base worktree at `708d9fa3` (`/tmp/c10a-base`, own
  `pnpm install` + shared build): **23 red / 3 green** (`checkOrgSlug is not a
  function`, `table organizations has no column named org_slug`) — identical to
  the red-first reading; head is 52/52 green.
- **Real-data probe** (22:13:24–25, `sqlite3 .backup` copy of `~/.markus/data.db`,
  13.1 GB; serving DB opened read-only only):
  - before: `org_slug` column absent; after upgrade through the new `openSqlite`:
    `default → org_default`, `user_4941a0558946c8e1f58962cc →
    org_user_4941a0558946c8e1f58962cc` (explicit, id-based; both orgs share the
    display name `My Organization`, so name-derivation is provably not the source).
  - non-destructive: agents 240, work_units 523, mailbox_items 243,322,
    channel_bindings 1, status_transitions 9,550, facts 61, envelope non-empty
    1,723 — **all identical before/after**; `entity_type='address'` rows = 0
    (migration fabricates no lifecycle history); the legacy routing row unchanged.
  - serving DB after probe: still **no** `org_slug` column (never upgraded in
    place — the view recreation would break the old build's read path).
- **Schema identity on real data** (22:14:58, probe #2): upgraded copy vs
  fresh-init, logical column shape (name/type/notnull/default/pk, sorted) +
  view/index SQL: **identical, diffs = []**. Probe #1's `false` was a comparison
  artifact (JSON key order = cid order); see the cid note below.
- **cid-order note**: physical column order legitimately differs between
  fresh-init and ALTER-upgrade for columns present in both `SCHEMA_SQL` and the
  migrations array (pre-existing precedent: `mailbox_items.envelope`,
  `channel_bindings.address`). All read paths are name-based, so the schema
  contract is logical identity — the test and probe compare sorted column shapes,
  never cid order.
- **CI-equivalent regression**: plan §3.1 layer-2 order, readings in the delivery
  report. Windows storage matrix **not covered locally**.