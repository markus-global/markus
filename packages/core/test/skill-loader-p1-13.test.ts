import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSkillInstructions, readSkillInstructionsDetailed } from '../src/skills/loader.js';

/**
 * P1-13：技能指令「读取失败」以前与「无指令」不可区分（都返回 undefined），
 * 磁盘/权限故障被静默当成合法无指令型 skill。现在必须可区分。
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-p113-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('P1-13: skill instruction load errors are distinguishable', () => {
  it('missing SKILL.md → ok, no instructions (legit no-op skill)', () => {
    const r = readSkillInstructionsDetailed(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.instructions).toBeUndefined();
  });

  it('readable SKILL.md → ok with instructions (frontmatter stripped)', () => {
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\n---\n\nDo the thing.');
    const r = readSkillInstructionsDetailed(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.instructions).toBe('Do the thing.');
  });

  it('unreadable SKILL.md → ok:false with error (NOT silently "no instructions")', () => {
    // A directory named SKILL.md: existsSync() is true, readFileSync() throws EISDIR.
    mkdirSync(join(dir, 'SKILL.md'));
    const r = readSkillInstructionsDetailed(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    // The legacy wrapper keeps returning undefined for back-compat…
    expect(readSkillInstructions(dir)).toBeUndefined();
    // …but callers can now tell the difference via the detailed API.
  });
});
