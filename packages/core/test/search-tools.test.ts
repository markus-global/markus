import { describe, it, expect } from 'vitest';
import { createGrepTool, createGlobTool, createListDirectoryTool } from '../src/tools/search.js';
import { resolve } from 'node:path';

const WORKSPACE = resolve(import.meta.dirname, '..');

describe('Search Tools', () => {
  describe('grep_search', () => {
    const grep = createGrepTool(WORKSPACE);

    it('should find pattern matches in files', async () => {
      const result = await grep.execute({ pattern: 'createGrepTool', include: '*.ts' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.results).toContain('createGrepTool');
    });

    it('should return no matches for nonexistent pattern', async () => {
      // Search only in a specific file that won't contain this pattern
      const result = await grep.execute({ pattern: 'z9q8w7e6r5t4y3', path: 'package.json' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.matchCount === 0 || parsed.results === '').toBe(true);
    });

    it('should support case-insensitive search', async () => {
      const result = await grep.execute({ pattern: 'CREATEGREPTOOL', case_insensitive: true, include: '*.ts' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.results).toContain('createGrepTool');
    });

    it('should respect include glob filter', async () => {
      const result = await grep.execute({ pattern: 'describe', include: '*.test.ts', max_results: 5 });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.results).toBeTruthy();
    });

    it('should allow reading outside workspace (read-only tools are unrestricted)', async () => {
      const tool = createGrepTool('/tmp/workspace');
      const result = await tool.execute({ pattern: 'test', path: '/etc' });
      const parsed = JSON.parse(result);
      expect(parsed.status).not.toBe('denied');
    });
  });

  describe('glob_find', () => {
    const glob = createGlobTool(WORKSPACE);

    it('should find TypeScript files', async () => {
      const result = await glob.execute({ pattern: '*.ts', path: 'src/tools', max_results: 20 });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.fileCount).toBeGreaterThan(0);
      expect(parsed.files.some((f: string) => f.includes('search.ts'))).toBe(true);
    });

    it('should find test files', async () => {
      const result = await glob.execute({ pattern: '*.test.ts', path: 'test', max_results: 50 });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.fileCount).toBeGreaterThan(0);
    });

    it('should return empty for nonexistent pattern', async () => {
      const result = await glob.execute({ pattern: '*.nonexistent_ext_xyz' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.fileCount).toBe(0);
    });

    it('should allow reading outside workspace (read-only tools are unrestricted)', async () => {
      const tool = createGlobTool('/tmp/workspace');
      const result = await tool.execute({ pattern: '*.ts', path: '/etc' });
      const parsed = JSON.parse(result);
      expect(parsed.status).not.toBe('denied');
    });
  });

  describe('list_directory', () => {
    const listDir = createListDirectoryTool(WORKSPACE);

    it('should list workspace root', async () => {
      const result = await listDir.execute({ depth: 1 });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.tree).toContain('src/');
      expect(parsed.tree).toContain('test/');
      expect(parsed.summary).toMatch(/\d+ directories, \d+ files/);
    });

    it('should list a subdirectory', async () => {
      const result = await listDir.execute({ path: 'src/tools', depth: 1 });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.tree).toContain('search.ts');
    });

    it('should skip node_modules and .git', async () => {
      const result = await listDir.execute({ depth: 1 });
      const parsed = JSON.parse(result);
      expect(parsed.tree).not.toContain('node_modules');
      expect(parsed.tree).not.toContain('.git');
    });

    it('should handle nonexistent directory', async () => {
      const result = await listDir.execute({ path: 'nonexistent_dir_xyz' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });

    it('should allow reading outside workspace (read-only tools are unrestricted)', async () => {
      const tool = createListDirectoryTool('/tmp/workspace');
      const result = await tool.execute({ path: '/etc' });
      const parsed = JSON.parse(result);
      expect(parsed.status).not.toBe('denied');
    });
  });
});
