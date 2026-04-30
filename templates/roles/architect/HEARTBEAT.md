# Architect Agent — Heartbeat Behavior

This document defines the Architect Agent's recurring activities during idle heartbeat cycles. Heartbeat execution runs periodically when no active tasks are assigned, serving as proactive maintenance and vigilance for the system architecture.

## Heartbeat Cadence

| Activity | Frequency | Priority | Description |
|----------|-----------|----------|-------------|
| ADR Index Health Check | Every cycle | High | Verify ADR index is consistent with actual ADR files on disk |
| Recent ADR Review | Every cycle | High | Review any ADRs in "Proposed" status that may need attention |
| Dependency Snapshot | Every 24h | Medium | Run a lightweight dependency audit on watched repositories |
| Technology Radar Scan | Every 72h | Low | Research emerging technologies relevant to the stack |
| Architecture Debt Review | Weekly | Medium | Review open architecture debt items and their status |
| ADR Stale Check | Weekly | Low | Check if any accepted ADRs may need re-evaluation due to context changes |

## Heartbeat Workflow

### 1. ADR Index Health Check (Every Cycle)

```
1. Search for all ADR files matching pattern `adr-*.md` in the workspace
2. Read `adr-index.md` to get the canonical list
3. Compare: are there ADRs on disk not in the index? Are there entries in the index with no corresponding file?
4. If discrepancies found, fix the index and log via memory_save
5. Check for ADRs with status "Proposed" that have been open > 7 days — flag for attention
```

### 2. Dependency Health Scan (Every 24h)

For each watched repository:

1. Run dependency listing command appropriate to the language stack
2. Check for:
   - Deprecated packages (markers in version strings like `deprecated`, `abandoned`)
   - Known CVE references in dependency metadata
   - Major version gaps (dependency lagging behind latest by > 2 major versions)
   - Peer dependency conflicts
3. If critical dependency issues found, create a task via `task_create`

### 3. Technology Radar Scan (Every 72h)

1. Use `web_search` to check for significant updates in the project's technology stack
2. Focus on:
   - Major version releases of core technologies
   - Security advisories affecting current dependencies
   - End-of-life announcements
   - Emerging alternative technologies with significant traction
3. Log findings via `memory_save` for future reference

### 4. Architecture Debt Review (Weekly)

1. Review the technical debt inventory
2. Check if any debt items have been resolved (and update their status)
3. Identify if any new debt has accumulated based on recent code changes
4. Re-prioritize debt items based on current project velocity and focus areas
5. Update task priorities for any delegated remediation tasks

### 5. ADR Stale Check (Weekly)

1. For each accepted ADR older than 90 days, briefly assess if the context has changed
2. Triggers for re-evaluation:
   - New technology releases that change the trade-off landscape
   - Significant changes in team composition or organizational priorities
   - New requirements that conflict with the original decision's assumptions
   - Operational incidents that reveal weaknesses in the decision
3. If re-evaluation is warranted, create a new ADR that supersedes the old one

## Heartbeat Tool Usage

| Activity | Tools Used |
|----------|-----------|
| ADR Index Check | `glob_find` (find ADR files), `file_read` (read index), `file_write` (update index), `deliverable_create` (register new ADRs) |
| Dependency Scan | `shell_execute` (run dependency tools), `grep_search` (find deprecation markers), `memory_save` (log findings) |
| Technology Radar | `web_search` (research), `memory_save` (log insights) |
| Debt Review | `task_list` (check existing tasks), `memory_search` (recall debt inventory), `task_update` (update priorities) |
| ADR Stale Check | `file_read` (review old ADRs), `memory_search` (recall context changes), `memory_save` (note re-evaluation needs) |

## Output Standards for Heartbeat Results

All heartbeat findings should be recorded concisely:

- **No issues found**: One-line confirmation (e.g., "ADR index consistent — 12 ADRs, all accounted for.")
- **Issues found**: Brief structured entry per issue with severity and suggested action
- **Critical issues**: Immediately create a task via `task_create` — do not wait for the heartbeat cycle to complete

## Heartbeat Logging

All heartbeat activities are logged via `memory_save` with tag "heartbeat" for traceability. Log format:

```
[Heartbeat] {YYYY-MM-DD HH:MM} {Activity} — {Summary of findings}
```
