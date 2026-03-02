import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnhancedMemorySystem } from '../src/enhanced-memory-system.js';

describe('EnhancedMemorySystem', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'markus-memory-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('creates system with required directories', () => {
      const system = new EnhancedMemorySystem(tmpDir);
      expect(system).toBeDefined();
    });

    it('accepts optional memory config', () => {
      const system = new EnhancedMemorySystem(tmpDir, {
        shortTerm: 1000,
        mediumTerm: 5000,
        longTerm: 50000,
        knowledgeBase: true,
      });
      expect(system).toBeDefined();
    });
  });

  describe('knowledge base', () => {
    it('adds and retrieves knowledge entries', () => {
      const system = new EnhancedMemorySystem(tmpDir);

      const entry = system.addKnowledge({
        category: 'technical',
        title: 'TypeScript Best Practices',
        content: 'Use strict mode, prefer interfaces over types for objects',
        tags: ['typescript', 'best-practices'],
        source: 'test',
      });

      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      expect(entry.category).toBe('technical');

      const results = system.searchKnowledge({ text: 'TypeScript' });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('TypeScript Best Practices');
    });

    it('searches by category', () => {
      const system = new EnhancedMemorySystem(tmpDir);

      system.addKnowledge({
        category: 'technical',
        title: 'Tech Entry',
        content: 'Tech content',
        tags: ['tech'],
        source: 'test',
      });

      system.addKnowledge({
        category: 'process',
        title: 'Process Entry',
        content: 'Process content',
        tags: ['process'],
        source: 'test',
      });

      const techResults = system.searchKnowledge({ category: 'technical' });
      expect(techResults.length).toBe(1);
      expect(techResults[0].title).toBe('Tech Entry');
    });

    it('searches by tags', () => {
      const system = new EnhancedMemorySystem(tmpDir);

      system.addKnowledge({
        category: 'general',
        title: 'Tagged Entry',
        content: 'Has specific tags',
        tags: ['alpha', 'beta'],
        source: 'test',
      });

      system.addKnowledge({
        category: 'general',
        title: 'Other Entry',
        content: 'Different tags',
        tags: ['gamma'],
        source: 'test',
      });

      const results = system.searchKnowledge({ tags: ['alpha'] });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Tagged Entry');
    });

    it('persists knowledge across instances', () => {
      const system1 = new EnhancedMemorySystem(tmpDir);
      system1.addKnowledge({
        category: 'persistent',
        title: 'Persisted Entry',
        content: 'This should survive restart',
        tags: ['persistence'],
        source: 'test',
      });

      const system2 = new EnhancedMemorySystem(tmpDir);
      const results = system2.searchKnowledge({ category: 'persistent' });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Persisted Entry');
    });
  });

  describe('memory summary', () => {
    it('returns correct summary statistics', () => {
      const system = new EnhancedMemorySystem(tmpDir);

      system.addKnowledge({
        category: 'cat-a',
        title: 'A1',
        content: 'c',
        tags: [],
        source: 'test',
      });
      system.addKnowledge({
        category: 'cat-a',
        title: 'A2',
        content: 'c',
        tags: [],
        source: 'test',
      });
      system.addKnowledge({
        category: 'cat-b',
        title: 'B1',
        content: 'c',
        tags: [],
        source: 'test',
      });

      const summary = system.getMemorySummary();
      expect(summary.knowledgeBaseSize).toBe(3);
      expect(summary.topCategories.length).toBe(2);
      expect(summary.topCategories[0].category).toBe('cat-a');
      expect(summary.topCategories[0].count).toBe(2);
    });
  });

  describe('agent context', () => {
    it('returns context with relevant knowledge for a query', () => {
      const system = new EnhancedMemorySystem(tmpDir);

      system.addKnowledge({
        category: 'project',
        title: 'API Design Guidelines',
        content: 'REST APIs should use proper HTTP verbs and status codes',
        tags: ['api', 'design'],
        source: 'test',
      });

      const context = system.getAgentContext('agent-1', 'API design');
      expect(context).toContain('API Design Guidelines');
      expect(context).toContain('Relevant Knowledge');
    });

    it('returns empty context for unrelated queries', () => {
      const system = new EnhancedMemorySystem(tmpDir);

      system.addKnowledge({
        category: 'cooking',
        title: 'Best Pasta Recipes',
        content: 'Use fresh ingredients',
        tags: ['food'],
        source: 'test',
      });

      const context = system.getAgentContext('agent-1', 'quantum physics');
      expect(context).not.toContain('Pasta');
    });
  });

  describe('IMemoryStore compliance', () => {
    it('implements all IMemoryStore methods', () => {
      const system = new EnhancedMemorySystem(tmpDir);

      // Session management
      const session = system.createSession('agent-1');
      expect(session.id).toBeDefined();
      expect(session.agentId).toBe('agent-1');

      system.appendMessage(session.id, { role: 'user', content: 'Hello' });
      system.appendMessage(session.id, { role: 'assistant', content: 'Hi there' });

      const messages = system.getRecentMessages(session.id, 10);
      expect(messages).toHaveLength(2);

      const latest = system.getLatestSession('agent-1');
      expect(latest?.id).toBe(session.id);

      const all = system.listSessions('agent-1');
      expect(all).toHaveLength(1);

      // Memory entries
      system.addEntry({ id: 'e1', timestamp: new Date().toISOString(), type: 'fact', content: 'Test fact' });
      expect(system.getEntries('fact')).toHaveLength(1);
      expect(system.search('Test fact')).toHaveLength(1);

      // Daily logs
      system.writeDailyLog('agent-1', 'End of day summary');
      expect(system.getDailyLog()).toContain('End of day summary');
      expect(system.getRecentDailyLogs(1)).toContain('End of day summary');

      // Long-term
      system.addLongTermMemory('project-info', 'Markus is an AI platform');
      expect(system.getLongTermMemory()).toContain('Markus is an AI platform');

      // Compaction
      const result = system.compactSession(session.id, 1);
      expect(result.flushedCount).toBe(1);
      const remaining = system.summarizeAndTruncate(session.id, 1);
      expect(remaining.length).toBeLessThanOrEqual(1);
    });
  });
});
