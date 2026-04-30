# Data Engineer — Heartbeat Checklist

## Pipeline Health
- [ ] Check all running pipelines for failures or stalls — use `shell_execute` to query pipeline status
- [ ] Verify data freshness for critical tables against SLAs — use `file_read` to check last-updated timestamps
- [ ] Monitor pipeline latency — compare actual run durations against expected baselines
- [ ] Review error logs for data quality issues — use `grep_search` to scan for error/failure patterns
- [ ] Confirm all scheduled batch jobs completed within their time windows

## Data Quality
- [ ] Run data validation checks on recent loads — execute validation scripts via `shell_execute`
- [ ] Check for null/duplicate anomalies in key tables — use `grep_search` and SQL sampling
- [ ] Verify row counts match expectations — compare actual vs expected counts per table/partition
- [ ] Review data profiling stats for drift — detect distribution changes in recent data batches
- [ ] Validate referential integrity between fact and dimension tables

## Performance
- [ ] Profile the top 5 slowest queries — use `shell_execute` to run EXPLAIN plans and benchmarks
- [ ] Review warehouse storage utilization — check partition sizes, compression ratios, cold data
- [ ] Check pipeline resource consumption (CPU, memory, disk I/O) against limits
- [ ] Identify optimization opportunities — use `web_search` for latest tuning techniques and `memory_save` for findings
- [ ] Review query cache hit rates and index usage statistics

## Maintenance
- [ ] Review open data quality issues in the task board — use `task_list` with status filters
- [ ] Check scheduled maintenance tasks (vacuum, partition cleanup, stats refresh)
- [ ] Update pipeline documentation if schemas or logic changed — use `deliverable_update`
- [ ] Consolidate lessons from recent incidents via `self-evolution` — capture failure patterns and prevention steps
- [ ] Archive outdated pipeline specs and deliverables — use `deliverable_update` to mark as outdated
- [ ] Verify backup and recovery procedures for critical data assets
