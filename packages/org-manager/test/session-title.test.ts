import { describe, it, expect } from 'vitest';
import { deriveSessionTitle, isInjectedContextMessage } from '../src/session-title.js';

const CHIP_MSG = [
  '[terminal-selection]',
  'Terminal: Terminal (id)',
  'Cwd: /p',
  '"""',
  'boom: selected output',
  '"""',
].join('\n');

describe('isInjectedContextMessage', () => {
  it('detects every injected context-chip marker', () => {
    for (const m of ['[terminal-selection]', '[terminal-output]', '[html-selection]']) {
      expect(isInjectedContextMessage(`${m}\nfoo`)).toBe(true);
    }
  });

  it('is false for an ordinary user message', () => {
    expect(isInjectedContextMessage('为什么远程访问这么慢')).toBe(false);
  });
});

describe('deriveSessionTitle', () => {
  it('prefers the user-authored titleSource over the raw payload', () => {
    const raw = `${CHIP_MSG}\n\n为什么远程访问这么慢`;
    expect(deriveSessionTitle('为什么远程访问这么慢', raw)).toBe('为什么远程访问这么慢');
  });

  it('never fabricates a title from injected context alone', () => {
    // This is the reported bug: slicing the raw payload produced
    // `[terminal-selection] Terminal: …`. We now refuse rather than guess.
    expect(deriveSessionTitle(undefined, CHIP_MSG)).toBeNull();
    expect(deriveSessionTitle('', CHIP_MSG)).toBeNull();
    expect(deriveSessionTitle('   ', CHIP_MSG)).toBeNull();
  });

  it('falls back to the first non-empty line for a plain message', () => {
    expect(deriveSessionTitle(undefined, '\n\nHello world\nsecond line')).toBe('Hello world');
  });

  it('caps the title at 60 characters', () => {
    expect(deriveSessionTitle('x'.repeat(100), '')?.length).toBe(60);
  });

  it('returns null for a blank message', () => {
    expect(deriveSessionTitle(undefined, '   \n  ')).toBeNull();
  });
});
