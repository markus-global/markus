/**
 * atomic-write（原子落盘原语）单元测试
 * ---------------------------------------------------------------------------
 * `writeFileAtomic()` 是记忆/状态落盘的**唯一原语**（`memory/store.ts` 依赖它）。
 * 它用「写同目录临时文件 + rename」实现原子替换，理由是：覆盖式写入一旦在写一半
 * 时进程退出，文件会停在**截断**状态，而 `knowledge.md` / `NOTEBOOK.md` 这类
 * 「下次启动要整体解析」的文件会把半截内容当成真实状态读进来 —— 最难排查的
 * 静默数据损坏。
 *
 * 这是落盘原语，所以**不 mock fs**：全部用 os.tmpdir() + mkdtempSync() 的真实临时
 * 目录打真实 IO。要断言的不是「调用了几次 fs」，而是「磁盘上最终是什么」。
 *
 * 失败路径的**真实行为**（已实测，见各条断言）：
 *   - 父目录不存在 / 临时文件写失败（EISDIR / EACCES）→ 原文件**完好无损**，
 *     因为失败发生在 rename 之前，旧文件从未被触碰。
 *   - rename 失败（如目标是非空目录）→ 原目标完好，但**临时文件会残留**，
 *     这是实现的一个已知边界。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/atomic-write.js';

/** 每个用例一个真实临时目录，结束后递归删除。 */
const createdDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'markus-atomic-'));
  createdDirs.push(dir);
  return dir;
}

/** 目标路径对应的临时文件名（与实现约定一致：同目录 + `.tmp-<pid>`）。 */
function tmpPathFor(filePath: string): string {
  return `${filePath}.tmp-${process.pid}`;
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    // 只读目录用例可能改了权限，先尽力恢复再删除
    try { chmodSync(dir, 0o755); } catch { /* 目录可能已不存在 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeFileAtomic — 正常写入（真实 IO）', () => {
  it('写入新文件：内容按 utf8 正确落盘，且不残留临时文件', () => {
    const dir = makeTempDir();
    const target = join(dir, 'knowledge.md');

    writeFileAtomic(target, '# 标题\n正文内容');

    expect(readFileSync(target, 'utf8')).toBe('# 标题\n正文内容');
    // 临时文件已被 rename 掉，目录里只应有目标文件
    expect(readdirSync(dir)).toEqual(['knowledge.md']);
    expect(existsSync(tmpPathFor(target))).toBe(false);
  });

  it('父目录已存在（含多级已建目录）时写入成功', () => {
    const dir = makeTempDir();
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const target = join(nested, 'notebook.md');

    writeFileAtomic(target, 'nested ok');

    expect(readFileSync(target, 'utf8')).toBe('nested ok');
    expect(readdirSync(nested)).toEqual(['notebook.md']);
  });
});

describe('writeFileAtomic — 覆盖已有文件', () => {
  it('新内容更长：旧内容被完整替换，不出现半截/残留尾巴', () => {
    const dir = makeTempDir();
    const target = join(dir, 'state.md');
    writeFileSync(target, 'SHORT');

    writeFileAtomic(target, 'A-much-longer-replacement-content-than-before');

    const content = readFileSync(target, 'utf8');
    expect(content).toBe('A-much-longer-replacement-content-than-before');
    // 旧的短内容不能以任何形式残留在文件里（覆盖未截断的经典症状）
    expect(content).not.toContain('SHORT');
    expect(content.length).toBe('A-much-longer-replacement-content-than-before'.length);
    expect(readdirSync(dir)).toEqual(['state.md']);
  });

  it('新内容更短：旧内容被完整替换，不残留旧尾巴', () => {
    const dir = makeTempDir();
    const target = join(dir, 'state.md');
    writeFileSync(target, 'A-very-long-original-content-that-must-disappear');

    writeFileAtomic(target, 'ok');

    expect(readFileSync(target, 'utf8')).toBe('ok');
    expect(readdirSync(dir)).toEqual(['state.md']);
  });

  it('连续多次覆盖：磁盘上始终只有最后一次的内容，无临时文件堆积', () => {
    const dir = makeTempDir();
    const target = join(dir, 'knowledge.md');

    for (let i = 0; i < 5; i++) {
      writeFileAtomic(target, `v${i}`);
    }

    expect(readFileSync(target, 'utf8')).toBe('v4');
    expect(readdirSync(dir)).toEqual(['knowledge.md']);
  });
});

describe('writeFileAtomic — 临时文件命名与 pid', () => {
  it('临时文件名带 pid（借 rename 失败残留的临时文件反查命名约定）', () => {
    const dir = makeTempDir();
    // 目标是非空目录：临时文件能写成功，但 rename 必然失败 →
    // 残留的临时文件正好暴露了它的真实命名。
    const target = join(dir, 'a-directory');
    mkdirSync(target);
    writeFileSync(join(target, 'inner.txt'), 'inner');

    expect(() => writeFileAtomic(target, 'x')).toThrow();

    const residue = readdirSync(dir).filter((f) => f !== 'a-directory');
    expect(residue).toEqual([`a-directory.tmp-${process.pid}`]);
    expect(residue[0]).toContain(`tmp-${process.pid}`);
  });
});

describe('writeFileAtomic — 失败路径的真实行为', () => {
  it('父目录不存在 → 抛 ENOENT；不产生目标文件，也不残留临时文件', () => {
    const dir = makeTempDir();
    const target = join(dir, 'missing-dir', 'knowledge.md');

    let code: string | undefined;
    try {
      writeFileAtomic(target, 'never written');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }

    expect(code).toBe('ENOENT');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(tmpPathFor(target))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('临时文件路径被占用（写临时文件即失败）→ 抛错，且**原文件完好无损**', () => {
    const dir = makeTempDir();
    const target = join(dir, 'knowledge.md');
    writeFileSync(target, 'OLD-CONTENT');
    // 用一个目录占住临时文件路径，让 writeFileSync(tmp) 直接 EISDIR 失败。
    mkdirSync(tmpPathFor(target));

    let code: string | undefined;
    try {
      writeFileAtomic(target, 'NEW-CONTENT');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }

    expect(code).toBe('EISDIR');
    // ★ 关键结论：写失败发生在 rename 之前，旧文件从未被触碰 —— 原文件完好。
    expect(readFileSync(target, 'utf8')).toBe('OLD-CONTENT');
  });

  it.skipIf(isRoot)('父目录不可写 → 抛 EACCES，且**原文件完好无损**', () => {
    const dir = makeTempDir();
    const target = join(dir, 'knowledge.md');
    writeFileSync(target, 'OLD-CONTENT');
    chmodSync(dir, 0o555); // 只读目录：无法创建临时文件

    let code: string | undefined;
    try {
      writeFileAtomic(target, 'NEW-CONTENT');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    } finally {
      chmodSync(dir, 0o755);
    }

    expect(code).toBe('EACCES');
    // ★ 关键结论：同上，原文件保持旧内容，未被截断/清空。
    expect(readFileSync(target, 'utf8')).toBe('OLD-CONTENT');
  });

  it('rename 失败（目标是非空目录）→ 原目标完好，但**临时文件残留**（已知边界）', () => {
    const dir = makeTempDir();
    const target = join(dir, 'a-directory');
    mkdirSync(target);
    writeFileSync(join(target, 'inner.txt'), 'inner');

    let code: string | undefined;
    try {
      writeFileAtomic(target, 'NEW');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }

    expect(code).toBe('EISDIR');
    // 原目标（目录及其内容）完好无损
    expect(readFileSync(join(target, 'inner.txt'), 'utf8')).toBe('inner');
    // 已知边界：临时文件写成功了但 rename 失败，因此会残留；实现未做清理。
    expect(existsSync(tmpPathFor(target))).toBe(true);
  });
});
