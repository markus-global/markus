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
