# Messaging Gateway

**Status:** implemented.
**Related:** `packages/comms/docs/platform-manifest.md` (type contract + "how to add a
platform"), issue #340.

---

## 1. Problem & goals

The comms layer today can *connect* a platform but cannot *express* how a platform
maps onto the organisation. The owner's requirement, stated plainly:

1. Markus must expose **one generic in/out gateway** with a unified abstraction over
   three kinds of channel: an **agent's main session**, a **group chat**, and
   **notifications**.
2. A single external platform may host **many bots**, each mapped to a different
   internal agent. (e.g. 10 agents on Markus, 5 bots on Feishu + 5 on Telegram.)
3. **Default**: bind the **Secretary** agent, and route **all notifications** through
   that same channel.
4. The user can **rebind** any of it, or **create a new bot** and bind it elsewhere.
5. Common capabilities must be abstracted and provided uniformly; **platform-unique
   capabilities must also be supportable** without polluting the core.

Non-goal for this document: implementing every platform capability. The document
fixes the *model*; capabilities land behind it incrementally.

## 2. Current state & root causes

A read-only baseline scan (evidence with `file:line`) found four single sources of
truth and four multi-point implementations:

| Concern | Today | Verdict |
|---|---|---|
| Which platforms exist / their fields | `PLATFORM_MANIFESTS`, `AGENT_BINDING_FIELD` (`comms/src/platforms/registry.ts`) | **single source ✓** |
| Wire format of an inbound message | `Message` (`shared/src/types/message.ts:11-23`) | **single source ✓** |
| Persistence | `integrations` table (`storage/src/sqlite-storage.ts:650`) | **single source ✓** |
| Binding resolution | router snapshot at startup **and** live DB re-read per message | **two writers ✗** |
| Inbound dispatch (Feishu) | `MessageRouter.routeIncomingMessage` **and** `handleFeishuUserMessage` | **two paths ✗** |
| Credential write | generic `savePlatform` **and** QR-register writing the repo directly | **two writers ✗** |
| Outbound notification | `FeishuNotifier` only | **one platform ✗** |

Concrete defects this causes:

- **D1 — one platform, one bot.** `integrations` is keyed `(org, platform)`. There is
  no way to hold two Telegram bots, so "N agents ↔ M bots" is unrepresentable.
- **D2 — binding is platform-level only.** `bindAgentToChannel` exists
  (`comms/src/router.ts:25`) but production never calls it; startup only calls
  `bindPlatformAgent`. Group-chat-level binding is unreachable.
- **D3 — no session isolation.** `Message` carries no session field; the router never
  injects one; the Feishu live path calls `getOrCreateMainSession(...)`
  (`org-manager/src/api-server.ts:2889`). **Every Feishu user shares one session.**
- **D4 — two Feishu inbound paths.** Both can be live at once ⇒ a message is handled
  twice, in two different sessions (one with thinking-card/reaction UX, one without).
- **D5 — outbound is Feishu-only.** `hitl-service.notify` (`hitl-service.ts:476`) is a
  platform-agnostic notification record, but the only subscriber is `FeishuNotifier`.
  Telegram/Slack/Discord/WhatsApp users never receive approvals or input requests.
- **D6 — unbound behaviour disagrees.** Feishu falls back to the Secretary
  (`api-server.ts:2780`); the router logs a warning and **drops** (`router.ts:115`).
- **D7 — `sendAsAgent` ignores `agentId`** (`router.ts:105`): "send as this agent"
  does not exist.

**Root cause (one sentence):** *the concept of "a bot instance" does not exist in the
code.* Everything above follows from conflating **platform** with **bot identity**.

## 3. Industry patterns → our decisions

Sources: matterbridge, Matrix Application Services, Microsoft Bot Framework,
Chatwoot, Mattermost/Zulip, Slack multi-workspace, Nylas grants, Twilio Conversations.
Full notes: `research/gateway-patterns.md`.

| Concern | Industry pattern | Our decision |
|---|---|---|
| Bot identity | matterbridge: `account` prefix = protocol, *more instances = more accounts*; Nylas: one account = one `grant`; Slack: per-`team_id` token | **First-class `BotInstance`** — `platform ≠ instance`. One instance = one credential set + one namespace. |
| Channel | `Channels[channel+account]`; Matrix room alias; BF `conversation` | **`ChannelRef { instanceId, nativeId, kind }`**, `kind ∈ {main, group, notification}` |
| Binding | BF per-conversation state; Chatwoot `Inbox → AgentBot` | **Layered, nearest-wins:** global → platform → instance → channel. Record *which level matched*. |
| Threads | parent-id + LRU cache; Nylas threads | **Canonical conversation key ↔ native ids**, both directions |
| Outbound | BF `ConversationReference` for proactive send | **`OutboundDispatcher`** consuming HITL + EventBus, rendering per capability |
| Platform extras | matterbridge `Extra` + Tengo escape hatch; BF `channelData` | Core knows the **minimal common set**; unique features ride in `extra` behind declared **capabilities**. |
| Fallback | some bridges silently drop | **Never silently drop.** Fallback chain ends at the global default (Secretary). |

**Learned caution:** matterbridge inlined protocol special-cases into its core and
later had to bolt on a scripting escape hatch. **We will not inline platform quirks
into the router** — capabilities + `extra` from day one.

## 4. Target model

Four entities, three of them new:

```
BotInstance        one configured bot on one platform (id, platform, label,
                   credentials, capabilities, enabled)          ← NEW
ChannelRef         { instanceId, nativeId, kind }                ← NEW
                   kind ∈ { main, dm, group, notification }
Binding            (scope, agentId)  scope ∈ { global, platform,
                   instance, channel }                           ← NEW (replaces agentId field)
ConversationKey    canonical id  ↔  (instanceId, nativeId)       ← NEW
```

Relationships:

```
organisation
  └── platform "telegram"
        ├── instance "sales-bot"    ──binding──▶ agent "Sales"
        │     ├── main       (DM with owner)   ──▶ Sales main session
        │     ├── group "team-a"               ──▶ Sales session #a
        │     └── notification (owner DM)      ──▶ Sales notification sink
        └── instance "ops-bot"      ──binding──▶ agent "Secretary"
              └── …
```

`platform` is a **manifest** (declared capabilities + field schema + adapter
factory). `instance` is a **configuration** of that manifest with credentials.
Adding a platform = one manifest; adding a bot = one instance row. Neither touches
the router.

### 4.1 Worked example (what "instance" vs "group" actually means)

```
platform "feishu"
├── instance "销售助手"   (one self-built app you created in the Feishu console)
│     ├── group "销售一群"     ──binding──▶ agent "Sales"
│     └── group "销售二群"     ──binding──▶ agent "Sales"
└── instance "通用助手"   (a second app, second bot identity)
      ├── group "产品群"       ──binding──▶ agent "Product"
      ├── group "运营群"       ──binding──▶ agent "Ops"
      └── dm    "老板的单聊"   ──binding──▶ agent "Secretary"  (kind=main)
```

- **instance** = one concrete bot you created and configured (credentials, avatar).
  "5 bots on Feishu" = 5 instances.
- **group / dm** = a *channel inside* an instance — the place messages actually
  arrive. A single bot (instance) can sit in many groups at once.
- **binding is per channel, not per instance.** That is the whole point:
  *one bot can serve five groups, each answered by a different agent.*
- Therefore the many-to-many is **agent ↔ channel**: one agent serves many
  channels; one instance fans out to many agents by channel. Binding an *instance*
  to an agent is just shorthand for "all its channels default to this agent".

### 4.2 `BotInstance` — the registry concept

The tables express the model; the registry puts the concept **into the running
system**, so "one platform may host many bots" is true of the **connections**, not
just of the rows.

**The type** (`packages/comms/src/platforms/instance.ts`):

```ts
interface BotInstance {
  id: string;                         // stable, unique per bot (bi_…; the implicit
                                      // legacy bot uses the platform id — see below)
  platform: string;                   // manifest id
  label: string;                      // human label, unique per (org, platform, label)
  config: Record<string, unknown>;    // resolved credentials + platform fields
  capabilities: PlatformCapabilities; // from the manifest, optionally narrowed
  enabled: boolean;                   // whether startup should connect it
}
```

`platform` is the **manifest** (declarative: fields, capabilities, adapter
factory). An **instance** is one *configuration* of that manifest with
credentials. Adding a platform = one manifest; adding a bot = one instance row.
**Neither touches the router** — the router is generic over instances.

**Identity.** A bot connection is keyed by `instanceId`, never by platform.
`MessageRouter.registerAdapter(adapter, instanceId?)` defaults `instanceId` to
`adapter.platform`, which is byte-for-byte the "one implicit bot per platform"
behaviour of every build before bot instances existed; a real instance row registers
under its own `id` (`bi_…`). Two rows of the same platform therefore occupy two distinct slots
and connect on two distinct credential sets — keying adapters by instance instead
of by platform is what makes "2 Telegram bots at once" *structurally* possible
rather than a silent overwrite.

**Startup traversal** (`connectConfiguredPlatforms`) is dual-read, matching §5.2
step 4:

1. for each manifest, take its `platform_instances` rows **when any exist** — one
   adapter per row, connected with that row's config; a row switched off
   (`enabled = false`) or whose required fields do not resolve is skipped;
2. a platform with **no** instance row falls back to the legacy path (the
   `integrations` row + `markus.json` + env) and registers a single implicit
   instance whose id **is** the platform id — the legacy behaviour, so a migrated
   install and an unmigrated one connect identically.

`PlatformStartupResult.id` is therefore the instance id: the platform id for the
implicit legacy bot, the `platform_instances.id` for a real row. Callers that need
the platform read `label` (the manifest name, disambiguated by the instance label)
— outbound routing is a separate concern (§7).

**Instances own connection.** Which agent answers an inbound message (instance /
channel scope, nearest-wins) and which session it lands in are §6's responsibility —
this layer only decides *which credentials connect*.

### 4.3 Startup: consuming the registry

`markus start` walks `PLATFORM_MANIFESTS` × the persisted instances of each
platform, and for every enabled bot does **factory → register → connect**
(`connectConfiguredPlatforms()` in `packages/cli/src/commands/start.ts`). The
hand-written `if (feishuAppId && feishuAppSecret)` block is gone and `start.ts` no
longer imports `FeishuAdapter` at all.

The invariant this buys:

> **Adding a platform must not require editing `start.ts`.**

`packages/cli/test/commands-start-platforms.test.ts` pins it end to end: it
registers an extra manifest the source code has never heard of and asserts that its
adapter connected.

**Config resolution is a merge, and the merge is load-bearing.** Per platform id,
fields resolve first-hit-wins from three sources:

| Source | Example | Notes |
|---|---|---|
| Stored row | `integrations.feishu.appId` | Keyed by `manifest.id`; written only by `savePlatform` (§5.4). |
| Config file | `markus.json` → `integrations.<id>` | Read-only bootstrap default (§5.4). |
| Environment | `FEISHU_APP_ID` | Derived generically as `<PLATFORM_ID>_<SNAKE_CASE_FIELD_KEY>` — the same variables the old hand-written block read, but for *every* field of *every* platform, with no per-platform table. |

Precedence is **row > file > env**, and it is not a convenience: on a real install
the Feishu row holds only `{connectionMode, notifyOnApproval, …}` while
`appId`/`appSecret` still live in `markus.json`, so an instance row is a *partial*
config. Any later code that treats a row as self-sufficient (an "is this instance
usable?" check, for instance) must re-apply this merge.

**Enablement is decided from configuration only**, never from reachability:
`defaultEnabled: true` platforms are always attempted; otherwise every field marked
`required` must have resolved to a non-empty value. A platform that declares no
required field stays off until something is supplied — it is never silently switched
on. Values are coerced by the declared field type; empty strings count as "not
configured"; `select` fields are stored comma-joined.

**Two things are deliberately *not* taken from the manifest at runtime:**

- `field.default` — the type contract defines it as "the value the form starts from
  when nothing is stored yet", i.e. a *form* concern. Runtime defaults belong to the
  adapter (`FeishuClient` falls back to `https://open.feishu.cn`). Keeping the roles
  separate means a form default can never silently change connect-time behaviour —
  precisely the trap §6.5 describes, where `wsMode` defaulting to `false` silently
  selected webhook mode on a desktop install that has no public URL.
- Anything beyond the declared type coercion — adapters own their own parsing.

**Failure semantics.** One platform failing to connect never blocks startup: it is
caught, logged at `WARN` and skipped, and the others still connect. Enablement came
from configuration, so a *misconfigured* platform is still attempted — and now
reported as failed. That last part is a fix, not a restatement: the old code printed
`OK` even when Feishu had failed, because `MessageRouter.connectAll()` swallows
connect errors internally and the surrounding `try/catch` therefore never fired. The
outcome now comes from the adapter's authoritative `isConnected()`, and the progress
text is generated from the adapters that actually connected.

## 5. Data model & migration

Replace the `(org, platform)`-keyed `integrations` row with two tables:

```sql
platform_instances(
  id TEXT PRIMARY KEY,            -- bi_…
  org_id TEXT NOT NULL,
  platform TEXT NOT NULL,         -- 'telegram' | 'feishu' | …
  label TEXT NOT NULL,
  config TEXT,                    -- JSON: credentials + platform fields
  capabilities TEXT,              -- JSON: resolved from manifest, may be narrowed
  enabled INTEGER NOT NULL DEFAULT 1,
  last_verified_at TEXT, last_error TEXT,
  UNIQUE(org_id, platform, label)
)

channel_bindings(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL,            -- 'global' | 'platform' | 'instance' | 'channel'
  instance_id TEXT,               -- NULL for global/platform scope
  native_id TEXT,                 -- NULL unless scope='channel'
  kind TEXT,                      -- NULL unless scope='channel'
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, scope, instance_id, native_id)
)
```

### 5.1 Backward compatibility (hard requirement)

We already have many existing installs. The migration therefore MUST be:

- **Additive.** New tables are *added*; the existing `integrations` table is **not**
altered or dropped in this release. An older binary reading the same DB keeps
working (forward-compatible file, not a breaking rewrite).
- **Idempotent.** Runs on every startup; re-running is a no-op (`INSERT … WHERE NOT
EXISTS` / `INSERT OR IGNORE`), never duplicates rows, never overwrites user edits.
- **Non-destructive.** Nothing is deleted. `config` blobs (credentials) are copied
verbatim — **never re-serialised** through a lossy path — so a user's existing
Feishu app secretly keeps working after the upgrade.
- **Fail-safe.** If migration throws, the app still starts and the **old read path
still serves**; new features degrade to "unavailable", never to "data lost".
- **Reversible.** The migration is a pure addition; rollback = ignore the new tables
(one release of dual-read keeps both worlds valid).

### 5.2 Migration steps (one-shot, run at startup)

1. For every existing `integrations` row, `INSERT OR IGNORE` one `platform_instances`
   row with `label = 'default'`, `config` copied **byte-for-byte**.
2. If that row had a non-empty `agentId`, insert an `instance`-scope binding for it.
3. If no binding exists at all afterwards, insert the **global default → Secretary**.
4. **Dual-read window:** readers prefer the new tables; if a platform has no
   `platform_instances` row yet (migration not run, or a row the user just added),
   fall back to the legacy `integrations` row. Writers go to the new tables only.
5. Old table is retained read-only for one release, then dropped in a *later*
   migration (not this one).

`markus.json` stays a **read-only bootstrap** (unchanged policy); the DB is the
single writer.

**Verification is on real data, not fixtures:** before/after screenshots of a copy of
an actual pre-upgrade DB (a user with Feishu configured), asserting the instance row,
credential blob and binding all survive and the old read path is unaffected.

### 5.3 Implementation contract

**Schema (created on every open, additive).** Both tables are created with
`CREATE TABLE IF NOT EXISTS` inside the existing `SCHEMA_SQL`, so they appear on
fresh installs and on upgrade without altering any existing table. Physical
columns match §5, plus `created_at` / `updated_at` for parity with every other
table:

- `platform_instances` — `UNIQUE(org_id, platform, label)`. `label` is
  `NOT NULL`, so the unique index is total (no `NULL`-distinctness hole) and
  `INSERT OR IGNORE` is a real de-duplicator.
- `channel_bindings` — `UNIQUE(org_id, scope, instance_id, native_id)`. SQLite
  treats `NULL` as **distinct** in a unique index, so this index alone does **not**
  de-duplicate `global` / `platform` bindings (whose `instance_id` and `native_id`
  are `NULL`). The migration therefore also guards those inserts with an explicit
  `WHERE NOT EXISTS`, and no caller may rely on the index to enforce "one global
  binding per org".

**One-shot migration** (`migrateMessagingGateway(db)`), invoked from `openSqlite`
behind `PRAGMA user_version`:

1. Every `integrations` row → `INSERT OR IGNORE` a `platform_instances` row with
   `label = 'default'`. The `config` column is copied **byte-for-byte from the raw
   SQL string** — it is never `JSON.parse`d and re-`stringify`d, so a user's
   credential blob survives unchanged. The id is deterministic
   (`bi_<org>_<platform>_<label>`), so a re-run is a no-op rather than a new row.
2. The row's `config.agentId` (parsed read-only, never re-serialised) → an
   `instance`-scope binding `(org, 'instance', instance_id, NULL, NULL, agentId)`.
3. If an org ends up with **no** binding at all, insert `global → Secretary`
   (resolved through the shared Secretary predicate below). Scoped to orgs that had
   at least one `integrations` row — the migration is about upgrading existing
   installs, not about inventing configuration for untouched ones.
4. `PRAGMA user_version` is bumped to `3` **only after** the migration succeeds.

**Fail-safe.** The whole call is wrapped in `try/catch`; a throw is logged and
`openSqlite` continues, so the app still starts and the legacy read path keeps
serving (`user_version` is *not* advanced, so the migration retries next start).
Every step is independently idempotent, so a retry after a partial failure cannot
duplicate or corrupt rows.

**Dual-read window.** Readers prefer the new tables and fall back to the legacy
`integrations` row when a platform has no `platform_instances` row yet; writers
target the new tables only. The storage layer ships the primitive for this
(`resolveInstanceConfig`), and the consumers resolve through it (§4.3, §6.1).

**Single source of truth for "who is the Secretary".** The predicate and the
preference order that the notification default depends on now live in
`@markus/shared` (`isSecretaryLikeAgent` / `pickOrgSecretary`); `OrgService` calls
the same functions. The migration uses them too, so "which agent is the Secretary"
has exactly one implementation.

### 5.4 Credentials: one writer, one reader, never echoed

Credentials had **two writers** — the Feishu QR `register` extension wrote
`markus.json`, while runtime preferences went to the SQLite `integrations` row — and
the notifier bootstrap read `markus.json` directly with a hard-coded
`orgId: 'default'`. The row is now both the writer and the reader:

- **One writer.** `savePlatform` writes the row; the QR `register` extension merges
  `appId`/`appSecret` into it instead of calling `saveConfig(...)`. `markus.json` is
  demoted to a **read-only bootstrap default** — never written.
- **One reader.** Every consumer resolves through `resolvePlatformConfig(orgId, id)`
  (row → bootstrap) and takes the org id from storage rather than a literal.
- **No `GET` returns a secret.** The invariant is asserted across the whole surface
  (`/api/settings/integrations*`), not just the generic endpoint: for every GET the
  response body must not contain a configured secret's plaintext. The test uses a
  **canary** secret value, so re-introducing a leak fails loudly.
- **Masked values do not clear data.** A client that re-submits the masked
  placeholder leaves the stored secret untouched.

## 6. Routing & session isolation

### 6.1 One resolution point

```ts
resolveInboundTarget(message): { instanceId, agentId, conversationKey, matchedScope }
```

Order — **nearest wins**, and the matched scope is recorded (observability, not
guesswork):

1. explicit `agentId` on the message (Web UI sets it)
2. `channel` scope — `(instanceId, nativeId)`
3. `instance` scope — the bot's default agent
4. `platform` scope
5. `global` scope — **the default binding (Secretary)**

Because step 5 always resolves, the router **never silently drops** (fixes D6): an
unbound platform falls through to the Secretary and logs the level that matched.

### 6.2 Session isolation

Each `(instanceId, nativeId, kind)` maps to a **stable canonical conversation key**.
The gateway is the only place that decides a conversation's identity, and it passes
it to the agent as an explicit session hint — the same contract the Web UI already
uses (`channelKey` / `sessionHint` in `core/src/agent.ts`).

Policy (default):

| `kind` | Meaning | Session mapping | Why |
|---|---|---|---|
| `main` | the channel *designated* as the agent's home | the agent's **main session** | continuity — the owner's DM with a bot *is* that agent's home conversation |
| `dm` | a 1:1 chat with an external user | **own session per external user** | two different people must not share one context |
| `group` | a group chat | **own session per group** | see below |
| `notification` | out-only sink | none (inbound ignored) | a notification is a destination, not a conversation |

**Why a group is its own session** — three reasons, in order of severity:

1. **Access isolation.** Group A and group B have different members. Sharing one
   session means the agent can answer a question in B using content it only saw in
   A. That is a data leak dressed up as "context".
2. **Correctness.** Two unrelated conversations interleaved in one context make the
   agent confuse participants, decisions and topics.
3. **Cost.** A shared session grows without bound; N groups × M messages is N×M of
   context, all paid for on every turn.

`main` is a **designation**, not a native platform type: at most one channel per
instance is marked as the agent's home. Everything else isolates by default. A group
may be *re-pointed* to `main` (opt-in) for users who explicitly want one continuous
context — but the default is isolation, because the default must be safe.

The old Feishu live path (`handleFeishuUserMessage`) and its
`getOrCreateMainSession` call are **deleted** — one inbound path, one session
decision (fixes D3, D4).

### 6.3 Implementation contract

> §6.1/§6.2 are one executable decision point rather than prose. It does **not**
delete the legacy Feishu path (§6.5); it makes the router path a single resolver
plus real session isolation, so nothing else has to decide routing again.

**One resolution point.** `resolveInboundTarget(envelope, lookup)` is a pure
function returning `{ instanceId, agentId, conversationKey, matchedScope, kind }`
or `undefined` when **nothing at all** is bound. Levels, nearest wins, with the
winning level recorded for observability:

| # | `matchedScope` | Source |
|---|---|---|
| 1 | `explicit` | `agentId` carried by the message (Web UI sets it) |
| 2 | `channel` | `channel_bindings` row `(scope='channel', instance_id, native_id)` |
| 3 | `instance` | `channel_bindings` row `(scope='instance', instance_id)` |
| 4 | `platform` | the binding on the platform's **`label='default'` instance** |
| 5 | `global` | `channel_bindings` row `scope='global'` (else the live Secretary) |

**`platform` needs no new column.** The design (§4/§5/§6.1) lists `platform` as a
scope, but a `platform`-scope row (`instance_id` and `native_id` both `NULL`)
cannot express *which* platform it applies to, and nothing in the product writes
one (the UI binds instances / channels / the global target — never a platform).
Rather than add a column no writer fills, level 4 is **realised as the platform's
default instance binding** — precisely the row the migration produces out of the
legacy platform-level `agentId` (`label='default'`). So "the whole platform
defaults to agent X" is expressed the way the migration already expresses it, and
the scope stays a single source of truth (no dual storage, no in-band platform
name). Level 4 fires when a message has no instance-specific binding — including
messages from adapters that never set `instanceId` (the legacy shape), which is
exactly when a platform-wide default should apply.

**Never silently drop (fixes D6).** Level 5 is terminal in practice: the `global`
row is seeded to the Secretary by the migration, and the DB-backed lookup falls
back to the live Secretary (shared `pickOrgSecretary` predicate) when no `global`
row exists. The only "drop" left is an org with **no** Secretary and **no**
binding — which is logged loudly with an actionable hint, never silently.

**Session isolation (fixes D3).** `conversationKeyOf({instanceId, nativeId, kind})`
is a pure, collision-free canonical key (`im:<instanceId>:<kind>:<uri(nativeId)>`,
parts percent-encoded so `:` can never be ambiguous). It is handed to the agent as
the existing **`channelKey`** contract (`core/src/agent.ts` maps it to the memory
session `channel_<key>_<agentId>`), so dm/group isolation reuses machinery that
already works for Web UI group chats:

| `kind` | Session |
|---|---|
| `main` | the bound agent's own main session (`MAIN_CONVERSATION_KEY`, no per-channel key) |
| `dm` | own session per native conversation (per external user) |
| `group` | own session per native conversation (per group) |
| `notification` | **inbound ignored** (a destination, not a conversation) |

A `channel`-scope binding whose own `kind='main'` *designates* that channel as the
agent's home (design §6.2) — the resolver then returns `MAIN_CONVERSATION_KEY` so
continuity with the agent's main session is opt-in, and isolation stays the default.

**`sendAsAgent` stops dropping `agentId` (fixes D7).** The agent identity is
forwarded to the adapter's send (`SendOptions.agentId`) instead of being discarded.

**Single path, bootstrap fallback.** The router resolves through this one function.
Its binding source is a lookup port; production injects a DB-backed one (the single
writer) and the in-memory maps populated from `markus.json` remain a read-only
**bootstrap** fallback (§5.2), consulted only when the DB has no answer. No inbound
message is ever routed by a second, independent decision.

### 6.4 Acknowledgement deadlines

Some platforms demand an ACK inside a hard window (Discord 3 s; Feishu card
callbacks 3 s; Slack Socket Mode 3 s). The gateway normalises this: the inbound
transport mints an `AckHandle` for the event, **acks it before the agent turn
starts**, and hands the `Message` to the handler without awaiting it. The real
reply is delivered out-of-band (today through the adapter, by the
`OutboundDispatcher`). The platform's read loop therefore never
blocks on an agent turn.

Implemented in `packages/comms/src/gateway/ack.ts`:

```ts
interface AckHandle { ack(): void; readonly acked: boolean; }
createAck(send: () => void): AckHandle      // idempotent — a second call is a no-op
createDeadlineAck(deadlineMs, send): AckHandle   // auto-acks if nobody did in time
```

Idempotence matters: a transport that acks on receipt *and* arms a deadline would
otherwise send the ACK twice, which several platforms treat as an error. The
Slack Socket Mode transport proves the invariant end-to-end (exactly one
`{envelope_id}` per envelope, even when the handler is slow).

### 6.5 Retiring the legacy Feishu path

**The defect.** Two independent Feishu inbound receivers ran in the same
process: the comms `FeishuAdapter` (the gateway path) and `FeishuNotifier` — an
org-manager class that opened its **own** long connection with the official
`@larksuiteoapi/node-sdk` `WSClient` and re-implemented routing, session choice,
card streaming and notification fan-out. A live Feishu message could therefore be
handled twice, and its session/agent decision was made by whichever receiver
fired — two writers for one fact.

**Why the notifier was the one that actually worked.** The adapter's `wsMode`
branch spoke a *fictional* protocol (`POST /open-apis/ws/v1/apps/{id}/subscribe`
plus a JSON `{type:'heartbeat'}`); Feishu's real long connection is the SDK's
framed `WSClient`. And the manifest `wsMode` field defaults to `false` (manifest
`field.default` is a *form* default and is deliberately never applied to adapter
config), so a real install resolved `wsMode` falsy and the adapter came up in
**webhook** mode — which needs a public URL that a desktop install does not have.
So the only functional receiver was the notifier. Deleting it without first giving
the adapter a real receiver would have *broken* Feishu inbound, not merged it.

**The fix — one receiver, owned by the adapter.** The long connection belongs to
the platform-integration layer, so the official `Lark.WSClient` + `EventDispatcher`
move **into `FeishuAdapter`**:

- `connect()` uses the long connection **by default** (this is the adapter's own
  runtime default, per §3 — the manifest default is not overridden, it is simply
  not consulted). `wsMode === false` opts into the webhook server for
  deployments that do have a public URL.
- `im.message.receive_v1` → `Message` → the adapter's registered handlers (the
  router, §6.1). `card.action.trigger` → the adapter's **action port** (below).
- The adapter now reports `instanceId` and `channelKind` (`dm` for `p2p`, else
  `group`) on every inbound message, so §6.2's isolation is driven by real data
  instead of the legacy shape.
- `@larksuiteoapi/node-sdk` is a dependency of `packages/comms`.

**Card actions are not a conversation.** An approval button tap is a HITL state
transition, not an agent turn, so it must not be fed to the agent handler. The
`CommAdapter` contract gains an optional **action port** (`onAction`), the router
wires it to a single injected `actionHandler`, and the wiring layer (`cli`)
resolves it — verifying the signed action ref (§7.4) when present, otherwise the
raw `approval_id`, then calling `hitlService.respondToApproval`. One inbound
funnel, but two *kinds* of inbound (message vs action) with an explicit decision
point each.

**What is deleted.** `packages/org-manager/src/feishu-notifier.ts` in full; the
`handleFeishuUserMessage` method and its `getOrCreateMainSession` call (the
session choice is now the resolver's, §6.1); the notifier's outbound duties (the
`OutboundDispatcher` owns them, §7); the api-server init/stop/config-sync wiring;
and now-dead `startWSClient`/`stopWSClient` on `FeishuApiClient`.

**Honest residual.** The notifier's **rich agent-response card streaming**
(thinking → tool calls → done, patched into one Feishu card) has no equivalent in
the gateway: the request/reply path returns text. That is a *platform capability*
(card streaming), not routing, and belongs with a future capability slice — it is
recorded as a known limitation rather than silently dropped.

### 6.6 The channel → agent binding is one source

**The defect.** `MessageRouter.bindAgentToChannel()` had **zero callers**
repo-wide, so `agentChannelMap` was permanently empty and "multi-platform binding"
did not exist. It was worse than merely unused: there were **two independent Feishu
inbound paths**, and the live one consulted no binding at all.

| Path | Entry | Target | State before this work |
|---|---|---|---|
| A. gateway | `FeishuAdapter` → router | `agentChannelMap` lookup → empty → **dropped at `log.debug`** | dead unless a webhook was configured |
| B. legacy notifier | its own Lark `WSClient` → api-server | **hard-coded org Secretary** | live for QR-registered apps |

The consequence shaped the fix: populating the map alone would have had **no
observable effect** on the live path, and adding a lookup to the live path required
knowing that the live path was B. The root cause was never the empty map — it was
that **the channel→agent decision had no single source**.

**Resolution order, first hit wins**, now read by every inbound path:

1. `message.agentId` — set by the adapter (Web UI sets it explicitly; unchanged).
2. an explicit **channel** binding (`bindAgentToChannel`).
3. the **instance** binding.
4. the **platform** binding (`bindPlatformAgent`) — defined as *the platform's
   `label='default'` instance binding*. `channel_bindings` has no `platform` column,
   so no writer could create such a row; this avoids inventing a row shape nothing
   can write. A true per-platform row needs the column **and** a writer first.
5. the org **Secretary** — so an unbound inbound is never dropped.

**Unbound inbound is loud.** `routeIncomingMessage` logs at `warn` with the
platform, the channel and an actionable hint (which config field or method to set)
instead of the previous `debug` "…skipping message".

**Binding semantics later work must not silently change:**

- A `channel`-scope binding with `kind = 'main'` designates the agent's home
  conversation; `kind = 'notification'` makes inbound on that channel ignored.
- The binding is **authoritative over the adapter's `channelKind`**.
- One binding source, two writers, applied at startup by
  `applyPersistedPlatformBindings` — and no platform name appears anywhere in the
  loader.

## 7. Outbound & notifications

### 7.1 The failure mode we must avoid

A notification route must **not** depend on the producing agent being bound to an
external channel. A user will bind a handful of important agents — never all of
them — so any design that delivers "to the agent's bound channel" **leaks every
unbound agent's notifications**. Guaranteed delivery is the requirement; smart
routing is an optimisation layered on top of it.

**Prior art, as a negative example: Multica** (`multica-ai/multica`, same problem
space). Its notification layer is **inbox-only — there is no outbound channel at
all** (issue #1020). Humans must open the product to discover that a decision is
waiting, which is exactly the "missed notification" failure in its purest form.
Also worth noting: **agents have no inbox** in Multica; the inbox is per human
member. Two things are worth borrowing: its **severity split** (`info` vs
`action_required`) and its **subscription-based** recipient model (you are notified
about what you watch). Full notes: `research/multica-notifications.md`.

### 7.2 Unified outbound

```
hitlService.notify() ─┐
EventBus (task:*, …) ─┼─▶ OutboundDispatcher ─▶ resolve target(s) ─▶ render ─▶ send
```

- **`OutboundMessage`** — the only shape renderers consume: `{ title, body,
  severity, actions[], attachments[], replyRef?, origin{agentId, taskId} }`.
- **Severity drives routing, not content**: `action_required` (approvals, input
  requests, failures) is pushed immediately; `info` may be batched or digested.
- **Renderers** degrade by capability — an interactive card where supported (Feishu
  interactive, Slack Block Kit, Discord components, Telegram inline keyboard),
  Markdown where supported, plain text otherwise. **A platform without buttons shows
  the same content as text** — a notification is never lost because a feature is
  missing.
- **Approvals round-trip**: an action click carries a signed reference (mirroring
  the existing card-action `approval_id`); the inbound side resolves it to the
  pending approval, so the user never sees an internal id.

### 7.3 Notification routing — three levels, the last one always wins

A notification resolves its destination by walking up the chain, **first hit wins**:

1. **agent** — the producing agent's **own conversation**. An explicit
   `kind = 'notification'` binding wins; otherwise the agent's own channel is used.
   (The agent's channel *is* its notification target — routing and notification
   cannot disagree, because they read the same row.)
2. **instance** — a notification sink declared on the instance the agent works in.
   Either an explicit `kind = 'notification'` binding with a native id, **or** the
   instance's **notification-target agent** (`platform_instances.config.notifyAgentId`,
   set by the Settings UI): *the sink is that agent's own conversation*. Lets an
   operator say "everything on the sales bot notifies here" without per-agent rows;
   blank ⇒ nothing declared ⇒ fall through to `global` (the UI's "leave empty to use
   the org secretary"). `RepoNotifyTargetLookup.instanceTarget` is the one reader.
3. **global** — the **Secretary's own conversation**, else the platform's legacy
   notify channel (`notifyChatId`).

Level 3 always exists, so **a notification can never be orphaned**. This is the
mechanism that satisfies the requirement — "everything goes through the Secretary
channel by default, but I can point a specific agent elsewhere" — **without** ever
regressing into "the agent wasn't bound, so the notification vanished".

> **Why level 1 accepts a non-marker binding.** The migration seeds routing
> bindings with `kind = NULL` — at migration time there is no way to know *which*
> conversation should receive notifications, so no row can honestly claim the
> marker. Requiring `kind = 'notification'` would therefore leave levels 1 and 3
> dead on **every migrated install**, i.e. notifications *would* be isolated — the
> exact defect this design removes. Preference order instead makes an explicit
> choice made in Settings supreme while guaranteeing a terminus. Verified on live data:
> the real-data probe asserts the Secretary's real binding resolves level 3.

Every forwarded message carries `origin{agentId, taskId}` so that one busy
Secretary channel stays readable while aggregating the whole org.

Optional (later): per-severity targets (`action_required` → an urgent channel).

### 7.4 Implementation contract

The pieces, and the one job each has. Everything below is pure or a port, so the
whole outbound chain is unit-testable without a platform, a database or a timer.

```
packages/comms/src/gateway/
  outbound.ts     OutboundMessage — the only shape renderers consume, + signed action refs
  notify-route.ts resolveNotifyTarget() — the three-level walk (agent → instance → global)
  render.ts       renderOutbound() — capability-driven degradation
  dispatcher.ts   OutboundDispatcher — HITL/EventBus in, resolve → render → send out
  notify-lookup.ts RepoNotifyTargetLookup — the lookup port backed by channel_bindings
  router-sink.ts  RouterOutboundSink — the sink port backed by the adapter router
```

**`OutboundMessage`** is the single outbound shape. `severity ∈ {action_required,
info}` drives *routing and timing*, never content: `action_required` (approvals,
input requests, failures) is pushed immediately; `info` is delivered immediately
by default and may be **digested** (buffered and flushed as one summary) when the
deployment opts in. A digest never swallows an `action_required`: it is flushed
first, then the urgent message goes on its own.

**Three-level notify routing** (`resolveNotifyTarget(orgId, origin, lookup)`) walks
`agent → instance → global` and stops at the first hit, recording which level
matched. The lookup (`RepoNotifyTargetLookup`, backed by `channel_bindings`) supplies
each level; level 3 is the *Secretary channel*. A notification can never be orphaned
by "the agent was not bound". If even level 3 is missing the dispatcher logs loudly
and reports `delivered: false` — it never pretends success. **Honest gap:** a live
install whose Secretary has no addressable binding *and* no legacy `notifyChatId`
has no level-3 terminus; the dispatcher reports it as undeliverable rather than
swallowing the notification, and the Settings notification-target field is what
configures it.

**Action refs are signed.** With `actionSecret` set, an approval notification's
action refs are opaque signed tokens (`signActionRef`/`verifyActionRef`, base64url
payload + `sha256` HMAC, constant-time compare) — the internal approval id never
leaves in the clear. Without a secret the raw id is used, which is flagged as a
configuration gap on the wiring, not silently accepted as equivalent.

**Capability degradation** is a total function: `cards|buttons → 'card'`,
`markdown → 'markdown'`, otherwise `'text'`. The plain-text projection always
exists and always carries the action labels **and their refs** — a platform
without buttons renders the same content as text rather than dropping it.

**Approval round-trip.** An action carries `ref`, an HMAC-signed opaque token over
`{approvalId, actionId, taskId?}` (`signActionRef` / `verifyActionRef`). The
internal approval id never leaves the process: the outbound side signs it, the
inbound side verifies and resolves it back to the pending approval. Forging or
tampering with a ref fails verification (returns `undefined`) instead of resolving
to the wrong approval.

**Sink / lookup ports.** `OutboundSink` exposes `capabilities(target)` +
`send(target, rendered)`; `NotifyTargetLookup` exposes `agentTarget` /
`instanceTarget` / `globalTarget`. Production binds them to the router and to
`channel_bindings` respectively; tests bind them to fakes. No module here imports
`org-manager` or `core` — the dispatcher consumes HITL notifications and EventBus
events through **structural** interfaces (`{ onNotification }`, `{ on }`).

## 8. Capability model

Each manifest declares what its platform can do; the core only ever reads this
table. Proposed shape:

```ts
capabilities: {
  inbound:  'socket' | 'webhook' | 'polling'
  outbound: Array<'text'|'markdown'|'rich'|'buttons'|'cards'|'media'
                  |'reaction'|'edit'|'delete'|'thread'|'replyRef'|'ephemeral'>
  group: boolean
  notify: boolean
  interactiveCallback: boolean
  ackDeadlineMs?: number          // e.g. 3000 on Discord / Feishu cards
}
```

### 8.1 As implemented

The proposal above **re-types** `inbound` / `outbound` (boolean → union / array).
That is a wire-shape change: the Settings UI (`PlatformCard`) reads
`caps.inbound` / `caps.outbound` as booleans and the Settings API already ships
them that way, so a rename would silently blank those chips and break every
existing consumer for zero functional gain. The implemented model is therefore
**additive**: the v1 booleans stay exactly as they were, and the gateway-era
facts (the *how*, not just the *whether*) are added as optional fields.

```ts
type InboundMode = 'webhook' | 'socket' | 'polling' | 'gateway';

interface PlatformCapabilities {
  // v1 — unchanged; the UI and Settings API read these.
  inbound: boolean;
  outbound: boolean;
  threads: boolean;
  cards?: boolean;

  // The transport facts, read by core; no consumer branches on a platform id.
  inboundModes?: InboundMode[];   // how inbound can arrive; undefined ⇒ unknown
  defaultInboundMode?: InboundMode; // the mode used when config expresses no choice
  requiresPublicUrl?: boolean;    // true iff every declared mode needs a public URL
  ackDeadlineMs?: number;         // platform ack window for one inbound event (ms)
  extra?: Record<string, string | number | boolean | string[]>;
}
```

Three rules keep this a *table* and not a branch:

1. **`inboundModes` is the single declaration of transport.** Nothing outside a
   manifest may write `if (platform === 'slack')` to decide socket-vs-webhook.
   `activeInboundMode(capabilities, config)` is the one pure function that reads the
   config + the table and names the live mode. **It is consumed at runtime**: the
   Feishu and Slack adapters call it in `connect()` instead of reading
   `config.wsMode` / `config.socketMode` directly, and the platform's default
   transport is declared in the table (`defaultInboundMode`), not in the adapter.
   Precedence: explicit `socketMode/wsMode: true` → socket; explicit
   `socketMode/wsMode: false` → webhook; `pollingEnabled: true` → polling;
   then `defaultInboundMode`; then `gateway`; then `webhook`.
2. **`requiresPublicUrl` answers the question users actually ask** ("do I need a
   public URL?"). It is declared, not inferred at each call site. Slack declares
   `false` because Socket Mode is available; Telegram `false` because of long
   polling; Discord `false` (gateway); Feishu `false` (WebSocket mode); WhatsApp
   `true` (webhook only).
3. **`extra` is where a platform's unique abilities live** — Slack Block
   Kit / modals / shortcuts, Discord slash commands / forum channels, Feishu
   scan-to-create app, WhatsApp templates. Core never inlines these; a client that
   wants to *show* them reads `extra` off the manifest.

Platform capabilities observed in research (full matrices in
`research/platform-*.md`):

| | Feishu | Telegram | Slack | Discord | WhatsApp |
|---|---|---|---|---|---|
| inbound | socket / webhook | polling / webhook | socket / events | gateway (ws) | webhook |
| rich out | cards, post | markdown | blocks | components, embeds | limited (template) |
| buttons | ✓ | inline kb | ✓ | ✓ | ✓ (interactive) |
| group | ✓ (needs @) | ✓ (needs @) | ✓ (needs invite) | ✓ (guild) | **limited** |
| thread | ✓ topic | ✓ forum | ✓ | ✓ | ✗ |
| notify | ✓ | ✓ | ✓ | ✓ | ✓ (24 h window) |

Unique capabilities worth exposing (not inlining): Feishu **scan-to-create app**,
message cards, topics, urgent; Telegram **forum topics**, inline queries; Slack
**Block Kit / modals / shortcuts**; Discord **slash commands, threads, forum
channels**; WhatsApp **approved templates + 24 h session window**.

## 9. UI

The Integrations page becomes an **instance list** rather than a platform list:

- Collapsed row = **icon + instance label + bound agent + status** (unchanged style).
- Expanded = guided setup (steps + scan where the platform supports it, e.g. Feishu)
  → credentials → **agent binding** (searchable picker, already built) →
  **group bindings** (multi-select from the bot's known chats) → **notification
  target**.
- **"Add bot"** creates a second instance of the same platform.
- Unknown platforms still render with zero UI code (manifest-driven) — the existing
  regression guard stays green.

### 9.1 Implementation contract

> §9 is the actual page. It was once a **platform list**, because a platform could
> physically hold one bot; it is now an **instance list**. The
> interesting decisions are about *not* growing a second form implementation.

**One form, N instances.** Nothing about a platform config changed — same manifest
fields, same secret masking, same required-field rule. So `InstanceCard` does not
re-implement them: `instanceAsPlatform(instance)` adapts the instance into the
`PlatformStatus` that the existing `PlatformCard` already renders, and the card is
reused with `hideHeader`. The adapter is the *single* place the two shapes meet;
`PlatformCard` never learns what an instance is.

**One fact, one writer.** Four facts, four writers, no overlap:

| Fact | Writer | Notes |
|---|---|---|
| credential fields + `agentId` | the platform card's Save | adapted to the instance endpoint |
| `notifyAgentId` | the routing Save | instance config, not a binding |
| per-chat bindings (`channel_bindings`) | the routing Save | `PUT …/channels` |
| instance existence (`id`, `label`) | "Add bot" | `POST …/instances` |

Because the API validates a save **as a whole** (a required field missing from the
body is a 400), a routing-only save replays the instance's *stored* values
alongside `notifyAgentId` (`buildRoutingPayload`). Stored **secrets are never
replayed** — their absence is what the server reads as "unchanged", so a routing
save cannot blank a stored credential.

**The bound agent is one fact.** It lives on the instance row, but the form reads
it through the manifest's agent field (`AGENT_BINDING_FIELD.key === 'agentId'`).
`instanceAsPlatform` feeds the column into that field, so the picker can never show
"unbound" for a bot that is demonstrably bound — the failure mode that would make
two storage locations for one fact visible to a user.

**Unknown platform = zero UI code.** `InstancesSection` derives its groups from the
manifest **catalog** unioned with the platforms that already have bots
(`visiblePlatformIds`) — so a platform the registry dropped keeps its bots visible
and deletable instead of vanishing. Nothing in the front-end names a platform; the
guard renders `mattermost` (absent from the front-end entirely) and asserts every
manifest-typed field appears.

**Retired.** `IntegrationsSection.tsx` (the platform list) is deleted, not left
alongside: two UIs writing the same settings would be the same
"one fact, two writers" defect this programme exists to remove. Its zero-UI-code
guard moved to `test/instancesSection.test.tsx`, where it is strictly stronger
(the unknown platform now has a *bot*).

**A half-assigned route is not a save.** Ticking a chat defaults it to the bot's own
agent (the common case). Ticking a chat on a bot with **no** default agent holds the
save and names the problem rather than silently writing a binding with no agent or
quietly dropping the chat the user just ticked.

### 9.2 The Settings surface (API + UI contract)

The endpoints are platform-parameterised, so one implementation serves every
platform, Feishu included:

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/settings/integrations` | Every platform as a manifest-shaped object. |
| `GET` | `/api/settings/integrations/:platform` | One platform, not wrapped; non-secret values are also flattened onto the top level so callers written against the legacy Feishu-only shape keep working. |
| `PUT` | `/api/settings/integrations/:platform` | Validate against the manifest's `required` fields, then write the row. |
| `POST` | `/api/settings/integrations/:platform/test` | Probes the **stored** credentials; an empty body is valid. |

The Feishu-specific extensions (`/register`, `/register/status`, `/chats`,
`/test-message`, notification rules) are kept verbatim for backward compatibility;
new platforms use the generic surface only.

**Response shape.** `{ id, label, docsUrl, capabilities, fields[], enabled,
connected, hasConfig, values{…}, secrets{ key: { hasValue } } }` — `values` carries
the non-secret fields, `secrets` carries presence only.

**Secret semantics.** `secret: true` fields are never returned in plaintext: on read
the key carries a mask plus `hasValue`; on write, `''` or the mask means *leave
unchanged*, so a form that round-trips the mask cannot overwrite the real secret.
The invariant is asserted across **every** `GET` under
`/api/settings/integrations*` with a canary secret value.

**UI.** One card per bot instance, and every field is rendered from
`manifest.fields` (text / number / boolean / select / secret), so adding a platform
adds no UI code. Platform-specific extras (Feishu's notification preferences and QR
flow, for instance) live in an **extras slot** the manifest names, and each field has
exactly one writer — the part of the card that owns it — so two save paths cannot
fight over the same value.

## 10. Module map

Where each responsibility lives. The code is the truth; this is the index.

| Path | Responsibility |
|---|---|
| `packages/comms/src/platforms/registry.ts` | `PLATFORM_MANIFESTS` — the platform data: fields, capabilities, `createAdapter()`. Type contract and "how to add a platform": `packages/comms/docs/platform-manifest.md`. |
| `packages/comms/src/platforms/instance.ts` | `BotInstance` — one configured bot of a platform. |
| `packages/comms/src/gateway/inbound.ts` | `resolveInboundTarget()` — the single inbound resolution point (§6.1), plus `MatchedScope`. |
| `packages/comms/src/gateway/conversation-key.ts` | `conversationKey()` / `MAIN_CONVERSATION_KEY` / `isInboundIgnored()` — session isolation (§6.2). |
| `packages/comms/src/gateway/ack.ts` | `createAck()` and the deadline-driven `createDeadlineAck()` (§6.4). |
| `packages/comms/src/gateway/outbound.ts` | `OutboundMessage` + signed action refs (`signActionRef` / `verifyActionRef`). |
| `packages/comms/src/gateway/render.ts`, `src/render/markdown.ts` | Capability-driven rendering; per-platform markdown dialects. |
| `packages/comms/src/gateway/dispatcher.ts` | `OutboundDispatcher` + the `OutboundSink` / `NotificationSource` ports (§7.2). |
| `packages/comms/src/gateway/notify-route.ts` | `resolveNotifyTarget()` — the three-level walk (§7.3). |
| `packages/comms/src/gateway/notify-lookup.ts`, `repo-binding-lookup.ts` | The lookup ports over `channel_bindings` / instance rows, and the bindings loader. |
| `packages/comms/src/gateway/router-sink.ts` | `RouterOutboundSink` — the sink port backed by the adapter router. |
| `packages/comms/src/gateway/connection-test.ts` | The Settings "test connection" probe. |
| `packages/comms/src/net/http.ts` | `httpFetch` + failure classification, injectable for tests. |
| `packages/comms/src/slack/socket.ts` | Slack Socket Mode transport (no public URL needed). |
| `packages/storage/src/*` | `platform_instances` / `channel_bindings` repositories and their migration (§5). |
| `packages/org-manager/src/api-server.ts` | The Settings API and `resolvePlatformConfig()` (§5.4, §9.2). |
| `packages/cli/src/commands/start.ts` | Assembly: walk manifests × instances, register, connect (§4.3). |
| `packages/web-ui/src/components/integrations/*` | The instance cards, rendered from `manifest.fields` (§9). |

## 11. Known limitations & residual risk

What this work does **not** claim.

**Cannot be verified on this machine** (no credentials, no public URL):

- Real-service connectivity for Slack (`xapp-…`), Telegram and Discord. The Slack
evidence is a real-WebSocket loopback with a local server playing Slack; Discord
gateway sessions and Telegram long polling against live services are unproven.
- Every webhook path (Slack / WhatsApp / Discord) needs a public URL, which a
desktop install does not have.
- `connected` has a real source only for Feishu.

**Deliberately not delivered:**

- Feishu approval buttons render as text (`[label] ref`) because the Feishu manifest
declares `cards: false`. The action port, signature verification and
`respondToApproval` wiring exist and are tested; making the buttons clickable is a
manifest/capability change.
- Slack `slash_commands` / `interactive` envelopes are ACKed and logged, not
projected into agent turns.
- The legacy notifier's **rich agent-response card streaming** has no equivalent in
the gateway — the request/reply path returns text (§6.5).
- `getOrCreateMainSession` / `MAIN_CONVERSATION_KEY` and the DB main session (`cs_*`)
remain two facts.

**Production should set `MARKUS_ACTION_SECRET`.** Unset, approval action refs are
bare ids (the previous behaviour) and the dispatcher logs a warning. Independently, an
install whose Secretary has no addressable binding has no level-3 terminus: the
dispatcher reports it as undeliverable rather than swallowing it (§7.4), and the
Settings notification-target field is what configures it.

**Operational trap found, not fixed here (pre-existing):** `initSqliteStorage`
swallows *all* errors and returns `null`, so a repository-wiring programming error
degrades silently to memory-only mode instead of failing loudly.

