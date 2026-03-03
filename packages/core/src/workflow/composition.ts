import { generateId } from '@markus/shared';
import type { WorkflowDefinition, StepDefinition } from './types.js';

/**
 * Pre-built composition patterns for common multi-agent workflows.
 * Each function generates a WorkflowDefinition ready for the WorkflowEngine.
 */

export interface PipelineStage {
  name: string;
  description?: string;
  agentId?: string;
  requiredSkills?: string[];
  prompt?: string;
  timeoutMs?: number;
}

/**
 * Pipeline: sequential chain where each step's output feeds the next.
 * A → B → C → D
 */
export function createPipeline(opts: {
  name: string;
  description?: string;
  stages: PipelineStage[];
  inputs?: WorkflowDefinition['inputs'];
  author?: string;
}): WorkflowDefinition {
  const steps: StepDefinition[] = opts.stages.map((stage, idx) => ({
    id: `stage_${idx}`,
    name: stage.name,
    type: 'agent_task' as const,
    description: stage.description,
    agentId: stage.agentId,
    requiredSkills: stage.requiredSkills,
    dependsOn: idx > 0 ? [`stage_${idx - 1}`] : [],
    taskConfig: {
      prompt: stage.prompt,
      timeoutMs: stage.timeoutMs,
    },
  }));

  const lastStepId = `stage_${opts.stages.length - 1}`;

  return {
    id: generateId('wf-pipeline'),
    name: opts.name,
    description: opts.description ?? `Pipeline: ${opts.stages.map(s => s.name).join(' → ')}`,
    version: '1.0.0',
    author: opts.author ?? 'system',
    steps,
    inputs: opts.inputs,
    outputs: {
      result: `steps.${lastStepId}.output`,
    },
  };
}

export interface FanOutConfig {
  name: string;
  description?: string;
  /** Step that produces the list of items */
  producer: PipelineStage;
  /** Template for parallel workers */
  worker: Omit<PipelineStage, 'name'> & { nameTemplate?: string };
  /** How to aggregate results */
  aggregation?: 'array' | 'merge' | 'first' | 'last';
  /** Optional final step to process aggregated results */
  reducer?: PipelineStage;
  inputs?: WorkflowDefinition['inputs'];
  author?: string;
}

/**
 * Fan-out/Fan-in: one producer generates work items, parallel workers process them,
 * results are collected and optionally reduced.
 *
 *        ┌── Worker[0] ──┐
 * Producer ├── Worker[1] ──┤ Fan-in → (Reducer)
 *        └── Worker[N] ──┘
 */
export function createFanOut(opts: FanOutConfig): WorkflowDefinition {
  const steps: StepDefinition[] = [];

  // Producer step
  steps.push({
    id: 'producer',
    name: opts.producer.name,
    type: 'agent_task',
    description: opts.producer.description,
    agentId: opts.producer.agentId,
    requiredSkills: opts.producer.requiredSkills,
    dependsOn: [],
    taskConfig: { prompt: opts.producer.prompt, timeoutMs: opts.producer.timeoutMs },
  });

  // Fan-out step
  steps.push({
    id: 'fan_out',
    name: 'Distribute work',
    type: 'fan_out',
    dependsOn: ['producer'],
    fanOut: {
      itemsFrom: 'steps.producer.output.items',
      stepTemplate: {
        name: opts.worker.nameTemplate ?? 'Worker',
        type: 'agent_task',
        description: opts.worker.description,
        agentId: opts.worker.agentId,
        requiredSkills: opts.worker.requiredSkills,
        taskConfig: { prompt: opts.worker.prompt, timeoutMs: opts.worker.timeoutMs },
      },
    },
  });

  // Fan-in step
  steps.push({
    id: 'fan_in',
    name: 'Collect results',
    type: 'fan_in',
    dependsOn: ['fan_out'],
    fanIn: {
      collectFrom: 'fan_out',
      aggregation: opts.aggregation ?? 'array',
    },
  });

  // Optional reducer
  if (opts.reducer) {
    steps.push({
      id: 'reducer',
      name: opts.reducer.name,
      type: 'agent_task',
      description: opts.reducer.description,
      agentId: opts.reducer.agentId,
      requiredSkills: opts.reducer.requiredSkills,
      dependsOn: ['fan_in'],
      taskConfig: { prompt: opts.reducer.prompt, timeoutMs: opts.reducer.timeoutMs },
    });
  }

  const lastStep = opts.reducer ? 'reducer' : 'fan_in';

  return {
    id: generateId('wf-fanout'),
    name: opts.name,
    description: opts.description ?? `Fan-out workflow: ${opts.producer.name} → Workers → Collect`,
    version: '1.0.0',
    author: opts.author ?? 'system',
    steps,
    inputs: opts.inputs,
    outputs: { result: `steps.${lastStep}.output` },
  };
}

/**
 * Review chain: work → review → (conditional) → approved or rework.
 * Models the common create-then-review pattern with conditional looping.
 */
export function createReviewChain(opts: {
  name: string;
  description?: string;
  worker: PipelineStage;
  reviewer: PipelineStage;
  inputs?: WorkflowDefinition['inputs'];
  author?: string;
}): WorkflowDefinition {
  const steps: StepDefinition[] = [
    {
      id: 'work',
      name: opts.worker.name,
      type: 'agent_task',
      description: opts.worker.description,
      agentId: opts.worker.agentId,
      requiredSkills: opts.worker.requiredSkills,
      dependsOn: [],
      taskConfig: { prompt: opts.worker.prompt, timeoutMs: opts.worker.timeoutMs },
    },
    {
      id: 'review',
      name: opts.reviewer.name,
      type: 'agent_task',
      description: opts.reviewer.description,
      agentId: opts.reviewer.agentId,
      requiredSkills: opts.reviewer.requiredSkills,
      dependsOn: ['work'],
      taskConfig: { prompt: opts.reviewer.prompt ?? 'Review the work from the previous step. Output { "approved": true/false, "feedback": "..." }', timeoutMs: opts.reviewer.timeoutMs },
    },
    {
      id: 'check_approval',
      name: 'Check approval',
      type: 'condition',
      dependsOn: ['review'],
      condition: {
        expression: 'steps.review.output.approved === true',
        trueBranch: ['finalize'],
        falseBranch: ['revise'],
      },
    },
    {
      id: 'revise',
      name: 'Revise based on feedback',
      type: 'agent_task',
      description: 'Revise the work based on reviewer feedback',
      agentId: opts.worker.agentId,
      requiredSkills: opts.worker.requiredSkills,
      dependsOn: ['check_approval'],
      taskConfig: {
        prompt: 'Revise your previous work based on this feedback: {{review.feedback}}',
      },
    },
    {
      id: 'finalize',
      name: 'Finalize',
      type: 'transform',
      dependsOn: ['check_approval'],
      transform: '({ result: input.work ?? input.revise, approved: true })',
    },
  ];

  return {
    id: generateId('wf-review'),
    name: opts.name,
    description: opts.description ?? `Review chain: ${opts.worker.name} → ${opts.reviewer.name} → Approve/Revise`,
    version: '1.0.0',
    author: opts.author ?? 'system',
    steps,
    inputs: opts.inputs,
    outputs: {
      result: 'steps.finalize.output',
      reviewOutcome: 'steps.review.output',
    },
  };
}

/**
 * Parallel consensus: same task given to N agents, results compared.
 * Useful for important decisions where multiple opinions are valuable.
 */
export function createParallelConsensus(opts: {
  name: string;
  description?: string;
  task: string;
  agents: Array<{ agentId?: string; requiredSkills?: string[] }>;
  aggregator?: PipelineStage;
  inputs?: WorkflowDefinition['inputs'];
  author?: string;
}): WorkflowDefinition {
  const steps: StepDefinition[] = [];

  // Parallel agent steps
  for (let i = 0; i < opts.agents.length; i++) {
    steps.push({
      id: `agent_${i}`,
      name: `Agent ${i + 1}`,
      type: 'agent_task',
      description: opts.task,
      agentId: opts.agents[i]!.agentId,
      requiredSkills: opts.agents[i]!.requiredSkills,
      dependsOn: [],
      taskConfig: { prompt: opts.task },
    });
  }

  // Collect step
  steps.push({
    id: 'collect',
    name: 'Collect opinions',
    type: 'transform',
    dependsOn: opts.agents.map((_, i) => `agent_${i}`),
    transform: `({ opinions: [${opts.agents.map((_, i) => `input.agent_${i}`).join(', ')}], count: ${opts.agents.length} })`,
  });

  // Optional aggregator
  if (opts.aggregator) {
    steps.push({
      id: 'aggregate',
      name: opts.aggregator.name,
      type: 'agent_task',
      description: opts.aggregator.description,
      agentId: opts.aggregator.agentId,
      requiredSkills: opts.aggregator.requiredSkills,
      dependsOn: ['collect'],
      taskConfig: {
        prompt: opts.aggregator.prompt ?? 'Synthesize the following opinions into a final decision: {{collect.opinions}}',
      },
    });
  }

  const lastStep = opts.aggregator ? 'aggregate' : 'collect';

  return {
    id: generateId('wf-consensus'),
    name: opts.name,
    description: opts.description ?? `Parallel consensus: ${opts.agents.length} agents`,
    version: '1.0.0',
    author: opts.author ?? 'system',
    steps,
    inputs: opts.inputs,
    outputs: { result: `steps.${lastStep}.output` },
  };
}
