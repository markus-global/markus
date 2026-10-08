#!/usr/bin/env node
/**
 * §26 — 唯一的目录同步实现（镜像语义）。
 *
 * 之前 desktop/build.mjs 与 cli/build.mjs 各写一份拷贝逻辑，且**语义还不一致**：
 * desktop 先 `rmSync` 再拷（真镜像），cli 只 `mkdirSync + cpSync`（合并）——
 * 于是源 `templates/` 里删掉的文件（如退役的 `skills/self-evolution`）在 CLI 产物里**永存**。
 * 同一件事两种实现 ⇒ 漂移。这里收敛成一份：**先清、再拷**，拷贝永远是镜像。
 *
 * 用法：
 *   import { syncDir } from '../../scripts/sync-dir.mjs';
 *   syncDir(srcDir, destDir);
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 把 `src` 镜像到 `dest`：先整体删除 `dest`，再重建并复制。
 * 幂等；`dest` 不存在时创建；源里已删除的条目在目标端**不会残留**。
 *
 * `ignore` 列出**不要随产物发布**的顶层条目（仍保留在源里，不影响镜像语义）。
 * 目前用于 `docs/`：`images/` 是 GitHub README 的配图（7.2 MB），对安装包毫无用途。
 *
 * @param {string} src  源目录
 * @param {string} dest 目标目录
 * @param {{ignore?: string[]}} [opts] 可选：顶层条目黑名单
 * @returns {boolean} 是否执行了同步（源存在时）
 */
export function syncDir(src, dest, { ignore = [] } = {}) {
  if (!existsSync(src)) return false;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  for (const name of ignore) {
    rmSync(join(dest, name), { recursive: true, force: true });
  }
  return true;
}
