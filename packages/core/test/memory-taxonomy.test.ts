import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dreamArchiveSkillSuggestion,
  ensureKnowledgeFile,
  knowledgePath,
  migrateLegacyMemory,
  retiredStatePath,
} from '../src/memory/taxonomy.js';

/**
 * knowledge.md is now the **only** long-term store: the state.md half of the old
 * "dual store" was retired (option A) because it had a reader and a TTL pruner but
 * no write tool, while the notebook already owns "short-lived situational state".
 * These tests pin the resulting invariants.
 */
describe('memory taxonomy — single knowledge store', () => {
  it('creates knowledge.md and never creates state.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-tax-'));
    try {
      ensureKnowledgeFile(dir);
      expect(existsSync(knowledgePath(dir))).toBe(true);
      expect(existsSync(retiredStatePath(dir))).toBe(false);
      expect(existsSync(join(dir, 'MEMORY.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates legacy MEMORY.md wholesale into knowledge.md (no state half)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-tax-'));
    try {
      writeFileSync(
        join(dir, 'MEMORY.md'),
        [
          '# MEMORY',
          '',
          '## Norms',
          'Be kind.',
          '',
          '## Current progress 2026-01-01',
          'Silent day 3 — waiting.',
        ].join('\n'),
        'utf8',
      );
      const result = migrateLegacyMemory(dir);
      expect(result.migrated).toBe(true);
      const knowledge = readFileSync(knowledgePath(dir), 'utf8');
      // Nothing is silently dropped: content that the old splitter would have filed
      // under state.md now lands in the single store.
      expect(knowledge).toContain('## Norms');
      expect(knowledge).toContain('Silent day 3');
      expect(existsSync(retiredStatePath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — an existing knowledge.md is never overwritten by migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-tax-'));
    try {
      ensureKnowledgeFile(dir);
      writeFileSync(knowledgePath(dir), '# Knowledge\n\n## Curated\nkeep me\n', 'utf8');
      writeFileSync(join(dir, 'MEMORY.md'), '## Old\nstale\n', 'utf8');
      expect(migrateLegacyMemory(dir).migrated).toBe(false);
      expect(readFileSync(knowledgePath(dir), 'utf8')).toContain('keep me');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C-dream-archive-suggest', () => {
    expect(dreamArchiveSkillSuggestion({ usageCount: 0, ageDays: 31 })).toBe(true);
    expect(dreamArchiveSkillSuggestion({ usageCount: 1, ageDays: 40 })).toBe(false);
  });
});
