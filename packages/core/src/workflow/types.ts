/**
 * Workflow Engine types — DAG-based multi-agent orchestration.
 *
 * A Workflow is a directed acyclic graph of Steps.
 * Each Step can be assigned to a specific agent or auto-routed by required skills.
 * Steps support conditional branching, parallel fan-out, and result aggregation.
 */

export type WorkflowStatus = 'draft' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'waiting' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';
export type StepType = 'agent_task' | 'condition' | 'fan_out' | 'fan_in' | 'transform' | 'delay' | 'human_approval';

export interface StepDefinition {
  id: string;
  name: string;
  type: StepType;
  description?: string;

  /** Agent assignment: specific agentId, or skills for auto-routing */
  agentId?: string;
  requiredSkills?: string[];

  /** IDs of steps that must complete before this step can run */
  dependsOn: string[];

  /** For 'condition' type: expression evaluated against previous step outputs */
  condition?: {
    expression: string;            // e.g. "steps.review.output.approved === true"
    trueBranch: string[];          // step IDs to enable if true
    falseBranch: string[];         // step IDs to enable if false
  };

  /** For 'fan_out' type: dynamically generate parallel sub-steps */
  fanOut?: {
    itemsFrom: string;             // expression resolving to an array, e.g. "steps.plan.output.tasks"
    stepTemplate: Omit<StepDefinition, 'id' | 'dependsOn'>;
  };

  /** For 'fan_in' type: collect results from fan-out steps */
  fanIn?: {
    collectFrom: string;           // fan_out step ID
    aggregation: 'array' | 'merge' | 'first' | 'last';
  };

  /** For 'delay' type */
  delayMs?: number;

  /** For 'transform' type: JS expression to transform input → output without LLM */
  transform?: string;

  /** Task configuration passed to the agent */
  taskConfig?: {
    title?: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    timeoutMs?: number;
    prompt?: string;               // Override or template for the task description
  };

  /** Maximum retries on failure */
  maxRetries?: number;

  /** Metadata for UI rendering */
  position?: { x: number; y: number };
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  steps: StepDefinition[];
  /** Variables available to all steps via interpolation */
  inputs?: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }>;
  /** Which step outputs to include in the final workflow result */
  outputs?: Record<string, string>;  // { resultName: "steps.stepId.output.field" }
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface StepExecution {
  stepId: string;
  status: StepStatus;
  agentId?: string;
  taskId?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  retryCount: number;
  startedAt?: Date;
  completedAt?: Date;
  /** For fan_out: generated child step executions */
  children?: StepExecution[];
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: WorkflowStatus;
  inputs: Record<string, unknown>;
  steps: Map<string, StepExecution>;
  outputs: Record<string, unknown>;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface WorkflowEvent {
  type: 'workflow_started' | 'workflow_completed' | 'workflow_failed' | 'workflow_cancelled'
    | 'step_started' | 'step_completed' | 'step_failed' | 'step_skipped' | 'step_retrying';
  executionId: string;
  stepId?: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}
