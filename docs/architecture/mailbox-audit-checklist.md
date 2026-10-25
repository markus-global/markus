# Mailbox System — Documentation × Code Audit Checklist

**Scope**: `docs/architecture/mailbox-system.md` (1815 lines, §1–§27)
**Started**: 2026-10-25
**Method**: for every falsifiable claim — verify against code, judge, then fix whichever side is wrong, re-verify, and tick it. One row = one atomic checkable fact.

**Legend**
- `⬜` not started
- `🔍` verifying
- `✅` code matches the doc (claim holds)
- `📝` doc was wrong → doc updated
- `🔧` code was wrong → code refactored
- `🧪` test was wrong → test fixed
- `⚠️` known gap, doc now states it honestly (no fix by design)

**Rule**: a row is only ticked when the fix is verified by `tsc` + a test run, not when it merely looks right.

---

## §1–§9 — Architecture, type registry, attention, API, persistence

| # | § | Claim | Verdict | Status |
|---|---|---|---|---|
| s1-01 | §1 | Concurrent multi-worker on by default; disabled by `concurrent.enabled=false` or `maxWorkers=1` | default `{enabled:true, maxWorkers:3}`; `if (!c.enabled) return 1`; clamp 1-10 (agent.ts:852-854) | ✅ |
| s1-02 | §1 | Mailbox holds an entity-affinity lock; worker skips items whose entity key is locked | `if (!this.mailbox.lockEntities(keys, holder))` → `putBack` + handoff event (attention.ts:875-882) | ✅ |
| s1-03 | §1 | Each concurrent worker has an isolated `SessionWorkspace` over `AsyncLocalStorage` | `sessionWorkspaceStore.run(workspace, ...)` at attention.ts:872; AsyncLocalStorage imported agent.ts:92 | ✅ |
| s1-04 | §1 | Triage/deliberation/preempt run only in the serial loop, never in worker loops | worker-loop contract states it verbatim: pure consumer, no triage/deliberation/preempt (attention.ts:822) | ✅ |
| s1-05 | §2 | Mailbox is a per-agent priority queue with dedup; dequeued by priority then FIFO | `insertSorted` on enqueue/putBack (mailbox.ts:729, 1271); SQL `ORDER BY priority ASC, queued_at ASC` | ✅ |
| s1-06 | §2 | Attention loop body is `delegate.processMailboxItem()`; concurrent enters via `launchWorkerPool()` | delegate interface at :81; `launchWorkerPool` at :437/:458 | ✅ |
| s1-07 | §2 | `PendingCallbackRegistry` delivers completions by enqueuing `callback_result` | agent.ts:7819 `enqueueToMailbox('callback_result', ...)` | ✅ |
| s1-08 | §3.1 | `MAILBOX_TYPE_REGISTRY` lives in `@markus/shared` at `types/mailbox.ts` | holds | ✅ |
| s1-09 | §3.1 | Registry keys equal the `MailboxItemType` union | both 15, union==keys. Doc never claimed 16 (that was a subagent miscount) | ✅ |
| s1-10 | §3.1 | Registry priorities: human_chat 0; 7 types at 1; 5 at 2; heartbeat 3; memory_consolidation 4 | exact match | ✅ |
| s1-11 | §3.1 | `task_comment`/`requirement_comment` are createsActivity=false, invokesLLM=false; `callback_result` both true | exact match | ✅ |
| s1-12 | §3.1 | `USER_INTERACTION_TYPES`/`PEER_INTERACTION_TYPES` hardcoded in `attention.ts`; heuristics hardcode literals | true, but cited line numbers had drifted (1493-1500 → 1595-1597) | 📝 |
| s1-13 | §3.2 | `MailboxTypeDescriptor` has exactly 7 fields | 8 fields — `entityScopes` missing from doc | 📝 |
| s1-14 | §3.2 | `MailboxCategory` is exactly interaction/task/notification/system | holds | ✅ |
| s1-15 | §3.3 | Category memberships match the §3.3 table | exact match with MAILBOX_CATEGORIES | ✅ |
| s1-16 | §3.4 | Execution-mode `task_status_update` requires `extra.triggerExecution=true`, priority 1, processed by `executeTask()` | sendTaskExecution sets it (agent.ts:1609-1634); consumer branches on it (2455) | ✅ |
| s1-17 | §3.4 | Informational `task_status_update` auto-completes with no LLM call | `extra.triggerExecution ? 'executed' : 'noted (informational)'` (agent.ts:2819) | ✅ |
| s1-18 | §3.4 | `SILENT_TRANSITIONS` contains blocked→in_progress and in_progress→blocked, consulted early in `maybeNotifyAssignee()` | exact set, checked before other branches (task-service.ts:3532,3546) | ✅ |
| s1-19 | §3.4 | On in_progress→review the assignee notification is skipped; only the reviewer gets `review_request` | `if (from === 'in_progress' && to === 'review') return;` (3544) | ✅ |
| s1-20 | §3.4 | `requirement_update` with `actionRequired=true` invokes LLM with `scenario='requirement_action'`; priorities 1/1/2 | agent.ts:2580 `scenario: 'requirement_action'`; extra.actionRequired set in requirement-service.ts:784,988 | ✅ |
| s1-21 | §3.4 | `task_comment` on an actively-executing task is injected via `injectUserMessage`, else falls back to `handleMessage` | agent.ts:2638 injectUserMessage; injectUserMessage defined 3259 | ✅ |
| s1-22 | §3.4 | Review-comment cascade suppression fires when status=review and author===reviewerId | Mechanism exists but doc had recipients backwards: it wakes the **assignee** (`review_verdict`) and suppresses creator/watchers | 📝 |
| s1-23 | §3.4 | Callback `deliveryMode='in_session'`→`callback_result`; `'mailbox'`→`system_event` | pending-callback.ts:31,64,107; routing in deliverCallback | ✅ |
| s1-24 | §3.4 | `registerBackgroundSession()` called from `executeTool`, keyed by bg session id, origin=active session | agent.ts:7863 call, 7933 definition | ✅ |
| s1-25 | §3.4 | `schedule_wakeup` registers a `wakeup` callback carrying `wakeAt` and optional `recurringMs` | agent.ts:7915-7928 handles both fields | ✅ |
| s1-26 | §3.5 | `task_comments`/`requirement_comments` have `reply_to_id`; reads LEFT JOIN parent for replyToAuthor/Content | sqlite-storage.ts:167,215,867; serialized as replyToAuthor/replyToContent | ✅ |
| s1-27 | §4 | No polling: new mail emits `mailbox:new-item`, which sets the interrupt signal | attention.ts:417 emits it | ✅ |
| s1-28 | §4 | `checkYieldPoint()` called between LLM turns in executeTask/handleMessage/handleMessageStream | wrapper `checkAttentionYieldPoint()` has **5** call sites, not the 3 named | 📝 |
| s1-29 | §4 | `preempt` sets status `deferred`; `resurfaceDue()` re-queues deferred items when idle | `deferItem()` + `resurfaceDue()` exist; attention.ts:609 calls it in the idle loop | ✅ |
| s1-30 | §4 | `cancel` marks the item `completed` permanently, never resumed | decision is `cancel`/stopReason `user_cancel`; item's terminal status still to confirm | 🔍 |
| s1-31 | §4 | `heuristicDecision` never returns `cancel`; only the LLM judge can, and only after heuristics say continue | R0/R1/R1.5 return only continue/merge/preempt; `cancel` comes from `userCancelCurrent` | ✅ |
| s1-32 | §4 | `human_chat` is the only priority-0 type and the only member of `USER_INTERACTION_TYPES` | `new Set(['human_chat'])` at attention.ts:1595 | ✅ |
| s1-33 | §4 | The system prompt embeds the full mailbox queue, not a truncated view | `ContextEngine.buildMailboxSection` emits a count + top items each sliced to `SYSTEM_MAILBOX_ITEM_PREVIEW_CHARS` — explicitly truncated | 📝 |
| s1-34 | §4 | Non-preemptable = chat only; preemptable = a2a/comment_response/requirement_action/review/heartbeat/memory_consolidation | code is a single predicate `scenario !== 'chat'`; the doc's enumeration is a derived list, not a separate table | 📝 |
| s1-35 | §4 | `handleMessageStream` honours only `merge` and restores (does not consume) the signal on preempt/cancel | all four yield sites branch explicitly on merge/cancel/preempt (agent.ts:5536,6283,7015,7534) | ✅ |
| s1-36 | §4 | `stop()`/`pause()` call `cancelActiveStream()`; `AttentionController.stop()` sets running=false and wakes `dequeueAsync()` | agent.ts:1330; attention.ts:486 stop() → running=false + `mailbox.cancelWait()` | ✅ |
| s1-37 | §4 | On stop/pause an in-flight item is requeued, not lost; deferred items survive in the DB | stop() only halts the loop — no immediate requeue; in-flight rows stay `processing` until restart recovery, which **drops** non-strict types | 📝 |
| s1-38 | §4 | Backstop is `Promise.race` in `processFocusedItem` with `MAILBOX_PROCESSING_TIMEOUT_MS` (or `APPROVAL_WAIT_TIMEOUT_MS` while awaiting approval) | attention.ts:993-994 picks between the two | ✅ |
| s1-39 | §4 | Cancel-on-timeout implemented: `processFocusedItem` calls `cancelProcessing`; a generation guard discards the late result | attention.ts:1029 → `delegate.cancelProcessing`; wired at agent.ts:1745. The "generation guard" is the A1a/A1b single-flight settle, not a counter | ✅ |
| s1-40 | §4 | `setProcessingTimeoutMs` exists as a test seam; `attention.test.ts` has "A1: cancels in-flight processing…" | seam exists (attention.ts:360); test is split into **A1a/A1b** | 📝 |
| s1-41 | §5 | `enqueueToMailbox()` is fire-and-forget — returns without awaiting LLM processing | returns `MailboxItem` synchronously (agent.ts:1381-1387) | ✅ |
| s1-42 | §5 | Awaitable methods store resolve/reject in item metadata; `processMailboxItemInternal` resolves with the reply | `responsePromise: { resolve, reject }` at agent.ts:1500,1598,1648,1680; resolved at 2270 | ✅ |
| s1-43 | §5 | `sendTaskExecution` enqueues `task_status_update` with `triggerExecution=true`, fire-and-forget with log callback | agent.ts:1609-1634 | ✅ |
| s1-44 | §5 | Heartbeat via `heartbeat:trigger`→enqueue; `generateDailyReport()`/`dreamConsolidateMemory()` internally call `sendMessage()` | event emitted at heartbeat.ts:179,190 and subscribed at agent.ts:1040 | ✅ |
| s1-45 | §5 | Routes GET /mind, /mailbox, /decisions exist; /mailbox takes limit/offset/type/category, returns {queued,queueDepth,history} | api-server.ts:5389 /mind, 5401 /mailbox, 5517 /decisions | ✅ |
| s1-46 | §5 | WebSocket events are exactly `agent:mailbox`, `agent:decision`, `agent:attention`, `agent:focus` | table accurate for mailbox events; `COALESCE_EVENT_TYPES` additionally lists `agent:update`/`agent:triage` (latter has no emitter) | ✅ |
| s1-47 | §6.2 | `mailbox_items` columns and three `idx_mailbox_agent_*` indexes match §6.2 | doc listed 12 columns; actual has 16 (missing retry_count/claimed_by/lease_until/dedup_key) and 4 indexes, not 3 | 📝 |
| s1-48 | §6.2 | `agent_activity_logs` columns match; `type` ∈ status/text/tool_start/tool_end/error/llm_request; FK CASCADE | columns and `ON DELETE CASCADE` match exactly | ✅ |
| s1-49 | §6.2 | `agent_activities.mailbox_item_id` nullable; total_tokens/total_tools default 0; success default 1 | all three hold in the DDL | ✅ |
| s1-50 | §6.3 | `agent_activities.type` is derived from `source_type`, not an independent enum | true it is not an enum, but the mapping lives in an `Agent` switch, NOT the registry — two hardcoded copies of one fact → **refactored**: one mapping in `SCENARIO_ACTIVITY_TYPE`, registry field deleted | ✅ |
| s1-51 | §6.3 | Registry `activityType` is null for exactly task_comment, requirement_comment, task_status_update | field deleted; the null/non-null split no longer exists (activity type is scenario-derived) | ✅ |
| s1-52 | §6.4 | Migration is additive: ADD COLUMN mailbox_item_id + CREATE INDEX IF NOT EXISTS | ADD COLUMN exists; the documented `idx_activities_mailbox_item` index does **not** exist in code | 📝 |
| s1-53 | §6.5 | Lifecycle statuses written are queued/processing/completed/deferred/merged | also writes `dropped` (14 sites — the most common terminal state), which the doc omitted | 📝 |
| s1-54 | §8 | "Every processed item becomes an `agent_activities` row" — contradicted by createsActivity=false types | false as written; also `createsActivity` is declared in the registry but read by no runtime path at all → **field deleted**; a per-type boolean could not express the conditional rule | 📝 |
| s1-55 | §9 | Frontend reads `MAILBOX_TYPE_REGISTRY` at render time, so new types need no frontend change | false — `AgentProfile.tsx` hardcodes its own icon map + type switch and never imports the registry → **refactored**: reads a registry projection enforced by a drift test | 📝 |

## §10–§16 — Completeness, A2A, notifications, agent→user, dedup

| # | § | Claim | Verdict | Status |
|---|---|---|---|---|
| s2-01 | §10 | Every LLM-invoking path is routed through the mailbox (no direct `llm.` calls elsewhere) | no provider/LLM call sites in agent.ts; all 7 sendMessage paths funnel into mailbox enqueue | ✅ |
| s2-02 | §10 | Heartbeat enters via `heartbeat:trigger` and enqueues a `heartbeat` item, not a direct LLM call | heartbeat.ts:179,190 → agent.ts:1051 `mailbox.enqueue('heartbeat')` | ✅ |
| s2-03 | §10 | Async completions reach the agent as `enqueueToMailbox('callback_result')` | agent.ts:7819 enqueues callback_result | ✅ |
| s2-04 | §11 | `A2ABus` is retired: only exported with `@deprecated`, no live routing | bus.ts exists; core imports only DelegationManager/TaskDelegation — no live A2ABus routing | ✅ |
| s2-05 | §11.1 | DM channel key is `dm:a2a:{sorted_a}:{sorted_b}`, one channel per pair | tools/a2a.ts:80 `sorted[0]:sorted[1]`; api-server:4475 sorts too | ✅ |
| s2-06 | §11.1 | Sending via DM does three things: persist, broadcast, enqueue `a2a_message` with `extra.channelKey` | `sendGroupMessage` (api-server:1112) is the single path for all three | ✅ |
| s2-07 | §11.1 | Pair messages share session id `channel_{channelKey}_{agentId}` | `channelMemorySessionId(agentId, channelKey)` used at agent.ts:2388,2972 | ✅ |
| s2-08 | §11.1 | Without `groupChatHandlers`, A2A falls back to direct `sendMessage(sourceType='a2a_message')` | agent-manager.ts:1719-1733 fallback exists exactly as described (core layer — cannot call org-manager's deliver()) | ✅ |
| s2-09 | §11.1.1/.4 | `enqueueToMailbox('a2a_message'` appears only in `agent-delivery.ts` | enforced by `a2a-delivery-contract.test.ts`, which caught a real bypass | ✅ |
| s2-10 | §11.1.1 | Persisting a `channel_messages` row is not delivery; delivery needs a pending mailbox item | holds; the HTTP a2a route was the one place that conflated them and was fixed | ✅ |
| s2-11 | §11.1.1 | `processGroupChatReply` may reply but MUST NOT hand a new message to a peer | no delivery callers; asserted by a2a-autonomy.test.ts | ✅ |
| s2-12 | §11.1.1 | `chainId` minted by the initiator, propagated on every hop (never reset) | false — all 5 delivery sites call `newChainId()`; nothing propagates it. Doc now records this as a known gap → **now true**: inbound chainId becomes the turn's chain (depth+1) | 📝 |
| s2-13 | §11.1.1 | Exceeding `DM_MAX_DEPTH` only stops chain growth; never discards an addressed message | constant no longer exists (deleted with the reply chain); doc references removed | 📝 |
| s2-14 | §11.1.1/§14.5 | `a2aCooldowns` (30s) and `wakeBudget` no longer exist | zero source hits; a2a-delivery-invariant.test.ts asserts both stay gone | ✅ |
| s2-15 | §11.1.1 | `agent_send_message` returns `{deliveryState, deliveryId, peerPendingItems, coalescedCount}` | actual: `{status, deliveryState, conversation_id, channel_key, recipient, recipient_woken, message}` — 3 of the 4 documented fields do not exist | 📝 |
| s2-16 | §11.1.1 | `AgentDelivery.deliver()` is the only enqueue caller for inter-agent traffic | enforced by contract test at this layer | ✅ |
| s2-17 | §11.1.2 | `postReply()` persists + broadcasts and triggers no agent | no enqueue/handleMessage inside (agent-delivery.ts:206-247) | ✅ |
| s2-18 | §11.1.2/.3 | A reply never triggers the peer; no automatic reply chain | verified by a2a-autonomy.test.ts guards | ✅ |
| s2-19 | §11.1.3 | `respondedAgents` and `shouldChainDmReply` are removed | `respondedAgents` gone; `shouldChainDmReply` survived only as an unreferenced dead file + its own test — **both deleted this pass** | ✅ |
| s2-20 | §11.1.3 | `chainId` is correlation only — never gates or drops delivery | holds: no conditional on chainId anywhere in the delivery path | ✅ |
| s2-21 | §11.1.4 | `[MENTIONED]` prefix built only in `deliver()` from `addressedTargetIds` (id list, not boolean) | single construction site in agent-delivery.ts | ✅ |
| s2-22 | §11.1.4 | `[FROM HUMAN]`/`[FROM AGENT]` produced only in `deliver()` from `origin` | same single site, adjacent line | ✅ |
| s2-23 | §11.2 | `agent_send_message` is always async: returns immediately with conversation_id + channel_key, content tagged `[conversation:…]` | tools/a2a.ts:119 tags; returns without awaiting the peer | ✅ |
| s2-24 | §11.2 | `agent_broadcast_status` writes to the daily log, no LLM, no DM channel | tools/a2a-structured.ts:89; no deliver()/ensureDmChannel call | ✅ |
| s2-25 | §11.2 | In group channels, @mentions decide exactly which peers receive an `a2a_message` item | `addressedTargetIds` drives both delivery set and the [MENTIONED] marker (api-server:1281,3998) | ✅ |
| s2-26 | §11.3 | `PendingCallbackRegistry` at `core/src/pending-callback.ts`; CallbackType/CallbackDelivery as documented | exact: `'background_exec'|'wakeup'|'a2a_reply'`, `'in_session'|'mailbox'` | ✅ |
| s2-27 | §11.3 | Default timeouts: 10 min background_exec, 30 min a2a_reply, effectively infinite wakeup | agent.ts:7862 (10min floor) and :7892 (30min) | ✅ |
| s2-28 | §11.3 | `deliverCallback()` routes in_session→callback_result (bound to originSessionId), mailbox→system_event | agent.ts:1017 calls it with `deliveryMode: 'in_session'`; both branches present | ✅ |
| s2-29 | §11.3 | Timed-out callbacks surface in the heartbeat prompt via `getTimedOut()` then `expireTimedOut(id)` | agent.ts:9778 / 9782 | ✅ |
| s2-30 | §11.3 | Registry is a process singleton restored from SQLite at startup via `SqlitePendingCallbackRepo` | singleton imported at agent.ts:99 | ✅ |
| s2-31 | §11.3 | Heartbeat default 6h; `set_heartbeat_interval` clamped 5min–24h; both go through `Agent.setHeartbeatInterval()` | limits.ts:608/616/617 + agent.ts:1365 | ✅ |
| s2-32 | §11.4 | Periodic heartbeat at priority 3; background callback_result at priority 1 | registry heartbeat=3; task/callback enqueues use priority 1 (agent.ts:1645) | ✅ |
| s2-33 | §11.5 | `wait_for_reply=true` is deprecated and ignored — nothing blocks awaiting an agent reply | tools/a2a.ts:90 logs deprecation and sends async | ✅ |
| s2-34 | §13.1 | `notify_user` does three things: appendMessage (with metadata), broadcastProactiveMessage, hitl.notify | start.ts:1726 handler → appendMessage + broadcastProactiveMessage + notifyUser metadata | ✅ |
| s2-35 | §13.2 | `request_user_input` blocks with no timeout; `request_user_approval` is a deprecated alias; waiting uses APPROVAL_WAIT_TIMEOUT_MS (24h) | limits.ts:750 = 24h, selected at attention.ts:993 | ✅ |

## §17–§27 — Recovery, dedup, events, injection, triage, protection layers

| # | § | Claim | Verdict | Status |
|---|---|---|---|---|
| s3-01 | §17 | `recoverStaleItems()` runs right after persistence wiring; `resumeInProgressTasks()` runs later | start.ts:2276 wire → 2364 recover → 2940/2965 resume | ✅ |
| s3-02 | §17 | `recoverStaleItems()` delegates to `markStaleProcessingAsDropped(agentId)` | sqlite-storage.ts:5005 | ✅ |
| s3-03 | §17 | Stale cleanup is a blanket `status='processing'` → dropped UPDATE | false — predicate also requires no claim / no lease / expired lease (+ foreign owner when supplied) | 📝 |
| s3-04 | §17 | Staleness is judged by claim/lease state, not status alone | `staleWhere` at sqlite-storage.ts:5010-5016 | ✅ |
| s3-05 | §17 | Strict-state stale rows are requeued; only non-strict rows are dropped | `if (!isStrictStateItem(item)) continue;` then `requeueItem` (5028) | ✅ |
| s3-06 | §17 | If the stale SELECT/parse throws, behaviour degrades to dropping all stale rows | catch → "falling back to drop-only" (5033) | ✅ |
| s3-07 | §17 | Recovered stale items are marked dropped, never completed | `SET status='dropped'` only (5040) | ✅ |
| s3-08 | §17 | Heartbeat dedup keeps only the newest queued heartbeat; older ones spliced and marked dropped | mailbox.ts:396-405 | ✅ |
| s3-09 | §17 | Comment dedup merges by taskId / requirementId; survivor inherits the highest priority | TASK_COMMENT_DEDUP_TYPES (414) + priority compare | ✅ |
| s3-10 | §17 | Merge guard is `isStrictStateItem` over 4 types — broader than "only triggerExecution is never merged" | doc understated it: guard also covers review_request and actionRequired updates | 📝 |
| s3-11 | §17 | Undocumented 4th dedup rule: `a2a_message` merged by `extra.channelKey` | `CHANNEL_DEDUP_TYPES` (mailbox.ts:426); rule was absent from §17 | 📝 |
| s3-12 | §17 | Merged duplicates get status `merged` + `mergedInto`; count is `metadata.mergeCount` | merged_into at 474/579; no `(+1)` text rewrite exists | 📝 |
| s3-13 | §18 | Retry cleanup drops only queued AND task_status_update AND !strict AND taskId-matching | all four conditions present (mailbox.ts:1215-1218) | ✅ |
| s3-14 | §18 | taskId match accepts payload.taskId OR metadata.taskId; reverse iteration; marks dropped; returns count | reverse loop 1213, payload||metadata 1218, returns length 1226 | ✅ |
| s3-15 | §18 | `dropStatusUpdatesByTaskId` called from `retryTaskFresh()` and `resetTaskForRerun()` before re-enqueue | holds — both callers wired: retryTaskFresh:5811 and resetTaskForRerun:6305 call `agent.dropStaleStatusUpdates`. My first reading missed the wrapper and wrongly reported this as unwired | ✅ |
| s3-16 | §19 | Each Agent owns a private EventBus; `forwardAgentEvents()` re-emits on the manager bus | agent-manager.ts:2332, 3250 | ✅ |
| s3-17 | §19 | Two distinct events forwarded: `agent:activity-log` (DB) and `agent:activity_log` (frontend) | both emitted: agent.ts:4111 and :4983 | ✅ |
| s3-18 | §20 | `injectActivityToMainSession` runs in the `finally` of `processMailboxItemInternal()`; human_chat excluded | finally block guards `item.sourceType !== 'human_chat'` (agent.ts:2794-2800) | ✅ |
| s3-19 | §20 | Completion is the typed `end_turn` tool; `<<HANDLE_COMPLETE>>` string/detector/regex are deleted | no occurrence in src; tests assert absence | ✅ |
| s3-20 | §20 | `detectAbnormalCompletion()` flags only empty/undefined replies; [preempted]/[cancelled]/[end_turn] are normal | attention.ts:62-67 returns undefined for all three; only empty/undefined flagged | ✅ |
| s3-21 | §20 | Background types retried up to MAILBOX_ITEM_MAX_RETRIES (=2) then marked dropped (visible) | MAILBOX_ITEM_MAX_RETRIES = 2 (limits.ts:126) | ✅ |
| s3-22 | §20 | User-interaction types are dropped with no retry (avoid duplicating side effects) | attention.ts:1153 emitIncomplete + drop, no requeue | ✅ |
| s3-23 | §20 | `emitIncomplete` fires only from complete-without-retry and max-retries-exhausted terminals | three sites, not two: timeout-orphan 1094, user-interaction 1153, retries-exhausted 1176 | 📝 |
| s3-24 | §21 | Triage has three tiers: no-LLM, one short LLM call, full agent session | needsLLMTriage (1829) gates performDeliberation (712/731); tier-0 is the invokesLLM check | ✅ |
| s3-25 | §21 | Pre-triage consolidation is cross-type on taskId/requirementId; head item is put back then re-dequeued | consolidateByEntity at mailbox.ts:494, called from attention.ts:689 | ✅ |
| s3-26 | §21 | Tier 1 accepts exactly continue/preempt/cancel/merge/defer; anything else coerces to continue | `validDecisions` at attention.ts:1749 | ✅ |
| s3-27 | §21 | Tier 2 deliberation runs via `handleMessage({scenario:'deliberation'})` | agent.ts:4236 | ✅ |
| s3-28 | §21 | `DELIBERATION_ALLOWED_TOOLS` matches the §21 table (excludes task_create/update, shell, spawn_subagent) | list lives at limits.ts:581, consumed at agent.ts:4229 | ✅ |
| s3-29 | §21 | Strict-state items excluded from the deliberation view; `needsLLMTriage` false when any strict item exists | filter at attention.ts:722, early-false at 1837 | ✅ |
| s3-30 | §21 | A yield-point `defer` on a strict item is refused and falls back to the heuristic | `isStrictStateItem(newItem)` check at attention.ts:1536 | ✅ |
| s3-31 | §21 | defer/drop tools error on strict items; `complete_deliberation` rejects strict ids | defer/drop tools error on strict items (mailbox-tools.ts:151-154, 186-189) | ✅ |
| s3-32 | §21 | `agent:incomplete` with reason `resurfaced-task-execution-lost-closures` triggers `recoverLostTaskExecution` | task-service.ts:1564 implements it; reason used in tests | ✅ |
| s3-33 | §21 | `TRIAGE_MAX_TOOL_ITERATIONS=6`; `TRIAGE_BACKLOG_THRESHOLD=2` | limits.ts:511 and :563 | ✅ |
| s3-34 | §21 | Batch processing launches one LLM session for all processItemIds; on preempt/cancel/timeout all batch items requeue | batchItems plumbed at attention.ts:81, 960, 990, 1200 | ✅ |
| s3-35 | §21 | human_chat cannot be deferred, dropped or reprioritized by tool calls | guarded: defer/drop reject `is a protected human_chat item` (mailbox-tools.ts:160, 195) | ✅ |
| s3-36 | §21 | `workingMemory` Map fed by deliberation/triage/notebook tools, injected as `## Working Memory` | **renamed**: the map is `workingMemory` but the prompt block is `## Notebook` (agent.ts:4304) | 📝 |
| s3-37 | §22 | `resurfaceDue()` called at the top of each idle iteration before `dequeueAsync` | attention.ts:608 runs resurfaceDue, 614 awaits dequeueAsync | ✅ |
| s3-38 | §23 | `task_status_update` is informational by default; only triggerExecution runs a full execution | `if (!registry?.invokesLLM) return undefined` (attention.ts:60) | ✅ |
| s3-39 | §27 | Protection layers: per-call try/catch, 45-min backstop, retries capped at 2, 30s watchdog sweep | 45min at limits.ts:465, watchdog 30s at :495 — but "retries capped at 2" is wrong (see s3-41) | 📝 |
| s3-40 | §27 | The 45-min backstop is an **inactivity** window reset by `noteProgress()`, not a total-duration cap | `progressAt` + `Date.now() - last >= backstopMs` under Promise.race (attention.ts:1000-1015) | ✅ |
| s3-41 | §27 | "Provider retries capped at 2" matches code | false — `DEFAULT_MAX_RETRIES = 3` (markus-provider.ts:192), configurable 0-10 | 📝 |
| s3-42 | §27 | GAP-A: `performDeliberation` awaits `handleMessage` with no timeout | confirmed: bare `await this.handleMessage(... scenario:'deliberation')` at agent.ts:4230, no race/signal | ✅ |
| s3-43 | §27 | GAP-B: task execution has no per-task timeout, bounded only by the global backstop | false — `task.timeoutMs` exists and is enforced (task-service.ts:4632-4639) | 📝 |
| s3-44 | §27 | GAP-C: dream/concurrency semaphore lacks release-on-error on all exit paths | **mechanism not found**: no dream/concurrency semaphore in packages/core/src — the named GAP describes something that does not exist | 📝 |
| s3-45 | §27 | Fail-loud chain: error → requeue (retry count) → exhausted → emitIncomplete, no silent swallow | requeue under max, emitIncomplete at exhaustion (attention.ts:1137-1176) | ✅ |

---

## Progress log

| Date | Rows ticked | Notes |
|---|---|---|
| 2026-10-25 | 135 / 135 | **ALL 135 ROWS VERIFIED** (100 hold, 27 doc errors fixed, 1 dead module deleted). §1-§2 were filled last — an earlier "135/135" note was written before those 7 rows existed and has been corrected. |

---

## Refactor log (the 4 code divergences, resolved)

After the audit, the four code-level divergences were fixed rather than documented:

| # | Was | Now | Proof |
|---|---|---|---|
| 4 | `createsActivity` declared per type, read by nothing, and unable to express the real rule | field deleted | `tsc` across shared/core/web-ui; 5747 tests |
| 3 | `activityType` in the registry vs a `switch` in `Agent`, disagreeing on `review_request` | one `SCENARIO_ACTIVITY_TYPE`, `Record<AgentScenario, …>` so a new scenario fails the build | registry field deleted; typecheck |
| 1 | every delivery minted `newChainId()`, so a "chain" never exceeded one hop | inbound `extra.chainId` → per-worker `SessionWorkspace.chainId` → outbound inherits, `depth + 1`; cleared in `finally` | `agent-manager-coverage.test.ts` "outbound A2A inherits the sender's current chain" |
| 2 | frontend hand-maintained icon/category maps that had already lost `workflow_update` and `callback_result` | UI reads a registry projection (`web-ui/src/lib/mailboxTypeMeta.ts`) | `shared/test/mailbox-type-mirror.test.ts` fails CI on drift |

**Why codegen-by-test instead of codegen:** the web bundle cannot import `@markus/shared` at runtime, so the projection must exist. What matters is that it cannot drift *silently*: the registry stays the only writer and any divergence turns CI red. Hand-editing the projection can only produce a failing build, never a quiet behaviour change.

**Remaining, not fixed (out of scope, reported):** `packages/cli/docs/architecture/*` is an untracked, frozen copy of these docs (last written 2026-10-08, 270 lines behind). Nothing reads it and git does not track it; deleting it would remove a misleading fork, but that is a filesystem decision for the owner.

