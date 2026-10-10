# Settings — Integrations UI (platform-manifest driven)

> Slice **S4** of the platform-manifest programme (issue #340, requirement
> `req_5e52c6c9ecf339b5724e9ae2`). S1 shipped the manifest registry, S3 made the
> **Settings API** consume it; this slice makes the **Settings UI** consume it.

## Why

Before this slice, the `integrations` tab rendered one 798-line, hand-written
component — `FeishuIntegrationSection.tsx`. Every input, label, badge and button
was written for exactly one platform. Adding a platform therefore meant writing
another 800-line component, and the only way to get that wrong was silently:
the platform was reachable in the API but invisible in the UI.

The API is already generic (`GET /api/settings/integrations` returns every
manifest plus its status — see
`packages/org-manager/docs/settings-integrations-api.md`). This slice makes the
UI generic in the same way: a platform's configuration form is **derived from
its manifest**, so a new platform needs **zero UI code**.

The acceptance test for that claim is literal: render the section with a fake
manifest that has never been seen by the front-end, and assert its card and its
fields appear.

## Architecture

```
Settings.tsx  (integrations tab)
  └─ <IntegrationsSection />            ← fetches GET /api/settings/integrations
       └─ <PlatformCard status client extras … />   ← one per platform, 100% manifest-driven
            ├─ fields[]  → text | password | number | boolean | select (single & multiple)
            └─ extras[status.id]?.render(ctx)   ← optional, front-end registry keyed by platform id
```

Three layers, three responsibilities:

| Layer | Knows about | Never knows about |
| --- | --- | --- |
| `PlatformCard` | the manifest shape (`fields`, `required`, `secret`, `help`, …) | any platform name |
| `platformExtras` registry | which platform id wants a richer panel | the generic form |
| `IntegrationsSection` | the endpoint + the card | field semantics |

### The extras slot — where a platform's extra capabilities live

The manifest is **data** (it lives in `packages/comms`, has no React dependency,
and is serialised over HTTP), so it cannot carry a React render function. The
extras slot therefore lives on the **front-end**, in
`platformExtras.tsx`, keyed by platform id:

```ts
export interface PlatformExtras {
  /** Manifest field keys this panel renders itself (rich widget), so the
   *  generic form omits them — keeps exactly one writer per field. */
  ownedFields?: string[];
  render: (ctx: PlatformExtrasContext) => React.ReactNode;
}
```

`FeishuIntegrationSection`'s genuinely-Feishu capabilities move here as one
entry in `PLATFORM_EXTRAS`:

```ts
{ feishu: {
    ownedFields: ['notifyChatId', 'notifyOnApproval', 'notifyOnNotification', 'notifyPriority'],
    render: (ctx) => <FeishuExtras ctx={ctx} />,
} }
```

covering QR-code app registration, the bot chat picker, the "send test
message" action and the notification-forwarding preferences (chat + toggles +
priority chips rendered as one panel).

A platform with no entry gets the generic card and nothing else — that is the
whole point: extras are **opt-in**, not a per-platform obligation.

### One writer per field

`PlatformCard` owns the draft state and the single Save. A rich widget in the
extras panel does not save on its own; it calls `ctx.setValue(key, value)` and
the same Save persists it. So there is exactly one place that writes a platform's
config from this tab, which is what stops the "two widgets round-tripping and
overwriting each other" class of bug.

## Field rendering

| `type` | widget | notes |
| --- | --- | --- |
| `text` | `<input type="text">` | `placeholder`, `help` |
| `password` | `<input type="password">` | eye toggle; `secret: true` shows `hasValue` placeholder |
| `number` | `<input type="number">` | |
| `boolean` | toggle switch | |
| `select` | `<select>` | `options` |
| `select` + `multiple: true` | toggle chips | value is `string[]` (e.g. notification priorities) |

`required` fields are marked with `*`; the Save button blocks and names the
missing field(s) client-side, and the API is the authority server-side (400
naming the field).

### Secret semantics (inherited from S3)

A `secret: true` field is never echoed by the API. The UI therefore renders an
**empty** input whose placeholder says whether a value is already stored
(`secrets[key].hasValue`). Leaving it untouched means "keep the stored value":
the client omits it from the save payload. Typing a value replaces it.

## Capability note — Feishu notification preferences

Moving Feishu into the generic card surfaced one real gap. The pre-S3 UI stored
`notifyOnApproval` / `notifyOnNotification` / `notifyPriority` through the same
`POST /api/settings/integrations/feishu` and read them back from the same GET.
S3's generic POST persists **manifest fields only**, and those three keys were
not in the manifest — so a save would have silently dropped them (the running
runtime's `syncPlatformRuntime` still reads them from the stored config).

To keep the capability, they are recorded in the Feishu manifest as fields
(they already exist as config surface — that is exactly what the manifest is
for). This is **additive data**, not an API-contract change: no new endpoint,
no new path, no changed response shape. `select` gained an optional
`multiple: true` so `notifyPriority` can stay a set, as it was.

## Out of scope

- The endpoints themselves (S3) and the manifest registry internals (S1); this
  slice consumes them.
- Runtime wiring of the new adapters (S5) and the remaining Feishu runtime
  migrations (S6).
- `connected` has a real source only for Feishu today; the badge shows
  `Disconnected` for the others until S5 wires their adapters.

## Verification

All commands run in the S4 worktree (`tsk_778a8fa2686319611059b376`).

| Check | Command | Result |
| --- | --- | --- |
| New UI tests | `vitest run --project web-ui packages/web-ui/test/integrationsSection.test.tsx` | **17/17 pass** |
| Full web-ui suite | `vitest run --project web-ui` | **821 pass / 52 files** |
| Store + registry tests | `vitest run --project node packages/org-manager packages/comms` | **1415 pass / 71 files** |
| Types (all projects) | `npx tsc -b` | clean |
| Types (web-ui) | `tsc --noEmit -p packages/web-ui` | **0 errors** |
| Production build | `pnpm --filter @markus/web-ui build` | **built** |
| Lint | `eslint` on changed sources | **0 errors** (warnings pre-existing in `Settings.tsx`) |

### The "zero UI code" claim is load-bearing, not a slogan

`integrationsSection.test.tsx` renders `<IntegrationsSection>` with a
`mattermost` manifest that exists nowhere in the front-end and asserts its card
and every one of its fields (text / password / number / boolean / multi-select
chips) appear.

This was **mutation-checked**: adding `platforms.filter(p => p.id === 'feishu')`
to `IntegrationsSection` — i.e. exactly the per-platform branch this slice is
meant to remove — turned those two tests red, and reverting it turned them green
again.

## Known limitations (carried from S3)

- `POST …/:platform/test` with an empty body probes with the **stored**
  credentials (deliberate S3 change, kept here so "Test" works on a saved
  config).
- `connected` is only real for Feishu until S5.
- The Feishu QR `register` endpoint and `FeishuNotifier` bootstrap still read
  `markus.json` on the server (S6).
- The deleted `FeishuIntegrationSection.tsx` and its four dead API wrappers
  (`getFeishuIntegration` / `saveFeishuIntegration` / `testFeishuConnection` /
  `deleteFeishuIntegration`) had no other callers; the Feishu *extension*
  endpoints they called remain served by S3.

