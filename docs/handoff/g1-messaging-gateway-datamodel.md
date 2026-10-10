# G1 — Messaging gateway data model (handoff & verification)

**Task:** `tsk_d36d4a2631887eff943a3ada` · **Requirement:** `req_f2610b70e3196b1201d4bf1b`
(通用消息网关) · **Design:** `docs/design/messaging-gateway.md` §5

## What shipped

The root fix for "代码里没有 *bot 实例* 概念" — the data foundation the rest of
the gateway (G2–G8) builds on. **Behavioural change for this slice: none.** No
route, adapter, or UI is rewired.

| Area | Change |
|---|---|
| Schema | two additive tables `platform_instances`, `channel_bindings` (+ indexes) |
| Migration | `migrateMessagingGateway(db)` — incremental, idempotent, non-destructive, fail-safe |
| Startup | `openSqlite()` runs it once, gated by `PRAGMA user_version` (v2 → **v3**) |
| Repos | `SqlitePlatformInstanceRepo`, `SqliteChannelBindingRepo` |
| Shared | `@markus/shared/secretary.ts` — single source of the "who is the Secretary" rule |
| Read primitive | `resolveInstanceConfig()` — dual-read (new table first, legacy fallback) |

### The two tables (docs §5.1)

- **`platform_instances`** — one row per configured bot. `UNIQUE(org_id, platform, label)`
  is what makes "one platform, many bots" possible (the old `integrations` PK was
  `(org_id, platform)` — physically one bot per platform).
- **`channel_bindings`** — `scope ∈ {global, instance, channel}` → `agent_id`.
  Scopes are ordered most-specific-first: `channel` → `instance` → `global`.
  **Caveat:** SQLite treats `NULL`s as DISTINCT in a UNIQUE index, so the
  `UNIQUE(org_id, scope, instance_id, native_id)` key does *not* de-duplicate
  `global`/`instance` rows. One-row-per-scope there is enforced by the migration's
  explicit `WHERE NOT EXISTS` guards — not by the index. (G2–G5 must keep this in mind.)

### The migration (docs §5.2/§5.3) — three steps, all re-runnable

1. every `integrations` row → `INSERT OR IGNORE` a `platform_instances` row
   (`label='default'`), the **`config` column copied as the RAW string** — never
   `JSON.parse` + re-`stringify` (byte fidelity proven below);
2. a non-empty `config.agentId` → one `instance`-scope binding;
3. an org left with **no** binding → `global → Secretary` (shared predicate).

The legacy `integrations` table is **read only** here — never altered, never deleted.

### Fail-safe

The whole migration is wrapped in try/catch inside `openSqlite`: a throw is logged
and swallowed, the app still starts, the legacy read path keeps serving, and
`user_version` is **not** advanced (so a fixed build retries next start).

## Verification

### Unit / regression (fixtures)

| Suite | Result |
|---|---|
| `packages/storage` (incl. new `messaging-gateway-migration.test.ts`, 16 tests) | **189 passed** (15 files) |
| `packages/org-manager` (touched `org-service.ts`) | **1241 passed** (58 files) |
| `packages/shared` + `packages/comms` | **478 passed** (34 files) |
| `tsc -b shared comms storage org-manager` | **0 errors** |

The new tests were written first and observed **RED** (12 failing: missing
`migrateMessagingGateway` + missing tables) before implementation.

### Real data (not fixtures)

`packages/storage/scripts/verify-g1-real-data.mjs` runs the **real startup path**
(`openSqlite`) against a copy of the live pre-upgrade DB and asserts 16 invariants.
The live DB is ~16 GB, so the copy keeps the **real schema** (all 48 tables / 105
indexes, DDL read straight from the running install) + the **real rows** of the
four tables this slice touches (`integrations`, `agents`, `organizations`, `teams`)
+ the real `user_version = 2` — the migration's complete input surface.

Live pre-upgrade facts: org `default`, one `integrations` row
`feishu_default` (平台=feishu, enabled=1, config 132 B, **no `agentId`**),
Secretary = `agt_5f7658fa63f1c5b8ca414d0a`.

```
PASS  live DB 含 integrations 行  1
PASS  live DB 含 Feishu 配置
PASS  live DB 为升级前版本 (<3)  2
PASS  copy 凭据 blob 与 live 字节一致（迁移前）
PASS  platform_instances 恰 1 行  1
PASS  instance 行映射正确 (org/platform/label/enabled)
PASS  instance 凭据 blob 字节级一致（绝不重新序列化）
PASS  channel_bindings 恰 1 行  1
PASS  无 agentId ⇒ global → Secretary  (→ agt_5f7658fa63f1c5b8ca414d0a)
PASS  legacy integrations 行迁移后原样保留
PASS  读路径优先新表  "instance"
PASS  重跑迁移无新增（幂等）
PASS  新表缺席时回落 legacy（旧读路径行为不变）  "legacy"
PASS  user_version 推进到 3  3
```

The migrated instance id is deterministic and collision-resistant
(`bi_feishu_<sha1-12>`), and its `config` hex is byte-identical to the live blob:
`7B22636F6E6E656374696F6E4D6F6465…227D`.

> **Note (dual-read window):** deleting a `platform_instances` row while the legacy
> `integrations` row still exists will *re-seed* it on the next migration pass.
> That is intended (legacy is still the fallback source until the retirement slice
> G6); do not treat the legacy table as a tombstone.

## Files

- `packages/storage/src/sqlite-storage.ts` — schema, repos, migration, `resolveInstanceConfig`, open wiring
- `packages/storage/src/types.ts` — row / repo types
- `packages/storage/src/index.ts` — exports
- `packages/storage/test/messaging-gateway-migration.test.ts` — 16 tests
- `packages/storage/test/legacy-upgrade-migration.test.ts` — version assertions 2 → 3
- `packages/storage/scripts/verify-g1-real-data.mjs` — real-data probe
- `packages/shared/src/secretary.ts` (+ `index.ts`) — Secretary single source
- `packages/org-manager/src/org-service.ts` — delegate to the shared predicate
- `docs/design/messaging-gateway.md` §5.3 — implementation contract

## Follow-ups / not in this slice

- **Not wired:** `resolveInstanceConfig` / the repos have no consumer yet — G2
  (instance registration) and G3 (inbound) do that.
- **Org Secretary soft-delete:** the migration skips agents with a non-empty
  `deleted_at`; it does not filter `role_id` nuances beyond the shared predicate.
- Rollback = `git revert` of the single commit; the two tables are additive and the
  legacy table is untouched, so no data is at risk.
