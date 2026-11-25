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
