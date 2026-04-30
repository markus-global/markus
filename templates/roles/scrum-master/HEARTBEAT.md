# Scrum Master — Heartbeat Guide

This document defines the periodic (heartbeat) activities that the Scrum Master executes on a regular cadence. Heartbeats keep the Sprint rhythm consistent and ensure no ceremony or tracking activity is missed.

---

## Daily Heartbeat — Standup & Blockers

**Trigger**: Every business day (configurable via schedule)

### Steps

1. **`task_list` — Query All Active Sprint Tasks**
   - Filter by the active Sprint's project_id
   - Group by status: pending, in_progress, blocked, review
   - Note counts and distribution for standup context

2. **`task_list` — Check for Blocked Tasks**
   - Filter: status=blocked
   - For each blocked task, use `task_get` to read the latest notes and understand the blocker
   - Check blocker duration — flag any over 24 hours

3. **Facilitate Standup (via agent_send_message)**
   - Send standup prompts to each active team member
   - Ask the three questions: what was done, what's next, what's blocked
   - Collect responses and identify coordination needs

4. **Blocker Resolution Coordination**
   - For new blockers: `agent_send_message` to the blocking agent to negotiate resolution
   - For stuck blockers (>24h): `notify_user` to escalate with blocker summary
   - Log action items and expected resolution time

5. **`memory_save` — Log Daily Summary**
   - Type: "note"
   - Tags: "daily-standup, yyyy-mm-dd, sprint-N"
   - Content: Brief summary of what was discussed, blockers identified, action items

6. **`task_note` — Update Affected Tasks**
   - Add progress notes to tasks with new blocker information or resolution updates

---

## End-of-Sprint Heartbeat — Review & Retrospective

**Trigger**: Last day of Sprint (configurable via schedule)

### Steps

1. **`task_list` — Collect Sprint Completion Data**
   - All tasks created for this Sprint
   - Count completed vs. incomplete vs. blocked
   - Identify carried-over tasks

2. **`memory_search` — Retrieve Historical Velocity**
   - Search: "sprint metrics" or "velocity"
   - Pull last 3 Sprints of velocity data for trend comparison

3. **Compile Sprint Metrics**
   - Planned vs. Actual story points/tasks
   - Completion rate %
   - Blocker count and avg resolution time
   - Cycle time (where available)
   - Velocity trend (current vs rolling average)

4. **`memory_save` — Persist Sprint Metrics**
   - Type: "fact"
   - Tags: "sprint-metrics, sprint-N, velocity"
   - Content: Structured metrics data for future reference and forecasting

5. **Facilitate Retrospective (via agent_send_message)**
   - Send retrospective prompts to each team member
   - Collect input on: What worked well? What could be improved? What puzzles us?
   - Synthesize into 1-3 actionable improvement experiments

6. **`memory_save` — Log Retrospective Outcomes**
   - Type: "insight"
   - Tags: "retrospective, sprint-N, action-items"
   - Content: Retro format used, key findings, committed improvement experiments

7. **`requirement_propose` — Submit Process Improvements**
   - If retro identified tooling, policy, or workflow changes requiring approval
   - Link to the retrospective findings as rationale

8. **`deliverable_create` — Publish Sprint Report**
   - Type: "file"
   - Title: "Sprint N Report — YYYY-MM-DD"
   - Summary: Sprint goal, completion stats, velocity, blocker log, retro outcomes
   - Reference: Path to the generated Sprint Report file
   - Tags: "sprint-report, sprint-N"

---

## Weekly / Mid-Sprint Heartbeat — Health Check

**Trigger**: Mid-point of each Sprint (or weekly for longer Sprints)

### Steps

1. **`task_list` — Mid-Sprint Health Scan**
   - Check completion progress vs. Sprint duration elapsed
   - Flag tasks at risk of not completing
   - Check for new blockers that emerged this week

2. **`task_list` — Backlog Audit**
   - Review stale tasks (no updates in 5+ days)
   - Check for unassigned tasks
   - Verify blocked tasks have active resolution efforts

3. **Coordination Outreach**
   - `agent_send_message` to team members on at-risk tasks to offer support
   - Check if scope creep or unplanned work has entered the Sprint

4. **`memory_save` — Mid-Sprint Snapshot**
   - Type: "note"
   - Tags: "mid-sprint, health-check, sprint-N"
   - Content: Progress against Sprint Goal, risks identified, correction actions

---

## On-Demand Heartbeat — Blocker Escalation

**Trigger**: When a task has been blocked for >24 hours without resolution

### Steps

1. **`task_get` — Full Context on Blocked Task**
   - Read all notes and comments
   - Identify the blocking party and the exact nature of the blocker

2. **`agent_send_message` — Direct Resolution Attempt**
   - Message the blocking agent/stakeholder
   - State: what is needed, why it's needed, by when
   - Request confirmation or alternative approach

3. **Escalation (if still unresolved after 24h)**
   - `notify_user` with:
     - Task ID and title
     - Duration of block
     - Impact on Sprint Goal
     - Attempted resolution steps
     - Suggested escalation path

4. **`task_note` — Document Escalation**
   - Record that escalation occurred, who was notified, and any response

---

## Heartbeat Configuration Notes

The heartbeat cadence should be configured via scheduled tasks:

| Heartbeat | Schedule | Priority |
|-----------|----------|----------|
| Daily Standup | Every business day (e.g., 9:00 AM) | High |
| Mid-Sprint Health Check | Weekly (Wednesdays) | Medium |
| End-of-Sprint Retrospective | Last day of Sprint | High |
| Blocker Escalation | On-demand / triggered | Urgent |

Configure `task_create` with `task_type: "scheduled"` and appropriate `schedule` values for recurring heartbeats.
