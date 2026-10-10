# Settings — Integrations API (platform-manifest driven)

> Slice **S3** of the platform-manifest programme (issue #340, requirement
> `req_5e52c6c9ecf339b5724e9ae2`). S1 shipped the manifest registry; this slice
> makes the **Settings API** consume it.

## Why

Before this slice the Settings API hard-coded one platform. Every endpoint under
`/api/settings/integrations/feishu/*` named Feishu in the path, the handler
branch, the config shape and the storage call. A second platform could not be
configured at all without another copy of all of that.

Now the platform set is data (`PLATFORM_MANIFESTS`), so the API is **generic**:
one set of handlers serves *every* platform, and the per-platform detail lives in
the manifest. Adding a platform stays a single additive registry entry — no new
endpoint, no new branch.

## Endpoint surface

### Generic (manifest-driven) — serves every platform, Feishu included

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/settings/integrations` | Every manifest + its live status. **No secret values.** |
| `GET` | `/api/settings/integrations/:platform` | One platform's config + status. **No secret values.** |
| `POST` | `/api/settings/integrations/:platform` | Save credentials + runtime preferences. |
| `DELETE` | `/api/settings/integrations/:platform` | Disconnect and clear stored config. |
| `POST` | `/api/settings/integrations/:platform/test` | Probe credentials via `manifest.testConnection()`. |

`:platform` is validated **against the registry**: an unknown id is a `404` with
an actionable hint; a missing `required` field is a `400` naming the field(s).

### Feishu-specific extensions — kept verbatim (backward compatible)

These are genuine platform capabilities rather than the generic
configure/test/save shape, so they keep their old paths and behaviour:

| Method | Path |
| --- | --- |
| `POST` | `/api/settings/integrations/feishu/register` |
| `GET` | `/api/settings/integrations/feishu/register/status` |
| `GET` | `/api/settings/integrations/feishu/chats` |
| `POST` | `/api/settings/integrations/feishu/test-message` |
| `GET`/`PUT` | `/api/settings/integrations/feishu/notifications` |

## Response shape

`GET /api/settings/integrations` →

```jsonc
{
  "platforms": [
    {
      "id": "feishu",
      "label": "Feishu / Lark",
      "docsUrl": "https://open.feishu.cn/document/home/index",
      "capabilities": { "inbound": true, "outbound": true, "threads": true, "cards": true },
      "fields": [ /* PlatformField[] straight from the manifest */ ],
      "enabled": true,
      "connected": true,
      "hasConfig": true,
      "values": {        // non-secret field values, keyed by manifest field
        "appId": "cli_xxx",
        "domain": "https://open.feishu.cn",
        "notifyChatId": "oc_xxx"
      },
      "secrets": {       // secret fields → presence only
        "appSecret": { "hasValue": true },
        "encryptKey": { "hasValue": false }
      }
    }
  ]
}
```

`GET /api/settings/integrations/:platform` returns the same object for one
platform (not wrapped in `platforms`), and additionally **flattens the non-secret
values onto the top level** plus a masked placeholder for each secret — so a
caller written against the pre-S3 shape (`body.appId`, `body.notifyChatId`,
`body.connected`, …) keeps working.

### Secret handling (the security invariant)

`secret: true` fields are **never** returned in plaintext.

- On read: the flattened key carries the mask `••••` and `secrets.<key>.hasValue`
  tells the client whether a value exists.
- On write: a submitted value equal to `''` or the mask is treated as
  *"leave unchanged"*, so a form that round-trips the masked value cannot
  overwrite the real secret with the string `••••`.

This replaces the pre-S3 behaviour where `GET …/feishu` echoed `appSecret` in the
clear. That single behaviour change is deliberate and is asserted by a regression
test (`no GET response body contains a configured secret`).

## Storage — one writer, one place

Config for a platform is one `integrations` row per `(orgId, platform)`
(`IntegrationRepo`), with every submitted field — **including secrets** — stored
under its `config` column.

`markus.json` is **no longer a writer**. It is read only as a *bootstrap
default*: when the database has no value for a field, the value from the legacy
`integrations.<platform>` block (if any) is used. That is what makes the change
transparent to installs that already have credentials in `markus.json` — nothing
is lost and nothing has to be re-entered.

Feishu's runtime reads credentials from several places. The `chats` /
`test-message` extensions and the notification-rule update now resolve through
the *same* helper, so for those paths there is exactly one answer to "what are
this platform's credentials right now".

**Not yet migrated (deferred to `S6`):** the `FeishuNotifier` *bootstrap*
(`tryInitFeishuNotifier`) still reads credentials from `markus.json`, and still
hard-codes the org id `'default'`. Moving it onto this store was attempted here
and deliberately reverted — it adds repository / `loadConfig` reads during
server construction, which perturbs the ordered `mockResolvedValueOnce` queues in
`api-server-extended.test.ts` (see Verification below), and it belongs to `S6`'s
brief anyway. Until then: live notification dispatch on a *fresh* process still
starts from the `markus.json` value, while the Settings API reads the database.
A save through the new POST does update the running notifier immediately
(`syncPlatformRuntime`).

## New platform = one registry entry

Nothing in this API names a platform. `webui` and `feishu` are already served;
`S5` adds Telegram / Slack / WhatsApp / Discord purely by appending manifests —
they become configurable, testable and listed with no change here.

## Out of scope (tracked elsewhere)

- **S6** migrates the remaining Feishu *runtime* paths onto this store — the QR
  `register` extension (still writes `markus.json`) and the `FeishuNotifier`
  bootstrap (still reads `markus.json`, and hard-codes org id `'default'`) —
  fixes the dead route bindings (root cause A), and re-asserts the no-plaintext
  invariant across every GET.
- `connected` currently has a real source only for Feishu
  (`FeishuNotifier.connected`); other platforms report `false` until `S5` wires
  their adapters up.

## Verification

| Check | Result |
|---|---|
| `npx vitest run --project node packages/org-manager/` | ✅ 57 files / all pass |
| `npx vitest run --project node packages/comms/` | ✅ 14 files / all pass |
| `pnpm typecheck` (`tsc -b` + web-ui) | ✅ clean |
| `npx eslint` on changed sources | ✅ 0 errors (125 pre-existing warnings) |

New/changed tests:

- `test/platform-integrations.test.ts` (24) — store semantics: validation,
  masking, preservation of legacy keys, non-overwrite of the stored secret.
- `test/platform-integrations-api.test.ts` (13) — the generic HTTP surface:
  auth, unknown platform 404 + hint, missing-field 400, persistence + masking,
  CRUD, and the explicit **"no plaintext secret in any GET/POST response"**
  regression.
- `test/integration-api.test.ts` — the pre-existing Feishu suite, updated to the
  new contract (credentials in SQLite; masked secret on GET).

### Two behaviours that changed on purpose

1. `POST /api/settings/integrations/feishu` (the old handler) used to validate
   `appId`/`appSecret` and write them to `markus.json`. The generic POST validates
   the manifest's `required` fields and writes to the `integrations` row; it no
   longer writes `markus.json`.
2. `POST …/feishu/test` with an **empty body** now probes using the *stored*
   credentials (manifest `testConnection`) instead of returning 400 without a
   network call. That is the intended behaviour for the `S4` UI ("test what is
   saved"), and it is what shifted the global `mockFetch` queue in
   `api-server-extended.test.ts`; the three affected tests now reset the mock
   they depend on rather than inheriting leftover queued responses.
