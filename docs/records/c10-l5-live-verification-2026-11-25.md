# C10 L5 end-to-end — live verification (2026-11-25)

**Verdict: the chain runs, 4 of 5 L5 conditions proven on the live instance.
The 5th (agent proposes the next step) is blocked by the owner having stopped
every content agent, not by the code.**

## Criterion being tested

`docs/design/c10-external-adapters-plan-2026-11-19.md:337` (L5):

> Give a content agent a resource it has never owned (an RSS feed is enough):
> within one conversation it binds the address, receives the first real signal,
> and proposes the next step — no human UI clicks — with corresponding rows in
> `work_units`, `address_bindings`, and `facts`.

## Venue

| Item | Value |
|---|---|
| Instance | `pid 29900`, started 2026-11-24 12:00:17 CST, listening `:8056` |
| Code under test | `build/c10-adapters @ 38e0f284` (desktop bundle, i.e. C10-A/B/B2/C; **not** PR #483) |
| Database | `/Users/liuqian/.markus/data.db` (the audited instance) |
| Executed at | 2026-11-25 16:37–16:40 CST |
| Initiator | CTO agent via the storage write points (no human UI clicks) |

## Blocker found before the test could start

Both organisations carried `org_slug = org_<id>` (`org_default`,
`org_user_4941a0…`) — **unparseable as an address label** (underscore), so the
C10-A ownership gate could never pass. Fixed by declaring a legal slug:

```
before  = org_default
declare = {"ok":true,"orgSlug":"jsyqrt"}     # SqliteOrgRepo.declareOrgSlug
after   = jsyqrt
```

**Gap (real, not incidental): `declareOrgSlug` has zero production callers.**
`grep -rn declareOrgSlug packages/*/src` matches only its definition and
comments; there is no HTTP route, no UI control, no agent tool. The only reason
this test could proceed is that the CTO called the storage method directly. A
real user or agent cannot — which means C10-A's "declare before bind" gate is
unreachable in the shipped product until an entry point exists.

## What was executed (both through the single writers)

```
BIND     = {"status":"bound","address":"writer.jsyqrt@markus.global",
            "targetRef":"agent:agt_ca128605b077ebe1d8fb4ced"}
REGISTER = {"status":"registered","source":{"id":"src_a0f3f11f026e474f",
            "kind":"rss","address":"writer.jsyqrt@markus.global",
            "config":"{\"feedUrl\":\"https://hnrss.org/frontpage\",\"pollIntervalMs\":60000}",
            "enabled":true}}
```

Writer ids: `SqliteAddressBindingRepo.bind`, `SqliteExternalSourceRepo.register`.
Recipient: 中文内容写手 (`agt_ca128605b077ebe1d8fb4ced`) — a content agent.

## The instance really polled

`startPolling` is a period **DB scan** (`pollAllEnabled` →
`listEnabledByKind('rss')`), so an externally written source is picked up by the
running process. Confirmed:

```
src_a0f3f11f026e474f | enabled=1
  cursor        = {"seenIds":[20 x news.ycombinator.com ids]}
  last_event_at = 2026-11-25T08:38:38.920Z   (53 s after registration)
  last_error    = (none)
```

## Readings (2026-11-25 16:40 CST, `~/.markus/data.db`)

| Table | Reading | L5 needs |
|---|---|---|
| `channel_bindings` (address not null) | **1** — `writer.jsyqrt@markus.global`, active | ✅ |
| `work_units` (`external:src_a0f3f11f%`) | **20** (one per HN item, status `idle`) | ✅ |
| `mailbox_items` from this source | **20**, of which `work_unit_ref IS NULL` = **0** | ✅ |
| `facts` | **71** (unchanged) | ❌ no new fact |

## Bonus finding: this is a live control for the audit's criterion 1

The daily identity audit went red on criterion 1 with `count=2` — two 11-24
`external_signal` rows carrying `work_unit_ref = NULL`. This run produced **20
fresh external_signal rows with 0 missing refs**. That is direct evidence the
two historical rows are old-process residue, exactly as the audit's code
walk claimed; current HEAD always stamps the ref.

## Why the 5th condition did not happen

`中文内容写手` is `stopped_by_human`; the platform blocks A2A wake for such
agents ("Do not retry with wake_recipient — that path is deliberately
blocked"). Signal delivery, mailbox rows and work units are all agent-agnostic
and completed; **consuming** the signal (→ proposing the next step → a `fact`)
requires a running agent. Hence `facts` unchanged.

## Secondary observation (not a blocker, worth a decision)

The first poll published **20 signals at once** — the source builds its baseline
(`cursor.seenIds`) and delivers the same batch as new, so a freshly registered
feed floods the recipient's mailbox. Whether first-poll should establish the
baseline silently is a product call; today's behaviour is "everything is new on
first sight".

## To close L5

1. **Start one content agent** (owner action — it is `stopped_by_human`), then
   re-run: the existing binding + source are still live and will produce new
   signals on the next HN update.
2. **Give `declareOrgSlug` an entry point** (route / UI / agent tool), otherwise
   no real user can satisfy the bind gate.

> **Superseded (2026-11-25, C10-E).** Recommendation 2 was rejected by the owner.
> Global uniqueness is a Hub property, so the slug write path moved to
> markus.global (`PUT /api/orgs/:id/slug`) and the local `declareOrgSlug` method and
> its route were **deleted** rather than wired up. Kept as history because the gap
> was real — only the fix direction was wrong.

---

## Webhook complement — the same chain without email (2026-11-25 21:16–21:21 CST)

Owner asked for a non-email test. C10-D needs DNS, but the webhook entry is the one
inbound channel that already carries a shared secret, so it can prove everything
except the email auth chain.

**Verdict: ingress, auth gate, identity, ceiling, idempotency and routing all pass on
the live instance. The fifth L5 condition fails on a *running* agent too — so it is a
structural gap, not the stopped content agent.**

Venue: live instance `pid 83971`, `:8056`, `/Users/liuqian/.markus/data.db`.
Probe rows are prefixed `src_probe_c10w_*` / `cb_probe_c10w_*`; the probe source is
`enabled=0` and the probe binding `revoked_at` was set at the end of the run (rows are
kept for auditability, not deleted).

### Readings

| # | Request | Result |
|---|---|---|
| 1 | POST, no token | `401 unauthorized`, **zero rows written** |
| 2 | POST, wrong token | `401 unauthorized`, **zero rows written** |
| 3 | POST, valid token, `intent=action_required` | `200 ingested` — `mbx_adad375d97f77f63a435c4d9`, `workUnitRef=external:src_probe_c10w_hook:probe-c10w-2`; stored `intent` capped to **`deliver`** (ceiling holds); `envelope.auth=null`, `fromVerified=false` (hard-coded until C10-D) |
| 4 | Replay of #3 (same `messageId`) | `200 bounced / duplicate_message_id`, no new queued row |
| 5 | POST to an RSS source id | `400 not_a_webhook_source` (kind gate) |
| 6 | POST to an unknown source | `404 unknown_source` |

Identity penetrates to the decision layer: `agent_decisions` holds a `pick` row for
Secretary carrying the same `work_unit_ref` as the mailbox row.

### The fifth condition fails on a running agent (the decisive finding)

Two deliveries were routed to **Secretary (`agt_5f76…`, status `idle` — i.e. running,
not human-stopped)** via a fresh binding `desk.jsyqrt@markus.global`. 120 s
observation window after the second delivery:

| Reading | Value |
|---|---|
| `work_units` row for the signal | created, but `status=idle`, `claimed_by=NULL`, `used=0` |
| mailbox row | `completed` within ~1 ms of enqueue |
| `agent_activities` for Secretary after 13:19Z | **0 rows** (last activity 13:01Z) |
| `facts` | **73 → 73, unchanged** |
| `agent_decisions` | `pick` row exists, but no turn ever ran |

Structural evidence, not inference: `external_signal` has exactly **one** reference in
`packages/core/src` + `packages/org-manager/src` — the `enqueue` call at
`external-source-service.ts:113`. The wake/execution branches in `agent.ts` key on
`sourceType === 'human_chat' | 'a2a_message' | 'callback_result'`; no branch consumes
`external_signal`. `complete()` (`mailbox.ts:1890`) marks the row `completed` with
`why:'turn-complete'`.

> **Correction (2026-11-25 22:2x, same day).** This section first claimed the terminal state
> lied ("no turn happened"). The runtime log contradicts that — the turn bootstrap did run
> (`Turn has NO session identity … sourceType=external_signal`, then two `Context assembled`).
> The defensible statement is narrower: **a turn ran and closed without claiming its
> `work_unit`, without a session identity of its own, and without producing a fact.**
> `processing → completed` is a legal FSM-2 transition (`回合正常收口`); the defect is that the
> turn had nothing to work with, not that the state machine lied. D1/D2/D3 in
> `docs/design/external-signal-decision-loop-2026-11-25.md` stand unchanged.

**Consequence for the cut gate:** L5 condition 5 cannot be closed by starting the
content agent. External signals need a consumer that starts a work turn (claim the
`work_unit`, then the agent proposes the next step → a `fact`). That consumer does not
exist today; until it does, "external signal arrives" means "row is filed", not "work
begins".

### Secondary finding — no backpressure for a stopped recipient

While `中文内容写手` was `stopped_by_human`, the RSS source kept polling and piling
`external_signal` rows into its mailbox: **27 rows `queued`** and growing, with no
expiry and no drop path. The RSS source was set `enabled=0` to stop the bleed. An
external source needs a budget/drop rule for a non-running target, otherwise a live
feed turns into an unbounded mailbox.

### What this run does NOT prove

- `verified=true` / `envelope.auth`: never written for a webhook (hard-coded `false`).
  A valid shared secret **is** a real authentication of the caller at the HTTP gate, so
  the verified side could be exercised without DNS by recording the scheme on the
  envelope — that is a trust-model decision, not a test detail.
- Outbound, bounce/DSN, and `verified` promotion remain C10-D territory (needs DNS).
