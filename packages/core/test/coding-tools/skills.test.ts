import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = join(import.meta.dirname, '../../../../templates/skills');

describe('coding tool skills', () => {
  const skillNames = ['coding-tools', 'claude-code', 'codex', 'cursor-agent'];

  for (const name of skillNames) {
    describe(name, () => {
      it('has valid skill.json', () => {
        const jsonPath = join(skillsDir, name, 'skill.json');
        expect(existsSync(jsonPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(jsonPath, 'utf-8'));
        expect(manifest.name).toBe(name);
        expect(manifest.type).toBe('skill');
        expect(manifest.category).toBe('development');
        expect(manifest.skill?.skillFile).toBe('SKILL.md');
      });

      it('has SKILL.md', () => {
        const mdPath = join(skillsDir, name, 'SKILL.md');
        expect(existsSync(mdPath)).toBe(true);
        const content = readFileSync(mdPath, 'utf-8');
        expect(content.length).toBeGreaterThan(100);
      });
    });
  }

  it('coding-tools skill mentions invoke_coding_tool', () => {
    const content = readFileSync(join(skillsDir, 'coding-tools', 'SKILL.md'), 'utf-8');
    expect(content).toContain('invoke_coding_tool');
    expect(content).toContain('coding_tool_apply');
  });
});
