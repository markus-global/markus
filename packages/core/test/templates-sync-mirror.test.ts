/**
 * §26 — 模板/静态资源拷贝必须是**镜像**，且**只有一个实现**。
 *
 * 背景：`packages/cli/templates/` 是 gitignored 构建产物。CLI 的 build.mjs 曾用
 * `mkdirSync + cpSync`（合并语义）拷贝根 `templates/`，导致**源里已删除的文件在产物里永存**
 * （实测残留 8 项：`skills/self-evolution`、`markus-*-cli`、`image-generation`、
 * `roles/SHARED.md`）。desktop/build.mjs 则是正确的镜像语义 —— 同一件事两种实现（R2）。
 *
 * 修法：唯一实现 `scripts/sync-dir.mjs#syncDir`，两个 build.mjs 共用。
 * 本测试锁死镜像语义 + "只有一种拷贝方式"这条结构不变式。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 唯一实现（相对仓库根）
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { syncDir } = await import(path.join(repoRoot, 'scripts/sync-dir.mjs'));

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-dir-'));
}

describe('§26 syncDir — 模板拷贝必须镜像', () => {
  it('目标里源已不存在的陈旧文件/目录必须被清除（镜像，而非合并）', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');

    // 源：只有 current.md
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'current.md'), 'v2', 'utf8');

    // 目标：模拟"上一次构建的遗留"——陈旧文件 + 整棵陈旧子树
    fs.mkdirSync(path.join(dest, 'skills', 'self-evolution'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'stale.md'), 'v1', 'utf8');
    fs.writeFileSync(path.join(dest, 'skills', 'self-evolution', 'skill.json'), '{}', 'utf8');

    syncDir(src, dest);

    // 陈旧项必须消失
    expect(fs.existsSync(path.join(dest, 'stale.md'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'skills', 'self-evolution'))).toBe(false);
    // 源内容必须在
    expect(fs.readFileSync(path.join(dest, 'current.md'), 'utf8')).toBe('v2');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('目标不存在时创建（首次构建）', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'nested', 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.md'), 'A', 'utf8');

    syncDir(src, dest);

    expect(fs.readFileSync(path.join(dest, 'a.md'), 'utf8')).toBe('A');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('幂等：连跑两次结果一致', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.md'), 'A', 'utf8');

    syncDir(src, dest);
    const first = fs.readdirSync(dest).sort();
    syncDir(src, dest);
    const second = fs.readdirSync(dest).sort();
    expect(second).toEqual(first);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('§27 syncDir — 可选 ignore（随包发布的 docs 要排除 README 配图）', () => {
  it('忽略的顶层条目不会被拷到目标，其余照常', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(path.join(src, 'images'), { recursive: true });
    fs.mkdirSync(path.join(src, 'architecture'), { recursive: true });
    fs.writeFileSync(path.join(src, 'images', 'preview.gif'), 'GIF', 'utf8');
    fs.writeFileSync(path.join(src, 'architecture', 'ARCHITECTURE.md'), 'A', 'utf8');
    fs.writeFileSync(path.join(src, 'README.md'), 'R', 'utf8');

    syncDir(src, dest, { ignore: ['images'] });

    expect(fs.existsSync(path.join(dest, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'architecture', 'ARCHITECTURE.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'images'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('不传 ignore 时行为与旧版一致（全量镜像）', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(path.join(src, 'images'), { recursive: true });
    fs.writeFileSync(path.join(src, 'images', 'x.gif'), 'GIF', 'utf8');

    syncDir(src, dest);

    expect(fs.existsSync(path.join(dest, 'images', 'x.gif'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('§26 结构闸门 — 只能有一种模板拷贝方式', () => {
  const cliBuild = fs.readFileSync(path.join(repoRoot, 'packages/cli/build.mjs'), 'utf8');
  const desktopBuild = fs.readFileSync(path.join(repoRoot, 'packages/desktop/build.mjs'), 'utf8');

  it('两个 build.mjs 都必须调用共享的 syncDir()', () => {
    expect(cliBuild).toContain('syncDir(');
    expect(desktopBuild).toContain('syncDir(');
  });

  it('不得再出现裸合并拷贝 templates（cpSync(templatesRoot…)）', () => {
    expect(cliBuild).not.toMatch(/cpSync\(\s*templatesRoot/);
    expect(desktopBuild).not.toMatch(/cpSync\(\s*templatesRoot/);
  });

  it('源模板树不含退役技能包（含 self-evolution）', () => {
    const retired = ['self-evolution', 'markus-cli', 'markus-agent-cli', 'markus-skill-cli', 'markus-project-cli', 'markus-team-cli'];
    for (const name of retired) {
      expect(fs.existsSync(path.join(repoRoot, 'templates/skills', name))).toBe(false);
    }
  });
});
