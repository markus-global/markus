# S6 — Channel→agent binding (one source) and credentials (one writer)

> Slice **S6** of the platform-manifest programme (issue #340, requirement
> `req_5e52c6c9ecf339b5724e9ae2`). S1 shipped the manifest registry, S2 made
> startup walk it, S3 generalised the Settings API. This slice fixes the two
> structural defects the issue never recorded — the ones that come back under a
> different name if you only patch the symptom.

## Defect A — the route bindings are dead code

`MessageRouter.bindAgentToChannel()` had **zero callers** repo-wide
(`grep -rn bindAgentToChannel` hit only the definition and a `.d.ts`), so
`agentChannelMap` was permanently empty and the "multi-platform binding"
capability did not actually exist.

### What we measured first (not assumed)

There are **two independent inbound paths** for Feishu, and only one of them is
live today:

| Path | Entry | Target | State today |
| --- | --- | --- | --- |
| A. `MessageRouter` | `FeishuAdapter` → `processMessageEvent` (`packages/comms/src/feishu/adapter.ts:416`, `agentId: ''`) → `routeIncomingMessage` | `agentChannelMap` lookup → empty → **dropped** | dead unless a webhook is configured |
| B. `FeishuNotifier` | its own Lark WS client → `feishu:message_received` → `ApiServer.handleFeishuUserMessage` | **hard-coded org Secretary** | live for QR-registered apps (`connectionMode: 'long_connection'`) |

So a Feishu pure-text inbound is *not* delivered by path A (it is silently
dropped at `log.debug`, which is why nobody noticed), while path B works but
**ignores platform configuration entirely** — the agent is a constant in code.
Wiring `bindAgentToChannel` alone would therefore have no observable effect on
the live path. The root cause is not "the map is empty"; it is **"the channel→agent
decision has no single source — one path looks it up in a map nothing fills, the
other does not look it up at all."**

### Design

One binding source, consulted by every inbound path.

1. **The binding is platform config, declared by the manifest.** A shared field
   `agentId` (optional, `type: 'text'`) is added to each manifest that supports
   inbound routing. It lives in the platform's `integrations` row `config`
   (same single-writer store S3 built), so the Settings UI renders it for free
   and no platform is special-cased.
2. **`MessageRouter` resolves in one place** —
   `message.agentId || channelBinding || platformBinding`. Two binding writers:
   `bindAgentToChannel()` (explicit per-channel) and the new
   `bindPlatformAgent()` (platform default). `message.agentId` still wins, so
   Web UI (which sets it explicitly) is unchanged.
3. **Unbound inbound is loud, not silent.** `routeIncomingMessage` logs at
   `warn` with the platform, channel and an actionable hint (which config field /
   method to set) instead of `debug "... skipping message"`.
4. **Startup wires it at the same point as S2's manifest traversal.** After
   `connectConfiguredPlatforms()` the CLI loads persisted bindings
   (`loadPlatformBindings(repo, orgId)`) and applies them
   (`applyPlatformBindings(router, …)`). No platform name appears in the loader.
5. **The live Feishu path honours the same binding.**
   `handleFeishuUserMessage` resolves its target through the store
   (`resolvePlatformConfig().agentId`), falling back to the org Secretary when
   nothing is bound — so the constant in code becomes configuration, and
   existing behaviour is preserved when no agent is bound.

## Defect B — credentials were written twice and echoed in the clear

Feishu `appId`/`appSecret` were written to `markus.json` by the QR `register`
extension (`api-server.ts`), while runtime preferences went to the SQLite
`integrations` row, and the notifier bootstrap read `markus.json` directly with a
hard-coded `orgId: 'default'`. S3 removed the *generic* GET leak and made the row
the single writer for the generic POST; S6 finishes the job.

### Design

- **One writer.** Credentials are stored in the `integrations` row `config`
  (S3's `savePlatform`). The QR `register` extension now merges `appId` /
  `appSecret` into that row instead of calling `saveConfig(...feishu...)`.
  `markus.json` is demoted to a **read-only bootstrap default**.
- **One reader.** `tryInitFeishuNotifier` resolves credentials through
  `resolvePlatformConfig(orgId, 'feishu')` (DB → bootstrap), not `markus.json`
  directly, and takes the org id from storage instead of the literal `'default'`.
- **No GET returns a secret.** The invariant is asserted across the whole
  surface, not just the generic endpoint: for every `GET` under
  `/api/settings/integrations*` the response body must not contain a configured
  secret's plaintext (asserted with a canary secret value).

## Non-goals

- Per-channel (per-chat) bindings for every platform — the platform default is
  the v1 capability; the router already supports the explicit channel binding for
  a later UI.
- Enabling Telegram / Slack / WhatsApp / Discord (S5) — they inherit the binding
  field and the generic store automatically.
- Changing the empty-body `POST …/test` semantics introduced in S3.

## Verification

See the task note. Summary: new router tests (bound / unbound / platform
binding), a binding-loader test, updated Feishu register + notifier-bootstrap
tests, and a no-plaintext-secret assertion over every integrations `GET`.

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | clean |
| Lint | `pnpm lint` | 0 errors (pre-existing warnings only) |
| comms + org-manager | `vitest run --project node packages/comms packages/org-manager` | **1419 passed / 71 files** |
| cli | `vitest run --project node packages/cli` | 271 passed; 1 environmental failure (below) |

New / updated tests:

- **Router (comms)** — platform binding routes a text inbound to the bound agent;
  explicit channel binding beats the platform default; `message.agentId` beats
  every router binding; an unbound inbound logs at `warn` (logger mocked, the
  warning + hint asserted — the contract is "loud, not silent").
- **Binding loader (org-manager)** — reads the manifest `agentId` from the row;
  ignores blanks; honours a legacy `markus.json` bootstrap only when the database
  has none; the database wins over the bootstrap.
- **Settings API (org-manager)** — `agentId` round-trips through the generic
  endpoint; re-submitting the masked placeholder does not clear the stored secret.
- **Feishu extension (org-manager)** — QR `register` no longer calls
  `saveConfig(...feishu...)` (single-writer assertion); `handleFeishuUserMessage`
  routes to the platform-bound agent instead of the hard-coded Secretary.
- **CLI** — `applyPersistedPlatformBindings` applies the persisted binding,
  applies a legacy bootstrap binding, and is a quiet no-op when nothing is bound.

### Known environmental failure (not caused by this slice)

`packages/cli/test/commands-start-integration.test.ts › auto-runs quickInit when
config is missing` binds the default Web UI port **8056**, already held on this
machine by the running Markus desktop app (`lsof -iTCP:8056 -sTCP:LISTEN` →
`Markus`). It fails with `EADDRINUSE` regardless of this change; every other cli
test passes.

### Behaviour change worth calling out

Reading the notifier bootstrap from the database (defect B) means the notifier
now obtains credentials in tests where it previously stayed inert — surfaced as 3
failures in `api-server-extended.test.ts`. Root cause: that file's
`FeishuApiClient` mock implemented only `sendCardToUser`. The fixture was
completed with the notifier's real call surface (inert `vi.fn`s); no production
code was weakened to accommodate it.
