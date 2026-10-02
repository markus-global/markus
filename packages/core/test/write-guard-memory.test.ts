/**
 * 单一写入者记忆文件门禁测试（审计 P-01）
 * ---------------------------------------------------------------------------
 * 锁死：knowledge.md / NOTEBOOK.md（及遗留 state.md）由记忆服务独占，通用
 * 文件工具（file_write / file_edit / apply_patch）与 shell 重定向对它们的
 * **直接写入必须被拒绝**，并给出改用记忆 / 笔记本工具的引导。
 *
 * 事故实证：2026-09-27 手工 file_write 改写 knowledge.md，
 * 于 2026-09-28 被记忆服务的下一次内存落盘静默覆盖。
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  assertWriteAllowed,
  assertShellWriteAllowed,
} from '../src/write-guard.js';
import { isSingleWriterMemoryFile } from '../src/lock-resources.js';
import { createFileWriteTool, createFileEditTool } from '../src/tools/file.js';

const AGENT_HOME = '/tmp/agents/agt_selftest';
const WORKSPACE = join(AGENT_HOME, 'workspace');

describe('isSingleWriterMemoryFile', () => {
  it('识别知识库 / 笔记本 / 遗留 state 为单一写入者文件', () => {
    expect(isSingleWriterMemoryFile(join(AGENT_HOME, 'knowledge.md'))).toBe(true);
    expect(isSingleWriterMemoryFile(join(AGENT_HOME, 'NOTEBOOK.md'))).toBe(true);
    expect(isSingleWriterMemoryFile(join(AGENT_HOME, 'state.md'))).toBe(true);
  });

  it('不把身份 / 巡检文件（role.md / HEARTBEAT.md）当单一写入者资源', () => {
    expect(isSingleWriterMemoryFile(join(AGENT_HOME, 'ROLE.md'))).toBe(false);
    expect(isSingleWriterMemoryFile(join(AGENT_HOME, 'HEARTBEAT.md'))).toBe(false);
  });

  it('工作区内的同名文件视为普通文件（放行）', () => {
    expect(isSingleWriterMemoryFile(join(WORKSPACE, 'knowledge.md'), WORKSPACE)).toBe(false);
    expect(isSingleWriterMemoryFile(join(AGENT_HOME, 'knowledge.md'), WORKSPACE)).toBe(true);
  });
});

describe('assertWriteAllowed：记忆文件拒绝', () => {
  it('拒绝写 agent home 下的 knowledge.md（含引导）', () => {
    const d = assertWriteAllowed(join(AGENT_HOME, 'knowledge.md'), { workspacePath: WORKSPACE });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toContain('single writer');
      expect(d.reason).toContain('memory_save');
    }
  });

  it('拒绝写 NOTEBOOK.md', () => {
    const d = assertWriteAllowed(join(AGENT_HOME, 'NOTEBOOK.md'), { workspacePath: WORKSPACE });
    expect(d.allowed).toBe(false);
  });

  it('未提供 workspacePath 时按安全方向拒绝', () => {
    expect(assertWriteAllowed(join(AGENT_HOME, 'knowledge.md')).allowed).toBe(false);
  });

  it('允许写工作区内的同名普通文件', () => {
    const d = assertWriteAllowed(join(WORKSPACE, 'knowledge.md'), { workspacePath: WORKSPACE });
    expect(d.allowed).toBe(true);
  });

  it('允许写身份 / 巡检文件与普通文件', () => {
    expect(assertWriteAllowed(join(AGENT_HOME, 'ROLE.md'), { workspacePath: WORKSPACE }).allowed).toBe(true);
    expect(assertWriteAllowed(join(WORKSPACE, 'a.txt'), { workspacePath: WORKSPACE }).allowed).toBe(true);
  });
});

describe('assertShellWriteAllowed：shell 重定向不得绕过记忆门禁', () => {
  it('拒绝：> 重定向到 knowledge.md', () => {
    const d = assertShellWriteAllowed(`echo x > ${join(AGENT_HOME, 'knowledge.md')}`, {
      workspacePath: WORKSPACE,
    });
    expect(d.allowed).toBe(false);
  });

  it('拒绝：tee 追加到 NOTEBOOK.md', () => {
    const d = assertShellWriteAllowed(`cat a | tee -a ${join(AGENT_HOME, 'NOTEBOOK.md')}`, {
      workspacePath: WORKSPACE,
    });
    expect(d.allowed).toBe(false);
  });

  it('允许：写工作区内的普通文件', () => {
    const d = assertShellWriteAllowed(`echo hi > ${join(WORKSPACE, 'ok.txt')}`, {
      cwd: WORKSPACE,
      workspacePath: WORKSPACE,
    });
    expect(d.allowed).toBe(true);
  });
});

describe('file 工具层：直写记忆文件被拒（端到端）', () => {
  it('file_write 对 knowledge.md 返回 status=denied', async () => {
    const tool = createFileWriteTool(undefined, WORKSPACE, undefined);
    const out = await tool.execute({ path: join(AGENT_HOME, 'knowledge.md'), content: '# hi' });
    const parsed = JSON.parse(out) as { status: string; error?: string };
    expect(parsed.status).toBe('denied');
    expect(parsed.error ?? '').toContain('single writer');
  });

  it('file_edit 对 NOTEBOOK.md 返回 status=denied', async () => {
    const tool = createFileEditTool(undefined, WORKSPACE, undefined);
    const out = await tool.execute({
      path: join(AGENT_HOME, 'NOTEBOOK.md'),
      old_string: 'a',
      new_string: 'b',
    });
    const parsed = JSON.parse(out) as { status: string };
    expect(parsed.status).toBe('denied');
  });
});
