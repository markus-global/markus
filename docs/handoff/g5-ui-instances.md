# G5 — Bot-instance UI: handoff & verification

**Slice:** G5 of the messaging-gateway programme (requirement `req_f2610b70e3196b1201d4bf1b`).
**Task:** `tsk_31bca5a6af53617a016aba45`.
**Depends on:** G2 (`tsk_95073651ac23d369f89b419a`), G3 (`tsk_bae3a9f097fde69834eb1190`).
**Repo:** `~/mycode/markus`, branch `task/tsk_31bca5a6af53617a016aba45`.

## 1. What the slice does

The Settings → Integrations page was a **platform list**, because the database
could physically hold one bot per platform (`integrations` PK `(org_id, platform)`).
G5 turns it into an **instance list**: every bot is its own card, a platform can
host several, and each bot carries its own credentials, its own agent and its own
chat routing.

Acceptance criteria from the task, and where each is met:

| # | Acceptance | Where |
|---|---|---|
| 1 | Collapsed row = icon + instance label + bound agent + status | `InstanceCard` header |
| 2 | Expanded = credentials → agent binding → group bindings → notify target | `InstanceCard` body (`PlatformCard hideHeader` + routing block) |
| 3 | "Add bot" creates a second instance of the same platform | `InstancesSection` add-bot row |
| 4 | Create a 2nd bot of one platform **and** bind a group, from the UI | tested (`creates a second bot from the UI`, `binds a known chat…`) |
| 5 | Notification target settable | routing block → `notifyAgentId` |
| 6 | Unknown platform still zero UI code, guard green | `test/instancesSection.test.tsx` + `test/integrationsSection.test.tsx` |
| 7 | Component/regression tests, failing-first | teeth check in §4 |

## 2. Files

**New**

| File | Role |
|---|---|
| `packages/web-ui/src/lib/instanceIntegrations.ts` | instance DTOs + pure logic + the `instance → PlatformStatus` adapter |
| `packages/web-ui/src/components/integrations/InstanceCard.tsx` | one bot: header, credentials (reused form), routing |
| `packages/web-ui/src/components/integrations/InstancesSection.tsx` | the page: groups per platform + "Add bot" |
| `packages/org-manager/src/instance-integrations.ts` | server store/routes for instances, channels, notify target |
| `packages/web-ui/test/instancesSection.test.tsx` | 19 tests (pure logic + section + routing) |

**Changed**

| File | Change |
|---|---|
| `packages/web-ui/src/components/integrations/PlatformCard.tsx` | `hideHeader` prop; export `StatusBadge` / `Msg` — the reuse seam |
| `packages/web-ui/src/api.ts` | 7 instance endpoints |
| `packages/web-ui/src/pages/Settings.tsx` | `<IntegrationsSection>` → `<InstancesSection>` |
| `packages/comms/src/platforms/registry.ts` | optional `listChannels()` manifest capability + `PlatformChannel` DTO; implemented for Feishu |
| `packages/org-manager/src/api-server.ts` | wiring for the instance routes |
| `packages/comms/test/router-instances.test.ts` | merge artifact: handler receives the **resolved target** (G3 contract) |
| `docs/design/messaging-gateway.md` | §9.1 implementation contract |

**Deleted**

| File | Why |
|---|---|
| `packages/web-ui/src/components/integrations/IntegrationsSection.tsx` | superseded by `InstancesSection`; keeping both would be two UIs writing one set of settings. Its zero-UI-code guard moved to `instancesSection.test.tsx`, where it is stronger |

## 3. Design decisions (and why)

**Reuse the platform form instead of writing a second one.** An instance *is* a
platform config — same manifest fields, same masking, same required rule. So
`instanceAsPlatform()` adapts the instance into the `PlatformStatus` the existing
`PlatformCard` renders, and the card is reused with `hideHeader`. One
implementation of "how a platform config behaves", N instances. `PlatformCard`
stays alive and stays tested; the new code is purely additive to it (default
behaviour is byte-identical: `hideHeader` defaults to `false`).

**The bound agent is one fact.** It lives on the instance row, but the form reads
it through the manifest's agent field (`AGENT_BINDING_FIELD.key === 'agentId'`).
`instanceAsPlatform` feeds the column into that field. Without this the picker
would render blank for a bot that is demonstrably bound — i.e. two storage
locations for one fact, visible to the user.

**A routing save must not blank a credential.** The API validates a save as a
whole, so a routing-only save replays the instance's *stored* values plus
`notifyAgentId`. Stored secrets are deliberately **not** replayed — their absence
is what the server reads as "unchanged".

**A half-assigned route is not a save.** Ticking a chat defaults it to the bot's
own agent. If the bot has no default agent, the save is held and the problem named
— rather than writing a binding with no agent, or silently dropping the chat the
user just ticked.

**A chat the platform no longer advertises keeps its binding visible** rather than
vanishing (`orphanBindings`). Hiding it would be silent data loss.

**Capability, not a special case.** `listChannels()` is an **optional manifest
capability**; Feishu implements it, everything else omits it and the UI says
"this platform cannot list its chats" instead of rendering an empty picker.
Missing credentials **throw** — "cannot list" must not be indistinguishable from
"no channels exist" (the same rule as G3's never-silently-drop).

**A platform dropped from the registry keeps its bots visible and deletable**
(`visiblePlatformIds` = catalog ∪ platforms-with-instances).

## 4. Verification

**Teeth check (failing-first evidence).** After the suite went green, the
"half-assigned route is not a save" guard was disabled and the suite re-run:

```
× blocks the routing save — and names why — when a selected chat has no agent
Tests  1 failed | 18 skipped
```

then restored and re-run green. The test bites the behaviour, not the code path.

**Results**

| Suite | Result |
|---|---|
| `vitest --project web-ui` | **53 files, 846 tests passed** |
| `vitest --project node` | **385 files / 5501 passed, 10 skipped, 1 failed** |
| `tsc -b` (whole repo) | 0 errors |

The single node failure is the known **environment flake**, not this payload:
`packages/cli/test/commands-start-integration.test.ts > auto-runs quickInit` needs
to bind port 8056, which the running desktop app holds:

```
$ lsof -nP -iTCP:8056 -sTCP:LISTEN
Markus  10648 liuqian  82u  IPv4 ... TCP *:8056 (LISTEN)
```

That file is untouched by this slice; G1/G2/G3 recorded the same failure.

**Merge artifacts found and fixed.** The worktree was built by merging G2 and G3.
One test broke that was **not** pre-existing — it was a genuine artifact of
combining the two: G2 wrote `router-instances.test.ts` against the pre-G3 handler
signature (`setAgentHandler((agentId) => …)`), while G3 changed the handler to
receive the resolved target. Fixed by passing `target.agentId` (the G3 contract).
Everything else in `packages/comms` is unchanged by G5.

## 5. Residual / known gaps (honest)

1. **No real-data probe for G5.** G1–G3 shipped `.mjs` probes against a copy of the
   live DB. The UI has no comparable script: the component tests are the evidence,
   and the first human click-through is the real test. Flagged rather than
   simulated.
2. **`notifyAgentId`: was stored but not consumed — now wired (G8).** As delivered by
   G5 the key was persisted yet inert: G4's `RepoNotifyTargetLookup` read only
   `channel_bindings`, so this handoff's original claim that "G4 reads it" was
   **wrong** and has been corrected here. G8 added the missing reader —
   `instanceTarget` now resolves `platform_instances.config.notifyAgentId` to that
   agent's own conversation (level 2). See `docs/handoff/g8-closure.md`.
3. **`data-testid`s inside a reused `PlatformCard` are not instance-scoped**
   (`integration-field-appId`, `integration-save`). Two instances of the same
   platform open at once produce duplicate ids in the DOM. Existing tests use
   `within(card)`, and the new tests do too — so this is a test-scoping wart, not a
   behaviour bug — but a future Playwright pass should scope by `instance-card-<id>`.
4. **Group bindings save with an explicit button**, not on change. Deliberate (one
   writer, no surprise writes), but it is an extra click compared with the toggle
   switches above it.
5. **Live Feishu chat listing is untested end-to-end.** `listChannels` is pinned
   with a mocked `fetch` (token + `/im/v1/chats` mapping, and the throw-without-
   credentials path); no real Feishu app was queried from this machine.
6. **The `platform` scope of §6 is still not a UI concept.** Consistent with G3's
   decision (level 4 = the platform's `label='default'` instance) — the UI binds
   instances and chats, never a platform row.

## 6. Rollback

Single commit on `task/tsk_31bca5a6af53617a016aba45`, base = merge of G2 `e96ded6d`
and G3 `55963d46`. `git revert <commit>` restores the platform list; the schema
(G1) and the runtime (G2/G3) are untouched by this slice, so reverting G5 loses no
data and no capability — only the UI for managing more than one bot.
