# AI Engineer — Heartbeat Protocol

This document defines the periodic self-check and status broadcast procedures for the AI Engineer agent. These heartbeat actions ensure that experiment results are properly recorded, model artifacts are versioned, and the team is aware of ongoing training progress.

## Periodic Activities

### Every Heartbeat Cycle

Run the following checks in order:

1. **[Status Broadcast]** Use `agent_broadcast_status` to advertise availability. Set `available_capacity` based on current training load (number of active experiments running).
2. **[Experiment Progress]** Check whether any spawned subagent experiments have completed. Collect results from finished experiments using `memory_search` for experiment logs.
3. **[Memory Sync]** Review `memory_list` for recent experiment results. If any results contain valuable findings (best hyperparameters, model comparisons), promote them to long-term knowledge using `memory_update_longterm`.
4. **[Pending Reviews]** Check for any `task_list` items in "review" status assigned to you. Complete outstanding reviews promptly.

### Every 3 Cycles (Deep Check)

1. **[Artifact Cleanup]** Review deliverables registered via `deliverable_create`. Update status of outdated or superseded model cards to "outdated."
2. **[Knowledge Consolidation]** Scan recent experiments and extract reusable insights (e.g., "learning_rate 1e-4 works best for fine-tuning ViT on medical imaging"). Save to long-term memory.
3. **[Pipeline Health]** Check if any training scripts or evaluation pipelines need updates. Flag issues in task notes.

### Every 10 Cycles (Strategic Review)

1. **[Research Refresh]** Use `web_search` to check for new ML research relevant to current projects (e.g., "latest ViT improvements 2026", "SOTA text classification benchmarks").
2. **[Methodology Review]** Evaluate whether current training and evaluation practices need updating. Review POLICIES.md compliance.
3. **[Tooling Assessment]** Check if platform tools are being used effectively. Identify opportunities to parallelize experiments or automate routine tasks.

## Status Broadcasting

When broadcasting status via `agent_broadcast_status`:

```yaml
# Example: Working on experiments
status: "working"
available_capacity: 60  # Running 2 active experiments, capacity for 1 more
skills_available: "model-training, hyperparameter-tuning, model-evaluation"

# Example: Idle and ready
status: "idle"
available_capacity: 100
skills_available: "model-training, hyperparameter-tuning, model-evaluation, mlops"

# Example: Blocked
status: "blocked"
available_capacity: 0
skills_available: "model-evaluation"  # Can still evaluate while waiting for data
```

## Consistency Checks

Before submitting any task for review, verify:

- [ ] **Reproducibility**: All experiments have recorded config, data version, and random seeds
- [ ] **Metrics**: All evaluation metrics are clearly reported with context (baseline comparison)
- [ ] **Artifacts**: Model weights, configs, and evaluation logs are saved and referenced
- [ ] **Limitations**: Documented any known failure modes, biases, or edge cases
- [ ] **Memory**: Key experimental findings are saved to memory for future reference
- [ ] **Deliverables**: Model cards and experiment reports are registered with `deliverable_create`

## Recovery Procedures

### Experiment Failure

If a training experiment fails:
1. **Record the error**: Log the error message, config, and stack trace to `memory_save`
2. **Diagnose**: Check for common issues (OOM, NaN gradients, data loading errors, dependency mismatches)
3. **Retry with fix**: Adjust config or environment and retry
4. **Escalate**: If failure persists despite reasonable fixes, create a task for investigation

### Data Quality Issues

If data quality problems are detected during training:
1. **Flag immediately**: Note the issue and its impact on model quality
2. **Coordinate**: Send message to Data Engineer with specific findings
3. **Document**: Record the data issue and resolution in experiment notes

### Model Degradation

If a deployed model shows performance degradation:
1. **Quantify**: Measure the performance drop and compare to baseline
2. **Investigate**: Check for data drift, concept drift, or infrastructure changes
3. **Report**: Document findings and recommend retraining or rollback strategy
