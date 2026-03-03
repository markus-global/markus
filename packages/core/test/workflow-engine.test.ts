import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WorkflowEngine,
  type WorkflowExecutor, type WorkflowDefinition, type WorkflowEvent,
  createPipeline, createFanOut, createReviewChain, createParallelConsensus,
  TeamTemplateRegistry, createDefaultTeamTemplates,
} from '../src/workflow/index.js';

function createMockExecutor(results?: Record<string, Record<string, unknown>>): WorkflowExecutor {
  return {
    executeStep: vi.fn(async (agentId: string, taskDescription: string, input: Record<string, unknown>) => {
      if (results && results[agentId]) return results[agentId]!;
      return { agentId, task: taskDescription, processed: true, input };
    }),
    findAgent: vi.fn((skills: string[]) => `agent-${skills[0] ?? 'default'}`),
  };
}

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;
  let executor: WorkflowExecutor;

  beforeEach(() => {
    executor = createMockExecutor();
    engine = new WorkflowEngine(executor);
  });

  describe('validation', () => {
    it('should reject empty workflow', () => {
      const errors = engine.validate({ id: '', name: '', description: '', version: '1.0.0', author: 'test', steps: [] });
      expect(errors).toContain('Workflow must have an id');
      expect(errors).toContain('Workflow must have a name');
      expect(errors).toContain('Workflow must have at least one step');
    });

    it('should detect missing dependencies', () => {
      const def: WorkflowDefinition = {
        id: 'wf-1', name: 'Test', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'a', name: 'A', type: 'agent_task', dependsOn: ['nonexistent'], agentId: 'agent-1' },
        ],
      };
      const errors = engine.validate(def);
      expect(errors).toContain('Step a: dependency "nonexistent" does not exist');
    });

    it('should detect cycles', () => {
      const def: WorkflowDefinition = {
        id: 'wf-1', name: 'Test', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'a', name: 'A', type: 'agent_task', dependsOn: ['b'], agentId: 'agent-1' },
          { id: 'b', name: 'B', type: 'agent_task', dependsOn: ['a'], agentId: 'agent-2' },
        ],
      };
      const errors = engine.validate(def);
      expect(errors).toContain('Workflow contains a cycle — must be a DAG');
    });

    it('should accept valid DAG', () => {
      const def: WorkflowDefinition = {
        id: 'wf-1', name: 'Test', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'a', name: 'A', type: 'agent_task', dependsOn: [], agentId: 'agent-1' },
          { id: 'b', name: 'B', type: 'agent_task', dependsOn: ['a'], agentId: 'agent-2' },
          { id: 'c', name: 'C', type: 'agent_task', dependsOn: ['a'], agentId: 'agent-3' },
          { id: 'd', name: 'D', type: 'agent_task', dependsOn: ['b', 'c'], agentId: 'agent-4' },
        ],
      };
      expect(engine.validate(def)).toHaveLength(0);
    });

    it('should validate step type requirements', () => {
      const def: WorkflowDefinition = {
        id: 'wf-1', name: 'Test', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'a', name: 'A', type: 'condition', dependsOn: [] },
          { id: 'b', name: 'B', type: 'fan_out', dependsOn: [] },
          { id: 'c', name: 'C', type: 'fan_in', dependsOn: [] },
        ],
      };
      const errors = engine.validate(def);
      expect(errors).toContain('Step a: condition type requires a condition definition');
      expect(errors).toContain('Step b: fan_out type requires a fanOut definition');
      expect(errors).toContain('Step c: fan_in type requires a fanIn definition');
    });
  });

  describe('execution', () => {
    it('should execute a single-step workflow', async () => {
      const def: WorkflowDefinition = {
        id: 'wf-1', name: 'Test', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'step1', name: 'Step 1', type: 'agent_task', dependsOn: [], agentId: 'agent-1' },
        ],
        outputs: { result: 'steps.step1.output' },
      };

      const result = await engine.start(def, { foo: 'bar' });
      expect(result.status).toBe('completed');
      expect(result.steps.get('step1')!.status).toBe('completed');
      expect(result.outputs.result).toBeDefined();
      expect(executor.executeStep).toHaveBeenCalledOnce();
    });

    it('should execute a sequential pipeline', async () => {
      const def: WorkflowDefinition = {
        id: 'wf-2', name: 'Pipeline', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'a', name: 'A', type: 'agent_task', dependsOn: [], agentId: 'agent-1' },
          { id: 'b', name: 'B', type: 'agent_task', dependsOn: ['a'], agentId: 'agent-2' },
          { id: 'c', name: 'C', type: 'agent_task', dependsOn: ['b'], agentId: 'agent-3' },
        ],
      };

      const result = await engine.start(def);
      expect(result.status).toBe('completed');
      expect([...result.steps.values()].every(s => s.status === 'completed')).toBe(true);
      expect(executor.executeStep).toHaveBeenCalledTimes(3);
    });

    it('should execute parallel steps concurrently', async () => {
      const def: WorkflowDefinition = {
        id: 'wf-3', name: 'Parallel', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'a', name: 'A', type: 'agent_task', dependsOn: [], agentId: 'agent-1' },
          { id: 'b', name: 'B', type: 'agent_task', dependsOn: [], agentId: 'agent-2' },
          { id: 'c', name: 'C', type: 'agent_task', dependsOn: ['a', 'b'], agentId: 'agent-3' },
        ],
      };

      const result = await engine.start(def);
      expect(result.status).toBe('completed');
      expect(executor.executeStep).toHaveBeenCalledTimes(3);
      // a and b should have started before c
      const aStart = result.steps.get('a')!.startedAt!.getTime();
      const bStart = result.steps.get('b')!.startedAt!.getTime();
      const cStart = result.steps.get('c')!.startedAt!.getTime();
      expect(cStart).toBeGreaterThanOrEqual(Math.max(aStart, bStart));
    });

    it('should pass inputs to steps', async () => {
      const def: WorkflowDefinition = {
        id: 'wf-4', name: 'With inputs', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 's1', name: 'S1', type: 'agent_task', dependsOn: [], agentId: 'agent-1' },
        ],
      };

      const result = await engine.start(def, { project: 'markus' });
      expect(result.inputs.project).toBe('markus');
      const stepInput = result.steps.get('s1')!.input;
      expect(stepInput).toHaveProperty('project', 'markus');
    });

    it('should use findAgent for requiredSkills', async () => {
      const def: WorkflowDefinition = {
        id: 'wf-5', name: 'Auto-route', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 's1', name: 'S1', type: 'agent_task', dependsOn: [], requiredSkills: ['git', 'code-analysis'] },
        ],
      };

      await engine.start(def);
      expect(executor.findAgent).toHaveBeenCalledWith(['git', 'code-analysis']);
    });
  });

  describe('condition steps', () => {
    it('should take true branch when condition is met', async () => {
      const mockExec = createMockExecutor({
        'agent-1': { approved: true, result: 'good' },
      });
      const eng = new WorkflowEngine(mockExec);

      const def: WorkflowDefinition = {
        id: 'wf-cond', name: 'Conditional', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'review', name: 'Review', type: 'agent_task', dependsOn: [], agentId: 'agent-1' },
          {
            id: 'check', name: 'Check', type: 'condition', dependsOn: ['review'],
            condition: {
              expression: 'steps.review.output.approved === true',
              trueBranch: ['publish'],
              falseBranch: ['revise'],
            },
          },
          { id: 'publish', name: 'Publish', type: 'agent_task', dependsOn: ['check'], agentId: 'agent-2' },
          { id: 'revise', name: 'Revise', type: 'agent_task', dependsOn: ['check'], agentId: 'agent-3' },
        ],
      };

      const result = await eng.start(def);
      expect(result.status).toBe('completed');
      expect(result.steps.get('publish')!.status).toBe('completed');
      expect(result.steps.get('revise')!.status).toBe('skipped');
    });

    it('should take false branch when condition is not met', async () => {
      const mockExec = createMockExecutor({
        'agent-1': { approved: false, feedback: 'needs work' },
      });
      const eng = new WorkflowEngine(mockExec);

      const def: WorkflowDefinition = {
        id: 'wf-cond2', name: 'Conditional', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'review', name: 'Review', type: 'agent_task', dependsOn: [], agentId: 'agent-1' },
          {
            id: 'check', name: 'Check', type: 'condition', dependsOn: ['review'],
            condition: {
              expression: 'steps.review.output.approved === true',
              trueBranch: ['publish'],
              falseBranch: ['revise'],
            },
          },
          { id: 'publish', name: 'Publish', type: 'agent_task', dependsOn: ['check'], agentId: 'agent-2' },
          { id: 'revise', name: 'Revise', type: 'agent_task', dependsOn: ['check'], agentId: 'agent-3' },
        ],
      };

      const result = await eng.start(def);
      expect(result.status).toBe('completed');
      expect(result.steps.get('publish')!.status).toBe('skipped');
      expect(result.steps.get('revise')!.status).toBe('completed');
    });
  });

  describe('transform steps', () => {
    it('should transform input to output', async () => {
      const def: WorkflowDefinition = {
        id: 'wf-xform', name: 'Transform', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 't1', name: 'Transform', type: 'transform', dependsOn: [], transform: '({ doubled: (input.value || 0) * 2 })' },
        ],
        outputs: { result: 'steps.t1.output' },
      };

      const result = await engine.start(def, { value: 21 });
      expect(result.status).toBe('completed');
      expect((result.outputs.result as Record<string, unknown>)?.doubled).toBe(42);
    });
  });

  describe('delay steps', () => {
    it('should delay execution', async () => {
      const def: WorkflowDefinition = {
        id: 'wf-delay', name: 'Delay', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 'd1', name: 'Wait', type: 'delay', dependsOn: [], delayMs: 50 },
        ],
      };

      const start = Date.now();
      const result = await engine.start(def);
      expect(result.status).toBe('completed');
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });
  });

  describe('retry', () => {
    it('should retry on failure up to maxRetries', async () => {
      let callCount = 0;
      const retryExec: WorkflowExecutor = {
        executeStep: vi.fn(async () => {
          callCount++;
          if (callCount < 3) throw new Error('Transient error');
          return { success: true };
        }),
        findAgent: vi.fn(() => 'agent-1'),
      };
      const eng = new WorkflowEngine(retryExec);

      const def: WorkflowDefinition = {
        id: 'wf-retry', name: 'Retry', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 's1', name: 'Flaky', type: 'agent_task', dependsOn: [], agentId: 'agent-1', maxRetries: 3 },
        ],
      };

      const result = await eng.start(def);
      expect(result.status).toBe('completed');
      expect(result.steps.get('s1')!.retryCount).toBe(2);
    });
  });

  describe('events', () => {
    it('should emit lifecycle events', async () => {
      const events: WorkflowEvent[] = [];
      engine.onEvent(e => events.push(e));

      const def: WorkflowDefinition = {
        id: 'wf-events', name: 'Events', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 's1', name: 'S1', type: 'agent_task', dependsOn: [], agentId: 'agent-1' },
        ],
      };

      await engine.start(def);
      const types = events.map(e => e.type);
      expect(types).toContain('workflow_started');
      expect(types).toContain('step_started');
      expect(types).toContain('step_completed');
      expect(types).toContain('workflow_completed');
    });
  });

  describe('cancellation', () => {
    it('should cancel a running workflow', async () => {
      const slowExec: WorkflowExecutor = {
        executeStep: vi.fn(async () => {
          await new Promise(r => setTimeout(r, 5000));
          return {};
        }),
        findAgent: vi.fn(() => 'agent-1'),
      };
      const eng = new WorkflowEngine(slowExec);

      const def: WorkflowDefinition = {
        id: 'wf-cancel', name: 'Cancel', description: '', version: '1.0.0', author: 'test',
        steps: [
          { id: 's1', name: 'S1', type: 'agent_task', dependsOn: [], agentId: 'agent-1' },
          { id: 's2', name: 'S2', type: 'agent_task', dependsOn: ['s1'], agentId: 'agent-2' },
        ],
      };

      const promise = eng.start(def);
      // Cancel after a short delay
      setTimeout(() => {
        const executions = eng.listExecutions();
        if (executions.length > 0) eng.cancel(executions[0]!.id);
      }, 50);

      const result = await promise;
      expect(result.status).toBe('cancelled');
    });
  });
});

describe('Composition patterns', () => {
  describe('createPipeline', () => {
    it('should create a sequential pipeline workflow', () => {
      const wf = createPipeline({
        name: 'Test Pipeline',
        stages: [
          { name: 'Plan', agentId: 'pm-1' },
          { name: 'Develop', requiredSkills: ['code'] },
          { name: 'Test', requiredSkills: ['testing'] },
        ],
      });

      expect(wf.steps).toHaveLength(3);
      expect(wf.steps[0]!.dependsOn).toHaveLength(0);
      expect(wf.steps[1]!.dependsOn).toEqual(['stage_0']);
      expect(wf.steps[2]!.dependsOn).toEqual(['stage_1']);
    });

    it('should be executable by the engine', async () => {
      const executor = createMockExecutor();
      const engine = new WorkflowEngine(executor);
      const wf = createPipeline({
        name: 'Exec Pipeline',
        stages: [
          { name: 'A', agentId: 'a-1' },
          { name: 'B', agentId: 'a-2' },
        ],
      });
      const result = await engine.start(wf);
      expect(result.status).toBe('completed');
    });
  });

  describe('createFanOut', () => {
    it('should create a fan-out/fan-in workflow', () => {
      const wf = createFanOut({
        name: 'Fan-out Test',
        producer: { name: 'Plan', agentId: 'pm-1' },
        worker: { requiredSkills: ['code'], prompt: 'Process {{item}}' },
        reducer: { name: 'Summarize', agentId: 'pm-1' },
      });

      expect(wf.steps).toHaveLength(4);
      expect(wf.steps.map(s => s.type)).toEqual(['agent_task', 'fan_out', 'fan_in', 'agent_task']);
    });
  });

  describe('createReviewChain', () => {
    it('should create a work-review-approve/revise workflow', () => {
      const wf = createReviewChain({
        name: 'Review Chain',
        worker: { name: 'Writer', agentId: 'dev-1' },
        reviewer: { name: 'Reviewer', agentId: 'rev-1' },
      });

      expect(wf.steps).toHaveLength(5);
      const condStep = wf.steps.find(s => s.type === 'condition');
      expect(condStep).toBeDefined();
      expect(condStep!.condition!.trueBranch).toContain('finalize');
      expect(condStep!.condition!.falseBranch).toContain('revise');
    });
  });

  describe('createParallelConsensus', () => {
    it('should create a parallel consensus workflow', () => {
      const wf = createParallelConsensus({
        name: 'Consensus',
        task: 'Review this code',
        agents: [
          { agentId: 'rev-1' },
          { agentId: 'rev-2' },
          { agentId: 'rev-3' },
        ],
        aggregator: { name: 'Synthesizer', agentId: 'pm-1' },
      });

      expect(wf.steps).toHaveLength(5); // 3 agents + collect + aggregate
      const parallelSteps = wf.steps.filter(s => s.dependsOn.length === 0);
      expect(parallelSteps).toHaveLength(3);
    });

    it('should be executable', async () => {
      const executor = createMockExecutor();
      const engine = new WorkflowEngine(executor);
      const wf = createParallelConsensus({
        name: 'Consensus',
        task: 'Review this',
        agents: [{ agentId: 'a-1' }, { agentId: 'a-2' }],
      });
      const result = await engine.start(wf);
      expect(result.status).toBe('completed');
    });
  });
});

describe('TeamTemplateRegistry', () => {
  it('should register and list team templates', () => {
    const registry = new TeamTemplateRegistry();
    registry.register({
      id: 'team-1', name: 'Test Team', description: 'A test team',
      version: '1.0.0', author: 'test',
      members: [{ templateId: 'tpl-developer', count: 2 }],
    });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('team-1')!.name).toBe('Test Team');
  });

  it('should search team templates', () => {
    const registry = createDefaultTeamTemplates();
    const results = registry.search('devops');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(t => t.id === 'team-devops-pipeline')).toBe(true);
  });

  it('should create default team templates', () => {
    const registry = createDefaultTeamTemplates();
    const all = registry.list();
    expect(all.length).toBe(5);

    const devSquad = registry.get('team-dev-squad');
    expect(devSquad).toBeDefined();
    expect(devSquad!.members).toHaveLength(4);
    expect(devSquad!.members.find(m => m.role === 'manager')!.templateId).toBe('tpl-project-manager');
  });

  it('should unregister team templates', () => {
    const registry = createDefaultTeamTemplates();
    expect(registry.list()).toHaveLength(5);
    registry.unregister('team-dev-squad');
    expect(registry.list()).toHaveLength(4);
    expect(registry.get('team-dev-squad')).toBeUndefined();
  });

  it('should have the full-stack team with all roles', () => {
    const registry = createDefaultTeamTemplates();
    const fullStack = registry.get('team-full-stack')!;
    expect(fullStack.members).toHaveLength(6);
    const totalAgents = fullStack.members.reduce((sum, m) => sum + (m.count ?? 1), 0);
    expect(totalAgents).toBe(8);
  });
});
