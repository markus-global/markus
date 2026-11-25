# External signals: unrouted delivery goes into the decision loop

Date 2026-11-25 · CTO · owner directive: *"没有建立路由的，应该进入决策循环，然后建立路由；
下次就可以直接路由了；如果还是路由不了，仍然进入决策循环。决策循环应该知道怎么处理外部事件
或者消息，应该有对应的系统提示词。"*

## 0. The measured problem (not a hypothesis)

Live instance `:8056`, 2026-11-25 13:17–13:20Z. Two real webhook events routed to a running
agent (`Secretary`, `idle`) via binding `desk.jsyqrt@markus.global`:

- ingress, auth gate, identity, ceiling (`action_required → deliver`), idempotency and the
  kind gate all behaved correctly (see `docs/records/c10-l5-live-verification-2026-11-25.md`);
- the agent **was** woken — `Trigger matched … wakeOn:{kind:'mailbox-any'}` followed by
  `Turn has NO session identity — keeping the current session`
  (`reason: sourceType=external_signal 未提供任何会话身份`);
- but the turn produced nothing: `work_units` stayed `idle` (`claimed_by=NULL`, `used=0`),
  `facts` unchanged, no `agent_activities` row, and the mailbox row was `completed` within
  one millisecond.

So "external signal arrives" currently means "a row is filed". Three separate defects produce
that, and none of them is a regression of C10 — they are gaps the cut never filled:

| # | Defect | Where |
|---|---|---|
| D1 | an unrouted signal is **bounced** (`no_active_target` → catch-all) instead of being routed to a decision maker | `external-source-service.ts#ingest` |
| D2 | the external-signal turn has **no session identity**, so it runs inside whatever session the agent last used — nothing belongs to it and nothing accumulates | agent turn bootstrap (the WARN above) |
| D3 | nothing in the system prompt tells the agent what an external event is or what it may do about it, so even a woken agent has no procedure | system prompt segments |

## 1. Contract

**R1 — one route resolver.** A route is an *active* `channel_bindings` row for
`external_sources.address`. The resolver is `findActive` and stays the only reader of that
fact; no adapter, tool or prompt may re-derive "is this routed" from anything else.

**R2 — unrouted is a delivery state, not a failure.** When `findActive` returns nothing, the
signal is delivered to the source's owning agent as a **routing decision item**, not bounced:

- `envelope.routing = { state: 'unrouted', reason: 'no_active_binding' }` (structural field;
  never inferred from payload text);
- identity is unchanged (`work_unit_ref = WORK_UNIT_REF.external(sourceId, messageId)`), so the
  unrouted signal is as traceable as a routed one;
- the existing `no_active_target` bounce stays for the one case it really describes: a route
  that *points at an agent mailbox that cannot be reached*. It must never again mean
  "nobody has bound this address yet".

**R3 — the decision loop owns routing.** The receiving agent gets one stable decision-loop
session per external source (`sessionKey = external:<sourceId>`), so consecutive unrouted
signals for the same source continue the same context instead of landing in an unrelated
conversation. In that loop the agent must, per the prompt contract:
1. read the event and say what it is;
2. decide the route: bind the address to itself (`bind_address`) **or** explain why it will not
   be routed and leave the reason on the record;
3. if it registers a source, remember that registration already requires an active binding — the
   order is bind, then register.

**R4 — the loop is re-entrant and self-closing.** After a successful bind, later signals for
that address resolve through `findActive` and are delivered directly (no decision loop). If the
decision loop fails to establish a route, the next signal enters the same loop again — no new
mechanism, no retry counter, no second queue. The loop ends when a route exists; it does not
end because a turn happened.

**R5 — the prompt states authority and boundary, not a menu.** The system prompt segment
defines: what an external event is, that routing is the agent's decision, that binding is
idempotent per address, and that an unverified source (`fromVerified=false`) may never be given
authority over the agent's own work. It does not enumerate "do not do X" for each tool.

## 2. Non-goals

- No second router, no route cache, no per-source policy table.
- No change to the trust ceiling: an unverified external signal still cannot demand action
  (`mayExternalSignalDemandAction(false) → deliver`). Routing to a decision loop is a platform
  routing decision, not an external demand.
- No email/DNS work (C10-D unchanged) and no `main` merge without owner approval.

## 3. Verification (must be red before it is green)

1. **Unrouted → decision loop**: ingest with no active binding writes an item whose
   `envelope.routing.state = 'unrouted'`, `work_unit_ref` non-null, and `status != 'bounced'`;
   falsify by restoring the bounce → red.
2. **Decision loop can route**: after the loop calls `bind_address`, a second event for the same
   address resolves to the bound agent with `routing.state = 'routed'` — no decision loop.
3. **Still unroutable → loop again**: a second event with no binding produces a second
   `unrouted` item in the same `sessionKey`; nothing is dropped and nothing is silently
   completed.
4. **Session identity**: the decision-loop turn carries `sessionKey = external:<sourceId>`;
   falsify by removing the key → the WARN returns and the test goes red.
5. **Prompt present**: the segment renders for an agent that has external sources, and does not
   render for one that has none (existence check alone is not a guard).

Evidence bar: live probe on a fresh build (real webhook → item → turn → bind → second event
routed), plus the seven-step gate of `c10-external-adapters-plan §3.1`.

---

## 4. Conformance review against the master plan (2026-11-25 22:2x)

The first draft of R1–R5 was written from the live probe alone. Read against
`markus-master-refactor-plan-2026-11-11.md` §2.7 / §4.1–§4.3 and the shipped code, **three
clauses contradict the existing architecture** and four questions were never answered. The
contract above is superseded by the amended clauses below; the original wording is kept in
git history, not silently rewritten.

### 4.1 Conflicts found (must be fixed before implementation)

**C1 — R3 invents a second decision loop.** The platform already has one: `#464` landed a
per-agent persistent decision loop, keyed `loop_<agentId>` (`packages/core/src/session-target.ts:11`,
`LOOP_SESSION_PREFIX = 'loop_'`; `worklog-entity.ts:123` renders it as 「决策循环（Loop）」).
§2.7 closes the session id space at four (`cs_*` / `sess_*` / `hb_|a2a_|sys_` /
`task_<id>_r<round>`), and the plan's own note says 「同一会话延续，不再每拍新建上下文」.
`external:<sourceId>` would be a fifth namespace and a second loop.

→ **Amended R3**: an unrouted signal is delivered **into the existing `loop_<agentId>`** of the
source's owning agent. No new session namespace, no new loop, no per-source session. If the
decision context needs to know *which* source it is deciding about, that is content of the item
(envelope `from` + `external_sources` row), not a new identity.

**C2 — R2's `envelope.routing.state` is a second writer of a routing fact.** §4.1 makes the
channels orthogonal and says an implementation that derives one channel's state from another's
is a guard failure. A frozen `state: 'routed' | 'unrouted'` on the envelope is exactly the
kind of copy that drifts the moment a binding is revoked.

→ **Amended R2**: the envelope records the **delivery disposition taken at this delivery**
(`routing.disposition: 'direct' | 'decision_loop'` + `reason`), i.e. an *event*, never a
queryable state. "Is this address routed *now*" has exactly one answer and one reader:
`findActive`. The guard test asserts that no read path consults `envelope.routing` to decide
delivery.

**C3 — R4's "no retry counter" contradicts the plan's boundedness requirement.** §4.3 is
explicit about `rest(wakeOn)`: 「有界：单次上限 / 连续次数上限」. Re-entrancy with no bound is an
unbounded spend loop when an agent repeatedly fails to route — and the measured instance
already shows a stopped recipient accumulating rows.

→ **Amended R4**: the loop is re-entrant **and bounded** — at most one open `unrouted`
decision item per `(source, address)`; new unrouted signals for the same pair **coalesce into
that item** (the mailbox already has `consolidateByEntity`), and the item carries a count. If
the turn cannot route, the item is completed with an explicit reason and the *next* signal
opens a new one — so the loop re-enters only on new external evidence, never on a timer, never
20 times for a 20-item RSS burst (today's first-poll behaviour publishes 20 signals at once).

### 4.2 Questions the first draft never answered

**Q1 — who claims the WorkUnit?** Measured: `work_units` stays `idle` (`claimed_by=NULL`,
`used=0`) while the mailbox row reaches `completed`. §4.6 makes WorkUnit the object every
channel hangs from; a decision turn that does not claim it leaves a permanent orphan. The
amended contract: the decision-loop turn **claims the WorkUnit** carried by the signal
(`work_unit_ref`), and the item's terminal state may only be `completed` if the turn either
routed, or recorded a reason. A `completed` row whose WorkUnit is still `idle` is a defect the
guard must catch.

**Q2 — two different failures are conflated.** "No binding" (address resolvable, nobody owns
it → decision loop) is not "address cannot be resolved at all" (unknown slug → the existing
`unresolved_address` bounce into catch-all). The amended R2 keeps both bounces for
unresolvable addresses and only reroutes the *resolvable-but-unbound* case.

**Q3 — cross-org.** `uq_channel_bindings_address_active` is a **global** unique index, while
slugs are per-org. A signal whose address belongs to another org must not silently enter a
local agent's loop. The amended contract: at most one active binding exists globally; the
decision loop is only entered for signals whose address resolves **into the receiving org**;
anything else keeps today's cross-org policy (C10-C `cross_org_policy`, default `observe`).

**Q4 — the prompt segment vs the prompt cache.** Acceptance item 5 of the first draft said the
segment "does not render for an agent with no external sources" — that makes the system prompt
take two shapes for the same semantic state, which is a cache miss by construction and
contradicts the fixed-segment discipline (§4.1 fixed vs variable; `buildSystemContent`
segments). The amended contract: the segment **always renders**, with a stable header and a
one-line tail (`external_sources: 0`, `unrouted_pending: 0`) — the variable part goes last,
never gates the segment's existence.

### 4.3 The plan's own bookkeeping is stale

`markus-master-refactor-plan` 附录 A-4 §7 says the only remaining work is ① L5 ② C10-D ③ the
main merge, and states L5 is «在新构建第二实例上跑» — implying it is runnable once an agent is
started. The probe shows L5 cannot close that way: routing absence is unhandled, so the fifth
condition is blocked by code, not by a stopped agent. A-4 gains **G15** (this gap) and the L5
sentence in the C10 plan gains the "no-route" branch; otherwise the SSOT claims a state the
system is not in.

### 4.4 Corrected factual claim from the probe record

`docs/records/c10-l5-live-verification-2026-11-25.md` asserted that `complete()` marked the
row `turn-complete` "while no turn happened". The runtime log contradicts that: the turn
bootstrap did run (`Turn has NO session identity … sourceType=external_signal`, then two
`Context assembled` entries). The defensible statement is narrower: **a turn ran and closed
without claiming the WorkUnit, without a session identity of its own, and without producing a
fact** — D1/D2/D3 stand, the "terminal state lies" wording does not.
