# C10 L5 end-to-end gate — verification (2026-11-26)

Scope: how far the L5 acceptance gate (§4.3 of the master plan) is actually
satisfied. **All five structural conditions now PASS** (conditions 3 and 5 were
added in a second round on the same day; the first round had left them
unexercised). One qualifier remains and is not glossed over: the receiving agent
was `Secretary`, not a "content agent" as the gate's wording asks for — the
content agents were stopped by the Owner and the platform refuses to wake them.
The Owner approved using Secretary with that limitation recorded.

## The gate, verbatim

> Give a content agent a resource it has never handled (social account / RSS /
> repository); within one conversation it completes by itself: `bind_address`
> declares responsibility → receives the first real signal → **proposes the next
> step**; no UI clicks throughout; and `work_units` / `address_bindings` / `facts`
> each have a corresponding row.

Five conditions. **All five PASS.**

## What was verified (live instance :8056, 2026-11-26 04:30–04:40Z)

Readings are from the live database and from the same HTTP endpoint the web UI
calls (`GET /api/agents/:id/mailbox?mode=groups&scan=5000`), not from fixtures.

| Condition | Result | Evidence |
| --- | --- | --- |
| 1. `bind_address` with no UI interaction | **PASS** | The receiving agent self-bound `secprobe.jsyqrt@markus.global` (`channel_bindings`, `scope='address'`, `revoked_at IS NULL`) and self-registered source `src_3acfbe50ba9a41cc` through its own tool calls. |
| 2. First real signal received | **PASS** | Three real webhook posts → `status=ingested` (not bounced) → landed in the receiving agent's mailbox → `completed`; each kept its own per-message key `external:src_3acfbe50ba9a41cc:<messageId>`; `envelope.to.address` correct. The receiving agent gained 4 `agent_decisions` rows, i.e. turns really ran. |
| 3. Proposes the next step | **PASS** | The agent judged the item, **refused the numbers in it**, and named a concrete next step. Verbatim from the fact it wrote: the item is a second-hand summary; the official material says "30 秒单镜头、最多 50 个全模态参考、区域级编辑", there is **no official 40% figure**, and the release date conflicts (official blog/media 2026-07-31 vs the Seed Chinese homepage 2026.11.16). Next step: verify parameters and figures against first-party sources **before** it enters the topic pipeline. |
| 4. `work_units` row | **PASS** | `external:src_3acfbe50ba9a41cc:*` rows present; identity anchors as designed. |
| 5. `facts` row | **PASS** | `fact_d1c34d0a461491a2981fb36c` — `work_unit_ref` is exactly the signal's ref (`external:src_3acfbe50ba9a41cc:c10-gate-step3-20261126`), `asserted_by` is the receiving agent, `confidence` 0.85, `source_refs` carries `src_3acfbe50ba9a41cc` plus two first-party URLs and one media article. |

## Cross-check: signals are no longer orphaned in "history"

The defect this round fixed was that every C10 signal was bucketed as "history"
in the overview instead of belonging to a conversation. Post-fix readings for
the receiving agent:

```
channel:secprobe.jsyqrt@markus.global   「外部地址 · secprobe.jsyqrt」  count=3  units=3
channel:loop_agt_5f7658fa…              「决策循环（Loop）」           count=356
none (history)                          count=347, latestAt=2026-11-14
```

The three signals form **one** address conversation. The "history" bucket's most
recent row is 2026-11-14 — i.e. nothing from this round fell into it. Lazy
backfill confirmed: all three rows now carry `entity_kind='channel'`,
`entity_id='secprobe.jsyqrt@markus.global'`.

## What still blocks C10 (not the gate — the gate passed)

1. **The fixes from this round are not yet on the integration branch.**
   `git branch -r --contains 4b695131` is empty: the work sits on local branch
   `task/c10-signal-decision-loop`. Merging into `origin/feat/refactor-plan` is
   inside the CTO's authority and is the next step; merging into `main` is not.
2. **C10-D (mail) is untouched** — the Owner has explicitly deferred the DNS change.
3. **`main` merge** — needs all cuts accepted plus Owner approval.

**Not a blocker, for the record:** the receiving agent was `Secretary`, not a
content agent (see the caveat at the top). If a strictly faithful content-agent run
is required later, unstop a content agent and repeat the same probe — the probe
shape and the five assertions are already pinned above.

## Reproduce

```bash
# entity resolution over real rows, through the shipped (asar) resolver
node --input-type=module -e '...' # see commit message of 4b695131 for the probe
# overview grouping exactly as the UI sees it (from a logged-in page)
fetch('/api/agents/<agentId>/mailbox?mode=groups&scan=5000',{credentials:'include'})
```
