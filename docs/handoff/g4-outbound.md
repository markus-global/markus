# G4 — Outbound dispatch & three-level notification routing

**Slice:** G4 of `req_f2610b70e3196b1201d4bf1b` (messaging gateway) · design §7
**Branch:** `task/tsk_055fc765af49815c7316acee` · **base:** G2 `task/tsk_95073651ac23d369f89b419a`
**Status:** delivered, **no PR** (per task discipline — hand to the owner for manual verification)

---

## 1. What this slice is for

Before G4, "an approval reached a chat app" existed **only inside the Feishu
notifier**. Every other platform could connect and route inbound messages, but an
approval or a notification had nowhere to go — the user simply never got it
(defect **D5**). This slice makes the outbound direction a first-class, unified
path: **one** dispatcher, **one** message shape, **three** routing levels, and
**capability-driven** rendering so a platform that cannot show a card still
receives the full message as text.

## 2. What was built

```
packages/comms/src/gateway/
  outbound.ts       OutboundMessage — the only outbound shape + signed action refs
  notify-route.ts   resolveNotifyTarget() — the three-level walk (agent → instance → global)
  notify-lookup.ts  RepoNotifyTargetLookup — the lookup port, backed by channel_bindings
  router-sink.ts    RouterOutboundSink — the sink port, backed by the adapter router
  render.ts         renderOutbound() — capability-driven degradation (total function)
  dispatcher.ts     OutboundDispatcher — HITL + EventBus in, resolve → render → send out
packages/cli/src/commands/outbound.ts   setupOutboundDispatch() — production wiring
packages/cli/src/commands/start.ts      wires the dispatcher at startup
packages/org-manager/src/hitl-service.ts approval notifications now carry agentId
```

**`OutboundMessage`** is the single outbound shape: `{title, body, severity,
actions[], attachments[], replyRef?, origin{agentId, taskId}}`. `severity ∈
{action_required, info}` drives *routing and timing*, never content:
`action_required` is pushed immediately; `info` is delivered immediately by default
and may be **digested** when the deployment opts in. A digest never swallows an
`action_required` — it is flushed first.

**Three-level routing — first hit wins, recorded in the outcome:**

| Level | Resolves to | Why |
|---|---|---|
| `agent` | the producing agent's **own conversation** (explicit `kind='notification'` binding preferred) | "point this agent elsewhere" |
| `instance` | a notification sink declared on the instance the agent works in | one row covers a whole bot |
| `global` | the **Secretary's own conversation**, else the platform's legacy notify channel | the default; never orphans a notification |

**Capability degradation** is total: `cards\|buttons → 'card'`, `markdown →
'markdown'`, otherwise `'text'`. The plain-text projection always exists and always
carries the action labels **and their refs**, so a button-less platform shows the
same content rather than dropping it.

**Signed action refs.** With `actionSecret` set, approval action refs are opaque
tokens (`signActionRef`/`verifyActionRef`, base64url payload + `sha256` HMAC,
constant-time compare) — the internal approval id never leaves in the clear.

## 3. Verification

**Tests (red → green).** Four new suites were written first and **observed failing**
(modules absent), then implemented:

| Suite | Covers |
|---|---|
| `packages/comms/test/gateway-outbound.test.ts` | shape, severity mapping, sign/verify round-trip, tamper + wrong-secret rejection |
| `packages/comms/test/gateway-notify-route.test.ts` | hit order, `global` fallback, level recorded, origin propagation |
| `packages/comms/test/gateway-render.test.ts` | card/markdown/text degradation, action refs survive as text |
| `packages/comms/test/gateway-dispatcher.test.ts` | HITL + EventBus intake, severity split, digest, target resolution, non-Feishu delivery, signed refs |
| `packages/comms/test/gateway-notify-lookup.test.ts` | real-row lookup: own channel, explicit-notification preference, instance sink, Secretary global |

**Result:** comms **261/261** green · org-manager + storage + shared **1646/1646**
green · `tsc -b` **0 errors**.

**Full regression:** the only failure is the pre-existing **environmental** flake
`cli > auto-runs quickInit when config is missing` (60 s timeout; needs port 8056,
held by the running Markus app). It is not in this payload's touch surface.

**Real-data probe** — `packages/cli/scripts/verify-g4-real-data.mjs`,
**21/21 PASS** against a copy of the live DB (`~/.markus/data.db`, 16 GB,
`user_version=2 → 3`, real migration, real manifests):

- the real Feishu instance row (`bi_feishu_d070a88d7e0a`) and the real
  `global → Secretary` binding (`agt_5f7658fa63f1c5b8ca414d0a`) drive the lookup;
- an approval reaches a **non-Feishu (Telegram)** platform, at the **agent** level,
  with the real instance id on the outbound call and format matching the real
  Telegram manifest — **D5 fixed**;
- an **unbound** agent's notification falls through to the **global (Secretary)**
  level — never orphaned;
- `RouterOutboundSink` forwards the **instance id** (the gap G2 flagged as
  "`sendToChannel` without an instanceId warns and picks the first bot");
- the delivered action ref **verifies back** to the real approval id, and the
  internal id **does not appear** in the text.

## 4. Honest findings & residual gaps

1. **Level 3 is not configured on the live DB today.** The G1 migration seeds
   `channel_bindings` as *routing* rows (`instance_id = NULL`, `native_id = NULL`,
   `kind = NULL`) — at migration time it cannot know which conversation should
   receive notifications. So on a live install there is currently **no addressable
   notification terminus**, and the dispatcher reports `delivered:false,
   reason:'no-notify-target'` **loudly** rather than silently dropping. Configuring
   it is exactly what the G5 notification-target UI is for. The probe asserts both
   halves: the gap is reported, and once configured on the real rows, delivery works.
2. **Level 1 accepts a non-`notification` binding.** Requiring the marker would
   make levels 1 and 3 dead on *every migrated install* — i.e. notifications would
   stay isolated, the defect this slice removes. An explicit `notification` binding
   still wins; the agent's own channel is the fallback. Documented in design §7.3.
3. **`actionSecret` is optional and unset by default.** Without it, refs are raw
   approval ids (pre-G4 behaviour). Production should set `MARKUS_ACTION_SECRET`;
   the wiring reads it from the environment. Until then the "user never sees an
   internal id" guarantee holds only for the text (the ref is opaque only when signed).
4. **Handler-side of the approval loop is out of scope here.** This slice *emits*
   the signed ref; parsing a clicked ref back into a pending approval belongs to the
   inbound side (G3) and the legacy-removal slice (G6).
5. **`digestInfo` is wired but defaults to `false`** — digest is opt-in, as designed.
6. **No PR**, per task discipline — the branch is handed over for manual verification.

## 5. Rollback

A single commit on `task/tsk_055fc765af49815c7316acee`. `git revert <sha>` restores
the pre-G4 state; no schema, migration or data change is involved, and the legacy
Feishu notifier path is untouched, so reverting leaves notifications exactly where
they were before this slice.
