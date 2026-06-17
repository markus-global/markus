import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveAndCheckAccess,
  createFileReadTool,
  createFileWriteTool,
  createFileEditTool,
} from '../src/tools/file.js';
import type { SecurityGuard } from '../src/security.js';

const TEST_DIR = join(tmpdir(), 'markus-file-tools-test');
const WORKSPACE = join(TEST_DIR, 'agent-a');
const OTHER_AGENT = join(TEST_DIR, 'agent-b');

function createMockGuard(overrides: Partial<SecurityGuard> = {}): SecurityGuard {
  return {
    validateFileReadPath: vi.fn(() => ({ allowed: true })),
    validateFilePath: vi.fn(() => ({ allowed: true })),
    validateShellCommand: vi.fn(() => ({ allowed: true })),
    ...overrides,
  } as unknown as SecurityGuard;
}

describe('resolveAndCheckAccess', () => {
  it('resolves relative paths against workspace', () => {
    const { resolved, access } = resolveAndCheckAccess('src/main.ts', WORKSPACE, undefined);
    expect(resolved).toBe(join(WORKSPACE, 'src/main.ts'));
    expect(access).toBe('readwrite');
  });

  it('resolves absolute paths without workspace', () => {
    const abs = '/tmp/absolute.txt';
    const { resolved, access } = resolveAndCheckAccess(abs, undefined, undefined);
    expect(resolved).toBe(abs);
    expect(access).toBe('readwrite');
  });

  it('denies write access to paths in denyWritePaths', () => {
    const policy = { denyWritePaths: [OTHER_AGENT] };
    const { resolved, access } = resolveAndCheckAccess(
      join(OTHER_AGENT, 'secret.txt'),
      WORKSPACE,
      policy,
    );
    expect(resolved).toContain('agent-b');
    expect(access).toBe('denied');
  });

  it('allows write access outside denyWritePaths', () => {
    const policy = { denyWritePaths: [OTHER_AGENT] };
    const { access } = resolveAndCheckAccess('local.txt', WORKSPACE, policy);
    expect(access).toBe('readwrite');
  });
});

describe('createFileReadTool', () => {
  const testFile = join(WORKSPACE, 'read-test.txt');

  beforeEach(() => {
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(testFile, 'line1\nline2\nline3\n');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates tool with expected name and schema', () => {
    const tool = createFileReadTool();
    expect(tool.name).toBe('file_read');
    expect(tool.inputSchema.required).toContain('path');
  });

  it('reads file content with line numbers', async () => {
    const tool = createFileReadTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({ path: 'read-test.txt' }));
    expect(result.status).toBe('success');
    expect(result.content).toContain('1|line1');
    expect(result.content).toContain('3|line3');
    expect(result.totalLines).toBe(4);
  });

  it('supports offset and limit', async () => {
    const tool = createFileReadTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({ path: 'read-test.txt', offset: 2, limit: 1 }));
    expect(result.content).toBe('2|line2');
    expect(result.shownLines).toBe('2-2');
  });

  it('returns error when path is missing', async () => {
    const tool = createFileReadTool();
    const result = JSON.parse(await tool.execute({}));
    expect(result.status).toBe('error');
    expect(result.error).toContain('path is required');
  });

  it('returns denied when security guard blocks read', async () => {
    const guard = createMockGuard({
      validateFileReadPath: vi.fn(() => ({ allowed: false, reason: 'Path blocked' })),
    });
    const tool = createFileReadTool(guard, WORKSPACE);
    const result = JSON.parse(await tool.execute({ path: 'read-test.txt' }));
    expect(result.status).toBe('denied');
    expect(result.error).toBe('Path blocked');
  });

  it('returns error for nonexistent file', async () => {
    const tool = createFileReadTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({ path: 'missing.txt' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('File not found');
  });
});

describe('createFileWriteTool', () => {
  beforeEach(() => {
    mkdirSync(WORKSPACE, { recursive: true });
    mkdirSync(OTHER_AGENT, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates tool with expected name', () => {
    const tool = createFileWriteTool();
    expect(tool.name).toBe('file_write');
    expect(tool.inputSchema.required).toEqual(['path', 'content']);
  });

  it('writes content to file', async () => {
    const tool = createFileWriteTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({ path: 'output.txt', content: 'hello world' }));
    expect(result.status).toBe('success');
    expect(result.bytesWritten).toBe(11);
    expect(readFileSync(join(WORKSPACE, 'output.txt'), 'utf-8')).toBe('hello world');
  });

  it('denies write to another agent workspace', async () => {
    const policy = { denyWritePaths: [OTHER_AGENT] };
    const tool = createFileWriteTool(createMockGuard(), WORKSPACE, policy);
    const result = JSON.parse(await tool.execute({
      path: join(OTHER_AGENT, 'hack.txt'),
      content: 'bad',
    }));
    expect(result.status).toBe('denied');
    expect(result.error).toContain("another agent's workspace");
  });

  it('denies when security guard blocks path', async () => {
    const guard = createMockGuard({
      validateFilePath: vi.fn(() => ({ allowed: false, reason: 'Write forbidden' })),
    });
    const tool = createFileWriteTool(guard, WORKSPACE);
    const result = JSON.parse(await tool.execute({ path: 'blocked.txt', content: 'x' }));
    expect(result.status).toBe('denied');
    expect(result.error).toBe('Write forbidden');
  });

  it('validates builder artifact manifests', async () => {
    const tool = createFileWriteTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({
      path: join(WORKSPACE, 'builder-artifacts/agent.json'),
      content: '{ invalid json',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Manifest validation failed');
  });
});

describe('createFileEditTool', () => {
  const editFile = join(WORKSPACE, 'edit-test.txt');

  beforeEach(() => {
    mkdirSync(WORKSPACE, { recursive: true });
    mkdirSync(OTHER_AGENT, { recursive: true });
    writeFileSync(editFile, 'alpha\nbeta\ngamma\n');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates tool with expected name', () => {
    const tool = createFileEditTool();
    expect(tool.name).toBe('file_edit');
    expect(tool.inputSchema.required).toEqual(['path', 'old_string', 'new_string']);
  });

  it('replaces unique string in file', async () => {
    const tool = createFileEditTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({
      path: 'edit-test.txt',
      old_string: 'beta',
      new_string: 'BETA',
    }));
    expect(result.status).toBe('success');
    expect(result.replacements).toBe(1);
    expect(readFileSync(editFile, 'utf-8')).toBe('alpha\nBETA\ngamma\n');
  });

  it('denies edit in another agent workspace', async () => {
    const otherFile = join(OTHER_AGENT, 'secret.txt');
    writeFileSync(otherFile, 'secret');
    const policy = { denyWritePaths: [OTHER_AGENT] };
    const tool = createFileEditTool(createMockGuard(), WORKSPACE, policy);
    const result = JSON.parse(await tool.execute({
      path: otherFile,
      old_string: 'secret',
      new_string: 'hacked',
    }));
    expect(result.status).toBe('denied');
    expect(result.error).toContain("another agent's workspace");
  });

  it('returns error when old_string not found', async () => {
    const tool = createFileEditTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({
      path: 'edit-test.txt',
      old_string: 'nonexistent',
      new_string: 'x',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('old_string not found');
    expect(result.current_content).toBeTruthy();
  });

  it('returns error when old_string is not unique', async () => {
    writeFileSync(editFile, 'dup\ndup\n');
    const tool = createFileEditTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({
      path: 'edit-test.txt',
      old_string: 'dup',
      new_string: 'x',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('found 2 times');
  });
});
