import { createLogger, generateId } from '@markus/shared';
import type {
  WorkflowDefinition, WorkflowExecution, WorkflowStatus,
  StepDefinition, StepExecution, StepStatus, WorkflowEvent,
} from './types.js';

const log = createLogger('workflow-engine');

export interface WorkflowExecutor {
  /** Execute a task on a specific agent, return output */
  executeStep(agentId: string, taskDescription: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Find best agent for required skills */
  findAgent(requiredSkills: string[]): string | undefined;
}

export type WorkflowEventHandler = (event: WorkflowEvent) => void;

export class WorkflowEngine {
  private executions = new Map<string, WorkflowExecution>();
  private eventHandlers: WorkflowEventHandler[] = [];

  constructor(private executor: WorkflowExecutor) {}

  onEvent(handler: WorkflowEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) this.eventHandlers.splice(idx, 1);
    };
  }

  private emit(event: WorkflowEvent): void {
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch (err) {
        log.warn('Event handler error', { error: String(err) });
      }
    }
  }

  /** Validate a workflow definition for structural correctness */
  validate(def: WorkflowDefinition): string[] {
    const errors: string[] = [];
    const stepIds = new Set(def.steps.map(s => s.id));

    if (!def.id) errors.push('Workflow must have an id');
    if (!def.name) errors.push('Workflow must have a name');
    if (def.steps.length === 0) errors.push('Workflow must have at least one step');

    for (const step of def.steps) {
      if (!step.id) errors.push('Step must have an id');
      if (!step.name) errors.push(`Step ${step.id}: must have a name`);

      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) {
          errors.push(`Step ${step.id}: dependency "${dep}" does not exist`);
        }
      }

      if (step.type === 'condition' && !step.condition) {
        errors.push(`Step ${step.id}: condition type requires a condition definition`);
      }
      if (step.type === 'fan_out' && !step.fanOut) {
        errors.push(`Step ${step.id}: fan_out type requires a fanOut definition`);
      }
      if (step.type === 'fan_in' && !step.fanIn) {
        errors.push(`Step ${step.id}: fan_in type requires a fanIn definition`);
      }
      if (step.type === 'agent_task' && !step.agentId && !step.requiredSkills?.length) {
        errors.push(`Step ${step.id}: agent_task requires agentId or requiredSkills`);
      }
    }

    // Check for cycles using topological sort
    if (this.hasCycle(def.steps)) {
      errors.push('Workflow contains a cycle — must be a DAG');
    }

    return errors;
  }

  private hasCycle(steps: StepDefinition[]): boolean {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const adjMap = new Map<string, string[]>();

    for (const step of steps) {
      adjMap.set(step.id, step.dependsOn);
    }

    const dfs = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const dep of adjMap.get(id) ?? []) {
        if (dfs(dep)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };

    for (const step of steps) {
      if (dfs(step.id)) return true;
    }
    return false;
  }

  /** Start a new workflow execution */
  async start(def: WorkflowDefinition, inputs: Record<string, unknown> = {}): Promise<WorkflowExecution> {
    const errors = this.validate(def);
    if (errors.length > 0) {
      throw new Error(`Invalid workflow: ${errors.join('; ')}`);
    }

    const executionId = generateId('wf-exec');
    const stepMap = new Map<string, StepExecution>();

    for (const step of def.steps) {
      stepMap.set(step.id, {
        stepId: step.id,
        status: 'pending',
        retryCount: 0,
      });
    }

    const execution: WorkflowExecution = {
      id: executionId,
      workflowId: def.id,
      status: 'running',
      inputs,
      steps: stepMap,
      outputs: {},
      startedAt: new Date(),
    };

    this.executions.set(executionId, execution);
    this.emit({ type: 'workflow_started', executionId, timestamp: new Date() });

    log.info('Workflow started', { executionId, workflowId: def.id, stepCount: def.steps.length });

    try {
      await this.executeGraph(def, execution);

      if (execution.status === 'cancelled') return execution;

      // Collect outputs
      if (def.outputs) {
        for (const [key, expr] of Object.entries(def.outputs)) {
          execution.outputs[key] = this.resolveExpression(expr, execution);
        }
      }

      execution.status = 'completed';
      execution.completedAt = new Date();
      this.emit({ type: 'workflow_completed', executionId, timestamp: new Date(), data: execution.outputs });
      log.info('Workflow completed', { executionId, elapsed: Date.now() - execution.startedAt!.getTime() });
    } catch (err) {
      execution.status = 'failed';
      execution.error = String(err);
      execution.completedAt = new Date();
      this.emit({ type: 'workflow_failed', executionId, timestamp: new Date(), data: { error: String(err) } });
      log.error('Workflow failed', { executionId, error: String(err) });
    }

    return execution;
  }

  /** Cancel a running execution */
  cancel(executionId: string): boolean {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status !== 'running') return false;

    execution.status = 'cancelled';
    for (const step of execution.steps.values()) {
      if (step.status === 'pending' || step.status === 'waiting') {
        step.status = 'cancelled';
      }
    }
    this.emit({ type: 'workflow_cancelled', executionId, timestamp: new Date() });
    return true;
  }

  getExecution(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  listExecutions(): WorkflowExecution[] {
    return [...this.executions.values()];
  }

  /** Execute the DAG by processing ready steps in parallel waves */
  private async executeGraph(def: WorkflowDefinition, execution: WorkflowExecution): Promise<void> {
    const stepDefs = new Map(def.steps.map(s => [s.id, s]));

    while (execution.status === 'running') {
      const readySteps = this.findReadySteps(def, execution);

      if (readySteps.length === 0) {
        const hasRunning = [...execution.steps.values()].some(s => s.status === 'running');
        if (hasRunning) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        break;
      }

      const promises = readySteps.map(stepId => {
        const stepDef = stepDefs.get(stepId)!;
        return this.executeStep(stepDef, execution).catch(err => {
          log.error('Step execution error', { stepId, error: String(err) });
        });
      });

      await Promise.all(promises);
    }

    // Check if any step failed without the workflow being explicitly failed
    const hasFailure = [...execution.steps.values()].some(s => s.status === 'failed');
    if (hasFailure && execution.status === 'running') {
      const failedSteps = [...execution.steps.values()].filter(s => s.status === 'failed');
      throw new Error(`Steps failed: ${failedSteps.map(s => s.stepId).join(', ')}`);
    }
  }

  /** Find steps whose dependencies are all satisfied */
  private findReadySteps(def: WorkflowDefinition, execution: WorkflowExecution): string[] {
    const ready: string[] = [];

    for (const step of def.steps) {
      const exec = execution.steps.get(step.id)!;
      if (exec.status !== 'pending') continue;

      const allDepsResolved = step.dependsOn.every(depId => {
        const depExec = execution.steps.get(depId);
        return depExec && (depExec.status === 'completed' || depExec.status === 'skipped');
      });

      if (allDepsResolved) {
        ready.push(step.id);
      }
    }

    return ready;
  }

  /** Execute a single step */
  private async executeStep(stepDef: StepDefinition, execution: WorkflowExecution): Promise<void> {
    const stepExec = execution.steps.get(stepDef.id)!;
    stepExec.status = 'running';
    stepExec.startedAt = new Date();

    this.emit({
      type: 'step_started',
      executionId: execution.id,
      stepId: stepDef.id,
      timestamp: new Date(),
    });

    try {
      // Build step input from dependency outputs
      const input = this.buildStepInput(stepDef, execution);
      stepExec.input = input;

      let output: Record<string, unknown>;

      switch (stepDef.type) {
        case 'agent_task':
          output = await this.executeAgentTask(stepDef, input, execution);
          break;
        case 'condition':
          output = this.executeCondition(stepDef, execution);
          break;
        case 'fan_out':
          output = await this.executeFanOut(stepDef, input, execution);
          break;
        case 'fan_in':
          output = this.executeFanIn(stepDef, execution);
          break;
        case 'transform':
          output = this.executeTransform(stepDef, input);
          break;
        case 'delay':
          await new Promise(r => setTimeout(r, stepDef.delayMs ?? 1000));
          output = { delayed: true, ms: stepDef.delayMs ?? 1000 };
          break;
        case 'human_approval':
          output = { approved: true, note: 'Auto-approved (approval UI not yet implemented)' };
          break;
        default:
          throw new Error(`Unknown step type: ${stepDef.type}`);
      }

      stepExec.output = output;
      stepExec.status = 'completed';
      stepExec.completedAt = new Date();

      this.emit({
        type: 'step_completed',
        executionId: execution.id,
        stepId: stepDef.id,
        timestamp: new Date(),
        data: output,
      });
    } catch (err) {
      const maxRetries = stepDef.maxRetries ?? 0;
      if (stepExec.retryCount < maxRetries) {
        stepExec.retryCount++;
        stepExec.status = 'pending';
        this.emit({
          type: 'step_retrying',
          executionId: execution.id,
          stepId: stepDef.id,
          timestamp: new Date(),
          data: { attempt: stepExec.retryCount, maxRetries },
        });
        log.warn('Step retrying', { stepId: stepDef.id, attempt: stepExec.retryCount });
      } else {
        stepExec.status = 'failed';
        stepExec.error = String(err);
        stepExec.completedAt = new Date();
        this.emit({
          type: 'step_failed',
          executionId: execution.id,
          stepId: stepDef.id,
          timestamp: new Date(),
          data: { error: String(err) },
        });
      }
    }
  }

  private async executeAgentTask(
    stepDef: StepDefinition,
    input: Record<string, unknown>,
    execution: WorkflowExecution,
  ): Promise<Record<string, unknown>> {
    let agentId = stepDef.agentId;

    if (!agentId && stepDef.requiredSkills?.length) {
      agentId = this.executor.findAgent(stepDef.requiredSkills);
      if (!agentId) {
        throw new Error(`No agent found with skills: ${stepDef.requiredSkills.join(', ')}`);
      }
    }

    if (!agentId) throw new Error('No agentId or requiredSkills for agent_task step');

    const stepExec = execution.steps.get(stepDef.id)!;
    stepExec.agentId = agentId;

    const description = stepDef.taskConfig?.prompt
      ? this.interpolate(stepDef.taskConfig.prompt, input, execution)
      : `${stepDef.name}: ${stepDef.description ?? ''}`;

    return await this.executor.executeStep(agentId, description, input);
  }

  private executeCondition(stepDef: StepDefinition, execution: WorkflowExecution): Record<string, unknown> {
    if (!stepDef.condition) throw new Error('Condition step missing condition definition');

    const result = this.evaluateExpression(stepDef.condition.expression, execution);
    const branch = result ? 'true' : 'false';
    const enabledSteps = result ? stepDef.condition.trueBranch : stepDef.condition.falseBranch;
    const disabledSteps = result ? stepDef.condition.falseBranch : stepDef.condition.trueBranch;

    // Skip steps in the disabled branch
    for (const stepId of disabledSteps) {
      const exec = execution.steps.get(stepId);
      if (exec && exec.status === 'pending') {
        exec.status = 'skipped';
        this.emit({
          type: 'step_skipped',
          executionId: execution.id,
          stepId,
          timestamp: new Date(),
          data: { reason: `Condition "${stepDef.id}" took ${branch} branch` },
        });
      }
    }

    return { branch, result: !!result, enabledSteps, disabledSteps };
  }

  private async executeFanOut(
    stepDef: StepDefinition,
    input: Record<string, unknown>,
    execution: WorkflowExecution,
  ): Promise<Record<string, unknown>> {
    if (!stepDef.fanOut) throw new Error('Fan-out step missing fanOut definition');

    const items = this.resolveExpression(stepDef.fanOut.itemsFrom, execution);
    if (!Array.isArray(items)) {
      throw new Error(`Fan-out itemsFrom must resolve to an array, got: ${typeof items}`);
    }

    const stepExec = execution.steps.get(stepDef.id)!;
    stepExec.children = [];

    const results: Record<string, unknown>[] = [];
    const tpl = stepDef.fanOut.stepTemplate;

    const promises = items.map(async (item, idx) => {
      const childId = `${stepDef.id}_${idx}`;
      const childExec: StepExecution = {
        stepId: childId,
        status: 'running',
        retryCount: 0,
        startedAt: new Date(),
        input: { item, index: idx, ...input },
      };
      stepExec.children!.push(childExec);

      try {
        const childDef: StepDefinition = {
          ...tpl,
          id: childId,
          name: `${tpl.name} [${idx}]`,
          dependsOn: [],
        };

        let agentId = childDef.agentId;
        if (!agentId && childDef.requiredSkills?.length) {
          agentId = this.executor.findAgent(childDef.requiredSkills);
        }

        if (agentId && childDef.type === 'agent_task') {
          const desc = childDef.taskConfig?.prompt
            ? this.interpolate(childDef.taskConfig.prompt, { item, index: idx, ...input }, execution)
            : `${childDef.name}: ${childDef.description ?? ''}`;
          const result = await this.executor.executeStep(agentId, desc, { item, index: idx, ...input });
          childExec.output = result;
          childExec.status = 'completed';
          results[idx] = result;
        } else if (childDef.type === 'transform' && childDef.transform) {
          childExec.output = this.executeTransform(childDef, { item, index: idx });
          childExec.status = 'completed';
          results[idx] = childExec.output;
        } else {
          childExec.output = { item, index: idx };
          childExec.status = 'completed';
          results[idx] = childExec.output;
        }
      } catch (err) {
        childExec.status = 'failed';
        childExec.error = String(err);
        results[idx] = { error: String(err) };
      }
      childExec.completedAt = new Date();
    });

    await Promise.all(promises);
    return { results, count: items.length };
  }

  private executeFanIn(stepDef: StepDefinition, execution: WorkflowExecution): Record<string, unknown> {
    if (!stepDef.fanIn) throw new Error('Fan-in step missing fanIn definition');

    const fanOutExec = execution.steps.get(stepDef.fanIn.collectFrom);
    if (!fanOutExec?.children) {
      return { collected: [], count: 0 };
    }

    const childOutputs = fanOutExec.children
      .filter(c => c.status === 'completed' && c.output)
      .map(c => c.output!);

    switch (stepDef.fanIn.aggregation) {
      case 'array':
        return { collected: childOutputs, count: childOutputs.length };
      case 'merge':
        return { collected: Object.assign({}, ...childOutputs), count: childOutputs.length };
      case 'first':
        return { collected: childOutputs[0] ?? null, count: childOutputs.length };
      case 'last':
        return { collected: childOutputs[childOutputs.length - 1] ?? null, count: childOutputs.length };
      default:
        return { collected: childOutputs, count: childOutputs.length };
    }
  }

  private executeTransform(stepDef: StepDefinition, input: Record<string, unknown>): Record<string, unknown> {
    if (!stepDef.transform) throw new Error('Transform step missing transform expression');
    try {
      const fn = new Function('input', `return (${stepDef.transform})`);
      const result = fn(input);
      return typeof result === 'object' && result !== null ? result : { value: result };
    } catch (err) {
      throw new Error(`Transform failed: ${err}`);
    }
  }

  /** Build input object for a step from its dependencies' outputs */
  private buildStepInput(stepDef: StepDefinition, execution: WorkflowExecution): Record<string, unknown> {
    const input: Record<string, unknown> = { ...execution.inputs };

    for (const depId of stepDef.dependsOn) {
      const depExec = execution.steps.get(depId);
      if (depExec?.output) {
        input[depId] = depExec.output;
      }
    }

    return input;
  }

  /** Resolve a dotted expression like "steps.review.output.approved" */
  private resolveExpression(expr: string, execution: WorkflowExecution): unknown {
    if (expr.startsWith('steps.')) {
      const parts = expr.split('.');
      const stepId = parts[1];
      const stepExec = execution.steps.get(stepId!);
      if (!stepExec) return undefined;

      let current: unknown = stepExec;
      for (let i = 2; i < parts.length; i++) {
        if (current == null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[parts[i]!];
      }
      return current;
    }

    if (expr.startsWith('inputs.')) {
      const key = expr.slice('inputs.'.length);
      return execution.inputs[key];
    }

    return undefined;
  }

  /** Evaluate a boolean expression against execution context */
  private evaluateExpression(expr: string, execution: WorkflowExecution): boolean {
    try {
      const steps: Record<string, Record<string, unknown>> = {};
      for (const [id, stepExec] of execution.steps) {
        steps[id] = {
          status: stepExec.status,
          output: stepExec.output ?? {},
          input: stepExec.input ?? {},
        };
      }
      const fn = new Function('steps', 'inputs', `return !!(${expr})`);
      return fn(steps, execution.inputs);
    } catch {
      log.warn('Expression evaluation failed', { expr });
      return false;
    }
  }

  /** Interpolate template strings like "Process {{item.name}}" */
  private interpolate(template: string, input: Record<string, unknown>, execution: WorkflowExecution): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_match, expr: string) => {
      const trimmed = expr.trim();
      if (trimmed.startsWith('steps.') || trimmed.startsWith('inputs.')) {
        return String(this.resolveExpression(trimmed, execution) ?? '');
      }
      // Resolve against direct input
      const parts = trimmed.split('.');
      let current: unknown = input;
      for (const part of parts) {
        if (current == null || typeof current !== 'object') return '';
        current = (current as Record<string, unknown>)[part];
      }
      return String(current ?? '');
    });
  }
}
