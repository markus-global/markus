# G3 — Single inbound resolution + session isolation (handoff & verification)

**Task:** `tsk_bae3a9f097fde69834eb1190` · **Requirement:** `req_f2610b70e3196b1201d4bf1b`
(通用消息网关) · **Design:** `docs/design/messaging-gateway.md` §6.1–§6.3
**Base:** G1 `tsk_d36d4a2631887eff943a3ada` (`c6e9d719`)

## What shipped

The router used to answer "who serves this inbound message?" with a **startup
snapshot** (`resolveInboundAgent`: explicit → channel → platform), and the Feishu
live path re-read the DB per message — two writers for one fact (§2). An unbound
message was dropped (D6) and every chat of a platform shared one agent session
(D3). G3 introduces one decision point and real conversation identity.

1. **`packages/comms/src/gateway/inbound.ts`** — `resolveInboundTarget(envelope, lookup)`:
   pure, nearest-wins, 5 levels, `matchedScope` recorded
   (`explicit → channel → instance → platform → global`). Returns `undefined`
   **only** when nothing at all is bound.
2. **`packages/comms/src/gateway/conversation-key.ts`** — `conversationKeyOf({instanceId, nativeId, kind})`:
   canonical, collision-free (`im:<instanceId>:<kind>:<uri(nativeId)>`,
   percent-encoded parts). `MAIN_CONVERSATION_KEY` sentinel for a channel
   designated as the agent's home; `notification` channels are outbound-only.
3. **`packages/comms/src/gateway/repo-binding-lookup.ts`** — `RepoBindingLookup`:
   the DB-backed binding source, over *structural* ports (comms keeps its
   no-storage dependency). Level 4 is realised as the platform's `label='default'`
   instance binding (see design §6.3 — G1's DDL has no `platform` column and
   nothing writes a platform-scope row, so no dead column was added).
4. **`packages/comms/src/router.ts`** — the router resolves through the single
   function. `setBindingLookup()` injects the authoritative (DB) source; the
   in-memory maps stay a read-only `markus.json` **bootstrap fallback**, consulted
   only when the DB has no answer. The handler now receives the whole
   `ResolvedInboundTarget` (not a bare agent id) so the conversation key travels
   with it. `sendAsAgent` forwards the agent identity to the adapter (D7).
5. **Wiring** — `packages/cli/src/commands/start.ts`: hands the resolved
   `conversationKey` to the agent as `channelKey` (the existing contract that maps
   to the memory session `channel_<key>_<agentId>`), and injects
   `RepoBindingLookup` built from `channelBindingRepo` + `platformInstanceRepo`
   plus a Secretary fallback (`pickOrgSecretary`) so level 5 terminates.
   `packages/org-manager/src/storage-bridge.ts` now exposes the two G1 repos.
6. **`@markus/shared` `Message`** — optional `instanceId` / `channelKind`
   (additive; every existing adapter keeps working unset).

## Verification

| Check | Result |
|---|---|
| New tests, **before** the implementation (teeth check) | **RED** — `git stash push -u` of `gateway/` + `router.ts` + `index.ts` + `adapter.ts` + `message.ts` → `10 failed / 10 passed (2 files)`; restored → green |
| `packages/comms` suite | **232 passed / 232** (16 files) — new: `gateway-inbound` 14, `gateway-repo-lookup` 4, router +3 |
| `tsc -b` (whole repo) | 0 errors |
| Acceptance: two groups → two sessions | `router` test "gives two groups of one instance independent session keys (D3)" — `im:bi_1:group:oc_A` ≠ `im:bi_1:group:oc_B` |
| Acceptance: unbound platform → Secretary, not dropped | `router` test "(D6)" + resolver level 5 (global row **and** live-Secretary fallback) |
| Acceptance: two external users' dms do not share context | `conversationKeyOf` dm×dm test (independent keys) |
| Acceptance: resolution precedence + level recorded | 5 explicit level tests, each asserting `matchedScope` |

## Contract notes for later slices

- `channel_bindings` still has no `platform` column. Level 4 (`platform`) =
  the platform's `label='default'` instance binding. A future slice that wants a
  true per-platform row must add the column **and** a writer; until then no such
  row is writable, so none is read.
- A `channel`-scope binding with `kind='main'` designates the agent's home
  (→ `MAIN_CONVERSATION_KEY`, no per-channel session); `kind='notification'`
  makes inbound on that channel ignored. The binding is authoritative over the
  adapter's `channelKind`.
- `MAIN_CONVERSATION_KEY` currently maps to "no `channelKey`" (the agent's own
  main session). Unifying it with the DB main session (`cs_*`) is G6's job, when
  the legacy Feishu path is retired.
- The legacy Feishu inbound path (`handleFeishuUserMessage` + its
  `getOrCreateMainSession`) is **untouched** — retiring it is G6. The router path
  is now the single resolver; G6 removes the second path.

## Residuals / known gaps

- Only the router path is wired. Feishu still routes through its legacy path
  until G6, so "one inbound path" is **not** yet true end-to-end.
- Adapters do not yet set `instanceId` / `channelKind` (G2 registers instances;
  adapters can start reporting the instance). Without them the resolver handles
  the legacy shape correctly (skips levels 2–3, resolves at platform/global).
- Inbound on a `notification` channel is ignored and logged; nothing consumes
  `matchedScope` for metrics yet (G4/G5).

## Rollback

One revertible commit on `task/tsk_bae3a9f097fde69834eb1190`. No schema change, no
migration version bump — reverting restores the old 3-level router. No PR (owner
validates manually).
