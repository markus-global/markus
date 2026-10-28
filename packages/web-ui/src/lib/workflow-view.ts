/**
 * Workflows view — pure logic for the Work page's workflow cards.
 *
 * Everything here is deliberately framework-free and synchronous so the card
 * UI can stay a thin renderer and the interesting rules can be tested without
 * a DOM. The rules encoded here:
 *
 *   1. **A run's status is a fact with one wording table.** `RUN_STATUS_META`
 *      is the only place a status string becomes a tone + label; the old
 *      `statusBadge()` in Work.tsx hard-coded colours *and* printed the raw
 *      English status into a Chinese UI.
 *   2. **Steps are identified by id, shown by name.** `depends_on` holds ids;
 *      the UI must never print `step-1-research` at a human.
 *   3. **A "DAG" is layers + edges, not a row of chips.** `layeredDag()` does
 *      the topological layering the old "→ name → name" strip pretended to do.
 *   4. **Progress is derived, never guessed.** `computeProgress()` needs a
 *      step→task mapping; when there is none it returns `total: 0` so callers
 *      show nothing rather than a fabricated percentage.
 */

export interface WorkflowStepLike {
  id: string;
  name: string;
  role: string;
  depends_on?: string[];
  prompt: string;
}

export interface WorkflowTaskLike {
  id: string;
  title: string;
  status: string;
  notes?: string;
  /** Structural identity written by the runner (null on pre-2026-10 rows until backfilled). */
  workflowStepId?: string;
  workflowRunId?: string;
}

export type RunStatusTone = 'info' | 'warning' | 'success' | 'danger' | 'neutral';

export interface RunStatusMeta {
  tone: RunStatusTone;
  /** i18n key inside the `work:task.*` namespace. */
  key: string;
  /** Fallback used when the key is missing (also what tests assert on). */
  label: string;
}

/** The single status → wording/tone table for workflow runs. */
export const RUN_STATUS_META: Record<string, RunStatusMeta> = {
  running: { tone: 'info', key: 'runStatusRunning', label: '运行中' },
  paused: { tone: 'warning', key: 'runStatusPaused', label: '已暂停' },
  completed: { tone: 'success', key: 'runStatusCompleted', label: '已完成' },
  failed: { tone: 'danger', key: 'runStatusFailed', label: '失败' },
  cancelled: { tone: 'neutral', key: 'runStatusCancelled', label: '已取消' },
};

export const UNKNOWN_STATUS: RunStatusMeta = {
  tone: 'neutral',
  key: 'runStatusUnknown',
  label: '未知',
};

export function runStatusMeta(status: string | undefined | null): RunStatusMeta {
  if (!status) return UNKNOWN_STATUS;
  return RUN_STATUS_META[status] ?? { ...UNKNOWN_STATUS, label: status };
}

/** Class fragments per tone — one place, so a status never invents its own palette. */
export const TONE_CLASS: Record<RunStatusTone, { chip: string; dot: string; bar: string; text: string }> = {
  info: {
    chip: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    dot: 'bg-blue-500',
    bar: 'bg-blue-500',
    text: 'text-blue-600 dark:text-blue-400',
  },
  warning: {
    chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    bar: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
  },
  success: {
    chip: 'bg-green-500/15 text-green-600 dark:text-green-400',
    dot: 'bg-green-500',
    bar: 'bg-green-500',
    text: 'text-green-600 dark:text-green-400',
  },
  danger: {
    chip: 'bg-red-500/15 text-red-600 dark:text-red-400',
    dot: 'bg-red-500',
    bar: 'bg-red-500',
    text: 'text-red-600 dark:text-red-400',
  },
  neutral: {
    chip: 'bg-surface-elevated text-fg-tertiary',
    dot: 'bg-fg-muted',
    bar: 'bg-fg-muted',
    text: 'text-fg-tertiary',
  },
};

/** Terminal statuses that a human would call "done" for progress purposes. */
const DONE_STATUSES = new Set(['completed', 'archived']);
const FAILED_STATUSES = new Set(['failed', 'rejected']);
const ACTIVE_STATUSES = new Set(['in_progress', 'review']);

export function isRunActive(status: string | undefined | null): boolean {
  return status === 'running' || status === 'paused';
}

/** id → step, for rendering `depends_on` ids as names. */
export function buildStepIndex(steps: WorkflowStepLike[]): Map<string, WorkflowStepLike> {
  const index = new Map<string, WorkflowStepLike>();
  for (const step of steps) index.set(step.id, step);
  return index;
}

export function stepDisplayName(id: string, index: Map<string, WorkflowStepLike>): string {
  return index.get(id)?.name ?? id;
}

export function dependsOnNames(
  step: WorkflowStepLike,
  index: Map<string, WorkflowStepLike>,
): string[] {
  return (step.depends_on ?? []).map((id) => stepDisplayName(id, index));
}

/** Stable ordering: depth first, then declaration order. */
export function layeredDag(steps: WorkflowStepLike[]): {
  layers: string[][];
  depth: Record<string, number>;
  edges: Array<{ from: string; to: string }>;
} {
  const ids = new Set(steps.map((s) => s.id));
  const depth: Record<string, number> = {};
  const edges: Array<{ from: string; to: string }> = [];
  for (const step of steps) {
    for (const dep of step.depends_on ?? []) {
      if (ids.has(dep)) edges.push({ from: dep, to: step.id });
    }
  }

  // Iterative relaxation with a bounded number of passes: a malformed template
  // with a cycle must not hang the renderer, it just caps out.
  for (const step of steps) depth[step.id] = 0;
  for (let pass = 0; pass < steps.length; pass++) {
    let changed = false;
    for (const step of steps) {
      for (const dep of step.depends_on ?? []) {
        if (!ids.has(dep)) continue;
        const candidate = (depth[dep] ?? 0) + 1;
        if (candidate > (depth[step.id] ?? 0)) {
          depth[step.id] = candidate;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const maxDepth = steps.reduce((max, s) => Math.max(max, depth[s.id] ?? 0), 0);
  const layers: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const step of steps) layers[depth[step.id] ?? 0]!.push(step.id);
  return { layers, depth, edges };
}

/**
 * Map steps → their tasks **by structural identity**.
 *
 * Tasks created by a run carry `workflowStepId` from birth, so this is a plain
 * join. It used to reconstruct the relationship from a `step: <id>` marker in
 * `notes`, then a `[Workflow] Step name` title suffix, then positional order —
 * three guesses, all of which break when a human edits a title. The one-time
 * backfill (`migrateWorkflowTaskIdentity`) already moved historical rows onto
 * the column, so no runtime reader touches text any more.
 *
 * Unmapped steps stay unmapped (the UI lists the leftovers) instead of
 * inheriting a neighbouring step's status.
 */
export function matchTasksToSteps(
  steps: WorkflowStepLike[],
  tasks: WorkflowTaskLike[],
): Record<string, WorkflowTaskLike | undefined> {
  const byStep: Record<string, WorkflowTaskLike | undefined> = {};
  const used = new Set<string>();
  for (const task of tasks) {
    if (!task.workflowStepId) continue;
    if (byStep[task.workflowStepId]) continue; // first wins; duplicates are surfaced by the caller
    byStep[task.workflowStepId] = task;
    used.add(task.id);
  }
  // Steps with no task are simply absent from the map.
  for (const step of steps) {
    if (!(step.id in byStep)) byStep[step.id] = undefined;
  }
  return byStep;
}

export interface RunProgress {
  /** Tasks that exist for this run (0 when we could not map any). */
  total: number;
  done: number;
  failed: number;
  active: number;
  /** 0–100, only meaningful when `total > 0`. */
  percent: number;
  failedSteps: WorkflowStepLike[];
  activeSteps: WorkflowStepLike[];
}

export function computeProgress(
  steps: WorkflowStepLike[],
  mapped: Record<string, WorkflowTaskLike | undefined>,
): RunProgress {
  let total = 0;
  let done = 0;
  let failed = 0;
  let active = 0;
  const failedSteps: WorkflowStepLike[] = [];
  const activeSteps: WorkflowStepLike[] = [];

  for (const step of steps) {
    const task = mapped[step.id];
    if (!task) continue;
    total++;
    if (DONE_STATUSES.has(task.status)) done++;
    else if (FAILED_STATUSES.has(task.status)) {
      failed++;
      failedSteps.push(step);
    } else if (ACTIVE_STATUSES.has(task.status)) {
      active++;
      activeSteps.push(step);
    }
  }

  return {
    total,
    done,
    failed,
    active,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
    failedSteps,
    activeSteps,
  };
}

export type StepDisplayStatus = 'done' | 'failed' | 'active' | 'pending' | 'unknown';

export function stepDisplayStatus(task: WorkflowTaskLike | undefined): StepDisplayStatus {
  if (!task) return 'unknown';
  if (DONE_STATUSES.has(task.status)) return 'done';
  if (FAILED_STATUSES.has(task.status)) return 'failed';
  if (ACTIVE_STATUSES.has(task.status)) return 'active';
  return 'pending';
}

/**
 * The single step-status → wording/tone table. Steps used to be labelled with
 * raw task statuses (`in_progress`) or nothing at all, and coloured in three
 * different places; this is now the only mapping.
 */
export const STEP_STATUS_META: Record<StepDisplayStatus, RunStatusMeta> = {
  done: { tone: 'success', key: 'runStatusCompleted', label: '已完成' },
  failed: { tone: 'danger', key: 'runStatusFailed', label: '失败' },
  active: { tone: 'info', key: 'runStatusRunning', label: '进行中' },
  pending: { tone: 'neutral', key: 'workflowStepPending', label: '待处理' },
  unknown: { tone: 'neutral', key: 'workflowStepNoTask', label: '未开始' },
};

export function stepStatusMeta(status: StepDisplayStatus): RunStatusMeta {
  return STEP_STATUS_META[status] ?? STEP_STATUS_META.unknown;
}

export const EXPANDED_WORKFLOWS_STORAGE_KEY = 'markus_workflows_expanded';

export function readExpandedWorkflows(getItem: (key: string) => string | null): Set<string> {
  try {
    const raw = getItem(EXPANDED_WORKFLOWS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

export function writeExpandedWorkflows(
  expanded: Set<string>,
  setItem: (key: string, value: string) => void,
): void {
  try {
    setItem(EXPANDED_WORKFLOWS_STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    /* storage full / disabled — expansion just won't persist */
  }
}

/** Steps whose prompt is long enough to deserve a "show more" affordance. */
export const PROMPT_CLAMP_CHARS = 160;

export function shouldClampPrompt(prompt: string | undefined): boolean {
  return (prompt ?? '').length > PROMPT_CLAMP_CHARS;
}

/**
 * Rewrite a template's identity when it is copied.
 *
 * A workflow has **two** identities that are easy to let drift: the file name
 * (`<name>.yaml`, which is what the API uses to address it) and the `name:`
 * field inside the YAML (which is what the parsed template — and therefore the
 * UI — reports). Copying a template without renaming the inner field produces
 * two workflows that both claim to be the original: the list shows duplicate
 * cards and `resolveWorkflowFile` can address the wrong file.
 *
 * This returns the new YAML with `name` set and `（副本）` appended to
 * `displayName`, so the platform never guesses which identity to trust — the
 * caller writes them consistently.
 */
export function prepareDuplicateYaml(
  yaml: string,
  newName: string,
  parse: (text: string) => unknown,
  stringify: (doc: unknown) => string,
): string {
  const doc = parse(yaml) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') throw new Error('模板 YAML 无法解析');
  doc['name'] = newName;
  const displayName = doc['displayName'];
  if (typeof displayName === 'string' && displayName.length > 0) {
    doc['displayName'] = `${displayName}（副本）`;
  }
  return stringify(doc);
}
