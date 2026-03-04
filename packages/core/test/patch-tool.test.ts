import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPatchTool } from '../src/tools/patch.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-patch-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('apply_patch tool', () => {
  const createTool = () => createPatchTool(undefined, tempDir);

  it('should edit a single file with one hunk', async () => {
    const file = join(tempDir, 'test.ts');
    writeFileSync(file, 'const x = 1;\nconst y = 2;\n');

    const tool = createTool();
    const result = await tool.execute({
      patches: [
        { file: 'test.ts', action: 'edit', hunks: [{ old_string: 'const x = 1;', new_string: 'const x = 42;' }] },
      ],
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(readFileSync(file, 'utf-8')).toContain('const x = 42;');
  });

  it('should apply multiple hunks to the same file', async () => {
    const file = join(tempDir, 'multi.ts');
    writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

    const tool = createTool();
    const result = await tool.execute({
      patches: [
        {
          file: 'multi.ts',
          action: 'edit',
          hunks: [
            { old_string: 'const a = 1;', new_string: 'const a = 10;' },
            { old_string: 'const c = 3;', new_string: 'const c = 30;' },
          ],
        },
      ],
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('const a = 10;');
    expect(content).toContain('const b = 2;');
    expect(content).toContain('const c = 30;');
  });

  it('should edit multiple files in one call', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'export const A = 1;\n');
    writeFileSync(join(tempDir, 'b.ts'), 'export const B = 2;\n');

    const tool = createTool();
    const result = await tool.execute({
      patches: [
        { file: 'a.ts', action: 'edit', hunks: [{ old_string: 'A = 1', new_string: 'A = 100' }] },
        { file: 'b.ts', action: 'edit', hunks: [{ old_string: 'B = 2', new_string: 'B = 200' }] },
      ],
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.appliedPatches).toBe(2);
    expect(readFileSync(join(tempDir, 'a.ts'), 'utf-8')).toContain('A = 100');
    expect(readFileSync(join(tempDir, 'b.ts'), 'utf-8')).toContain('B = 200');
  });

  it('should create a new file', async () => {
    const tool = createTool();
    const result = await tool.execute({
      patches: [
        { file: 'new-file.ts', action: 'create', content: 'export const NEW = true;\n' },
      ],
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(existsSync(join(tempDir, 'new-file.ts'))).toBe(true);
    expect(readFileSync(join(tempDir, 'new-file.ts'), 'utf-8')).toContain('NEW = true');
  });

  it('should delete a file', async () => {
    const file = join(tempDir, 'to-delete.ts');
    writeFileSync(file, 'delete me');

    const tool = createTool();
    const result = await tool.execute({
      patches: [{ file: 'to-delete.ts', action: 'delete' }],
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(existsSync(file)).toBe(false);
  });

  it('should support dry_run mode', async () => {
    const file = join(tempDir, 'dry.ts');
    writeFileSync(file, 'const x = 1;\n');

    const tool = createTool();
    const result = await tool.execute({
      patches: [
        { file: 'dry.ts', action: 'edit', hunks: [{ old_string: 'const x = 1;', new_string: 'const x = 99;' }] },
      ],
      dry_run: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.message).toContain('Dry run');
    // File should NOT be changed
    expect(readFileSync(file, 'utf-8')).toContain('const x = 1;');
  });

  it('should fail if old_string not found', async () => {
    const file = join(tempDir, 'notfound.ts');
    writeFileSync(file, 'const x = 1;\n');

    const tool = createTool();
    const result = await tool.execute({
      patches: [
        { file: 'notfound.ts', action: 'edit', hunks: [{ old_string: 'NOT HERE', new_string: 'replacement' }] },
      ],
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('not found');
  });

  it('should enforce workspace isolation', async () => {
    const tool = createPatchTool(undefined, '/tmp/workspace');
    const result = await tool.execute({
      patches: [{ file: '/etc/passwd', action: 'edit', hunks: [{ old_string: 'a', new_string: 'b' }] }],
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('denied');
  });
});
