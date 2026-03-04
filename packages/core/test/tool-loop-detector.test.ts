import { describe, it, expect } from 'vitest';
import { ToolLoopDetector } from '../src/tool-loop-detector.js';

describe('ToolLoopDetector', () => {
  it('should not detect patterns with insufficient history', () => {
    const d = new ToolLoopDetector();
    d.record('shell_execute', { command: 'ls' }, 'files...');
    const result = d.check();
    expect(result.detected).toBe(false);
  });

  it('should detect genericRepeat pattern', () => {
    const d = new ToolLoopDetector({ enabled: true, historySize: 30, warningThreshold: 3, criticalThreshold: 5, detectors: { genericRepeat: true, pingPong: false, noProgress: false } });

    for (let i = 0; i < 5; i++) {
      d.record('file_read', { path: 'config.json' }, '{"key":"value"}');
    }

    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe('genericRepeat');
    expect(result.severity).toBe('critical');
  });

  it('should detect genericRepeat warning before critical', () => {
    const d = new ToolLoopDetector({ enabled: true, historySize: 30, warningThreshold: 3, criticalThreshold: 6, detectors: { genericRepeat: true, pingPong: false, noProgress: false } });

    for (let i = 0; i < 3; i++) {
      d.record('file_read', { path: 'config.json' }, '{"key":"value"}');
    }

    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('warning');
  });

  it('should detect pingPong pattern', () => {
    const d = new ToolLoopDetector({ enabled: true, historySize: 30, warningThreshold: 4, criticalThreshold: 6, detectors: { genericRepeat: false, pingPong: true, noProgress: false } });

    for (let i = 0; i < 6; i++) {
      if (i % 2 === 0) {
        d.record('file_edit', { path: 'a.ts', old: 'x', new: 'y' }, 'success');
      } else {
        d.record('file_read', { path: 'a.ts' }, 'content...');
      }
    }

    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe('pingPong');
  });

  it('should detect noProgress pattern', () => {
    const d = new ToolLoopDetector({ enabled: true, historySize: 30, warningThreshold: 3, criticalThreshold: 5, detectors: { genericRepeat: false, pingPong: false, noProgress: true } });

    for (let i = 0; i < 5; i++) {
      d.record('shell_execute', { command: `npm test attempt_${i}` }, 'Error: test failed at line 42');
    }

    const result = d.check();
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe('noProgress');
    expect(result.severity).toBe('critical');
  });

  it('should not detect when different tools are used', () => {
    const d = new ToolLoopDetector({ enabled: true, historySize: 30, warningThreshold: 3, criticalThreshold: 5, detectors: { genericRepeat: true, pingPong: true, noProgress: true } });

    d.record('file_read', { path: 'a.ts' }, 'content_a');
    d.record('shell_execute', { command: 'npm test' }, 'tests pass');
    d.record('file_write', { path: 'b.ts' }, 'written');
    d.record('grep_search', { pattern: 'TODO' }, 'found');
    d.record('list_directory', {}, 'tree...');

    const result = d.check();
    expect(result.detected).toBe(false);
  });

  it('should not detect when disabled', () => {
    const d = new ToolLoopDetector({ enabled: false, historySize: 30, warningThreshold: 3, criticalThreshold: 5, detectors: { genericRepeat: true, pingPong: true, noProgress: true } });

    for (let i = 0; i < 10; i++) {
      d.record('file_read', { path: 'config.json' }, 'same result');
    }

    const result = d.check();
    expect(result.detected).toBe(false);
  });

  it('should reset history', () => {
    const d = new ToolLoopDetector({ enabled: true, historySize: 30, warningThreshold: 3, criticalThreshold: 5, detectors: { genericRepeat: true, pingPong: false, noProgress: false } });

    for (let i = 0; i < 5; i++) {
      d.record('file_read', { path: 'config.json' }, 'result');
    }

    d.reset();
    expect(d.getHistory().length).toBe(0);
    expect(d.check().detected).toBe(false);
  });

  it('should trim history to historySize', () => {
    const d = new ToolLoopDetector({ enabled: true, historySize: 5, warningThreshold: 3, criticalThreshold: 5, detectors: { genericRepeat: true, pingPong: false, noProgress: false } });

    for (let i = 0; i < 20; i++) {
      d.record('tool_' + i, {}, 'result_' + i);
    }

    expect(d.getHistory().length).toBe(5);
  });
});
