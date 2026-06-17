import { describe, it, expect } from 'vitest';
import {
  validateWorkflowTemplate,
  topologicalSort,
  parseInterval,
  renderStepPrompt,
  extractRoles,
  type StepDef,
  type WorkflowTemplate,
} from '../src/types/workflow-template.js';

// ---------------------------------------------------------------------------
// validateWorkflowTemplate
// ---------------------------------------------------------------------------

describe('validateWorkflowTemplate', () => {
  const minValid = {
    name: 'test-wf', description: 'desc', version: '1.0.0',
    steps: [{ id: 's1', name: 'Step 1', role: 'worker', prompt: 'do it', type: 'agent_task' }],
  };

  it('accepts a minimal valid template', () => {
    expect(validateWorkflowTemplate(minValid)).toEqual([]);
  });

  it('rejects null', () => {
    expect(validateWorkflowTemplate(null)).toContain('Template must be a non-null object');
  });

  it('rejects missing name', () => {
    const t = { ...minValid, name: '' };
    expect(validateWorkflowTemplate(t)).toContain('name is required');
  });

  it('rejects missing description', () => {
    const t = { ...minValid, description: undefined };
    expect(validateWorkflowTemplate(t).some(e => e.includes('description'))).toBe(true);
  });

  it('rejects missing version', () => {
    const t = { ...minValid, version: undefined };
    expect(validateWorkflowTemplate(t).some(e => e.includes('version'))).toBe(true);
  });

  it('rejects empty steps', () => {
    const t = { ...minValid, steps: [] };
    expect(validateWorkflowTemplate(t)).toContain('steps must be a non-empty array');
  });

  it('rejects duplicate step IDs', () => {
    const t = {
      ...minValid,
      steps: [
        { id: 's1', name: 'A', role: 'r', prompt: 'p' },
        { id: 's1', name: 'B', role: 'r', prompt: 'p' },
      ],
    };
    expect(validateWorkflowTemplate(t).some(e => e.includes('duplicated'))).toBe(true);
  });

  it('rejects step missing role', () => {
    const t = {
      ...minValid,
      steps: [{ id: 's1', name: 'A', role: '', prompt: 'p' }],
    };
    expect(validateWorkflowTemplate(t).some(e => e.includes('role'))).toBe(true);
  });

  it('rejects unknown depends_on reference', () => {
    const t = {
      ...minValid,
      steps: [
        { id: 's1', name: 'A', role: 'r', prompt: 'p', depends_on: ['s99'] },
      ],
    };
    expect(validateWorkflowTemplate(t).some(e => e.includes('unknown step'))).toBe(true);
  });

  it('detects circular dependencies', () => {
    const t = {
      ...minValid,
      steps: [
        { id: 's1', name: 'A', role: 'r', prompt: 'p', depends_on: ['s2'] },
        { id: 's2', name: 'B', role: 'r', prompt: 'p', depends_on: ['s1'] },
      ],
    };
    expect(validateWorkflowTemplate(t).some(e => e.includes('Circular'))).toBe(true);
  });

  it('validates params: rejects duplicate names', () => {
    const t = {
      ...minValid,
      params: [
        { name: 'topic', type: 'string' },
        { name: 'topic', type: 'text' },
      ],
    };
    expect(validateWorkflowTemplate(t).some(e => e.includes('Duplicate param'))).toBe(true);
  });

  it('validates params: enum needs options', () => {
    const t = {
      ...minValid,
      params: [{ name: 'choice', type: 'enum' }],
    };
    expect(validateWorkflowTemplate(t).some(e => e.includes('non-empty options'))).toBe(true);
  });

  it('validates schedule: rejects empty schedule', () => {
    const t = { ...minValid, schedule: {} };
    expect(validateWorkflowTemplate(t).some(e => e.includes('at least one of'))).toBe(true);
  });

  it('validates schedule: rejects invalid interval', () => {
    const t = { ...minValid, schedule: { every: 'nope' } };
    expect(validateWorkflowTemplate(t).some(e => e.includes('invalid interval'))).toBe(true);
  });

  it('validates schedule: accepts valid cron', () => {
    const t = { ...minValid, schedule: { cron: '0 9 * * 1-5' } };
    expect(validateWorkflowTemplate(t)).toEqual([]);
  });

  it('validates inputs[].from references', () => {
    const t = {
      ...minValid,
      steps: [
        { id: 's1', name: 'A', role: 'r', prompt: 'p', inputs: [{ from: 's99', as: 'data' }] },
      ],
    };
    expect(validateWorkflowTemplate(t).some(e => e.includes('inputs.from'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------

describe('topologicalSort', () => {
  it('returns steps in dependency order', () => {
    const steps: StepDef[] = [
      { id: 'c', name: 'C', role: 'r', prompt: 'p', type: 'agent_task', depends_on: ['b'] },
      { id: 'a', name: 'A', role: 'r', prompt: 'p', type: 'agent_task' },
      { id: 'b', name: 'B', role: 'r', prompt: 'p', type: 'agent_task', depends_on: ['a'] },
    ];
    const sorted = topologicalSort(steps);
    const ids = sorted.map(s => s.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  it('throws on circular deps', () => {
    const steps: StepDef[] = [
      { id: 'a', name: 'A', role: 'r', prompt: 'p', type: 'agent_task', depends_on: ['b'] },
      { id: 'b', name: 'B', role: 'r', prompt: 'p', type: 'agent_task', depends_on: ['a'] },
    ];
    expect(() => topologicalSort(steps)).toThrow('Circular');
  });

  it('handles independent steps', () => {
    const steps: StepDef[] = [
      { id: 'a', name: 'A', role: 'r', prompt: 'p', type: 'agent_task' },
      { id: 'b', name: 'B', role: 'r', prompt: 'p', type: 'agent_task' },
    ];
    const sorted = topologicalSort(steps);
    expect(sorted.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parseInterval
// ---------------------------------------------------------------------------

describe('parseInterval', () => {
  it('parses seconds', () => { expect(parseInterval('30s')).toBe(30_000); });
  it('parses minutes', () => { expect(parseInterval('5m')).toBe(300_000); });
  it('parses hours', () => { expect(parseInterval('6h')).toBe(21_600_000); });
  it('parses days', () => { expect(parseInterval('1d')).toBe(86_400_000); });
  it('parses weeks', () => { expect(parseInterval('1w')).toBe(604_800_000); });
  it('returns null for invalid input', () => { expect(parseInterval('nope')).toBeNull(); });
  it('returns null for empty string', () => { expect(parseInterval('')).toBeNull(); });
  it('handles leading/trailing whitespace', () => { expect(parseInterval(' 2h ')).toBe(7_200_000); });
});

// ---------------------------------------------------------------------------
// renderStepPrompt
// ---------------------------------------------------------------------------

describe('renderStepPrompt', () => {
  it('substitutes user parameters', () => {
    const step: StepDef = { id: 's1', name: 'S', role: 'r', prompt: 'Write about {{topic}}', type: 'agent_task' };
    const result = renderStepPrompt(step, { topic: 'AI' }, 1);
    expect(result).toBe('Write about AI');
  });

  it('substitutes built-in {{run_number}}', () => {
    const step: StepDef = { id: 's1', name: 'S', role: 'r', prompt: 'Run #{{run_number}}', type: 'agent_task' };
    const result = renderStepPrompt(step, {}, 42);
    expect(result).toContain('Run #42');
  });

  it('substitutes {{date}} and {{time}}', () => {
    const step: StepDef = { id: 's1', name: 'S', role: 'r', prompt: 'Date: {{date}} Time: {{time}}', type: 'agent_task' };
    const result = renderStepPrompt(step, {}, 1);
    expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
    expect(result).toMatch(/Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('appends upstream context for inputs', () => {
    const step: StepDef = {
      id: 's2', name: 'S', role: 'r', prompt: 'Continue', type: 'agent_task',
      inputs: [{ from: 's1', as: 'research_data' }],
    };
    const result = renderStepPrompt(step, {}, 1);
    expect(result).toContain('research_data');
    expect(result).toContain('s1');
  });
});

// ---------------------------------------------------------------------------
// extractRoles
// ---------------------------------------------------------------------------

describe('extractRoles', () => {
  it('extracts unique roles from steps', () => {
    const template: WorkflowTemplate = {
      name: 'test', description: 'test', version: '1.0.0',
      steps: [
        { id: 's1', name: 'A', role: 'developer', prompt: 'p', type: 'agent_task' },
        { id: 's2', name: 'B', role: 'reviewer', prompt: 'p', type: 'agent_task', reviewer: 'manager' },
        { id: 's3', name: 'C', role: 'developer', prompt: 'p', type: 'agent_task' },
      ],
    };
    const roles = extractRoles(template);
    expect(roles.sort()).toEqual(['developer', 'manager', 'reviewer']);
  });

  it('includes reviewer roles', () => {
    const template: WorkflowTemplate = {
      name: 'test', description: 'test', version: '1.0.0',
      steps: [{ id: 's1', name: 'A', role: 'worker', prompt: 'p', type: 'agent_task', reviewer: 'lead' }],
    };
    const roles = extractRoles(template);
    expect(roles).toContain('worker');
    expect(roles).toContain('lead');
  });
});
