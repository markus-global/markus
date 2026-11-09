/**
 * The evaluator is the security-critical replacement for the code generator that
 * used to compile workflow expressions. These tests pin both halves of the
 * contract: the expressions workflow authors legitimately need keep working, and
 * everything that could reach the host process keeps failing closed.
 */
import { describe, it, expect } from 'vitest';
import { evaluateExpression, ExpressionError } from '../src/workflow/expression.js';

const scope = {
  input: { value: 21, name: 'alpha', nested: { deep: true }, items: [1, 2, 3] },
  steps: { a: { output: { ok: true }, status: 'completed' } },
  inputs: { topic: 'test' },
};

describe('evaluateExpression — what workflows need', () => {
  it('reads literals and identifiers from the scope', () => {
    expect(evaluateExpression('42', scope)).toBe(42);
    expect(evaluateExpression("'text'", scope)).toBe('text');
    expect(evaluateExpression('true', scope)).toBe(true);
    expect(evaluateExpression('null', scope)).toBeNull();
    expect(evaluateExpression('input.name', scope)).toBe('alpha');
  });

  it('does arithmetic, comparison and logical operators', () => {
    expect(evaluateExpression('(input.value || 0) * 2', scope)).toBe(42);
    expect(evaluateExpression('input.value + 1', scope)).toBe(22);
    expect(evaluateExpression('input.value > 10 && input.nested.deep', scope)).toBe(true);
    expect(evaluateExpression('input.value === 21', scope)).toBe(true);
    expect(evaluateExpression('!input.nested.deep', scope)).toBe(false);
  });

  it('supports nullish coalescing and the conditional operator', () => {
    expect(evaluateExpression('input.missing ?? input.value', scope)).toBe(21);
    expect(evaluateExpression("input.value > 20 ? 'big' : 'small'", scope)).toBe('big');
  });

  it('builds the object and array literals the workflow builders emit', () => {
    // Shape produced by the review-chain / consensus builders.
    expect(evaluateExpression('({ result: input.value ?? input.name, approved: true })', scope))
      .toEqual({ result: 21, approved: true });
    expect(evaluateExpression('({ opinions: [input.name, steps.a.status], count: 2 })', scope))
      .toEqual({ opinions: ['alpha', 'completed'], count: 2 });
  });

  it('reads nested, computed and numeric members', () => {
    expect(evaluateExpression('steps.a.output.ok', scope)).toBe(true);
    expect(evaluateExpression("input['name']", scope)).toBe('alpha');
    expect(evaluateExpression('input.items[1]', scope)).toBe(2);
  });
});

describe('evaluateExpression — everything else fails closed', () => {
  it('rejects function calls', () => {
    expect(() => evaluateExpression('input.name.toUpperCase()', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('require("child_process")', scope)).toThrow(ExpressionError);
  });

  it('rejects assignment and statements', () => {
    expect(() => evaluateExpression('input.value = 1', scope)).toThrow(ExpressionError);
  });

  it('rejects unknown identifiers instead of leaking globals', () => {
    expect(() => evaluateExpression('process', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('globalThis', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('constructor', scope)).toThrow(ExpressionError);
  });

  it('blocks prototype-chain keys on member access', () => {
    expect(() => evaluateExpression('input.__proto__', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression("input['constructor']", scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('input.prototype', scope)).toThrow(ExpressionError);
  });

  it('rejects template interpolation and empty input', () => {
    expect(() => evaluateExpression('`v=${input.value}`', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('   ', scope)).toThrow(ExpressionError);
  });

  it('does not evaluate anything from a working example of the old bug', () => {
    // The shape an attacker used to send: a call chain that would have reached the
    // host process. It must fail at parse/eval time, not run.
    expect(() => evaluateExpression(
      "process.getBuiltinModule('child_process').execSync('id')", scope,
    )).toThrow(ExpressionError);
  });
});
