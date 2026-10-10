# G8 — Closure: full regression, real-data acceptance, docs, owner handoff

> Slice **G8** of requirement `req_f2610b70e3196b1201d4bf1b` (通用消息网关).
> Branch `task/tsk_ae3d5e79cfb2173d7555a38d`, base = `main` tip `ec8b423f`,
> HEAD = *this branch's tip commit*.
> **This slice opens no PR.** It exists so the owner can verify the whole
> requirement by hand, then submit it as one unit.

---

## 0. What "closure" means here

G1–G7 are seven mergeable slices that were built in parallel worktrees. Each one
passed its own review, but three seams *between* slices were left unwired — two
handoffs each claimed the other side had connected them, and the code said
otherwise. G8 is the slice that:

1. **assembles** G5 + G6 + G7 into one mergeable line (real 3-way merges, not a
   concatenation of patches),
2. **closes the three cross-slice seams** (A/B/C below) — this is new code, not
   paperwork,
3. runs the **full regression** and classifies every failure (this slice vs.
   pre-existing),
4. states, per requirement bullet, **what is proven on this machine and what is
   not**,
5. hands the owner a step-by-step manual verification script, and
6. **does not** open a PR, merge, or touch `main`.

## 1. Assembly: topology, base, conflicts

G5, G6 and G7 were built off different bases, so the union has to be re-merged
rather than assumed. The topology, verified with `git log --graph`:

```
G1 c6e9d719  storage: platform_instances + channel_bindings + idempotent migration
 ├─ G2 e96ded6d  bot instances in the registry
 │   └─ G4 92878519  OutboundDispatcher + three-level notification routing
 ├─ G3 55963d46  single inbound resolution + conversation isolation
 └─ (G6 base) 1b03bcfd  merge: G4 ⊕ G3
      └─ G6 dcf60dc1  single Feishu inbound path, legacy notifier retired
           └─ G7 9e598b53  Slack Socket Mode + capability model (off G4 tip)
                └─ merge G7 → dbd1cb9e        (clean)
                     └─ merge G5 685ad4b1 → c8a7c98c   (3 conflicts, below)
```

The branch was cut from `main` at `ec8b423f` (`git merge-base HEAD origin/main`),
not from any single slice tip.

Two merges were performed, both into this branch:

| Merge | Result | Conflicts |
|---|---|---|
| G7 (`9e598b53`) | `dbd1cb9e` | 0 — clean |
| G5 (`685ad4b1`) | `c8a7c98c` (G5 merge) | 3 files, resolved below |

The G5 merge conflicts were all **merge artifacts of parallel work**, not
disagreements:

- `packages/comms/src/index.ts` (×2) — both sides appended exports; unioned.
- `packages/comms/src/router.ts` — G6's gateway inbound + G7's
  `isPlatformConnected` / `reconnectPlatform`; unioned, keeping both.
- `packages/comms/test/router-instances.test.ts` — G6 changed the inbound
  handler's signature to hand the resolver's `target`; G5's test had been written
  before that. Adapted the call site to `target.agentId` (the G6 contract). This
  is the same class of "merge artifact fixture" G5 already hit once (see its
  handoff §4).

### Payload

`git diff --stat origin/main...HEAD` reports **107 files, +19055 / −2907** — the
whole requirement as one reviewable unit. (The branch inherits the earlier
issue-340 manifest programme from `main`'s line, so the diff is the union, not
just G1–G8.)

## 2. The three cross-slice seams — closed

The Secretary's reviews of G4/G5/G7 found three places where two slices each
believed the other had wired a seam. G8 is the closing slice, so each is handled
here — either **wired with evidence** or **honestly declared**, never left as the
original inaccurate claim.

### A. `notifyAgentId` — **WIRED** (was: persisted but inert)

**Was.** The G5 UI writes the "Notification target" into
`platform_instances.config.notifyAgentId`. G4's `RepoNotifyTargetLookup` read only
`channel_bindings` — `grep notifyAgentId` against the G4 worktree had **zero**
hits. So the control persisted and never took effect, and the two handoffs each
said the other end was connected.

**Now.** `RepoNotifyTargetLookup.instanceTarget` (level 2 of the walk) reads the
key. The UI's own words define the semantics — *"Approvals and notifications about
this bot are delivered here. Leave empty to use the org secretary"* — so:

- instance declares `config.notifyAgentId = X` → the sink is **X's own addressable
  conversation** (resolved by the same `ownTarget` helper level 1 uses);
- blank/empty → nothing declared → the walk falls through to level 3 (the org
  Secretary), which is literally the UI's "leave empty to use the org secretary";
- an explicit `kind = 'notification'` binding, if one exists, still wins (it names
  a concrete channel, so it is the more specific declaration).

**Evidence.**
- Code: `packages/comms/src/gateway/notify-lookup.ts` — `instanceTarget` step (b)
  and the private `declaredNotifyAgent` reader.
- Tests: `packages/comms/test/gateway-notify-lookup.test.ts` — three new cases
  (resolves the declared target agent; ignores a blank value and falls through;
  explicit `notification` binding still wins). All green.
- The production wiring already passes the full `platformInstanceRepo` (whose rows
  carry `config`) into the lookup (`packages/cli/src/commands/start.ts`), so no
  assembly change was needed — only the reader was missing.

### B. Capability table — **WIRED** (was: no runtime consumer; `ackDeadlineMs` had two writers)

**Was.** `activeInboundMode` / `capabilities.inboundModes` had no production
consumer — the Slack adapter decided socket-vs-webhook from a bare
`config.socketMode`. And the ack window existed twice: `ackDeadlineMs: 3000` in the
table *and* `SLACK_ACK_DEADLINE_MS = 3000` in the adapter.

**Now.**
1. **Transport decision goes through the table.** `SlackAdapter.connect()` and
   `FeishuAdapter.connect()` call `activeInboundMode(capabilities, config)`; neither
   reads `config.socketMode` / `config.wsMode` to choose a transport any more. The
   adapter defaults `capabilities` to its own manifest entry, so the table is the
   single author of "how does inbound arrive".
2. **`ackDeadlineMs` has one writer.** The Slack adapter passes
   `capabilities.ackDeadlineMs` to `SlackSocketMode`; the local `3000` constant is
   gone (`grep SLACK_ACK_DEADLINE_MS` → 0 hits).
3. **The table needed a new field to be truthful.** Expressing *"Feishu defaults to
   its long connection, webhook is opt-in"* was impossible with `inboundModes`
   alone, so `defaultInboundMode` was added. This exposed a **latent contradiction**:
   the G7 test asserted `activeInboundMode(feishu, {}) === 'webhook'`, while the G6
   adapter has shipped *long connection by default* since it landed. The table had
   drifted from reality precisely because nothing read it. Fixed: Feishu declares
   `defaultInboundMode: 'socket'`, and the registry test now asserts that — with a
   new case pinning `wsMode: false → webhook`.

**Evidence.**
- Code: `packages/comms/src/platforms/registry.ts` (`defaultInboundMode`,
  `activeInboundMode`), `packages/comms/src/slack/adapter.ts`,
  `packages/comms/src/feishu/adapter.ts`.
- Tests: `platform-registry.test.ts` (default + opt-out cases);
  `slack-adapter.test.ts`, `slack-socket.test.ts`, `feishu-adapter.test.ts` all
  still green — the wiring is **behaviour-preserving** for both platforms.

### C. G7 handoff wording — **CORRECTED**

`docs/handoff/g7-platform-capabilities.md` claimed Discord "pins its transport
behaviour in the probe's capability table". The probe
(`verify-g7-real-data.mjs`) is **Slack-only — zero Discord references**. The claim
is corrected in place to point at the real coverage: `platform-registry.test.ts`
(the declaration) and the pre-existing `discord-transport.test.ts` (the wire).

### Also corrected: the G5 handoff's mirror-image claim

`docs/handoff/g5-ui-instances.md` residual #2 said *"G5 writes the key, G4 reads
it"*. That was **false**. It now records that G8 added the missing reader.

---

## 3. Slice map

Every slice's commit is reachable from the branch tip:

| Slice | Commit | What it added |
|---|---|---|
| G1 | `c6e9d719` | Schema + idempotent migration: `platform_instances`, `channel_bindings` |
| G2 | `e96ded6d` | Bot instances in the registry; router keyed by `instanceId` (one platform, many bots) |
| G3 | `55963d46` | Single inbound resolution + per-channel session isolation; unbound ⇒ falls back to the Secretary, never dropped |
| G4 | `92878519` | Outbound dispatcher + three-level notification routing |
| G5 | `685ad4b1` | UI: instance list, Add bot, group/channel binding, notification target |
| G6 | `dcf60dc1` | Retire the old Feishu dual inbound path + old notifier (single inbound path) |
| G7 | `9e598b53` | Slack Socket Mode + platform capability table (no public URL needed) |
| **G8** | *(this branch's tip commit)* | Closure: assembly, A/B/C wiring, regression, acceptance, docs |

---

## 4. Verification

### 4.1 Full regression

`pnpm test` across the monorepo, on the branch tip:

```
 Test Files  2 failed | 445 passed (447)
      Tests  2 failed | 6423 passed | 10 skipped (6435)
```

`tsc -b` (whole repo) and `eslint` (changed files): **0 errors**.

**Every failure, classified — with evidence, not impressions:**

| # | Failing test | Wall time | Why it is *not* this payload |
|---|---|---|---|
| 1 | `packages/cli/test/commands-start-integration.test.ts › auto-runs quickInit when config is missing` | 60 s (timeout) | Needs TCP port **8056**. `lsof -nP -iTCP:8056 -sTCP:LISTEN` → the **running Markus desktop app** holds it (PID 10648). Environmental collision; the same flake was recorded by G4 and G6. |
| 2 | `packages/core/test/agent-concurrent-cancel-isolation.test.ts › 并发取消隔离：两侧状态收敛` | 12 s (waitFor timeout) | `packages/core/**` is **byte-identical to `main`** — `git diff --name-only origin/main...HEAD -- packages/core/` is empty, and this payload changes no file under it. A timing-sensitive concurrency test under whole-suite load. |

Both failures are **pre-existing / environmental**. Neither is reachable from any
file this payload changes. Honest caveat: I could not obtain a *clean isolated
re-run* of #2 in this worktree (`npx vitest run <file>` failed at vite
server-creation), so the claim rests on the structural evidence above
(byte-identical to `main` + untouched package) rather than a green isolated run.

The payload's **own** suites pass, including
`packages/org-manager/test/instance-integrations.test.ts` (reconciled by an
earlier slice) and the three comms suites that G8 A/B touched.

### 4.2 Real-data acceptance (requirement, item by item)

| # | Acceptance bullet | Status | Evidence / honesty |
|---|---|---|---|
| 1 | Upgrading an existing DB loses **zero** Feishu config and stays usable | ✅ | Real-data probe on a **copy of the live `data.db`**; migration 2→3 runs for real; the existing `bi_feishu_…` instance survives with its config intact |
| 2 | **Two bots of the same platform connect at once** | ✅ | Instance registry keyed by `instanceId`; probe asserts two instances of one platform both register |
| 3 | **Two groups do not share a session** | ✅ | Per-channel session keys; probe asserts distinct sessions for distinct channels |
| 4 | Unbound platform message **falls back to the Secretary, not dropped** | ✅ | G3's single-resolution path; probe asserts Secretary fallback (never a silent drop) |
| 5 | Approval / notification reachable on **non-Feishu** platforms (Telegram / Slack) | ⚠️ **partly local** | Rendering + routing verified by unit tests and the Slack real-WebSocket loopback probe. **Reaching a real Telegram/Slack tenant needs real tokens + network — not testable on this machine.** Stated, not papered over. |
| 6 | Adding a platform still needs **zero UI code** | ✅ | G5's guard asserts every manifest field type against `mattermost` (a platform absent from the front-end entirely) |

**Explicitly not testable here:** real Slack `xapp-` token acceptance, real
Discord bot-token acceptance, and any flow needing a public URL or a live
third-party tenant. Everything provable without those was proven; the rest is
marked, never simulated.

### 4.3 Raw regression tail

```
 Test Files  2 failed | 445 passed (447)
      Tests  2 failed | 6423 passed | 10 skipped (6435)
```

(Both failing tests are named and classified in 4.1.)

---

## 5. Docs reconciled

- `docs/design/messaging-gateway.md` — §8.1 now documents `defaultInboundMode` +
  its runtime consumer; §10 slice table marks G7/G8 **implemented**.
- `packages/comms/docs/platform-manifest.md` — in sync with the capability table.
- `docs/handoff/g5-ui-instances.md` — the false *"G4 reads the key"* residual
  corrected to reflect the wiring actually done in G8 (§2.A).
- `docs/handoff/g7-platform-capabilities.md` — the Discord-probe claim corrected
  (§2.C).
- A whole-repo grep for the retired symbols (`SLACK_ACK_DEADLINE_MS`) and for the
  stale cross-claims found **no remaining dangling references**.

---

## 6. Rollback

This branch is not merged anywhere and mutates no data or schema (the migration
belongs to G1, already reviewed). **"Rollback" = discard the branch / worktree** —
nothing downstream depends on it. Nothing here touches `main`.

---

## 7. PR steps (for the owner — **G8 does NOT open the PR**)

```bash
git push -u origin task/tsk_ae3d5e79cfb2173d7555a38d
gh pr create --base main --head task/tsk_ae3d5e79cfb2173d7555a38d \
  --title "feat(messaging): unified gateway — multi-bot instances, channel bindings, conversation isolation, three-level notifications" \
  --body-file docs/handoff/g8-closure.md
```

Payload = the whole feature, **107 files, one PR**.

---

## 8. Residuals (honest, no polishing)

1. **Real-tenant connectivity is unverified.** Slack `xapp-` and Discord bot
   tokens are never exercised against the real services — no credentials on this
   machine. All Slack evidence is a **real-WebSocket loopback** with a local server
   playing Slack. Same for any flow needing a public URL.
2. **Telegram notification delivery** (§4.2 #5) rests on unit-level routing /
   rendering proofs, not an end-to-end send to a live Telegram tenant.
3. **The A/B fixes** (notification-target wiring, capability-table consumer,
   ack-deadline single writer) are covered by unit tests but **not** exercised
   against a live platform in this slice. See §2 for the exact seam each closes.
4. **Feishu approval buttons are still text** (`[label] ref`), because the Feishu
   manifest renders `cards:false`. The action port, signature verification and
   `respondToApproval` wiring are in place and tested; making them real clickable
   buttons is a capability/manifest change, out of this slice's scope.
5. **`MARKUS_ACTION_SECRET` is unset by default** — with it unset, action refs are
   bare approval ids (pre-G4 behaviour), logged as a warning. Production should set
   it.
6. **`getOrCreateMainSession` / `MAIN_CONVERSATION_KEY` vs. the DB main session
   (`cs_*`)** remain two facts (flagged by G3/G6); not unified in this slice.
7. **`platform` is still not a UI concept** (consistent with G3): a level-4 binding
   is the `label='default'` instance of that platform.
8. **Two pre-existing test failures** remain in the full suite (port 8056; a
   load-sensitive core concurrency test). Classified in §4.1; neither is this
   payload's.

---

## 9. What "closure" means here

The requirement is met for everything provable on this machine, and every
unprovable item is marked as such rather than simulated. The single inbound path
(G6) is the only receiver; the capability table has a runtime consumer (B); the
notification target actually routes (A); the Discord claim is honest (C). The
branch is a single revertible unit on top of a git-verified union of the slices,
and it does **not** touch `main` or open a PR — that is the owner's call after
manual verification (steps in §7).
