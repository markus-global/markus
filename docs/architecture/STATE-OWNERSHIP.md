# State Ownership Contract

> Why this document exists: pushing state down from "agent-level singleton" to "per-worker workspace"
> is the right direction, but it **legitimately changes** an implicit premise found all over the repo
> ("reading `currentSessionId` gives you this request's session").
> Changes of this kind don't throw errors, they compile, and all the old tests stay green — they only
> show up in production as "the agent has amnesia".
> So "who owns which state, who may read it, and in which context it may be read" has to be written down
> as a contract and enforced by machine.

**Applies to**: any change that touches session identity / history / concurrency / workspace state.

---

## 1. The three execution contexts (first, figure out where you are)

| Context | When it occurs | `sessionWorkspaceStore.getStore()` | Default workspace |
|---|---|---|---|
| **HTTP thread** | `api-server` handling a request, SSE callbacks, route validation | `undefined` | `rootWorkspace` |
| **worker workspace** | an attention worker pool processing a mailbox item | that worker's workspace | that worker's workspace |
| **background timers / bare callbacks** | backstop timeouts, `setTimeout`, external events | `undefined` | `rootWorkspace` |

> The test: `private workspace() { return sessionWorkspaceStore.getStore() ?? this.rootWorkspace; }`
> Under concurrent mode (3 workers by default), **the HTTP thread and a worker do not see the same thing**.

---

## 2. State ownership matrix (writer / reader / context)

| State | Ownership | Who writes | Who reads | Implicit reads allowed? |
|---|---|---|---|---|
| `currentSessionId` (in-memory session `sess_*`) | **per-worker** | the worker handling that item (restore / startNewSession / handle*) | the turn logic inside that same worker | ❌ **forbidden** to read across threads |
| `dbSessionMap` (`cs_*` → `sess_*` binding) | agent-level (shared across workers) | **written only in the worker handling that message** | anyone (looked up by DB id) | ✅ allowed (this is the only cross-thread-safe session bridge) |
| `MemoryStore.sessions` (the history itself) | agent-level singleton | `appendMessage` (inside a worker) | `getRecentMessages` / `getSession` | ✅ allowed (but an unknown id must warn — never silently return empty) |
| `chatSessionRepo` (`cs_*` persistence layer) | storage (out of process) | api-server (persist) | api-server / restore | ✅ allowed |
| `activeScenario` / `currentTaskId` / `turnModelOverride` / `currentInteractingUserId` | **per-worker** | same worker | same worker | ❌ forbidden to read across threads |
| `workerWorkspaces` / `workerStates` / `inFlightProcessing` | attention controller | attention itself | attention / targeted cancellation (**must carry workerId explicitly**) | ⚠️ only for targeted APIs that take a workerId |
| `session.summary` / fragments / slots | MemoryStore (singleton) | compactor | context assembly | ✅ allowed |

**In one sentence**: **per-worker things can never be obtained by "reading a global pointer"; they must be passed explicitly.**
The only session bridge that may be shared across threads is `dbSessionMap` (`cs_*` ↔ `sess_*`).

---

## 3. Hard rules

1. **DB ids and in-memory ids are never mixed**. `cs_*` is the request identity, `sess_*` is the internal cache key;
   never use a `cs_*` directly as a `MemoryStore` key (that causes split-brain: one conversation splits into two stores).
2. **Passing session identity across threads must be explicit**. For the HTTP thread to hand a session to a worker,
   it may only go through the mailbox item's `extra.sessionHint` (normalized from the legacy `extra.sessionId` /
   `extra.sessionRestore`), never through any shared pointer.
3. **Session context is applied only in the workspace that handles that item**. "Eager restore" in the HTTP thread
   is forbidden (it only writes `rootWorkspace`, which the worker never sees).
4. **Failures must be visible**. Distinguish `found | missing | notLoaded`: the latter two must at minimum `log.warn`
   with `dbSessionId / memorySessionId / agentId`. "Not found → return empty / create new / swallow the exception" is forbidden.
5. **The binding may be written in exactly one place**: in the workspace that actually handles that message.
6. **Targeted operations must carry a workerId** (cancellation, status queries, hot updates); inferring it from ALS is not allowed.

---

## 4. Enforcement mechanisms already in place

| Mechanism | Location | What it protects |
|---|---|---|
| Streaming path carries the DB session id explicitly | `agent.ts` `sendMessageStream` → `extra.sessionHint` | rule R2 |
| Session resolution order "DB-bound in-memory session > workspace pointer > create new" | `resolveTurnSession` (single resolution point, called from `processMailboxItemCore`) | rule R1 |
| restore / binding executed in the workspace handling that item | `processMailboxItemCore` | rules R3/R5 |
| Lazy loading for history reads + warning on unknown id | `memory/store.ts` `getRecentMessages` | rule R4 |
| Invariant test suite | `packages/core/test/conversation-session-invariants.test.ts` | all of the above |
| Architecture gate | `scripts/architecture-guard.mjs` (must pass in CI) | bans `console.*`, bans empty `catch` |

---

## 5. Checklist for adding/changing state

1. Does this state belong to **agent level** or is it **per-worker**? (per-worker ⇒ it must be passed explicitly)
2. Who writes it, who reads it, in which context? (fill it into the matrix in section 2 — **a blank cell is a risk**)
3. What happens when it can't be read? Does it silently degrade? (it must be observable)
4. Add an **invariant test** (not an assertion over an implementation snapshot), and do mutation validation (revert the fix → the case must go red).
5. Does it affect the `worker=1` serial-equivalence contract? (equivalence must hold)
