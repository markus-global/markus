/**
 * 原子文件写入 —— 记忆/状态文件的落盘原语。
 *
 * ## 为什么不能直接 `writeFileSync(path, content)`
 *
 * 覆盖式写入不是原子的：进程若在写了一半时退出（崩溃、被 watchdog 杀掉、外部
 * `kill`），文件会停在**截断**状态。对 `knowledge.md` / `NOTEBOOK.md` 这类
 * 「下次启动要整体解析」的文件，半截内容会被当成**真实状态**读进来 ——
 * 这是最难排查的一类静默数据损坏。
 *
 * `rename` 在同一个文件系统内是原子的：读者只会看到旧的完整内容或新的完整内容，
 * 不会看到中间态。写临时文件再 rename 是业界标准做法（POSIX 的
 * "atomic replace" 惯用法）。
 *
 * 已知边界：临时文件名带 pid，因此**同进程内**并发写同一路径不会互相踩
 * （虽然调用方本应通过资源域锁串行）；跨进程的互斥仍由锁层负责。
 */

import { renameSync, writeFileSync } from 'node:fs';

/** 写临时文件后 `rename` 覆盖目标路径（同目录，保证同文件系统）。 */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}
