# Platform Manifests

A **platform manifest** is the single record that describes one external
communication platform: its id, its configurable fields, what it can do on the
wire, and how to build its adapter.

Everything above the adapter layer — runtime registration, the Settings API, the
Settings UI — is (or will be) driven by iterating `PLATFORM_MANIFESTS` instead
of branching on the platform name.

## Why this exists (issue #340)

The comms package already ships adapters for Telegram, Slack, WhatsApp and
Discord. They are implemented, exported from `src/index.ts`, and covered by unit
tests — yet **nothing ever instantiated them**. They were dead code.

The gap was never inside the adapters. It was in every layer above them:

| Layer | Before |
| --- | --- |
| Runtime registration | `start.ts` had a hand-written `if (feishuAppId && feishuAppSecret)` block plus a hard-coded `WebUIAdapter` |
| Config schema | the `integrations.feishu` shape lived only as an ad-hoc interface in `config.ts` |
| Settings API | endpoints were Feishu-specific (`/api/settings/integrations/feishu`) |
| Settings UI | `Settings.tsx` had a hand-built Feishu card |

Each of those layers hard-coded a single platform, so adding a real platform
meant editing five unrelated places — and forgetting one produced a silently
half-wired platform (exactly what happened to Telegram/Slack/WhatsApp).

Rather than patching each layer in place, we introduce one source of truth. A
new platform becomes a **single additive entry** in the registry; every
manifest-driven layer above it picks the platform up with no new branch.

### Increment scope

`S1` added this file and the registry as **pure data**: it registered only the
platform that was live at the time (`feishu`) and `createAdapter()` returned the
**existing** adapters, so importing it changed no runtime behaviour. The later increments then migrated each layer above the
adapter to consume the registry:

| Increment | What it moved onto the manifest |
| --- | --- |
| `S2` | CLI startup: connect every enabled platform by iterating the registry (no per-platform `if`). |
| `S3` | Settings API: `GET/PUT /api/settings/integrations/:platform`, parameterised by manifest. |
| `S4` | Settings UI: one card per platform, rendered entirely from `manifest.fields`. |
| `S5` | Revived platforms: Telegram / Slack / WhatsApp / Discord declared here — the adapters that were dead code in issue #340 are now reachable. |
| `S6` | Fixed the two structural defects the issue found on top (dead route bindings; credential double-write with plaintext secret round-tripping). |

## Type contract

```ts
type PlatformFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select';

interface PlatformFieldOption { value: string; label: string }

interface PlatformField {
  key: string;                 // stable config key, e.g. 'appSecret'
  label: string;               // human-readable label for the settings form
  type: PlatformFieldType;     // which input widget to render
  required: boolean;           // platform cannot be configured without it
  secret?: boolean;            // never round-trip to a client (implies password)
  placeholder?: string;
  help?: string;               // one-line guidance under the input
  options?: PlatformFieldOption[];  // choices for type: 'select'
  multiple?: boolean;          // 'select' taking a set → value is string[]
  default?: string | number | boolean | string[];  // settings-form starting value
}

interface PlatformCapabilities {
  // v1 flags — unchanged; the Settings UI and Settings API read these as booleans.
  inbound: boolean;    // can receive messages from the platform
  outbound: boolean;   // can send messages to the platform
  threads: boolean;    // supports replying inside a thread
  cards?: boolean;     // supports interactive card payloads

  // G7 additions — *how*, not just *whether*. All optional (unknown ⇒ assume webhook).
  inboundModes?: Array<'webhook' | 'socket' | 'polling' | 'gateway'>;
  requiresPublicUrl?: boolean;  // true iff every declared inbound mode needs a public URL
  ackDeadlineMs?: number;       // platform ack window for one inbound event, ms
  extra?: Record<string, string | number | boolean | string[]>;  // platform-unique
}

interface TestConnectionResult { ok: boolean; error?: string }

interface PlatformManifest {
  id: string;                  // stable platform id, unique across the registry
  label: string;               // human-readable platform name
  docsUrl?: string;            // upstream credential/setup docs
  fields: PlatformField[];
  capabilities: PlatformCapabilities;
  defaultEnabled?: boolean;    // on out of the box (absent ⇒ false)
  createAdapter(): CommAdapter;
  testConnection?(config: Record<string, unknown>): Promise<TestConnectionResult>;
}
```

### Rules that the tests pin

- **Ids are unique.** `assertUniqueManifestIds()` throws on a duplicate, and the
  registry validates itself at module load (`import` fails loudly instead of
  silently dropping a platform).
- **Fields are structurally complete and uniquely keyed** within a manifest.
- **`type: 'select'` fields carry `options`.**
- **`secret` implies `type: 'password'`** — so a value the API must never echo
  back is also rendered as a masked input by construction.
- **`createAdapter()` returns a fresh instance** whose `platform` equals the
  manifest `id`.

## How to add a platform

Everything below is the **entire** checklist. There is no `if (platform === …)`
anywhere above the adapter, and no hand-written UI code: the Settings card, the
config schema, the startup registration and the API routes are all derived from
the manifest.

**Step 1 — have a `CommAdapter`.** Implement (or reuse) a `CommAdapter` subclass;
see `src/adapter.ts` for the interface. The entries in
`src/telegram|slack|whatsapp|discord/adapter.ts` show the shape.

**Step 2 — declare the manifest.** Read the adapter's config type and enumerate
*every* value it reads, marking credentials `secret: true` and the values the
adapter cannot start without `required: true`. Append the manifest to
`PLATFORM_MANIFESTS` in `packages/comms/src/platforms/registry.ts`.

Walkthrough for the field flags, using the real Telegram manifest:

- `required` — the minimum for `createAdapter()` result to authenticate. Only
  `botToken` qualifies: `TelegramClient.getMe()` cannot run without it. Do **not**
  mark a field required just because it is common; an over-required field makes
  the platform un-enableable for a valid configuration.
- `secret: true` — anything that must never be echoed back. The Settings API
  drops these on read and shows a `hasValue` placeholder instead (S3 invariant).
- `default` — the *form starting value* only. It is not applied at startup (S2
  contract); the adapter owns its own runtime defaults.
- `help` — one actionable line; this is what the user reads in the Settings card.

```ts
const TELEGRAM_MANIFEST: PlatformManifest = {
  id: 'telegram',
  label: 'Telegram',
  docsUrl: 'https://core.telegram.org/bots/api',
  fields: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true, secret: true,
      help: 'Token from @BotFather. Verified with getMe when the adapter connects.' },
    AGENT_BINDING_FIELD,                 // { key: 'agentId', … } — see below
    { key: 'apiUrl', label: 'API URL', type: 'text', required: false },
    { key: 'pollingEnabled', label: 'Long polling', type: 'boolean', required: false, default: false },
    { key: 'webhookPort', label: 'Webhook port', type: 'number', required: false },
    { key: 'webhookSecret', label: 'Webhook secret', type: 'password', required: false, secret: true },
    { key: 'webhookPath', label: 'Webhook path', type: 'text', required: false, default: '/webhook/telegram' },
  ],
  capabilities: { inbound: true, outbound: true, threads: true, cards: false },
  createAdapter: () => new TelegramAdapter(),
  async testConnection(config) { /* optional — see Step 3 */ },
};
```

**Step 3 — the connection probe (optional, opt-in).** If the platform exposes a
cheap credential check (Telegram `getMe`, Slack `auth.test`, Discord
`GET /users/@me`), implement `testConnection` and return `{ ok: true }` /
`{ ok: false, error }`. If it does not (WhatsApp — Meta offers no safe
"who is this token" call), **omit it**; the Settings API then reports
`{ ok: false, error: 'test not supported' }` rather than faking success. The probe
must never throw — a network error is `{ ok: false, error: message }`.

**Step 4 — the agent binding.** Inbound routing needs to know which agent answers.
The shared `AGENT_BINDING_FIELD` (`key: 'agentId'`, exported from the package) is
defined once in `registry.ts` and included by every platform with
`capabilities.inbound` (`feishu`, `telegram`, `slack`, `whatsapp`, `discord`). Do
not invent a per-platform binding key.

**Step 5 — test it.** Add a case to
`packages/comms/test/platform-registry.test.ts` asserting the id appears in
`PLATFORM_MANIFESTS`, `createAdapter().platform` matches, and secrets are flagged.
`packages/cli/test/commands-start-new-platforms.test.ts` shows the end-to-end
shape (configure → registered → connected → inbound routed to the bound agent).

That is the whole list.

## Field reference

### Shared field: the agent binding

Every platform with `capabilities.inbound` includes the same `AGENT_BINDING_FIELD`:

| key | type | required | meaning |
| --- | --- | --- | --- |
| `agentId` | text | no | Agent that answers inbound messages. Blank ⇒ an explicit per-channel binding is required. |

It is defined once in `registry.ts` so the binding capability has one shape; a
per-platform binding key would be a second source of truth for the same fact.

### `feishu`

| key | type | required | secret | default |
| --- | --- | --- | --- | --- |
| `appId` | text | yes | | |
| `appSecret` | password | yes | ✅ | |
| `domain` | text | no | | `https://open.feishu.cn` |
| `wsMode` | boolean | no | | `false` |
| `webhookPort` | number | no | | `9000` |
| `encryptKey` | password | no | ✅ | |
| `verificationToken` | password | no | ✅ | |
| `notifyChatId` | text | no | | |
| `notifyOpenId` | text | no | | |
| `notifyOnApproval` | boolean | no | | `true` |
| `notifyOnNotification` | boolean | no | | `false` |
| `notifyPriority` | select (multiple) | no | | `["high", "urgent"]` |
| `agentId` | text | no | | |

Every field above mirrors a value that already exists in code — either read
directly by `FeishuAdapter` (`appId`, `appSecret`, `domain`, `wsMode`,
`webhookPort`, `encryptKey`), declared in `FeishuAdapterConfig` /
`FeishuConfigPayload` (`verificationToken`), stored under
`MarkusConfig.integrations.feishu` (`notifyChatId`, `notifyOpenId`), or — for the
`notifyOn*` preferences — served before the manifest programme by the
Feishu-specific `GET/PUT /api/settings/integrations/feishu/notifications`
endpoint (recording them here is what lets the manifest-driven Settings form
round-trip them). `agentId` is the one genuinely new key: the shared inbound
routing field described above. The manifest invents no new *platform* config
surface; it records the surface that already exists in one place.

### `telegram`

| key | type | required | secret | default |
| --- | --- | --- | --- | --- |
| `botToken` | password | yes | ✅ | |
| `agentId` | text | no | | |
| `apiUrl` | text | no | | `https://api.telegram.org` |
| `pollingEnabled` | boolean | no | | `false` |
| `webhookPort` | number | no | | |
| `webhookSecret` | password | no | ✅ | |
| `webhookPath` | text | no | | `/webhook/telegram` |

Probe: `getMe` (the same call `TelegramAdapter.connect()` makes).

### `slack`

| key | type | required | secret | default |
| --- | --- | --- | --- | --- |
| `botToken` | password | yes | ✅ | |
| `agentId` | text | no | | |
| `signingSecret` | password | no | ✅ | |
| `appToken` | password | no | ✅ | |
| `socketMode` | boolean | no | | `false` |
| `webhookPort` | number | no | | |
| `webhookPath` | text | no | | `/webhook/slack` |
| `apiUrl` | text | no | | `https://slack.com/api` |

Probe: `auth.test`. Only `botToken` is `required`: the adapter can send with just
it. Inbound is one of two paths, chosen by `socketMode`:

- `socketMode: true` → **Socket Mode** (G7). Needs `appToken` (an app-level token,
  `xapp-…`); opens a WebSocket to the URL returned by `apps.connections.open`, so
  **no public URL and no `webhookPort`**. The adapter acks each event envelope
  immediately (well inside Slack's 3 s window) and processes it out-of-band.
- `socketMode: false` → the webhook path: needs `signingSecret` + `webhookPort`.

`appToken` is deliberately **not** `required` — marking it required would block a
valid webhook-only configuration.

### `whatsapp`

| key | type | required | secret | default |
| --- | --- | --- | --- | --- |
| `phoneNumberId` | text | yes | | |
| `accessToken` | password | yes | ✅ | |
| `agentId` | text | no | | |
| `businessAccountId` | text | no | | |
| `apiVersion` | text | no | | `v18.0` |
| `baseUrl` | text | no | | `https://graph.facebook.com` |
| `webhookPort` | number | no | | |
| `webhookPath` | text | no | | `/webhook/whatsapp` |
| `webhookVerifyToken` | password | no | ✅ | |
| `appSecret` | password | no | ✅ | |

Probe: **none.** Meta exposes no safe "who is this token" call for an arbitrary
Cloud API token, so `testConnection` is intentionally omitted and the Settings
API returns `{ ok: false, error: 'test not supported' }` — honest, not a fake
success.

### `discord`

| key | type | required | secret | default |
| --- | --- | --- | --- | --- |
| `botToken` | password | yes | ✅ | |
| `agentId` | text | no | | |
| `apiUrl` | text | no | | `https://discord.com/api/v10` |
| `gatewayUrl` | text | no | | `wss://gateway.discord.gg` |

Probe: `GET /users/@me`.

`capabilities.threads` is `true` for all four because each adapter implements
`sendReply` (the router's threaded-reply path); `cards` is `false` for all four
because none exposes a structured card payload.

## Known limitations

Real gaps, recorded so the manifest is not mistaken for a claim of full support:

- **Slack Socket Mode and the Discord gateway are implemented (G7).** Slack
  Socket Mode (`socketMode: true` + `appToken`) and the Discord gateway (bot token
  over a WebSocket) both connect **without a public URL**; the webhook path is kept
  for Slack when `socketMode` is off. What cannot be exercised on a laptop is
  *real-credential* connectivity — there is no Slack app / Discord bot in CI — so
  the transport invariants (open → connect → envelope → ack → dispatch, exactly
  one ack per envelope, reconnect on `disconnect`) are pinned with an injected fake
  socket in `packages/comms/test/slack-socket.test.ts`, and a loopback probe
  (`packages/cli/scripts/verify-g7-real-data.mjs`) drives the **real** WebSocket
  protocol against a local server. Real Slack/Discord credentials are **not**
  verified here and are flagged as such in the handoff.
- **Webhook inbound needs a public URL; socket/gateway/polling do not.**
  `capabilities.requiresPublicUrl` (and `inboundModes`) declare this per platform:
  Slack / Feishu (`socket`), Telegram (`polling`), Discord (`gateway`) are `false`;
  WhatsApp (`webhook`) is `true`. The webhook-only paths still cannot be exercised
  end-to-end on a laptop — registration, connect and routing invariants are pinned
  with mocked `fetch` in `packages/cli/test/commands-start-new-platforms.test.ts`.
- **`connected` in the Settings status is real only for Feishu**
  (`ApiServer.platformConnected` → `FeishuNotifier.connected`); every other
  platform reports `false` until a later slice wires live status.
- **One binding per platform (v1).** `agentId` binds a whole platform to one
  agent. The router already supports an explicit per-channel binding
  (`bindAgentToChannel` / `bindPlatformAgent`), but there is no per-channel UI.
- **Startup config precedence.** `markus start` reads the persisted
  `integrations` rows (`readStoredPlatformConfig`) and overlays them on the
  file/env config — the database wins, and a row's `enabled: false` keeps a
  platform off. If storage is unavailable the CLI falls back to file/env-only
  config without blocking startup. Manifest `field.default` is never applied at
  startup (it is a settings-form default only).
- **Secrets never round-trip.** Every `GET /api/settings/integrations*` response
  omits secret values (masked placeholder + `hasValue`), asserted by a
  regression test.

## Relationship to issue #340

Issue #340 reported the adapters as unreachable dead code and proposed wiring
each one up in place. This manifest design is the alternative the owner chose:
rather than five per-platform patches, make the platform set data-driven so the
class of bug ("a platform exists but no layer knows about it") cannot recur.

### Consolidation

S1–S6 were developed as parallel slices on separate branches. This document, the
registry and the start path are the **union** of those slices (consolidation
merge on branch `task/tsk_2aab2e8fef102acdb64e1b0e`). The one place two slices
independently introduced the same concept — a shared `agentId` binding field —
was unified to a single exported `AGENT_BINDING_FIELD`; a second definition of
the same fact is exactly the class of bug this programme exists to remove.
