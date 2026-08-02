import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  splitLegacyMemory,
  ensureKnowledgeStateFiles,
  pruneExpiredState,
  dreamArchiveSkillSuggestion,
  knowledgePath,
  statePath,
} from '../src/memory/taxonomy.js';

describe('memory taxonomy (MEMORY-SYSTEM §1.1)', () => {
  it('A-knowledge-cap helpers: split legacy MEMORY.md', () => {
    const { knowledge, state } = splitLegacyMemory([
      '## Stack',
      'Use TypeScript.',
      '',
      '## Current progress 2026-01-01',
      'Silent day 3 — waiting.',
      '',
      '## _observations',
      '- note',
    ].join('\n'));
    expect(knowledge).toContain('## Stack');
    expect(knowledge).toContain('## _observations');
    expect(state).toMatch(/progress|Silent|silent/i);
  });

  it('migrates MEMORY.md to knowledge.md + state.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-tax-'));
    try {
      writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n## Norms\nBe kind.\n', 'utf8');
      ensureKnowledgeStateFiles(dir);
      expect(existsSync(knowledgePath(dir))).toBe(true);
      expect(existsSync(statePath(dir))).toBe(true);
      expect(readFileSync(knowledgePath(dir), 'utf8')).toContain('Norms');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C-dream-state-ttl: prunes dated state entries', () => {
    const old = '## Snap\nupdatedAt: 2020-01-01\nold stuff\n';
    const fresh = '## Now\nupdatedAt: 2099-01-01\nkeep\n';
    const pruned = pruneExpiredState(old + fresh, Date.parse('2026-07-01'), 7);
    expect(pruned).not.toContain('old stuff');
    expect(pruned).toContain('keep');
  });

  it('C-dream-archive-suggest', () => {
    expect(dreamArchiveSkillSuggestion({ usageCount: 0, ageDays: 31 })).toBe(true);
    expect(dreamArchiveSkillSuggestion({ usageCount: 1, ageDays: 40 })).toBe(false);
  });
});
