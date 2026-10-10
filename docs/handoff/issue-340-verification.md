# Issue #340 — Platform-Manifest Programme: consolidation & manual verification

> Requirement `req_5e52c6c9ecf339b5724e9ae2` · issue `markus-global/markus#340`
> Consolidation branch `task/tsk_2aab2e8fef102acdb64e1b0e` (HEAD `00f9ad48`), base `main` merge-base `523a9c10`.
> **No PR was opened.** This branch is the single reviewable payload; the owner verifies manually and opens the PR.

---

## 1. Summary

Issue #340 reported that the Telegram / Slack / WhatsApp adapters were implemented, exported
and unit-tested, yet **no layer above the adapter knew they existed** — dead code. The owner
chose a *platform-manifest* design over the issue's "wire each one up in place" proposal: make
the set of platforms a single data-driven registry so the class of bug ("a platform exists but
no layer knows about it") cannot recur.

Six slices (S1–S6) were developed on separate branches. **This branch is their union** — the
consolidation the programme needs, because S4/S5/S6 were parallel siblings and no single slice
contains a working whole. See §3 for the commit map and §9 for what the merge had to reconcile.

**Result:** adding a new external platform is now a single-file change (`registry.ts`) —
runtime registration, Settings API and Settings UI all derive from it with **zero hand-written
UI code**. Four previously-dead platforms (Telegram, Slack, WhatsApp, Discord) are live.

## 2. What shipped (architecture in one pass)

The **platform manifest registry** (`packages/comms/src/platforms/registry.ts`) is the single
source of truth. For each platform it declares: id, label, docs URL, `fields[]` (key / label /
type / required / secret / help / default / options / multiple), `capabilities`
(inbound / outbound / threads / cards), `createAdapter(config)`, and an optional
`testConnection(config)`.

Every layer **derives** from the registry instead of hard-coding a platform list:

| Layer | File | What it derives |
| --- | --- | --- |
| Runtime registration | `packages/cli/src/commands/start.ts` | iterate manifests → build adapters → register on the router |
| Config resolution | `packages/org-manager/src/platform-integrations.ts` | read persisted store (DB wins) → validate against `fields` → resolve credentials |
| Settings API | `packages/org-manager/src/api-server.ts` | `GET/PUT /api/settings/integrations/:platform`, param validated against the registry |
| Settings UI | `packages/web-ui/src/components/integrations/*` | render a card per manifest, a form control per `field.type` |
| Channel→agent routing | `packages/comms/src/router.ts` | resolve binding from `message.agentId \|\| channel \|\| platform` |

Two structural defects the issue did **not** record were fixed at root (slice S6), because a
"wire it up" patch would have re-committed the same mistake:

- **(A) Channel→agent binding was dead.** `MessageRouter.bindAgentToChannel()` had zero callers
  anywhere, so the binding map was always empty and inbound messages were silently dropped at
  `log.debug`. The fix makes the binding *a platform config value* — one source, declared by a
  shared manifest field `agentId` — and the router resolves it in one place. Unbound messages
  now `warn` with an actionable hint instead of disappearing.
- **(B) Credentials had two writers and secrets round-tripped.** The QR `register` path wrote
  `markus.json` while the Settings API wrote the DB (two writers, one fact); and some
  integration responses echoed secret values. The fix converges on a single writer (the
  `integrations` row) and a single reader (`resolvePlatformConfig`), and **no**
  `/api/settings/integrations*` response ever returns a secret.

## 3. Commit / branch map

Merge-base with `origin/main`: `523a9c10`. Merges: `27fbb0df` (S2 duplicate → S6),
`00f9ad48` (S6 → S5) = **HEAD**.

| Slice | Task | Commit | Branch |
| --- | --- | --- | --- |
| S1 manifest registry (webui + feishu) | `tsk_627e6243ff744a800324dec5` | `9294dbdf` | (registry) |
| S2 startup iterates manifests | `tsk_8b4b44a92aace016de0c0cd2` | `7af5bbf3` / `e07e8638` | `task/tsk_8b4b44a9…` |
| S3 Settings API → `:platform` | `tsk_742f7b6f93e3cf9e2232ea43` | `e9f3e5fc` | `task/tsk_742f7b6f…` |
| S4 Settings UI (manifest-driven) | `tsk_778a8fa2686319611059b376` | `2b90c93f` | `task/tsk_778a8fa2…` |
| S5 Telegram/Slack/WhatsApp/Discord | `tsk_c83d36df8ba5597198844b0e` | `974d3746` | `task/tsk_c83d36df…` |
| S6 root-cause (A)+(B) | `tsk_ba2b0c3d12f69f37d7a1d8c4` | `355fb12f` | `task/tsk_ba2b0c3d…` |
| **Consolidation merge** | `tsk_2aab2e8fef102acdb64e1b0e` | `00f9ad48` | `task/tsk_2aab2e8fef102acdb64e1b0e` |

**PR payload** (`git diff --stat 523a9c10...HEAD`): **37 files, +5722 / −1052.**
