# Manifest-driven comms startup (issue #340, slice S2)

> Author: CTO | Date: 2026-10-08 | **Status: implemented** (branch `task/tsk_8b4b44a92aace016de0c0cd2`)
> Scope: `packages/cli/src/commands/start.ts` (+ tests). Builds on slice S1
> (`PLATFORM_MANIFESTS` in `@markus/comms`).

---

## 1. Why

Issue #340: the comms layer ships Telegram / Slack / WhatsApp / Discord adapters that are
implemented, exported and unit-tested — but nothing ever instantiates them. The gap is not the
adapter; it is every layer above it. Slice **S1** introduced a single source of truth — the
platform manifest (`PlatformManifest` + `PLATFORM_MANIFESTS`) — so those layers can iterate the
registry instead of branching.

**S2 is the first consumer of that registry: the CLI startup path.** Before this change,
`markus start` hard-coded one branch per platform:

```ts
const feishuAppId = config.integrations?.feishu?.appId ?? process.env['FEISHU_APP_ID'];
if (feishuAppId && feishuAppSecret) {
  messageRouter.registerAdapter(new FeishuAdapter());
  await messageRouter.connectAll([{ platform: 'feishu', appId, appSecret }]);
}
```

Every new platform meant editing this file. Now startup walks `PLATFORM_MANIFESTS`.

**This slice is a behaviour-equivalent refactor**: the set of platforms that connect (feishu
when its credentials are present) and the failure semantics are unchanged.

## 2. What changed

`connectConfiguredPlatforms()` replaces the two hard-coded registration sites. It is exported so
the invariant below can be tested directly.

For every manifest in the registry it:

1. **Resolves the config** for that platform id from, in order: the config file section
   `integrations[<id>]` → the environment → (any runtime-computed value supplied by the caller).
2. **Decides enablement**: `defaultEnabled: true` platforms are always on; otherwise every
   `required` field must have resolved to a value. A platform that declares **no** required
   field stays off until at least one value is supplied — it is never silently switched on.
3. If enabled: **factory → register → connect**, then records whether the adapter reports
   `isConnected()`.

The per-platform if-branches are gone. `FeishuAdapter` is no longer imported by
`start.ts`; adapters are built by `manifest.createAdapter()`.

## 3. Config resolution rules

| Source | Example | Notes |
|---|---|---|
| Config file | `integrations.feishu.appId` | Keyed by `manifest.id`, so it works for any platform. |
| Environment | `FEISHU_APP_ID` | Derived generically: `<PLATFORM_ID>_<SNAKE_CASE_FIELD_KEY>`. `appId` → `FEISHU_APP_ID`, `appSecret` → `FEISHU_APP_SECRET` — i.e. exactly the variables the old code read, but for *every* field of *every* platform, with no per-platform table. |
| Runtime | `{ <id>: { … } }` | Values that cannot be static (e.g. one derived from the API port). Data, keyed by id — **not** a branch: a new platform needs no entry here. No platform currently requires one. |

**Manifest `field.default` is deliberately NOT applied at runtime.** Per the S1 type contract a
field `default` is "the value the settings form starts from when nothing is stored yet" — a
*form/preview* concern. At runtime the adapter owns its own defaults (e.g. `FeishuClient` falls
back to `https://open.feishu.cn`). Keeping the two roles separate means
a manifest default can never silently change connect-time behaviour.

Values are coerced by the declared field `type` (`number`, `boolean`, else string); empty strings
count as "not configured".

## 4. Failure semantics (unchanged in spirit, now actually observed)

- One platform failing to connect never blocks startup: it is caught, reported with
  `startupLog('WARN', …)` and skipped. Other platforms still connect.
- **Enablement is decided from configuration only**, so a *misconfigured* platform (bad
  credentials) is still attempted — and now correctly reported as failed.

> Note on the old code: `MessageRouter.connectAll()` catches connect errors internally, so the old
> `try/catch` around it never fired and `startupLog('OK', …)` printed even when Feishu had failed.
> S2 keeps `connectAll()` (it owns the `onMessage` wiring) but bases the outcome on the
> authoritative `adapter.isConnected()` instead. Degradation is identical (never throws); only the
> log/status text becomes truthful.

Step-5 progress text is now generated from the adapters that actually connected
(`webhook adapters: Feishu / Lark`, `… (Feishu / Lark failed)`), replacing the
hard-coded `"Feishu"` / `"Feishu only"` strings.

## 5. The invariant, pinned by a test

> **Adding a platform must not require editing `start.ts`.**

`packages/cli/test/commands-start-platforms.test.ts` asserts this end to end: it registers an
extra manifest the source code has never heard of (via a mocked `PLATFORM_MANIFESTS`), runs the
real `markus start` command with that platform configured, and asserts its adapter connected — with
no reference to the new id anywhere in `start.ts`.

## 6. Regression surface

- Existing `packages/cli/test/commands-start-integration.test.ts` must stay green (the feishu
  configured / feishu-fails / no-feishu cases exercise exactly this path).
- New unit tests cover: feishu enabled from file and from env, missing-required
  → skipped, generic env derivation, per-platform failure isolation, and the "new manifest" case.

## 7. Out of scope (follow-up slices)

- Persisted `integrations` rows as a startup config source (S6 — credentials double-write / secret
  echo, `(B)` in the requirement).
- Telegram / Slack / WhatsApp / Discord manifests and their reviving (S5).
- Settings API / UI generalisation (S3 / S4).
