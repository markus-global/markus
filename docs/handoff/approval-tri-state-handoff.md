# Approval tri-state — handoff & verification

**Branch:** `feat/approval-tri-state-e2e` (worktree `/Users/liuqian/mycode/markus-approval-e2e`)
**Commits:** `a780c09f` (T1 · single execution point) → `e3ad9ad9` (T2/T3 · re-initiation + three-state UI)
**Base:** `8bc8d4e2` (main). Not pushed, `main` untouched.

## 1. What the gate semantics are

Every approval is resolved to one of three intents — `approve` / `request_changes` (打回) /
`reject` — by a **single parser** (`resolveApprovalIntent`, `hitl-service.ts`) from
`f(subType, selectedOption, approved)`. The boolean is only a legacy fallback for payloads
with no recognised option token. The intent is then applied by a **single execution point**
(`ApprovalApplier`, `approval-apply.ts`); no consumer transitions a target inline.

| Gate (`details.subType`) | Target | approve | 打回 (request_changes) | reject |
|---|---|---|---|---|
| `task` (建卡闸) | task `pending` | → `in_progress` | **stays `pending`** + reviewer comment | → `rejected` |
| `task_review` (验收闸) | task `review` | → `completed` | → `in_progress` (返工) | → `in_progress` (no terminal reject) |
| `requirement` / `requirement_resubmit` | requirement `pending` | → `in_progress` | **stays `pending`** + comment + creator notice | → `rejected` |

The 打回 loop has three segments and none is optional:
① the target stays `pending` (zero transition) → ② the reviewer's feedback lands as a comment
→ ③ the assignee revises and **re-initiates the approval**.

## 2. What this branch adds (on top of T1)

- **Re-initiation entry (the missing segment ③).** A 打回 consumes the approval entity, so
  the target has no live approval and drops out of `listApprovals('pending')` — an *orphan*
  whose only exit used to be the admin approve endpoint. Now:
  - `TaskService.requestTaskApproval(taskId, actorId?)` and
    `RequirementService.requestRequirementApproval(reqId, actorId?)` re-open the gate.
  - HTTP: `POST /api/tasks/:id/request-approval`, `POST /api/requirements/:id/request-approval`.
  - Agent tool: `task_request_approval`.
  - Guards are actionable errors, never silent no-ops: not-`pending`, already-active
    approval, missing target.
- **SSOT extraction.** `createTask` and `requestTaskApproval` share one implementation
  (`openCreationGateApproval`); `createRequirement` / `resubmitRequirement` /
  `requestRequirementApproval` share `openRequirementApprovalGate`. No second copy of the
  approval-发起逻辑 can drift.
- **Explicit three-state UI.** `NotificationBell.tsx` (both the mobile and desktop render
  blocks) now send the canonical token, label `approve` / `request_changes` / `reject`
  distinctly, and no longer fold 打回 into an approval or a rejection. `api.ts` gained the
  `resolveApprovalDirection` closure mirror plus `tasks/requirements.requestApproval`.
  `optionLabels` added for zh-CN / en / es.

## 3. Verification (run in the worktree)

| Check | Result |
|---|---|
| `pnpm --filter @markus/{core,org-manager} build`, `pnpm --filter markus build` (cli) | exit 0 |
| `tsc --noEmit -p packages/web-ui/tsconfig.json` | clean |
| `vitest run --project node` | **6028 pass**, 1 fail — pre-existing network flake `commands-start-integration > auto-runs quickInit` (times out at 60 s in isolation too; unrelated to approvals) |
| `vitest run --project web-ui` | **1006 pass** (after registering `task_request_approval` in `toolCategories.ts`) |
| `approval-resubmit-entry.test.ts` (new) | 7/7 |

The new test locks: the orphan precondition, gate re-opening, re-send-back stays `pending`,
re-approve proceeds through the same single execution point, and every guardrail rejection.

## 4. Residual / not done

- **Not merged.** Still on `feat/approval-tri-state-e2e`; the previous plan targeted
  `feat/ui-optimize-1015` (a merge, not a fast-forward — my branch is based on `8bc8d4e2`).
- **UI resubmit button** for a human reviewer is not wired into a specific screen; the
  re-initiation path today is the agent tool + the two HTTP endpoints. Suggested home: the
  pending-task detail view in `Work.tsx` (show it when `status === 'pending'` and no active
  approval exists).
- **CLI approval card** does not yet render a distinct `changes_requested` terminal state;
  the decision still applies correctly, only the tapped-card wording is generic.
- `ToolApprovalModal` (tool execution approval) stays binary by design — not a gate.
