# LLM Provider Timeout Governance

> Last updated: 2026-09. Distilled from the provider timeout audits (set A + set B).
> This is the **current-state design reference** for how each LLM provider adapter
> handles timeouts / hangs / retries — what is bounded, what is not, and the agreed
> target design. Do not add per-file line references here (they drift); describe
> behavior, not line numbers.

## 1. Governing matrix (current state)

| Provider adapter | Non-stream timeout | Stream idle timeout | Hard cap | External abort | Retry | Notes |
|------------------|--------------------|---------------------|----------|----------------|-------|-------|
| **openai** | ✅ configurable | ✅ idle (per-chunk reset) + hard | ✅ | ✅ shared AbortController | — | Reference implementation; fails loudly |
| **markus-provider** | ✅ | ✅ idle (per-chunk reset) + hard | ✅ | ✅ external abort | ✅ budget shared across retries (not reset) | Aligned baseline with openai |
| **anthropic** | ❌ **none** — non-stream chat can hang forever | ✅ | — | ✅ | — | **Most severe gap (set A)** |
| **google** | partial | partial | — | — | — | Needs hardening (set A) |
| **dashscope** | partial | — | — | — | — | Needs timeout coverage (set A) |
| **ollama** | partial | — | — | — | — | Needs timeout coverage (set A) |
| **openai-codex** | — | — | ✅ single 180 s | — | — | Single coarse root timer |
| **proxy-fetch** | ❌ **no built-in timeout** | — | — | relies on caller-passed signal | — | Caller must pass `signal`, else unbounded |
| **minimax** | ✅ | ✅ | — | — | — | **Video polling can hang ~30 min, not externally cancellable; silent `max_tokens` downgrade + empty-array fallbacks** |

## 2. Known risk inventory (priority order)

1. **anthropic non-streaming chat: no timeout at all** — a hung model call blocks the
   turn indefinitely. Must get an idle timeout + hard cap (openai semantics).
2. **minimax video polling: ~30 min without external cancel** — plus silent degradation
   (downgraded `max_tokens`, empty-array response accepted as success). Needs a real poll
   timeout + fail-loud on degradation.
3. **proxy-fetch: no own timeout** — unbounded unless the caller threads a signal.
   Should default to a sane timeout and still honor an external signal.
4. **google / dashscope / ollama**: partial coverage — streaming idle semantics and hard
   caps not consistently implemented.
5. **Streaming errors thrown as bare `AbortError`** in several adapters — callers cannot
   distinguish user-cancel from provider failure; wrap with intent.
6. **Timer leaks** where timers are not cleared on completion paths.
7. **Hardcoded durations** in several adapters — should be configurable (openai-style).

## 3. Target design (agreed direction)

- **Idle semantics**: per-chunk timer reset on every received chunk (stream stays alive
  while tokens flow), plus a **hard cap** as the outer bound.
- **Configurable durations** with sane defaults; no hardcoded magic numbers.
- **External abort**: all adapters accept a caller-provided `AbortController`/signal and
  cooperate with it (used by streaming cancel — see STREAMING-AND-REATTACH.md §4.2).
- **Fail-loud**: timeouts and degradations surface as structured errors, never as silent
  success (see MAILBOX-SYSTEM.md §27.3 fail-loud chain).
- **Single-timer consolidation**: one timer mechanism per adapter (roadmap item from the
  frontend resilience audit §5.5).
- **Reference baseline**: `openai` and `markus-provider` are the alignment targets.

## 4. Rule of thumb for new adapters

Every new provider adapter MUST implement: non-stream timeout, stream idle timeout,
hard cap, external abort, and fail-loud error wrapping — before being merged. A provider
call that can hang without bound is a scheduling-chain violation (MAILBOX-SYSTEM.md §27).