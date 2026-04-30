# SRE Agent — Heartbeat Routine

This document defines the SRE Agent's periodic heartbeat activities — automated check-in routines that run on a scheduled basis to monitor system health, review operational metrics, and surface proactive recommendations before incidents occur.

---

## Heartbeat Schedule

| Frequency | Activity | Purpose |
|-----------|----------|---------|
| **Every 15 min** | Quick Health Scan | Check critical service endpoints and core SLIs |
| **Every 1 hour** | Alert & Incident Review | Review active alerts, acknowledge unacknowledged pages, check incident queue |
| **Every 4 hours** | SLO Burn Rate Check | Verify error budget consumption, flag burning SLOs |
| **Every 12 hours** | Runbook Audit | Check if any runbooks need validation or updates |
| **Daily** | Reliability Report | Summarize daily incident activity, SLO status, and action item progress |
| **Weekly** | Capacity & Trend Review | Analyze growth trends, forecast resource needs, review error budget trends |

---

## Every 15 min — Quick Health Scan

**Objective**: Detect critical availability issues within seconds of occurrence.

### Steps

1. **Ping critical service endpoints**
   - Use `shell_execute` with `curl -I -f -s -o /dev/null -w "%{http_code}"` against Tier 1 service health endpoints
   - Check: API gateway, authentication service, task executor, LLM proxy
   - Expected: HTTP 200/204 within timeout (≤5s)

2. **Verify last-known-good state**
   - Compare current endpoint responses against last heartbeat
   - If any endpoint returned non-200 in this or the previous heartbeat → escalate

3. **Check process health**
   - Use `shell_execute` with `ps aux | grep -c <service>` for critical daemon processes
   - Verify expected process count against baseline

4. **Quick disk/CPU/memory check**
   - `df -h` — flag any mount point above 85% utilization
   - `uptime` — flag load average > 2× CPU core count
   - Free memory — flag if below 10% of total

### Escalation

If any quick health check fails:
- Immediately escalate with `notify_user` (P0/P1 based on impact)
- Begin incident response per ROLE.md and POLICIES.md
- Document finding in heartbeat log

---

## Every 1 hour — Alert & Incident Review

**Objective**: Ensure no alert has been missed or left unacknowledged. Review incident queue for stale items.

### Steps

1. **Check active alert count**
   - Query alert manager or monitoring system for current firing alerts
   - Categorize by severity: P0/P1/P2/P3
   - Flag any P0/P1 alert still firing for >15 min without acknowledgment

2. **Review unacknowledged pages**
   - Check if any `notify_user` notifications have pending acknowledgments
   - Re-escalate any P0/P1 notifications not acknowledged within policy time

3. **Check incident timeline staleness**
   - Review open incidents — if the last update was >30 min ago for a P0 or >60 min ago for a P1, send status request
   - If no response, escalate per escalation rules

4. **Log heartbeat status**
   - Use `memory_save` to record: `Heartbeat {timestamp}: {N} active alerts, {N} incidents, {service}: OK/FAIL`

---

## Every 4 hours — SLO Burn Rate Check

**Objective**: Detect SLO violations in progress before the error budget is depleted.

### Steps

1. **Calculate current burn rate**
   - For each Tier 1 SLO, compute: `(1 — current_sli_value) / (1 — slo_target) × 100%`
   - If > 0%, budget is being consumed

2. **Flag deviations**
   - **Rapid burn** (budget consuming >10%/hour): Alert — this could exhaust budget in <10 hours
   - **Sustained burn** (budget consuming >2%/hour over 24h): Issue warning
   - **Multi-day burn** (budget consuming >0.5%/hour over 7 days): Create ticket

3. **Recommend actions**
   - If any Tier 1 SLO is in rapid burn → `notify_user` with P1 priority
   - If budget is below 10% remaining → recommend change freeze per Error Budget Policy
   - Log findings: `SLO Burn Check {timestamp}: {SLO_name}: {burn_rate}%/h, {budget_remaining}% remaining`

---

## Every 12 hours — Runbook Audit

**Objective**: Ensure runbooks remain accurate and complete.

### Steps

1. **Check for recent incidents without runbooks**
   - Compare last 7 days of incidents against the runbook directory
   - Any failure mode without a runbook → create one using `file_write`

2. **Flag stale runbooks**
   - Review runbooks that have not been updated in >90 days
   - Flag for review with `task_create` if the associated system has been updated

3. **Validate runbook accuracy**
   - Spot-check 1–2 runbooks by reviewing the diagnosis commands
   - If commands reference removed or deprecated infrastructure, update the runbook

---

## Daily — Reliability Report

**Objective**: Provide a daily snapshot of system reliability status.

### Report Structure

```markdown
# Reliability Report — {YYYY-MM-DD}

## Summary
- Incidents today: P0: {N} / P1: {N} / P2: {N} / P3: {N}
- MTTA: {value} / MTTR: {value}
- SLO status: {Tier1_SLO_1}: ✅/{X}% breached | {Tier1_SLO_2}: ✅/{X}% breached

## Active Incidents
| ID | Severity | Service | Status | Age | Owner |
|----|----------|---------|--------|-----|-------|

## Health Check Results
| Service | Status | P50 Latency | P99 Latency | Error Rate |
|---------|--------|-------------|-------------|------------|
| {svc}   | ✅/❌  | {ms}       | {ms}        | {%}       |

## Error Budget Status
| SLO | Target | Current | Budget Used | Status |
|-----|--------|---------|-------------|--------|
| {slo} | {99.9%} | {99.95%} | {10%} | ✅ Healthy |

## Runbook Status
- Total runbooks: {N}
- Updated today: {N}
- Missing for recent incidents: {N}

## Action Items Due Soon
| # | Action | Owner | Due Date | Status |
|---|--------|-------|----------|--------|

## Recommendations
- {Reliability improvement suggestions}
```

Report is saved using `deliverable_create` and shared with the SRE team.

---

## Weekly — Capacity & Trend Review

**Objective**: Identify growth trends and resource constraints before they become availability risks.

### Steps

1. **Analyze growth trends**
   - Review 30-day trends for: request volume, active users, data storage, LLM token consumption
   - Calculate week-over-week growth rate
   - Extrapolate: "At current growth rate, we will hit {resource limit} in {N} weeks"

2. **Review SLO trend**
   - Check if any SLO has been degrading week-over-week for 3+ weeks
   - Flag sustained degradation as a reliability risk

3. **Review incident trend**
   - Compare incident counts week-over-week and month-over-month
   - Identify if a particular service or failure mode is becoming more frequent

4. **Update capacity forecast**
   - Write a capacity note: `Capacity Check W{week}: {service} growing {X}%/week, {N} weeks until {limit}`
   - If any resource is projected to exhaust within 4 weeks → `task_create` for capacity planning

5. **Publish weekly digest**
   - Use `deliverable_create` to publish the weekly reliability digest
   - Highlight: reliability trends, top incident types, SLO health, capacity alerts

---

## Heartbeat Log Format

Each heartbeat execution writes a concise entry using `memory_save`:

```
Heartbeat {YYYY-MM-DD HH:MM} | Type: {15min/1h/4h/12h/daily/weekly}
Health: gateway=✅(200), auth=✅(200), executor=✅(200), llm-proxy=✅(200)
Processes: {svc}=✅({N}/running), {svc}=✅({N}/running)
System: cpu=12%, mem=34%, disk=/data=62%, load=1.2
Alerts: 0 firing
Incidents: 0 open
SLO: availability=99.97%, latency-p99=185ms
Notes: {any anomalies, warnings, or escalations triggered}
```

---

## Heartbeat Failure Protocol

If the heartbeat itself encounters an error:

| Symptom | Action |
|---------|--------|
| `shell_execute` fails (tool unavailable) | Skip automated checks; rely on last-known-good state; retry in 5 min |
| `memory_save` fails | Log locally; retry on next heartbeat |
| All health checks timeout | Assume potential system-wide issue; escalate with `notify_user` |
| Partial health check failures | Report only the failed services; do not escalate on partial tool failures |

---

*The heartbeat routine is the SRE Agent's always-on vigilance layer — catching issues before they catch users.*
