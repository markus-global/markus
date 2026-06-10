---
name: workflow-building
description: Design and create workflow templates — YAML format, DAG patterns, scheduling, and role mapping
---

# Workflow Building

This skill teaches you how to create **workflow templates** — YAML-based definitions of multi-step processes that are executed as a DAG (Directed Acyclic Graph) of tasks. Each step is assigned to a team member by role and runs automatically with dependency tracking.

## When to Use Workflows

Workflows are for **repeatable, multi-step processes** where:
- Multiple agents need to collaborate in a defined sequence
- Steps have clear dependencies (B waits for A to finish)
- The same process runs repeatedly with different parameters
- You want automatic scheduling (daily, weekly, etc.)

**Do NOT use workflows for**: one-off tasks, simple single-agent work, or ad-hoc coordination.

## How to Create Workflows

There are two ways to create a workflow, depending on context:

### For an existing (live) team

Use the `workflow_create` tool:
```
workflow_create(name: "content-publishing", yaml: "<full YAML content>")
```
This writes the YAML file directly to `~/.markus/teams/{teamId}/workflows/`.

### For a team package (builder artifact)

Write the YAML file via `file_write` to the team's artifact directory, then reference it in `team.json`:

```
file_write("~/.markus/builder-artifacts/teams/{team-name}/workflows/my-workflow.yaml", "<YAML content>")
```

In `team.json`, add:
```json
{
  "team": {
    "members": [...],
    "workflows": ["workflows/my-workflow.yaml"]
  }
}
```

The workflow YAML files are copied to `~/.markus/teams/{teamId}/workflows/` when the team is installed.

## YAML Format Reference

### Top-Level Fields

```yaml
name: content-publishing           # REQUIRED. Identifier (kebab-case, English)
displayName: Content Publishing    # Optional. Human-readable name (any language)
description: Research, write, ...  # REQUIRED. What this workflow does
version: "1.0.0"                   # REQUIRED. Semver

schedule:                          # Optional. Auto-trigger configuration
  every: "1d"                      #   Interval shorthand: 30m, 6h, 1d, 1w
  cron: "0 9 * * 1-5"             #   OR cron expression
  run_at: "2025-06-01T09:00:00Z"  #   OR one-shot ISO timestamp
  timezone: "Asia/Shanghai"        #   IANA timezone (default: server local)
  max_runs: 10                     #   Stop after N runs (0 = unlimited)

params:                            # Optional. User-provided or auto-generated inputs
  - name: topic                    #   Referenced as {{topic}} in step prompts
    type: string                   #   string | enum | text | agent
    label: "Content Topic"
    required: true
  - name: platform
    type: enum
    options: ["wechat", "zhihu", "xiaohongshu", "x.com"]
    default: "wechat"

steps:                             # REQUIRED. The task DAG (at least one step)
  - id: research
    name: Research Topic
    type: agent_task
    role: researcher
    prompt: "Research {{topic}} thoroughly and produce a summary."
    priority: high
```

### Step Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier within the workflow |
| `name` | Yes | Human-readable step name |
| `type` | Yes | Always `agent_task` |
| `role` | Yes | Role placeholder mapped to a team member at run time |
| `prompt` | Yes | Task description. Supports `{{param}}` interpolation |
| `depends_on` | No | Array of step IDs that must complete first |
| `inputs` | No | Upstream deliverable references (see below) |
| `reviewer` | No | Role that reviews this step (defaults to team manager) |
| `priority` | No | `low`, `medium`, `high`, or `urgent` |
| `timeout` | No | Step timeout shorthand, e.g. `"30m"`, `"2h"` |
| `retry_count` | No | Number of retries on failure (default: 0) |

### Parameter Types

| Type | Description |
|------|-------------|
| `string` | Free-form text input |
| `enum` | Dropdown selection from `options[]` |
| `text` | Multi-line text input |
| `agent` | Agent ID picker |

### Built-in Template Variables

These are available in all step prompts without declaring params:
- `{{date}}` — Current date (YYYY-MM-DD)
- `{{time}}` — Current date and time (YYYY-MM-DD HH:MM)
- `{{run_number}}` — Sequential run number for this workflow

### Upstream Inputs

When a step depends on another step's output, use `inputs` to create a named reference:

```yaml
steps:
  - id: research
    name: Research
    type: agent_task
    role: researcher
    prompt: "Research {{topic}} and produce a summary document."

  - id: write
    name: Write Draft
    type: agent_task
    role: writer
    depends_on: [research]
    inputs:
      - from: research       # Step ID of the upstream step
        as: research_notes    # Variable name in this step's context
    prompt: "Write a draft about {{topic}} using the upstream research."
```

The system automatically injects context about upstream deliverables into the step's prompt. The downstream agent can use `task_get` to retrieve the upstream step's full deliverables.

## DAG Design Patterns

### Linear Chain

Steps run one after another. Simple and predictable.

```yaml
# A → B → C
steps:
  - id: research
    name: Research
    type: agent_task
    role: researcher
    prompt: "Research the topic."

  - id: write
    name: Write
    type: agent_task
    role: writer
    depends_on: [research]
    prompt: "Write based on research."

  - id: review
    name: Review
    type: agent_task
    role: editor
    depends_on: [write]
    prompt: "Review and finalize the draft."
```

### Fan-Out (Parallel)

Multiple independent steps run simultaneously after a shared predecessor.

```yaml
#        ┌→ write_cn
# plan ──┤
#        └→ write_en
steps:
  - id: plan
    name: Plan Content
    type: agent_task
    role: editor
    prompt: "Create content outline for {{topic}}."

  - id: write_cn
    name: Write Chinese Version
    type: agent_task
    role: chinese_writer
    depends_on: [plan]
    inputs: [{ from: plan, as: outline }]
    prompt: "Write the Chinese version based on the outline."

  - id: write_en
    name: Write English Version
    type: agent_task
    role: english_writer
    depends_on: [plan]
    inputs: [{ from: plan, as: outline }]
    prompt: "Write the English version based on the outline."
```

### Fan-In (Aggregation)

One step waits for multiple parallel steps to complete.

```yaml
#  write_cn ──┐
#             ├→ publish
#  write_en ──┘
steps:
  # ... (plan, write_cn, write_en as above)

  - id: publish
    name: Final Review & Publish
    type: agent_task
    role: editor
    depends_on: [write_cn, write_en]
    inputs:
      - { from: write_cn, as: chinese_draft }
      - { from: write_en, as: english_draft }
    prompt: "Review both drafts and prepare for publishing."
```

### Diamond

Combination of fan-out and fan-in — a common pattern for parallel work with consolidation.

```yaml
#        ┌→ B ──┐
#  A ────┤      ├→ D
#        └→ C ──┘
```

## Role Design

Roles are **placeholders** that get mapped to actual team members at run time. The system auto-resolves roles by matching role names to agent names, skills, or role types.

**Best practices:**
- Use descriptive role names that match your team composition: `editor`, `chinese_writer`, `researcher`, `reviewer`
- Each role should map to a distinct team member or function
- The `reviewer` field defaults to the team manager — only override if a specific specialist should review
- Keep role names consistent across workflows in the same team

## Schedule Configuration

### Interval-Based

```yaml
schedule:
  every: "6h"        # Run every 6 hours
  timezone: "Asia/Shanghai"
```

Supported units: `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks).

### Cron-Based

```yaml
schedule:
  cron: "0 9 * * 1-5"   # Weekdays at 9am
  timezone: "Asia/Shanghai"
```

Standard 5-field cron: minute, hour, day-of-month, month, day-of-week.

### One-Shot

```yaml
schedule:
  run_at: "2025-07-01T09:00:00+08:00"
```

Fires once at the specified time, then stops.

## Complete Examples

### Example 1: Content Publishing Pipeline

A 4-step pipeline for a content team: plan → parallel writing → review.

```yaml
name: content-publishing
displayName: Content Publishing Pipeline
description: Plan content, write in parallel across platforms, then review and publish
version: "1.0.0"

params:
  - name: topic
    type: string
    label: Content Topic
    required: true
    description: The main topic or theme for this content batch
  - name: target_platforms
    type: text
    label: Target Platforms
    default: "WeChat, Xiaohongshu, X.com"

steps:
  - id: plan
    name: Content Planning
    type: agent_task
    role: editor
    priority: high
    prompt: |
      Create a detailed content plan for: {{topic}}
      Target platforms: {{target_platforms}}

      Produce:
      1. Content angle and key messages
      2. Platform-specific adaptation notes
      3. Target audience for each platform
      4. SEO keywords / hashtags

  - id: write_chinese
    name: Write Chinese Content
    type: agent_task
    role: chinese_writer
    depends_on: [plan]
    inputs: [{ from: plan, as: content_plan }]
    prompt: |
      Write Chinese content about {{topic}} following the content plan.
      Produce drafts for WeChat public account and Zhihu.

  - id: write_xhs
    name: Write Xiaohongshu Notes
    type: agent_task
    role: xhs_operator
    depends_on: [plan]
    inputs: [{ from: plan, as: content_plan }]
    prompt: |
      Create Xiaohongshu notes about {{topic}} following the content plan.
      Produce 2-3 note drafts with title, body, hashtags, and image descriptions.

  - id: review_and_publish
    name: Editorial Review
    type: agent_task
    role: editor
    depends_on: [write_chinese, write_xhs]
    inputs:
      - { from: write_chinese, as: chinese_drafts }
      - { from: write_xhs, as: xhs_drafts }
    prompt: |
      Review all content drafts for {{topic}}.
      Check for consistency, quality, and brand voice alignment.
      Provide final approval or revision notes for each piece.
```

### Example 2: Research Report

A linear pipeline: research → analyze → write report.

```yaml
name: research-report
displayName: Research & Report
description: Deep research on a topic, data analysis, and formatted report
version: "1.0.0"

params:
  - name: research_question
    type: text
    label: Research Question
    required: true
  - name: depth
    type: enum
    options: ["brief", "standard", "deep-dive"]
    default: "standard"

steps:
  - id: research
    name: Gather Sources
    type: agent_task
    role: researcher
    priority: high
    timeout: "2h"
    prompt: |
      Research: {{research_question}}
      Depth level: {{depth}}

      Gather information from multiple sources. Save key findings,
      data points, and source references as deliverables.

  - id: analyze
    name: Analyze Findings
    type: agent_task
    role: analyst
    depends_on: [research]
    inputs: [{ from: research, as: raw_findings }]
    prompt: |
      Analyze the research findings for: {{research_question}}
      Identify patterns, insights, and actionable conclusions.
      Produce a structured analysis document.

  - id: report
    name: Write Final Report
    type: agent_task
    role: writer
    depends_on: [analyze]
    inputs: [{ from: analyze, as: analysis }]
    prompt: |
      Write a comprehensive report on: {{research_question}}
      Use the analysis to structure the report with:
      - Executive summary
      - Key findings
      - Detailed analysis
      - Recommendations
      Format as a polished HTML deliverable.
```

### Example 3: Scheduled Daily Digest

An automatically triggered daily workflow.

```yaml
name: daily-digest
displayName: Daily Content Digest
description: Automatically gather and summarize daily updates
version: "1.0.0"

schedule:
  cron: "0 9 * * 1-5"
  timezone: "Asia/Shanghai"

steps:
  - id: gather
    name: Gather Updates
    type: agent_task
    role: researcher
    prompt: |
      Gather today's updates and news for {{date}}.
      Check industry trends, competitor activity, and team progress.

  - id: summarize
    name: Write Daily Summary
    type: agent_task
    role: writer
    depends_on: [gather]
    inputs: [{ from: gather, as: updates }]
    prompt: |
      Write a concise daily digest for {{date}} (run #{{run_number}}).
      Summarize the key updates and highlight action items.
```

## Validation Rules

The system validates your YAML before saving. Common errors:
- **Missing required fields**: `name`, `description`, `version`, and at least one step
- **Each step requires**: `id`, `name`, `role`, `prompt`
- **Duplicate step IDs**: every `id` must be unique
- **Invalid `depends_on` references**: must reference existing step IDs
- **Circular dependencies**: the DAG must be acyclic (A→B→C→A is invalid)
- **Enum params without options**: `type: enum` requires a non-empty `options[]`
- **Invalid schedule**: must have at least one of `every`, `cron`, or `run_at`

## Rules

- **Keep workflows focused**: each workflow should serve one clear purpose. Don't combine unrelated processes.
- **Role names must match team composition**: roles are resolved to team members. Use names that correspond to the team's actual member names or skills.
- **Write clear prompts**: each step's prompt should be self-contained enough for the assigned agent to execute without ambiguity. Include expected outputs.
- **Use `depends_on` for ALL dependencies**: if step B needs output from step A, it MUST list A in `depends_on`. Without this, steps run in parallel.
- **Use `inputs` for deliverable passing**: when a downstream step needs to reference upstream output, declare it in `inputs` so the system injects the context.
- **Test incrementally**: start with 2-3 steps and validate before adding complexity.
- **The `name` field MUST be English kebab-case** (e.g., `content-publishing`, `daily-report`).
