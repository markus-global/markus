/**
 * W2 的第一半：**声明侧**校验。
 *
 * 设计取向（第一性原理）：产出是 `TaskDeliverable.type` 这种**结构化字段**，
 * 不是自由文本。所以契约可以被机械校验，而不是靠 agent 自觉或靠人读描述。
 *
 * 同时守住向后兼容：没有 `outputs` / `inputs` 的模板行为完全不变——这条比
 * "校验更严"更重要，旧模板不能因为升级而突然存不进去。
 */
import { describe, it, expect } from 'vitest';
import { validateWorkflowTemplate } from '../src/types/workflow-template.js';

function template(steps: Array<Record<string, unknown>>) {
  return { name: 'wf', description: 'd', version: '1.0.0', steps };
}

const base = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Step ${id}`,
  role: 'worker',
  prompt: 'do {{topic}}',
  type: 'agent_task',
  ...extra,
});

describe('declared outputs', () => {
  it('accepts a valid output declaration', () => {
    const errors = validateWorkflowTemplate(template([
      base('a', { outputs: [{ name: 'plan', type: 'file' }] }),
    ]));
    expect(errors).toEqual([]);
  });

  it('rejects an output type that is not a real deliverable type', () => {
    const errors = validateWorkflowTemplate(template([
      base('a', { outputs: [{ name: 'plan', type: 'markdown' }] }),
    ]));
    expect(errors.join(' ')).toMatch(/type must be "file" or "directory"/);
  });

  it('rejects duplicate output names', () => {
    const errors = validateWorkflowTemplate(template([
      base('a', { outputs: [{ name: 'plan' }, { name: 'plan' }] }),
    ]));
    expect(errors.join(' ')).toMatch(/declared twice/);
  });

  it('rejects a nameless output', () => {
    const errors = validateWorkflowTemplate(template([
      base('a', { outputs: [{ type: 'file' }] }),
    ]));
    expect(errors.join(' ')).toMatch(/non-empty "name"/);
  });
});

describe('input wiring', () => {
  it('accepts an input that names a declared upstream output', () => {
    const errors = validateWorkflowTemplate(template([
      base('a', { outputs: [{ name: 'plan', type: 'file' }] }),
      base('b', { depends_on: ['a'], inputs: [{ from: 'a', as: 'plan' }] }),
    ]));
    expect(errors).toEqual([]);
  });

  it('rejects an input naming an output the upstream never declared', () => {
    const errors = validateWorkflowTemplate(template([
      base('a', { outputs: [{ name: 'plan' }] }),
      base('b', { depends_on: ['a'], inputs: [{ from: 'a', as: 'spec' }] }),
    ]));
    expect(errors.join(' ')).toMatch(/not one of step "a" outputs/);
  });

  it('rejects consuming from a step that is not a dependency (it could run later)', () => {
    const errors = validateWorkflowTemplate(template([
      base('a', { outputs: [{ name: 'plan' }] }),
      base('b', { inputs: [{ from: 'a', as: 'plan' }] }), // no depends_on
    ]));
    expect(errors.join(' ')).toMatch(/not a declared dependency/);
  });

  it('accepts consumption through a transitive dependency', () => {
    const errors = validateWorkflowTemplate(template([
      base('a', { outputs: [{ name: 'plan' }] }),
      base('b', { depends_on: ['a'] }),
      base('c', { depends_on: ['b'], inputs: [{ from: 'a', as: 'plan' }] }),
    ]));
    expect(errors).toEqual([]);
  });
});

describe('backward compatibility', () => {
  it('keeps accepting templates that declare no contract at all', () => {
    const errors = validateWorkflowTemplate(template([
      base('a'),
      base('b', { depends_on: ['a'] }),
    ]));
    expect(errors).toEqual([]);
  });

  it('does not enforce the contract when the upstream declares no outputs', () => {
    // 老模板可能已经有 inputs（类型早存在），上游没声明产出 → 不硬性拒绝
    const errors = validateWorkflowTemplate(template([
      base('a'),
      base('b', { depends_on: ['a'], inputs: [{ from: 'a', as: 'legacy' }] }),
    ]));
    expect(errors).toEqual([]);
  });
});
