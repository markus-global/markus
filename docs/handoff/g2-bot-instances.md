# G2 — Bot instances: the concept in the running system

**Task:** `tsk_95073651ac23d369f89b419a` · **Requirement:** `req_f2610b70e3196b1201d4bf1b`
(通用消息网关) · **Design:** `docs/design/messaging-gateway.md` §4.2 · **Depends on:** G1
(`tsk_d36d4a2631887eff943a3ada`).

## What shipped

G1 gave the model a table (`platform_instances` + `channel_bindings`). G2 puts the
**bot instance** concept into the running system, so "one platform hosts many bots"
is true of the **connections**, not just of the rows.

1. **`BotInstance`** (`packages/comms/src/platforms/instance.ts`) — `id / platform /
   label / config / capabilities / enabled`. `platform` is the **manifest**
   (declarative); an instance is one *configuration* of it with credentials.

2. **Router keyed by instance, not platform** (`packages/comms/src/router.ts`).
   `registerAdapter(adapter, instanceId?)` — the default instance id is the
   adapter's platform, i.e. byte-for-byte the pre-G2 "one implicit bot per
   platform". A real row registers under its own `id` (`bi_…`), so two rows of one
   platform occupy two slots instead of the second silently overwriting the first.
   - `getInstances()` — new observability (`{instanceId, platform, connected}`).
   - `sendToChannel(…, instanceId?)` — target one bot explicitly; without an id a
     multi-bot platform logs a **warning** and uses the first (never silent).
   - inbound replies now leave through **the bot that received the message**
     (captured per-bot), so two instances keep independent inbound namespaces.
   - `connectAll` resolves the slot via `config.instanceId ?? config.platform`; an
     unmatched instance is a loud skip, not a drop.

3. **Startup traversal iterates instances** (`connectConfiguredPlatforms`,
   `packages/cli/src/commands/start.ts`): for each manifest take its
   `platform_instances` rows **when any exist** (one adapter per row, row config ⊕
   file section ⊕ env); a platform with **no** row falls back to the legacy path
   (integrations row + `markus.json` + env) with instance id = **platform id**. So
   a migrated install and an unmigrated one connect identically.
   - `PlatformStartupResult.id` is the instance id; `label` is the manifest name
     disambiguated by the instance label (`Feishu / Lark (sales-bot)`), defaults
     (`label === 'default'`) keep the bare manifest name.

4. **Storage bridge exposes the two repos** (`platformInstanceRepo`,
   `channelBindingRepo`) — pure wiring, no behaviour on its own.

## Verification

- **New tests, red-first.** `packages/comms/test/router-instances.test.ts` (5) and
  `packages/cli/test/commands-start-instances.test.ts` (4) were written first and
  observed RED (9/9: missing `getInstances`, missing instance-keyed registration,
  missing `instances` option). Then GREEN.
- **Regression.** `comms + shared` 483/483 · `cli + storage` 470/471 ·
  `org-manager` 1241/1241 · full `vitest run --project node`: **5429 passed / 10
  skipped / 1 failed**. The single failure is the **environment flake** already
  documented in G1: `cli > auto-runs quickInit` times out because port 8056 is held
  by the running Markus app (`lsof` → PID 10648 `Markus` LISTEN on `*:8056`). It is
  not in this slice's payload and fails identically without it.
- **`tsc -b`** full repo: 0 errors.
- **Real data** (`packages/cli/scripts/verify-g2-real-data.mjs`, **14/14 PASS**,
  exit 0): builds the copy of the live pre-upgrade DB (16 GB, `user_version = 2`),
  runs the **real** `openSqlite` migration, reads the **real** instance row, and
  drives the **real** `connectConfiguredPlatforms` with the **real** Feishu
  manifest:
  - real row → exactly **1** adapter, keyed by the real id
    `bi_feishu_d070a88d7e0a`, connected;
  - the copy's credential blob is byte-identical to the live `integrations` blob
    (guaranteed by G1; re-asserted here);
  - **row ⊕ file merge**: the adapter receives `appId` from the file section *and*
    `notifyPriority` from the row;
  - **two bots of one platform** (real row + a second row): 2 adapters, each with
    its own credentials, both connected, 2 distinct instances on the router;
  - a platform with no row and no config creates **0** adapters (no phantom bot).

## Real-data finding worth carrying into G3/G4

On the live install the Feishu `integrations.config` is **not** a full credential
blob — it holds only `{connectionMode, notifyOnApproval, notifyOnNotification,
notifyPriority}`; **`appId`/`appSecret` live in `markus.json`**. So an instance row
is a *partial* config and the **row ⊕ file ⊕ env merge is load-bearing**:
`resolveManifestConfig` precedence is `row > file section > env`. Anything that
later treats the instance row as self-sufficient (e.g. an "is this instance
usable?" check) must re-apply that merge. Also: `select`-typed fields are coerced
to a comma-joined string (`['high','urgent','normal'] → 'high,urgent,normal'`).

## Known issues / residuals

1. **Inbound routing is still platform-scoped.** `resolveInboundAgent` uses
   `message.agentId → channel binding → platform binding`; with two bots of one
   platform both share the platform default until G3 lands instance/channel scope
   (`channel_bindings` is written by the G1 migration but not yet read by the
   router). **G3 owns this** — the router is deliberately unchanged here.
2. `applyPersistedPlatformBindings` still reads the **legacy** `integrations`
   config for `agentId`. No regression (that row is retained read-only), but a bot
   created *purely* as an instance row has no platform binding until G3.
3. `sendToChannel` without an `instanceId` on a multi-bot platform warns and uses
   the first bot. Correct until G4's `OutboundDispatcher` carries the instance.
4. `initSqliteStorage` swallows **all** errors (including a repo-wiring
   programming error) and returns `null`. This is pre-existing; G2 only had to stop
   a test fixture from lying about the repo list (see below). A dedicated slice
   should narrow that catch so a wiring bug fails loudly instead of silently
   degrading to memory-only mode.
5. No PR, per task rules — handed to 老板 for manual verification.

## Test-fixture fix (in scope, structural)

`packages/org-manager/test/storage-bridge.test.ts` enumerated every `*Repo` export
of `@markus/storage` in its module mock. Adding two repos to the bridge made three
unrelated tests fail with `expected null not to be null` (the undefined constructor
threw, and the broad catch hid it). The fixture now mocks `openSqlite` /
`runInTransaction` explicitly and hands **any** `*Repo` name a no-op — so the
fixture can no longer drift out of date with the bridge.

## Rollback

One commit, self-contained. `git revert` it: the traversal falls back to the
pre-G2 per-platform loop (no `instances` option is passed), and the router keeps a
single slot per platform. G1's tables and migration are untouched.
