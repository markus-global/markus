import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { skillPendingDir, skillLiveDir, shouldSuppressSkillDraft } from '../src/learning-loop.js';

describe('skill staging (LEARNING-LOOP §3)', () => {
  it('B-stage-not-live: pending path is under .pending', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifacts-'));
    try {
      const pending = skillPendingDir(root, 'my-skill');
      expect(pending).toContain(`${join('skills', '.pending', 'my-skill')}`);
      mkdirSync(pending, { recursive: true });
      writeFileSync(join(pending, 'SKILL.md'), '# My Skill\n', 'utf8');
      expect(existsSync(join(skillLiveDir(root, 'my-skill'), 'SKILL.md'))).toBe(false);
      expect(existsSync(join(pending, 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('B-approve-install path: live dir distinct from pending', () => {
    const root = '/tmp/builder-artifacts';
    expect(skillLiveDir(root, 'x')).not.toContain('.pending');
    expect(skillPendingDir(root, 'x')).toContain('.pending');
  });

  it('B-reject-feedback suppress', () => {
    expect(shouldSuppressSkillDraft(['- rejected fingerprint:abc'], 'abc')).toBe(true);
  });
});
