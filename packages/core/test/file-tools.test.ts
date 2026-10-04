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

describe('多字节内容与路径（CJK / 代理对）', () => {
  // 本文件此前零多字节覆盖。本组把「中文内容 / 代理对 / 中文文件名」这条链路钉住。
  // 注意 bytesWritten 是**字节**语义（Buffer.byteLength），不是字符数 —— 中文 1 字 = 3 字节。
  // 2026-10-04：曾有报告把「编辑后文档内容被复制」误判为 CJK / 字节-字符 offset 混用；
  // 真因是替换串的 dollar 序列（见 file-edit-replace-template.test.ts）。本组用于证明
  // 多字节本身是安全的，避免同一个误判再次发生。
  const cjkFile = join(WORKSPACE, '中文文件名.md');

  beforeEach(() => {
    mkdirSync(WORKSPACE, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('bytesWritten 按字节计数（中文 1 字 = 3 字节）', async () => {
    const tool = createFileWriteTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({ path: 'zh-bytes.txt', content: '你好世界' }));
    expect(result.status).toBe('success');
    expect(result.bytesWritten).toBe(Buffer.byteLength('你好世界', 'utf-8'));
    expect(result.bytesWritten).toBe(12); // 4 字 x 3 字节，而非 4
    expect(readFileSync(join(WORKSPACE, 'zh-bytes.txt'), 'utf-8')).toBe('你好世界');
  });

  it('中文写入 / 读回不产生乱码，行号与总行数正确', async () => {
    const content = '第一行标题\n第二行正文\n第三行结尾\n';
    const write = createFileWriteTool(createMockGuard(), WORKSPACE);
    const wrote = JSON.parse(await write.execute({ path: 'zh-roundtrip.txt', content }));
    expect(wrote.status).toBe('success');

    const read = createFileReadTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await read.execute({ path: 'zh-roundtrip.txt' }));
    expect(result.status).toBe('success');
    expect(result.totalLines).toBe(4);
    expect(result.content).toContain('1|第一行标题');
    expect(result.content).toContain('3|第三行结尾');
    // 乱码哨兵：一旦出现替换字符，说明多字节被切断
    expect(result.content).not.toContain(String.fromCharCode(0xFFFD));
  });

  it('替换中文 old_string：逐字落盘且不改变文档结构', async () => {
    const original = '# 中文标题\n\n正文甲\n替换目标\n正文乙\n';
    writeFileSync(cjkFile, original, 'utf-8');

    const tool = createFileEditTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({
      path: '中文文件名.md',
      old_string: '替换目标',
      new_string: '改后的中文内容',
    }));
    expect(result.status).toBe('success');
    expect(result.replacements).toBe(1);
    expect(readFileSync(cjkFile, 'utf-8')).toBe('# 中文标题\n\n正文甲\n改后的中文内容\n正文乙\n');
  });

  it('代理对（emoji / BMP 外星形汉字）在多字节编辑中不被切断', async () => {
    const original = '开始🎉\n替换目标\n结束𠮷\n';
    writeFileSync(cjkFile, original, 'utf-8');

    const tool = createFileEditTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({
      path: '中文文件名.md',
      old_string: '替换目标',
      new_string: '中段🙂',
    }));
    expect(result.status).toBe('success');

    const after = readFileSync(cjkFile, 'utf-8');
    expect(after).toBe('开始🎉\n中段🙂\n结束𠮷\n');
    expect(after).toContain('𠮷'); // 星形汉字（U+20BB7，UTF-16 代理对）完整存活
    expect(after).not.toContain(String.fromCharCode(0xFFFD));
  });

  it('中文 old_string 的唯一性判定按完整多字节串进行', async () => {
    writeFileSync(cjkFile, '重复\n重复\n', 'utf-8');
    const tool = createFileEditTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({
      path: '中文文件名.md',
      old_string: '重复',
      new_string: '唯一',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('found 2 times');
  });

  it('中文长文档尾部替换（原报障形态）：行数不变、标题仅一份', async () => {
    const body: string[] = [];
    for (let i = 0; i < 120; i++) body.push('第 ' + (i + 1) + ' 段正文');
    const original = ['# 工具契约文档', '', ...body, '', '替换目标', '', '结尾', ''].join('\n');
    writeFileSync(cjkFile, original, 'utf-8');

    const tool = createFileEditTool(createMockGuard(), WORKSPACE);
    const result = JSON.parse(await tool.execute({
      path: '中文文件名.md',
      old_string: '替换目标',
      new_string: '新的中文行',
    }));
    expect(result.status).toBe('success');

    const after = readFileSync(cjkFile, 'utf-8');
    expect(after).toContain('新的中文行');
    expect(after.split('\n').length).toBe(original.split('\n').length);
    expect(after.split('# 工具契约文档').length - 1).toBe(1);
    expect(after).not.toContain(String.fromCharCode(0xFFFD));
  });

  it('中文文件名可写、可读、可编辑', async () => {
    const write = createFileWriteTool(createMockGuard(), WORKSPACE);
    const wrote = JSON.parse(await write.execute({ path: '中文文件名.md', content: '初始内容' }));
    expect(wrote.status).toBe('success');
    expect(existsSync(cjkFile)).toBe(true);

    const read = createFileReadTool(createMockGuard(), WORKSPACE);
    expect(JSON.parse(await read.execute({ path: '中文文件名.md' })).content).toContain('初始内容');

    const edit = createFileEditTool(createMockGuard(), WORKSPACE);
    const edited = JSON.parse(await edit.execute({
      path: '中文文件名.md',
      old_string: '初始内容',
      new_string: '更新后的内容',
    }));
    expect(edited.status).toBe('success');
    expect(readFileSync(cjkFile, 'utf-8')).toBe('更新后的内容');
  });
});
