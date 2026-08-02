import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('B-self-evolution-skill-retired', () => {
  it('templates/skills/self-evolution package is removed', () => {
    expect(existsSync(join(repoRoot, 'templates/skills/self-evolution'))).toBe(false);
    expect(existsSync(join(repoRoot, 'templates/skills/self-evolution/skill.json'))).toBe(false);
  });
});
