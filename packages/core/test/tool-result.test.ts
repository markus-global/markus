import { describe, it, expect } from 'vitest';
import { toolOk, toolErr, isToolErrorResult } from '../src/tools/result.js';

describe('toolOk / toolErr', () => {
  it('emits the canonical success envelope and keeps payload fields', () => {
    const parsed = JSON.parse(toolOk({ provider: 'markus', model: 'deepgram/aura-2' }));
    expect(parsed).toEqual({
      provider: 'markus',
      model: 'deepgram/aura-2',
      status: 'success',
      success: true,
    });
  });

  it('does not let a payload `status` overwrite the canonical success status', () => {
    const parsed = JSON.parse(toolOk({ status: 'completed', taskId: 't1' }));
    expect(parsed.status).toBe('success');
    expect(parsed.success).toBe(true);
    // Payload status is lost by design — callers must use a distinct key
    // (e.g. generationStatus) for domain-specific status values.
  });

  it('emits the canonical error envelope with optional hints', () => {
    const parsed = JSON.parse(toolErr('boom', { hint: 'retry with aura-2-thalia-en' }));
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('boom');
    expect(parsed.hint).toBe('retry with aura-2-thalia-en');
  });
});

describe('isToolErrorResult', () => {
  it('recognises status error/denied/rejected', () => {
    expect(isToolErrorResult(JSON.stringify({ status: 'error', error: 'x' }))).toBe(true);
    expect(isToolErrorResult(JSON.stringify({ status: 'denied', error: 'no' }))).toBe(true);
    expect(isToolErrorResult(JSON.stringify({ status: 'rejected', reason: 'user' }))).toBe(true);
  });

  it('recognises legacy { error } and { success: false }', () => {
    expect(isToolErrorResult(JSON.stringify({ error: 'TTS failed' }))).toBe(true);
    expect(isToolErrorResult(JSON.stringify({ success: false, error: 'gui' }))).toBe(true);
    expect(isToolErrorResult(JSON.stringify({ success: true, error: null }))).toBe(false);
    expect(isToolErrorResult(toolOk({ images: [] }))).toBe(false);
  });

  it('B1: recognises non-JSON plain-text errors', () => {
    expect(isToolErrorResult('Error: something broke')).toBe(true);
    expect(isToolErrorResult('error: lowercase prefix')).toBe(true);
    expect(isToolErrorResult('Failed to read file')).toBe(true);
    expect(isToolErrorResult('Exception: boom')).toBe(true);
    expect(isToolErrorResult('TypeError: x is not a function')).toBe(true);
    expect(isToolErrorResult('Traceback (most recent call last):')).toBe(true);
    expect(isToolErrorResult('Cannot find module "foo"')).toBe(true);
    expect(isToolErrorResult('Unable to connect to host')).toBe(true);
    expect(isToolErrorResult('  Fatal: disk full')).toBe(true); // leading whitespace tolerated
  });

  it('B1: does not misclassify ordinary plain text as an error', () => {
    expect(isToolErrorResult('Successfully wrote 3 files')).toBe(false);
    expect(isToolErrorResult('The error handling module was refactored')).toBe(false); // "error" not at start
    expect(isToolErrorResult('Here is the file content you requested')).toBe(false);
    expect(isToolErrorResult('')).toBe(false);
    expect(isToolErrorResult('done')).toBe(false);
  });
});
