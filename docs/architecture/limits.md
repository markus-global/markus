# Platform limits — what exists, who it protects, whether you can change it

Every numeric limit in Markus answers one question: **who is hurt if it is missing?**
That question is the admission rule. A limit with no victim is a bug, not a policy.

```
victim = nobody            → delete the limit
victim = the user himself  → keep it, expose it in Settings, pick a sane default
victim = the system        → keep it, derive the default from the hardware, don't expose it
victim = other people      → keep it, expose it (fairness is negotiable by the owner)
```

This document is the registry of decisions. Adding a limit without adding a row here is
the defect this file exists to prevent — the same way `packages/shared/src/limits.ts` is
the single place a numeric constant may live.

## 1. Exposed in Settings (the victim is the user, and only the user can judge it)

| Limit | Default | Where | Why the user decides |
|---|---|---|---|
| Pending requirement proposals / agent | 10 (was 3) | Settings → Execution | An agent's own backlog. Only the owner knows how many proposals he is willing to triage. |
| Pending tasks / agent | 20 | Settings → Execution | Same family — per-agent queue depth. |
| Tool iterations per turn | 0 (unlimited) | Settings → Execution | Trades token spend against how much autonomy one turn gets. |
| Concurrent workers | `min(8, max(2, cores-1))` | Settings → Execution | Buy speed with CPU/memory and provider rate limits. |

**Retired:** an org-wide cap on total active tasks existed as a governance-policy field that
defaulted to 0 (unlimited) and had no UI to turn it on — a gate that can never fire. Removed
on the owner's call (2026-11-27); `checkTaskLimits` no longer reads it, and the type field is
kept only as an optional, unread residue for persisted project JSON (removal condition is
documented at the field).

Note on `0`: it means **unlimited**, never "forbidden". Any UI that renders these must say
"unlimited" rather than showing a bare `0` — the number reads as a prohibition to everyone
who did not write the code.

## 2. Kept, with a sane default, deliberately not exposed (the victim is the system)

| Limit | Value | Victim it protects | Why no knob |
|---|---|---|---|
| Image upload size | 10 MB (was 2 MB) | disk | 2 MB rejected ordinary phone screenshots; 10 MB still bounds a runaway upload. Nobody benefits from choosing another number. |
| Files per upload request | 10 | process memory (each entry is buffered during parse) | Already bounded together with the size cap. |
| A2A nesting depth | 20 | stack | A recursion guard, not a product policy. |
| Review settlement batch | 1000 | memory | Internal batching ceiling. |
| Mailbox processing timeout | 45 min of **inactivity** | hung turns | Measures silence, not duration: a long multi-tool turn is never interrupted. |
| Task/mailbox retry counts | 3 / 2 / 8 | provider rate limits | Retrying the same failure rarely self-corrects. |

## 3. Internal, never surfaced (implementation detail)

Tool-response sizes (`TASK_GET_NOTES_DEFAULT`), prompt section budgets
(`PROMPT_*_CHARS`), pagination caps (`TASK_LIST_PAGE_MAX`), archive ages, TTLs. Exposing
these would add dozens of knobs that no user can reason about, and turning them the wrong
way silently degrades prompt quality. They belong in code review, not in Settings.

## 4. Changed in this pass, and why

- **Pending requirement proposals 3 → 10, now configurable.** The original value was a
  `private static readonly 3` inside the service — the owner could neither see it nor
  change it. Three concurrent proposals is not a "backlog", it is a working set; an agent
  hit the wall and could not file a fourth (2026-11-27, live).
- **Image upload 2 MB → 10 MB.** No victim: the bytes land in the local avatars directory.
- **Concurrent workers 3 → derived from CPU cores.** A hard-coded 3 only fits the
  developer's laptop; on an 18-core machine it left 15 cores idle. The default now comes
  from the hardware, and an explicit setting still wins.

## 6. Saving model (why there are no Save buttons)

The Execution tab used to have one Save button per group. Two groups, two buttons, and
the failure was structural: change the top group, change the bottom group, press one
button — the other group silently keeps its old value. Fields now auto-save with a 600 ms
debounce, out-of-order responses are discarded by sequence number, and a pending write is
flushed on unmount so switching tabs never loses an edit. The UI only reports state
(saving / saved / failed) instead of asking the user to remember to commit.

The **knowledge-injection budget** (`knowledgeInjectionCapChars` → 6000 execute / 4800
converse chars) caps how much of its own curated knowledge an agent can see in one turn.
Its victim is the owner's token bill, so by the rule above it belongs in group 1 — but
raising it raises cost on every single turn, and the current value was chosen deliberately
against a documented ceiling ("never 15 000"). Changing it needs the owner's call on
cost-vs-capability, so it stays as-is and is listed here instead of being quietly raised.
