# G6 — Retire the legacy Feishu inbound path + legacy notifier

**Task:** `tsk_2951e2c0526d467764e12097` · **Requirement:** `req_f2610b70e3196b1201d4bf1b`
(通用消息网关) · **Design:** `docs/design/messaging-gateway.md` §6.2/§6.5/§10/§11.4
**Depends on:** G3 `tsk_bae3a9f097fde69834eb1190` + G4 `tsk_055fc765af49815c7316acee`
**Status:** delivered, **no PR** (handed to 老板 for manual verification)

---

## 1. What the dependency graph actually looked like (correction)

G4's handoff claimed to be "based on G3 tip `55963d46`". Git proves otherwise:

| Slice | Commit | Parent chain |
|---|---|---|
| G3 | `55963d46` | G1 |
| G4 | `92878519` | **G2** |

G3 and G4 are **sibling branches**, not a stack. So G6 cannot start from either
one alone: it needs G3's inbound resolver *and* G4's dispatcher. G6 therefore
opens from **G4 (`92878519`)** and merges **G3 (`55963d46`)** in, resolving 5
conflicts (`router.ts`, `index.ts`, `start.ts`, `storage-bridge.ts`,
`storage-bridge.test.ts`). The merge commit `1b03bcfd` is the union base
(G1+G2+G3+G4) and is itself green (`tsc -b` 0; comms 283/283).

> Conflict resolution notes: `router.ts` keeps **G2's instance-keyed bots** and
> layers **G3's single resolve path** on top (G3 had rewritten the file from G1);
> `storage-bridge.test.ts` takes HEAD's **Proxy-based storage mock** (auto-covers
> every `*Repo`) over G3's hand-enumerated list — that enumeration is exactly what
> broke G3 once and the Proxy cannot go stale.

---

## 2. The decisive finding: the new path had no receiver

`FeishuNotifier` was not just a notification helper — it was the **only working
Feishu inbound receiver**, via the official SDK long connection
(`apiClient.startWSClient`). The comms `FeishuAdapter` claimed to support
`wsMode`, but:

- there was **no `@larksuiteoapi/node-sdk` dependency** in `comms`;
- no `WSClient` / `EventDispatcher` was ever constructed;
- `wsMode` read a config key that **nothing set** (`resolveManifestConfig`
  deliberately does not apply manifest defaults, and the manifest's `wsMode`
  defaults to `false`).

So the adapter's "websocket" branch was **fictional**: deleting the notifier
without moving the real transport would have silently killed Feishu inbound.
G6 therefore **relocates the official SDK long connection into the adapter**.

---

## 3. Deliverables

### comms — the adapter owns the real transport
- `packages/comms/src/feishu/adapter.ts`: the official SDK long connection
  (`WSClient` + `EventDispatcher`, `im.message.receive_v1` /
  `card.action.trigger`) replaces the fictional WS block. **Long connection is
  the default**; `wsMode: false` still selects the webhook HTTP server (the
  pre-existing path, kept for public-URL deployments).
  - The SDK's **inner event** (no envelope) is normalised into the same
    `FeishuEvent` shape the webhook path uses, so **one** `processMessageEvent` /
    `processCardAction` serves both transports.
  - Inbound now reports `instanceId` + `channelKind` (G3's residual), which is
    what makes session isolation actually take effect on Feishu.
  - Card taps go to the **action port** (`InboundAction`), not a fabricated
    `Message` (design §6.5).
- `packages/comms/src/adapter.ts`: `CommAdapter` gains the optional
  `onAction?` port + `InboundAction` / `InboundActionHandler`.
- `packages/comms/src/router.ts`: the router wires one message handler and one
  action handler per bot; new `isPlatformConnected(platform)` and
  `reconnectPlatform(platform, overrides)` (the gateway is the single owner of
  connection state and of runtime reconfiguration).
- `packages/comms/src/platforms/registry.ts`: `wsMode` field is actually
  reachable in the UI now (label "Use long connection").
- `packages/comms/package.json`: adds `@larksuiteoapi/node-sdk` (same range as
  org-manager).

### org-manager — the legacy path is gone
- **Deleted** `packages/org-manager/src/feishu-notifier.ts` (imported by nobody).
- `api-server.ts` (−510 lines): removed the `FeishuNotifier` import/field,
  `tryInitFeishuNotifier`, `updateFeishuConfig`, `handleFeishuUserMessage` (and
  its `getOrCreateMainSession` call), `resolveFeishuBoundAgent`,
  `resolveIntegrationOrgId`, plus all call sites.
- New `apiServer.setPlatformRuntimeHooks({ connected, sync })` — the API server
  no longer keeps a second copy of connection state; it asks the gateway.
- `platform-integrations.ts`: comment no longer names the retired class.

### cli — the approval loop closes on the action port
- `start.ts`: `messageRouter.setActionHandler(...)` — verifies the **signed ref**
  (`verifyActionRef`) and hands the decision to the one HITL service
  (`respondToApproval`). Without `MARKUS_ACTION_SECRET` the ref is a bare
  approval id (pre-G4 behaviour) — accepted, but warned.
- `start.ts`: `apiServer.setPlatformRuntimeHooks({ ... })` binds
  `isPlatformConnected` / `reconnectPlatform`, so a saved Settings change
  reconnects the platform's bots without a restart (replaces `updateFeishuConfig`).

### tests
- `packages/comms/test/feishu-adapter.test.ts`: the obsolete "websocket mode"
  suite is replaced by a **long-connection** suite (default transport; SDK
  payloads normalised; instanceId/channelKind reported; card action → action
  port). 13 webhook fixtures now pass `wsMode: false` explicitly (behaviour
  unchanged for them).
- `packages/org-manager/test/api-server-extended.test.ts`: the 4
  `handleFeishuUserMessage` tests are removed with the method.

### verification harness
- `packages/cli/scripts/verify-g6-real-data.mjs` — real-data probe, **22/22 PASS**.

---

## 4. Verification evidence

| Check | Result |
|---|---|
| `tsc -b` (whole repo) | **0 errors** |
| comms | **284/284** (23 files) |
| org-manager + comms | **1521/1521** (81 files) |
| **full regression** | **6324 passed / 10 skipped / 1 failed** |
| real-data probe (live DB copy) | **22/22 PASS** |
| teeth check (stash the adapter impl) | **RED — 5 failed / 33 passed**, then restored |

The **single** full-regression failure is the known **environmental** flaky
`cli > commands-start-integration > auto-runs quickInit when config is missing`
(60 s timeout): it needs TCP 8056, which `lsof` shows held by the running
`Markus.app` (PID 10648). Documented identically in the G1/G3/G4 handoffs; it is
not in this slice's payload.

### Real-data probe (22/22) — what it proves
The copy is built the G4 way (real schema + real rows + real `user_version`),
then the **real startup migration** runs on it.

- real `user_version` 2 → **3**; `platform_instances`=1, `channel_bindings`=1;
  re-running `openSqlite` is **idempotent** (same instance ids);
- real instance `bi_feishu_d070a88d7e0a` (feishu, label `default`);
- real global binding → `agt_5f7658fa63f1c5b8ca414d0a`;
- an inbound Feishu message through the **real `MessageRouter`** reaches the agent
  handler and resolves to that **real bound agent**;
- conversation key is the canonical `im:bi_feishu_d070a88d7e0a:group:oc_probe_group_A`
  and `matchedScope` = `global`;
- a card action reaches the **action handler** (with its instance id) and
  **never** enters the conversation path;
- `isPlatformConnected` false → true → false across connect/disconnect;
  `reconnectPlatform` reconnects in place;
- **zero** occurrences of `FeishuNotifier` / `handleFeishuUserMessage` /
  `tryInitFeishuNotifier` / `updateFeishuConfig` in `packages/*/src`.

### Teeth check (RED first)
`git stash push -- packages/comms/src/feishu/adapter.ts` → the new long-connection
suite **fails 5 / passes 33**; `git stash pop` → green. The tests genuinely
depend on the implementation (they are not tautological).

---

## 5. Honest residuals

1. **The approval button is still text, not a tap.** G4 renders actions for
   Feishu as `[label] ref` text (feishu declares `cards: false` in the manifest's
   render capabilities), so a real card *button* is not produced yet. The action
   port, the signed ref and the `respondToApproval` wiring are all in place and
   tested; turning Feishu into an interactive-card target is a capability/manifest
   change (and, on the Web UI side, G5's notification-target UI). **Not a
   regression** — before G6 the only buttons came from the deleted notifier, which
   also could not reach a non-Feishu platform.
2. **`MARKUS_ACTION_SECRET` is unset by default.** Without it, action refs are
   bare approval ids (pre-G4 behaviour) and the probe/wiring accept them with a
   warning. Production should set it.
3. **`wsMode: false` (webhook) is kept** as the alternative transport; it needs a
   public URL. The long connection is now the default, so a fresh install needs no
   public URL (this is what makes the retirement safe).
4. **Single receiver per process.** The long connection is owned by the adapter
   instance; two `markus` processes on the same Feishu app would both receive
   events (Feishu load-balances long connections per app). Unchanged from the
   notifier, and out of scope here.
5. **`getOrCreateMainSession` in `cli start.ts` bootstrap is untouched** — the
   task scoped the removal to `handleFeishuUserMessage`'s call. The gateway's
   `MAIN_CONVERSATION_KEY` and the DB main session are still not unified; that
   remains G6-adjacent follow-up (G3 flagged it).
6. **No PR** — per task discipline, handed to 老板 for manual verification.

---

## 6. Rollback

One commit on `task/tsk_2951e2c0526d467764e12097`:

```
git revert <commit>     # or: git checkout 1b03bcfd -- .   (back to the merged base)
```

The merged base `1b03bcfd` is itself a valid, green state, so reverting G6 lands
on "G1+G2+G3+G4, legacy path still present" rather than on a broken tree.
