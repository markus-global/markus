/**
 * 后台修复工人（独立进程）。
 *
 * 大库重建是分钟级，绝不能压在启动路径上。所以拆成两段：
 *   本次启动 = 探测到损坏 → 派工人后台重建 → 应用照常启动（继续用原库）
 *   下次启动 = 两个 rename 换库（毫秒级）→ 再进入迁移 + 空间回收
 *
 * 工人只重建 + 校验 + 写就绪标记，**不碰原库**：这时应用正开着它，
 * 换库必须发生在下一次启动、没有进程占用的时刻。
 */

import { writeFileSync } from 'node:fs';
import { runBackgroundRepair } from './repair.js';

const dbPath = process.argv[2];

function logLine(message: string, data?: Record<string, unknown>): void {
  if (!dbPath) return;
  try {
    writeFileSync(`${dbPath}.repair.log`, `${new Date().toISOString()} ${message} ${data ? JSON.stringify(data) : ''}\n`, { flag: 'a' });
  } catch { /* 日志失败不影响修复 */ }
}

async function main(): Promise<void> {
  if (!dbPath) return;
  logLine('worker started', { pid: process.pid });
  const res = await runBackgroundRepair(dbPath, logLine);
  logLine('worker finished', { action: res.action, reason: res.reason, durationMs: res.durationMs });
}

void main();
