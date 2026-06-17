# Test Issues Log

Issues discovered during test coverage improvement. Each issue is categorized:

- **[BUG]** — Simple bug (off-by-one, missing null check, wrong field name). Fix immediately.
- **[DESIGN]** — Design issue (wrong abstraction, architectural flaw). Document thoroughly, consider carefully before fixing.
- **[SECURITY]** — Security vulnerability. Evaluate severity and fix accordingly.
- **[RACE]** — Race condition / concurrency issue. Needs careful analysis.

## Issues

| ID | Severity | Type | File | Description | Status |
|----|----------|------|------|-------------|--------|
| T-001 | Low | [DESIGN] | `core/src/llm/router.ts` | Providers without `getCapabilities()` bypass capability filter for non-text tasks — they are included as fallbacks even when they may not support the modality | **Fixed** — reject providers without `getCapabilities` for non-text tasks |
| T-002 | Low | [DESIGN] | `core/src/llm/router.ts` | Auth/billing errors (401/402) trigger cross-provider fallback — intentional but can produce misleading errors when all providers fail for auth reasons | Open |
| T-003 | Low | [BUG] | `core/src/llm/openai.ts` | `Buffer.buffer` returns full underlying ArrayBuffer (larger than contents) — TTS consumers using `.buffer` directly get wrong data | Verified: code no longer uses `.buffer` |
| T-004 | Low | [DESIGN] | `core/src/tools/settings.ts` | `detectModelTaskMismatch` is private/not exported — cannot be unit tested directly, only indirectly through `llm_set_task_routing` | Open — acceptable; tested indirectly |
| T-005 | Low | [BUG] | `core/src/tools/web-fetch.ts` | `String(error)` produces `"Error: message"` not `"message"` — minor inconsistency in user-facing error strings | **Fixed** — use `error.message` for Error instances |
| T-006 | Low | [DESIGN] | `core/src/tools/file.ts` | `denyMessage` is exported but unused internally — write/edit tools inline their own denial messages creating duplication | **Fixed** — removed unused function and export |
| T-007 | Medium | [DESIGN] | `core/src/concurrent/state-manager.ts` | `activeTaskCount` only updates on progress events, not on task start/completion — can stay stale | Open — needs careful review of event flow |
| T-008 | Low | [DESIGN] | `core/src/security.ts` | `SecurityGuard.pendingApprovals` field declared but never read/written — dead code | **Fixed** — removed dead field |
| T-009 | Low | [BUG] | `core/src/file-converter.ts` | Fallback message says "Image" for all non-image file types (CSV, PDF, etc.) when markitdown is unavailable | **Fixed** — now shows "File" for non-image types |
| T-010 | High | [RACE] | `shared/src/utils/config.ts` | `saveConfig` reads, merges, then writes with no file lock — concurrent saves (e.g. from two API requests) can lose writes; read-modify-write is NOT atomic | **Fixed** — added filesystem lock via `O_EXCL` with stale-lock cleanup |
| T-011 | High | [RACE] | `core/src/llm/auth-profiles.ts` | `acquireLock` uses `writeFileSync('wx')` but stale-lock check (>30s) races with other processes — two processes can both decide the lock is stale and both acquire it simultaneously | **Fixed** — stale lock now `unlink` + retry `wx` instead of direct overwrite |
| T-012 | Medium | [DESIGN] | `storage/src/sqlite-storage.ts` | Zero transaction usage across 4815 lines — multi-step operations (e.g. task with subtasks, org with team+members) are not atomic; a crash mid-operation leaves inconsistent data | Open |
| T-013 | Medium | [DESIGN] | `core/src/agent-manager.ts` | 24 empty `catch {}` blocks silently swallow errors — failures in agent lifecycle operations (start, stop, restore) are invisible; makes debugging production issues very difficult | **Partially Fixed** — added `log.debug`/`log.warn` to 5 most dangerous catch blocks (workflow, tasks, cleanup, role-update) |
| T-014 | Medium | [DESIGN] | `core/src/agent.ts` | 11 empty `catch {}` blocks + 4 `.catch(() => {})` — errors in consolidation, session finalization, and cleanup are silently dropped; at minimum these should log at debug level | **Fixed** — added `log.debug` to 7 key catch blocks (requirement, calibration, activity callbacks, heartbeat search) |
| T-015 | Low | [BUG] | `core/src/agent.ts` | `updateTokensUsed` adds to `state.tokensUsedToday` AND delegates to `stateManager.updateTokensUsed` — if stateManager also accumulates, tokens could be double-counted depending on which source is read | **Fixed** — `notifyStateChange` now uses `getTokensUsed()` (reads from stateManager when available) |
| T-016 | Medium | [RACE] | `core/src/agent.ts` | `handleMessage` has no mutex/queue — two simultaneous calls share `currentSessionId`, both modify the same session's message history, and tool executions can interleave. The `activeTasks` set tracks task IDs but doesn't prevent concurrent `handleMessage` on the same session | Open |
| T-017 | Low | [DESIGN] | `core/src/agent.ts` | Event listener added in constructor (`on(...)`) but never removed in `stop()` — if agent is created/destroyed repeatedly, listeners accumulate. Only 1 listener currently but pattern is risky | **Fixed** — save unsubscribe handle, call in `stop()` |
| T-018 | Medium | [SECURITY] | `core/src/tools/shell.ts` | Shell command is passed directly to `sh -c` with no escaping or sanitization — while this is by design (agent needs shell access), combined with LLM hallucination, a compromised LLM could execute arbitrary destructive commands. Approval callback is the only protection but it's optional | Open — by design, but worth noting |
| T-019 | Low | [BUG] | `core/src/tools/web-search.ts` | `_dispatcher` module-level cache uses `false` as sentinel for "not yet resolved" — fragile because `undefined` (no proxy) is also falsy | **Fixed** — use `Symbol('not-resolved')` as sentinel |
| T-020 | Medium | [DESIGN] | `core/src/tools/mcp-client.ts` | MCP child process stdout is parsed line-by-line with `JSON.parse` — no handling for partial JSON if a message spans multiple `data` chunks. The `readline`-like split on `\n` can break if JSON contains escaped newlines in strings | Open |
| T-021 | Low | [BUG] | `core/src/tools/task-tools.ts` | 4 empty catch blocks — `JSON.parse` failures for `deliverables` and `subtasks` are silently ignored; malformed JSON input from LLM results in silent data loss instead of an error message to the user | Open |
| T-022 | Low | [DESIGN] | `core/src/attention.ts` | 6 empty catch blocks — attention/triage failures are swallowed; if the LLM returns malformed JSON for priority assessment, the item falls through to default handling without any logging | **Fixed** — added `log.debug` to all 6 catch blocks |
| T-023 | Medium | [DESIGN] | `org-manager/src/api-server.ts` | 12,599 lines in a single file — extremely difficult to maintain, review, and test. Route handlers, middleware, SSE management, websocket logic, and business logic all mixed together | Open — needs refactoring into modules |
| T-024 | Low | [BUG] | `core/src/agent-metrics.ts` | `writeFileSync` for metrics persistence has no error handling beyond empty catch — if disk is full, metrics are silently lost AND the agent continues without knowing. `readFileSync` for restore also swallows parse errors | **Fixed** — added `log.warn` for save and load failures |
| T-025 | Medium | [RACE] | `core/src/agent.ts` | `activeTasks` Set and `activeTaskGen` Map are modified without synchronization — while JS is single-threaded, the `async` task execution paths can interleave at `await` points, potentially causing the `finally` block of an older generation to clear a newer task's entry (mitigated by generation counter, but the gen check itself is not atomic with the delete) | Open — partially mitigated |
| T-026 | Low | [DESIGN] | `core/src/memory/store.ts` | 5 empty catch blocks — memory persistence failures (write daily log, compact session) are swallowed; data loss in memory subsystem is invisible | **Fixed** — added `log.debug` to 3 silent catch blocks (stat, sessions dir, load session) |

## Fix Priority

### Immediate (simple bugs — already fixed)
- T-005: `String(error)` → `error.message` ✅
- T-008: Remove dead `pendingApprovals` field ✅
- T-009: "Image" → "File" for non-image fallback ✅

### High Priority (race conditions affecting data integrity)
- T-010: Config file concurrent write race ✅
- T-011: Auth profile lock race ✅
- T-012: SQLite transactions — wrap multi-step operations in `db.transaction()` (remaining)

### Medium Priority (silent error swallowing)
- T-013: agent-manager empty catches ✅ (5 critical)
- T-014: agent.ts empty catches ✅ (7 key blocks)
- T-016: `handleMessage` concurrency — needs mutex/queue (remaining)
- T-024: Metrics persistence logging ✅

### Low Priority (design improvements)
- T-001: Provider capability check ✅
- T-006: Dead denyMessage export ✅
- T-015: Token state consistency ✅
- T-017: Event listener leak ✅
- T-019: Dispatcher cache sentinel ✅
- T-022: attention.ts empty catches ✅
- T-026: memory/store.ts empty catches ✅

### Remaining Open
- T-002: Auth/billing fallback behavior (by design)
- T-004: detectModelTaskMismatch private (acceptable)
- T-007: activeTaskCount stale (needs event flow review)
- T-012: SQLite transactions (large refactor)
- T-016: handleMessage concurrency (design decision needed)
- T-018: Shell command injection (by design, approval-gated)
- T-020: MCP partial JSON (edge case)
- T-023: api-server.ts 12.6k lines (needs modular refactor)
- T-025: activeTasks race (partially mitigated by gen counter)
