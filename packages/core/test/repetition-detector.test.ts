import { describe, it, expect } from 'vitest';
import { detectDegenerateRepetition, RepetitionGuard } from '../src/repetition-detector.js';

describe('detectDegenerateRepetition', () => {
  it('flags a sentence repeated many times (the observed failure mode)', () => {
    const line = '好的，让我最终完成所有测试，读取 STT 转录结果，完成最终测试报告。';
    expect(detectDegenerateRepetition(line.repeat(6))).toBe(true);
  });

  it('flags a repeated English line dominating the output', () => {
    const text = Array(5).fill('Let me now read the STT transcription results.').join('\n');
    expect(detectDegenerateRepetition(text)).toBe(true);
  });

  it('does not flag ordinary varied prose', () => {
    const text = [
      'The migration adds a new column to the users table.',
      'It backfills existing rows in batches of one thousand.',
      'Finally it flips the feature flag so reads use the column.',
      'Rollback drops the column and clears the flag.',
    ].join('\n');
    expect(detectDegenerateRepetition(text)).toBe(false);
  });

  it('does not flag a few repeated lines inside otherwise varied output', () => {
    // e.g. repeated log lines in generated code — repeats exist but do not dominate.
    const varied = Array.from({ length: 20 }, (_, i) => `const value${i} = compute(${i}) + offset;`);
    varied.splice(5, 0, 'console.log("processing item");');
    varied.splice(9, 0, 'console.log("processing item");');
    varied.splice(13, 0, 'console.log("processing item");');
    varied.splice(17, 0, 'console.log("processing item");');
    expect(detectDegenerateRepetition(varied.join('\n'))).toBe(false);
  });

  it('ignores short repeated fragments below the length threshold', () => {
    expect(detectDegenerateRepetition('Yes.\nYes.\nYes.\nYes.\nYes.')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(detectDegenerateRepetition('')).toBe(false);
  });
});

describe('RepetitionGuard', () => {
  it('latches once a repeated segment dominates the stream', () => {
    const guard = new RepetitionGuard();
    const line = 'Let me finalize the report and check the video output now.\n';
    let tripped = false;
    for (let i = 0; i < 5; i++) tripped = guard.push(line) || tripped;
    expect(tripped).toBe(true);
    expect(guard.degenerated).toBe(true);
    // Stays latched even if later chunks are unique.
    expect(guard.push('a brand new unique sentence appears here.')).toBe(true);
  });

  it('does not trip on healthy streaming output', () => {
    const guard = new RepetitionGuard();
    const chunks = [
      'First, I read the transcript file. ',
      'Then I compared it against the source audio. ',
      'The word error rate was under two percent. ',
      'I saved the report to disk and notified the owner. ',
    ];
    let tripped = false;
    for (const c of chunks) tripped = guard.push(c) || tripped;
    expect(tripped).toBe(false);
    expect(guard.degenerated).toBe(false);
  });
});
