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
    dot: 'bg-fg-quaternary',
    bar: 'bg-fg-quaternary',
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

/** The runner stamps `step: <id>` into task notes — read it, don't guess. */
export function stepIdFromNotes(notes: string | undefined): string | null {
  if (!notes) return null;
  const match = /step:\s*([A-Za-z0-9_.-]+)/.exec(notes);
  return match ? match[1]! : null;
}

/**
 * Map steps → their tasks.
 *
 * Order of trust: the `step: <id>` marker in task notes (exact), then a title
 * suffix match (`[Workflow] Step name`), then positional. Returns only the
 * steps it could actually match — an unmapped step shows as "not started"
 * rather than inheriting a neighbour's status.
 *
 * Residual debt (tracked in the review doc): tasks carry no structural
 * `stepId`. Both strategies above are in-band, so a rename breaks the suffix
 * match. The structural fix is a `step_id` column on tasks.
 */
export function matchTasksToSteps(
  steps: WorkflowStepLike[],
  tasks: WorkflowTaskLike[],
): Record<string, WorkflowTaskLike | undefined> {
  const byStep: Record<string, WorkflowTaskLike | undefined> = {};
  const used = new Set<string>();
  const stepIds = new Set(steps.map((s) => s.id));

  for (const task of tasks) {
    const fromNotes = stepIdFromNotes(task.notes);
    if (fromNotes && stepIds.has(fromNotes) && !byStep[fromNotes]) {
      byStep[fromNotes] = task;
      used.add(task.id);
    }
  }

  for (const step of steps) {
    if (byStep[step.id]) continue;
    const match = tasks.find(
      (task) =>
        !used.has(task.id) &&
        (task.title === step.name || task.title.endsWith(` ${step.name}`)),
    );
    if (match) {
      byStep[step.id] = match;
      used.add(match.id);
    }
  }

  const leftovers = tasks.filter((task) => !used.has(task.id));
  const unmatchedSteps = steps.filter((step) => !byStep[step.id]);
  if (leftovers.length > 0 && leftovers.length === unmatchedSteps.length) {
    unmatchedSteps.forEach((step, i) => {
      byStep[step.id] = leftovers[i];
    });
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
