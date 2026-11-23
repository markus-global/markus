# C10-C — Trust boundary: rebuild the autonomy axis + cross-org policy

Date: 2026-11-23 · Branch: `task/c10-c` · Base: `build/c10-adapters` @ 00358c88
(= 708d9fa3 + 0G cab08bc9 + A 9c91c9ee + B cdf9bca5) · Card: tsk_bcf3988a624bca685574aad8
SSOT for problem/fix/acceptance: `c10-external-adapters-plan-2026-11-19.md` §C.
This doc is the construction design + test plan; it does not restate the card.

## 0. Measured preconditions (grep at 00358c88, not from memory)

- `maySelfInitiate` = 0 hits; `cross_org_policy`/`crossOrgPolicy` = 0 hits;
  `autonomy-single-consumer.test.ts` absent. #464 (887e6a58) physically deleted the
  predicate + its consumer + witness + test (introduced by #462 cc06f99e). This is a
  REBUILD card, not reuse.
- `agents.autonomy` column: writers exist (sqlite-storage.ts:155 schema default 'act',
  :974 migration, :1637/:1657 insert, :1719/:1728 updateConfig, :1744 row mapper) but
  ZERO decision readers outside storage. shared `AgentConfig` (types/agent.ts:3) has no
  autonomy field; agent-manager create (:1602) / restore (:2578) drop it. 240/240 live
  agents = 'act' (plan §0.1) ⇒ no behavioral difference today; risk window Owner-accepted.
- Patrol machinery survives #464: `recordHeartbeatSkip` (agent.ts:10655, sole liveness
  exit, no LLM), `runHeartbeatPatrol` (:10680, clock wrapper + inFlight guard),
  `handleHeartbeat` (:10698). THREE entry paths converge on handleHeartbeat:
  heartbeat:trigger listener (:1495→:1514), triggerHeartbeat api fallback (:8921),
  mailbox 'heartbeat' item case (:3405). ⇒ handleHeartbeat top is the single admission.
- Settled seam (B, mail.ts:291-293 doc): signal-level ceiling
  `mayExternalSignalDemandAction(fromVerified)` (sole consumer ExternalSourceService.ingest
  :96) is a DIFFERENT fact from the agent-level axis. Two facts, two owners — do not merge,
  do not rebuild B's predicate. C rebuilds the agent-level `maySelfInitiate`.
- Forged-From rule already structural (comms/external-source.ts:9-10): namespace decided by
  ARRIVAL CHANNEL (webhook/RSS ⇒ external/unverified), never string similarity. ingest
  fromVerified=false always (:94). address.ts:127/:193 dot-count decides bindability only.
- Global resolution already org-agnostic (storage :6487 comment, findActive :6628, H4).
  ⇒ forged-From + cross-org resolution need PROBES + tests, not new enforcement code.

## 1. Construction A — autonomy axis (one predicate, one consumer, witness)

### A1. shared (packages/shared/src/types/agent.ts)
- Restore `export type AgentAutonomy = 'observe' | 'act';`
- Restore `AgentConfig.autonomy?: AgentAutonomy` (optional; storage default 'act' keeps
  historical rows identical — compatible read, no data migration).
- Restore the ONE predicate, extended so the verified=false→observe ceiling hangs on it
  (no second measure):
  ```ts
  export function maySelfInitiate(
    autonomy: AgentAutonomy | string | undefined,
    ceiling?: AgentAutonomy,
  ): boolean {
    const effective = ceiling === 'observe' ? 'observe' : autonomy;
    return effective !== 'observe';
  }
  ```
  Fail-open to old behavior by design: only 'observe' blocks; undefined/dirty ⇒ act
  (a new field must not stall existing agents). `ceiling='observe'` is the trust cap
  (cross-org unverified input, §2); it is an INPUT to the same predicate, not a second
  permissibility function.
- Export from packages/shared/src/index.ts (incremental edit).

### A2. declarations witness (packages/shared/src/declarations.ts)
- Re-register `'agent.autonomyLevel'` (kind 'param', declaredAt
  'packages/shared/src/types/agent.ts:AgentConfig', witness {type:'reader',
  at:'maySelfInitiate'}, note: default 'act', one consumer). Restore the original entry.

### A3. core single consumer (packages/core/src/agent.ts)
- At the TOP of `handleHeartbeat` (:10698), before any LLM/patrol work:
  ```ts
  if (!maySelfInitiate(this.config.autonomy, this.selfInitiationCeiling())) {
    this.recordHeartbeatSkip('Heartbeat', 'autonomy=observe — self-initiated patrol disabled');
    return;
  }
  ```
  Must go through recordHeartbeatSkip (writes last_heartbeat + metrics), NOT a bare
  return — an observe agent must still report liveness or it looks dead in the UI
  (the deleted code's load-bearing comment).
- `selfInitiationCeiling()` derives the trust ceiling from cross-org policy (§2 consumer).
  For platform-internal patrol with no unverified cross-org pending input ⇒ undefined
  (no cap) ⇒ act agents patrol unchanged.
- This is the ONLY call site of maySelfInitiate in packages/*/src.

### A4. autonomy threading (packages/core/src/agent-manager.ts)
- createAgent path (~:1602): `autonomy: request.autonomy ?? 'act'` into AgentConfig.
- restoreAgent path (~:2578): `autonomy: row.autonomy ?? 'act'` (storage row mapper
  already returns it). Mirror the heartbeatIntervalMs threading exactly.
- Add autonomy to the create request type + restore row type as needed.

## 2. Construction B — cross_org_policy + the verified=false ceiling

### 2.0 Measured seam (decides the ceiling's scope)
- a2a delivery (org-manager/agent-delivery.ts:306) passes only `from: agentAddressRef(...)`;
  mailbox.ts:1207 defaults `fromVerified ?? false`. So EVERY a2a item carries
  fromVerified=false today. Per C10-A's frozen semantics (mail.ts:144) the bit is only
  meaningful for kind='external'; for kind='agent' identity IS the platform-built id.
  ⇒ A naive "any fromVerified=false caps patrol" rule would stop every agent with queued
  a2a mail — a live-traffic regression, not a trust boundary. REJECTED.
- Settled division of labor (B, mail.ts:291-293): signal-level ceiling
  (mayExternalSignalDemandAction, sole consumer = ingest) caps what an external signal
  may DEMAND (intent→deliver, record-only). C's agent-level axis caps what the agent may
  SELF-INITIATE. external_signal records are already demand-capped by B; capping patrol
  on them again would break the L5 observe→propose flow. They do NOT feed C's ceiling.
- RULING (documented for CTO review — review is the adjudication point, as with B2):
  the verified=false→observe ceiling at the AGENT level applies to **cross-org agent
  mail**: queued item with envelope.from.kind='agent' AND fromVerified===false AND
  sender's org ≠ receiver's org, while receiver org's cross_org_policy ≠ 'auto'.
  Same-org a2a (platform-built identity) and IM human chat (B2 semantics) are untouched.
  Today: single-org serving instance ⇒ zero behavioral change; the boundary becomes
  real and probe-testable with two local orgs.

### 2.1 Storage (packages/storage/src/sqlite-storage.ts)
- organizations: add `cross_org_policy TEXT NOT NULL DEFAULT 'observe'` to SCHEMA_SQL
  (:112 block) AND the migration array (dual-write, fresh==upgraded logical shape;
  mirror the autonomy-column migration at :974). No data migration, no DROP.
- `_mapOrg` (:1628): `crossOrgPolicy: (r['cross_org_policy'] as string|null) ?? 'observe'`.
- SqliteOrgRepo (:1524): single writer `setCrossOrgPolicy(orgId, policy)` (UPDATE only;
  createOrg keeps the column default — 'observe' is never written by hand at creation).

### 2.2 Human-approved elevation (org-manager)
- org-service: `setCrossOrgPolicy(orgId, policy, actorUserId)` — validates the actor is
  a HUMAN user row (userRepo.findById), refuses otherwise (agent ids / missing actor
  throw). On success writes the policy AND one audit row via SqliteAuditRepo
  (audit_logs :594; event_type 'cross_org_policy_changed', user_id=actor,
  details={orgId, from, to}). Elevation without a human approval row is structurally
  refused at the service, not only at the HTTP edge.
- api-server: `POST /api/orgs/:orgId/cross-org-policy` behind requireAuth (human JWT;
  agents have no JWT path) + role owner/admin. 401 unauthenticated, 403 non-human/
  insufficient role, 200 + audit row on success. Mirror an existing org mutation route.

### 2.3 Ceiling wiring (one port, one consumer, same predicate)
- shared: `type CrossOrgPolicy = 'observe' | 'auto'` (exported).
- core Agent: `setTrustBoundaryPort(port)` where port =
  `{ selfInitiationCeiling(senderAgentIds: string[]): AgentAutonomy | undefined }`.
  Agent-side derivation (INPUT, not a decision): collect from.kind='agent' &&
  fromVerified===false senders of queued items → ask port. Port absent ⇒ undefined
  (single-org/embedded deployments have no cross-org knowledge; documented fail-open
  consistent with the axis's fail-open default — the axis itself still bites).
- org-manager/storage-bridge implements the port: sender org ≠ receiver org AND
  receiver org crossOrgPolicy ≠ 'auto' ⇒ 'observe', else undefined.
- agent-manager: applyTrustBoundaryPort on BOTH creation paths (mirror
  applyFactsCapability:3814); autonomy threaded per §A4.
- The ONLY place the ceiling can affect behavior is the maySelfInitiate call in §A3.
  No per-adapter guard, no second permissibility function.

## 3. Probes (second instance, HOME redirect; serving DB untouched)
- P1 observe/act behavior: disposable agent autonomy='observe' → heartbeat trigger →
  skip activity + last_heartbeat refreshed, no LLM patrol; 'act' twin → patrol runs.
- P2 forged From: webhook POST from='cto.<slug>@markus.global' requesting
  trigger_execution → stored envelope kind='external', fromVerified=false, intent
  capped 'deliver' (B's ceiling) — string similarity never decides identity.
- P3 cross-org resolution + ceiling: two local orgs; org-B agent binds address; org-A
  agent delivers → global resolution lands the item; while it is queued unverified,
  org-B agent's self-initiated patrol is capped (skip); human elevates policy → audit
  row → patrol resumes. Readings with timestamps.
- P4 elevation auth: no token → 401; non-owner → 403; owner → 200 + audit_logs row.
- L5 strengthened (B2/C gate): stranger resource self-binds in one conversation →
  real webhook signal arrives → agent consumes and proposes next step while the
  trust boundary holds (no autonomous action demanded by the unverified signal).

## 4. Tests + falsification (red first, then implement)
- shared: predicate truth table (observe blocks; act/undefined/dirty pass; ceiling
  'observe' caps act); single-consumer guard (a second call site in packages/*/src →
  red); witness registry entry present (declarations-witness greps maySelfInitiate).
- core behavior: observe agent heartbeat → recordHeartbeatSkip path, no patrol LLM;
  act agent → patrol; cross-org unverified queued item + policy observe → capped;
  policy auto → not capped; same-org a2a / external_signal / im items → NOT capped.
- storage: fresh + upgraded DB both default 'observe'; setCrossOrgPolicy round-trip.
- org-manager: elevation without human actor refused; with human → policy + audit row;
  API 401/403/200 matrix.
- Falsification trio (each: seed → RED observed → revert → GREEN):
  F1 seed a second maySelfInitiate call site → guard red;
  F2 remove the admission consumer (bare return) → behavior test red;
  F3 bypass the human check in setCrossOrgPolicy → elevation test red.
- Non-empty-shell: new tests copied onto clean base 00358c88 → red; this tree → green.

## 5. Boundaries
- No data migration, no DROP, no serving-instance restart, no merge to main, no publish.
- Do NOT touch Feishu inbound dispatch files (B2 territory, already landed a25cd735).
- Do NOT rebuild or modify B's signal-level predicate (two facts, two owners).
- Envelope shape (C10-A frozen) unchanged; no new envelope fields.
- packages/*/src/index.ts: incremental edits only.

## 6. Verification gates (CI order, exit codes not step names)
typecheck → lint → architecture-guard → identity-audit --self-test → test:json →
test:web-ui → test:skipped-audit; security-guard extra local run. Known pre-existing
red: quickInit-8056 port collision (dual-card precedent); any NEW red is mine to fix.

## 7. Built status (landing note)

Built: YES — this commit on task/c10-c (base 00358c88).
- Construction A + B landed as designed above. agent-manager.ts changes are pure
  additions (autonomy threading on create/restore + setTrustBoundaryPort); agent
  registration / getAgent / listAgents are untouched.
- Tests: 28 new (shared 8 / core 6 / storage 4 / org-manager 10), red-first on base.
  Falsification trio F1/F2/F3 each seeded → RED observed → reverted → GREEN.
  Non-empty-shell: the new tests copied onto clean base 00358c88 → 26 red; this
  tree → 28 green.
- CI (exit codes measured): typecheck / lint / architecture-guard / identity-audit
  --self-test / security-guard = 0. test:json = 7634 passed | 11 skipped | 1 red,
  the red being quickInit-8056 EADDRINUSE (pre-existing: the serving instance holds
  :8056 — lsof PID 28013 — and this card touches zero cli files). test:web-ui =
  1591 passed | 3 skipped. test:skipped-audit = 0 (7646 total, 11 registered skips).
- Probes (second instance, HOME redirect, serving DB untouched): P2 forged From →
  envelope kind=external, fromVerified=false, intent capped deliver, external
  work_unit_ref (real machine). P4 elevation 401/403/200/200/400 + one audit row per
  change (real machine). P3 cross-org a2a delivery envelope + elevation observe→auto
  audit (real machine). P1 observe/act + P3 ceiling skip/resume behavior is evidenced
  by the real-code behavior tests driving handleHeartbeat admission directly; the
  HTTP heartbeat-trigger probe could not read created agents in the probe boot path
  (getAgent reads the in-memory map while the list route merges DB rows) — a probe
  instance characteristic orthogonal to this card's pure-additions diff.
- §2.0 RULING (ceiling scope = cross-org agent mail only; same-org a2a / IM untouched)
  is the adjudication point for CTO review, as with B2.