// ─── Workflow Template Types ────────────────────────────────────────────────
//
// Defines the YAML-backed workflow template format and runtime run model.
// Templates live on disk at ~/.markus/teams/{teamId}/workflows/*.yaml
// and are instantiated as Requirement + Task DAGs via WorkflowRunner.

// ─── Schedule ────────────────────────────────────────────────────────────────

export interface ScheduleDef {
  /** Human-friendly interval shorthand, e.g. "6h", "30m", "1d" */
  every?: string;
  /** Cron expression, e.g. "0 9 * * 1-5" */
  cron?: string;
  /** ISO timestamp for a one-shot trigger */
  run_at?: string;
  /** IANA timezone, e.g. "Asia/Shanghai" */
  timezone?: string;
  /** Maximum number of runs. 0 = unlimited. */
  max_runs?: number;
}

// ─── Parameters ──────────────────────────────────────────────────────────────

export type WorkflowParamType = 'string' | 'enum' | 'text' | 'agent';

export interface ParamDef {
  /** Variable name, referenced as {{name}} in step prompts */
  name: string;
  type: WorkflowParamType;
  label?: string;
  description?: string;
  required?: boolean;
  default?: string;
  /** For enum type */
  options?: string[];
  /** When true, scheduled runs auto-generate this param via LLM */
  auto_generate?: boolean;
  /** Prompt sent to the LLM when auto-generating */
  auto_prompt?: string;
}

// ─── Step Input (upstream deliverable reference) ─────────────────────────────

export interface StepInput {
  /** ID of the upstream step whose output is consumed */
  from: string;
  /** Variable name used in the current step's context */
  as: string;
}

// ─── Step Definition ─────────────────────────────────────────────────────────

export interface StepDef {
  /** Unique identifier within the template */
  id: string;
  name: string;
  type: 'agent_task';

  /** Role placeholder, resolved to an agent via role mapping */
  role: string;
  /** Optional explicit reviewer role (defaults to team manager) */
  reviewer?: string;

  /** Task prompt template. Supports {{param}}, {{date}}, {{time}}, {{run_number}} interpolation. */
  prompt: string;
  /** Step IDs that must complete before this step can start */
  depends_on?: string[];
  /** References to upstream step outputs */
  inputs?: StepInput[];

  priority?: 'low' | 'medium' | 'high' | 'urgent';
  /** Step timeout shorthand, e.g. "30m" */
  timeout?: string;
  /** Number of retries on failure */
  retry_count?: number;
}

// ─── Workflow Template (top-level YAML structure) ────────────────────────────

export interface WorkflowTemplate {
  name: string;
  /** Display name (may contain non-ASCII) */
  displayName?: string;
  description: string;
  version: string;

  schedule?: ScheduleDef;
  params?: ParamDef[];
  steps: StepDef[];
}

// ─── Workflow Run (runtime instance) ─────────────────────────────────────────

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type WorkflowRunTrigger = 'manual' | 'schedule' | 'agent';

export interface WorkflowRun {
  id: string;
  teamId: string;
  workflowName: string;
  runNumber: number;

  requirementId: string;
  taskIds: string[];

  params: Record<string, string>;
  roleMapping: Record<string, string>;

  status: WorkflowRunStatus;
  triggeredBy: WorkflowRunTrigger;
  projectId?: string;

  startedAt: string;
  completedAt?: string;
}

// ─── Schedule State (in-memory, rebuilt on startup) ──────────────────────────

export interface WorkflowScheduleState {
  teamId: string;
  workflowName: string;
  schedule: ScheduleDef;
  nextRunAt: string | null;
  totalRuns: number;
  lastRunAt: string | null;
  paused: boolean;
  lastRoleMapping: Record<string, string>;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateWorkflowTemplate(template: unknown): string[] {
  const errors: string[] = [];
  if (!template || typeof template !== 'object') return ['Template must be a non-null object'];
  const t = template as Record<string, unknown>;

  if (!t.name || typeof t.name !== 'string' || t.name.trim().length === 0)
    errors.push('name is required');
  if (!t.description || typeof t.description !== 'string')
    errors.push('description is required');
  if (!t.version || typeof t.version !== 'string')
    errors.push('version is required');

  if (!Array.isArray(t.steps) || t.steps.length === 0) {
    errors.push('steps must be a non-empty array');
    return errors;
  }

  const stepIds = new Set<string>();
  const steps = t.steps as Array<Record<string, unknown>>;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const prefix = `steps[${i}]`;

    if (!step.id || typeof step.id !== 'string')
      errors.push(`${prefix}.id is required`);
    else if (stepIds.has(step.id))
      errors.push(`${prefix}.id "${step.id}" is duplicated`);
    else
      stepIds.add(step.id);

    if (!step.name || typeof step.name !== 'string')
      errors.push(`${prefix}.name is required`);
    if (!step.role || typeof step.role !== 'string')
      errors.push(`${prefix}.role is required`);
    if (!step.prompt || typeof step.prompt !== 'string')
      errors.push(`${prefix}.prompt is required`);
  }

  // Validate depends_on references exist
  for (const step of steps) {
    const deps = step.depends_on;
    if (Array.isArray(deps)) {
      for (const dep of deps) {
        if (typeof dep !== 'string') {
          errors.push(`Step "${step.id}": depends_on entries must be strings`);
        } else if (!stepIds.has(dep)) {
          errors.push(`Step "${step.id}": depends_on references unknown step "${dep}"`);
        }
      }
    }
  }

  // Cycle detection via topological sort (Kahn's algorithm)
  if (errors.length === 0) {
    const cycleErrors = detectCycles(steps);
    if (cycleErrors) errors.push(cycleErrors);
  }

  // Validate params
  if (t.params !== undefined) {
    if (!Array.isArray(t.params)) {
      errors.push('params must be an array');
    } else {
      const paramNames = new Set<string>();
      for (const p of t.params as Array<Record<string, unknown>>) {
        if (!p.name || typeof p.name !== 'string')
          errors.push('params[].name is required');
        else if (paramNames.has(p.name))
          errors.push(`Duplicate param name: "${p.name}"`);
        else
          paramNames.add(p.name);

        if (p.type && !['string', 'enum', 'text', 'agent'].includes(p.type as string))
          errors.push(`Param "${p.name}": invalid type "${p.type}"`);
        if (p.type === 'enum' && (!Array.isArray(p.options) || p.options.length === 0))
          errors.push(`Param "${p.name}": enum type requires non-empty options array`);
      }
    }
  }

  // Validate schedule
  if (t.schedule !== undefined) {
    const sched = t.schedule as Record<string, unknown>;
    const hasEvery = typeof sched.every === 'string';
    const hasCron = typeof sched.cron === 'string';
    const hasRunAt = typeof sched.run_at === 'string';
    if (!hasEvery && !hasCron && !hasRunAt)
      errors.push('schedule must have at least one of: every, cron, run_at');
    if (hasEvery && !parseInterval(sched.every as string))
      errors.push(`schedule.every: invalid interval "${sched.every}"`);
  }

  return errors;
}

/** Detect cycles in step dependencies using Kahn's algorithm. Returns error string or null. */
function detectCycles(steps: Array<Record<string, unknown>>): string | null {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const step of steps) {
    const id = step.id as string;
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const step of steps) {
    const id = step.id as string;
    const deps = step.depends_on as string[] | undefined;
    if (deps) {
      for (const dep of deps) {
        adj.get(dep)?.push(id);
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (processed < steps.length) {
    return 'Circular dependency detected in step depends_on';
  }
  return null;
}

// ─── Prompt Rendering ────────────────────────────────────────────────────────

/**
 * Render a step's prompt template with parameter interpolation and context injection.
 */
export function renderStepPrompt(
  step: StepDef,
  params: Record<string, string>,
  runNumber: number,
): string {
  let prompt = step.prompt;

  // User parameters: {{topic}} → "AI Agent"
  for (const [key, value] of Object.entries(params)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }

  // Built-in template variables
  const now = new Date();
  prompt = prompt.replaceAll('{{date}}', formatDate(now));
  prompt = prompt.replaceAll('{{time}}', formatDateTime(now));
  prompt = prompt.replaceAll('{{run_number}}', String(runNumber));

  // Upstream deliverable context
  if (step.inputs && step.inputs.length > 0) {
    const inputContext = step.inputs
      .map(inp =>
        `## Upstream output: ${inp.as}\nFrom step: ${inp.from}\nReview this step's deliverables using \`task_get\` for full details.`)
      .join('\n\n');
    prompt += `\n\n---\n### Workflow Context\n${inputContext}`;
  }

  return prompt;
}

// ─── Topological Sort ────────────────────────────────────────────────────────

/**
 * Return steps in topological order (dependencies before dependents).
 * Throws if the graph contains cycles.
 */
export function topologicalSort(steps: StepDef[]): StepDef[] {
  const stepMap = new Map(steps.map(s => [s.id, s]));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, 0);
    adj.set(step.id, []);
  }

  for (const step of steps) {
    for (const dep of step.depends_on ?? []) {
      adj.get(dep)?.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: StepDef[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(stepMap.get(id)!);
    for (const neighbor of adj.get(id) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length < steps.length) {
    throw new Error('Circular dependency in workflow steps');
  }

  return sorted;
}

// ─── Interval Parsing ────────────────────────────────────────────────────────

const INTERVAL_RE = /^(\d+)(s|m|h|d|w)$/;
const INTERVAL_MULTIPLIERS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse a shorthand interval like "6h" into milliseconds. Returns null for invalid input. */
export function parseInterval(interval: string): number | null {
  const match = INTERVAL_RE.exec(interval.trim());
  if (!match) return null;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  return value * (INTERVAL_MULTIPLIERS[unit] ?? 0);
}

// ─── Date Formatting Helpers ─────────────────────────────────────────────────

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d)} ${h}:${min}`;
}

/**
 * Collect all unique roles referenced by workflow steps.
 */
export function extractRoles(template: WorkflowTemplate): string[] {
  const roles = new Set<string>();
  for (const step of template.steps) {
    roles.add(step.role);
    if (step.reviewer) roles.add(step.reviewer);
  }
  return [...roles];
}
