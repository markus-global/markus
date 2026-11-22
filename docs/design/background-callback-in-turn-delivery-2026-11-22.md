# Background completion → in-turn delivery (rework of PR #474)

Date: 2026-11-22 · Owner directive: first principles; remove `background_wait`;
the async result must land in the **originating session**; in-turn delta
injection MUST work.

## Invariant

A background command's result is a debt owed to `(originSession, originWorkUnit)`
— not a competing stimulus. Exactly two delivery cases, decided by whether the
origin turn is still running when the result is delivered:

1. **Origin turn active** → deliver the FULL result inside that turn, before its
   next LLM call, and consume the mailbox row so no continuation turn fires.
2. **Origin turn ended** → the `callback_result` row drives a lineage
   continuation (same session / scenario, coalesced) — the path PR #474 already
   fixed (durable lineage + coalescing). This stays.

## Why not a new tool

`shell_execute` is execute-and-wait but capped (300s) and serial; `background_exec`
exists for long / parallel jobs. The common "launch → need result" intent is
logically synchronous and must not be forced across an async boundary. The fix is
delivery into the origin session, not a pull tool. `background_wait` is removed.

## Why reuse the C8-B injection point (and its one limitation)

`injectTurnDelta` (agent.ts:821) is the single writer of `turnDeltaCursor` and the
safe point where same-work-unit queued rows are surfaced before the next LLM call
(4 sites: chat 6291 / stream 7072 / task 7839 / ris 8375). Reusing it keeps the
cursor single-writer and delivers at a safe point instead of an external append.

LIMITATION: `buildTurnDeltaSegment` is a ≤600-char, label-only teaser
(`payload.summary`, 120 chars). A command result is kilobytes of stdout/stderr in
`payload.content`. So background results are NOT rendered through the teaser;
they are appended as a full-content session message at the same injection point,
then consumed. The teaser keeps handling contradiction/authoritative/decision
facts unchanged.

## Changes

### core/src/agent.ts — `injectTurnDelta`
- Partition `mailbox.deltaSince(WU, cursor)` rows into:
  - background results: `sourceType==='callback_result'` &&
    `payload.extra.callbackType==='background_exec'`;
  - other facts: everything else.
- For each background result (seq order): append
  `{role:'user', content: payload.content}` to the session (tail append,
  cache-safe); consume it — `mailbox.complete(item.id)` +
  `markBackgroundResultConsumed(extra.callbackId)` +
  `pendingCallbackRegistry.resolve(extra.callbackId)`.
- Advance the cursor past ALL rows (incl. background) so nothing is re-read;
  build the teaser segment from the non-background rows only.
- Results never cancel; return `continue`.

### core/src/agent.ts — bus listener (~1412)
- Remove the `hasActiveBackgroundWaiter` yield (no waiters exist).
- Keep: registry ownership check → resolve → `wasBackgroundResultConsumed` guard
  → build content → `deliverCallback(in_session, workUnitRef, scenario)`.

### core/src/tools/process-manager.ts
- Delete `background_wait` tool (484-566), `activeWaiters`,
  `hasActiveBackgroundWaiter`.
- Keep `consumedResults` / `markBackgroundResultConsumed` /
  `wasBackgroundResultConsumed` (used by `process poll/log`, the new in-turn
  delivery, and the callback_result dedupe).
- `background_exec` description: drop background_wait references; state the
  result arrives in-turn if the turn is still running, else as a continuation.

### core/src/agent.ts — case 'callback_result' (3487)
- Keep consumed-dedupe + coalescing + scenario replay (ended-turn path).

### capability-packs.ts
- Remove `background_wait` (4 packs: 448/466/487/507).

### web-ui
- Remove `background_wait` from toolCategories runtime prefix, execution-utils
  TOOL_META + TOOL_ICON_NAME (revert the 2b8f1814 additions). Drift guard stays
  green because the tool no longer exists in core.

## Tests (real process, must bite)
- Rewrite `background-wait.test.ts` → in-turn delivery: launch a real background
  command, keep the turn alive, assert the FULL result is appended to the origin
  session in-turn AND no continuation turn fires; a second completion for the
  same session is not re-delivered.
- Keep/extend `background-callback-lineage.test.ts` (ended-turn continuation +
  coalescing + scenario replay) and `callback-scenario.test.ts`.
- `turn-delta-injection.test.ts` must stay green (owner emphasis).
- Mutation falsification: disable the in-turn consumption → the no-continuation
  assertion must go red.

## Verification
tsc -b core; core background + turn-delta tests; full node regression; web-ui
toolCategories + tsc -p web-ui; architecture-guard; eslint. Update the 4
architecture docs (state-machines, lock table, cognitive-architecture, overview).
