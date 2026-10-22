/**
 * 子进程健康探针。
 *
 * 为什么不能在主进程里 `PRAGMA quick_check`：实测 16.7 GB 的库**跑满要 155 秒**，
 * 而 node:sqlite 是同步 API —— 等于整个服务（含所有 SSE 流）冻结 2.5 分钟。
 * 之前我用 `quick_check(1)`（遇到第一个错误就停）测出 8.3 秒，是因为那个库恰好
 * 很早就出错；健康的库会老老实实扫完全文，一样是分钟级。
 *
 * 所以：放进子进程跑，带硬超时。拿不到结论就返回 unknown —— 调用方按保守策略处理
 * （宁可不搬数据，也不把磁盘搞成两份）。
 */

import { spawn } from 'node:child_process';

export type HealthProbeStatus = 'ok' | 'corrupt' | 'unknown';

/**
 * 大库阈值：超过它就不能在启动路径上同步做整库扫描。
 *
 * 单一常量，两处语义共用：
 *  ① 开库前的探测（超过就搬到后台，否则启动会冻住）；
 *  ② 损坏后的重建方式（超过就走两段式：后台重建 → 下次启动换库）。
 * 分开写两份数值迟早会漂移，所以只留一个来源。
 */
export const LARGE_DATABASE_BYTES = 512 * 1024 * 1024;

/** 探针超时上限：再慢也不无限等。 */
export const PROBE_TIMEOUT_CEILING_MS = 15 * 60_000;

/**
 * 探针超时必须是库大小的函数 —— 这原来是一处真实的静默失效。
 *
 * 实测：16.7 GB 的库整库 `quick_check` 要 **155 秒**。原来这个超时写死 20 秒，
 * 结果大库**永远拿不到结论**（unknown）→ 修复逻辑永远跳过 → 库永远是坏的，
 * 而日志只有一行 "skipped"，看起来像"没事"。
 *
 * 12 ms/MB 覆盖到约 1 GB ≈ 12 s、17 GB ≈ 205 s，留了约 30% 余量。
 */
export function deriveProbeTimeoutMs(dbSizeBytes: number): number {
  const mb = Math.max(0, Math.round(dbSizeBytes / 1048576));
  return Math.min(PROBE_TIMEOUT_CEILING_MS, Math.max(20_000, mb * 12));
}

export interface HealthProbeResult {
  status: HealthProbeStatus;
  detail?: string;
  elapsedMs: number;
}

const PROBE_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(process.argv[1]);
  const row = db.prepare('PRAGMA quick_check(1)').get();
  const v = String(Object.values(row)[0] ?? '');
  db.close();
  process.stdout.write(v);
} catch (e) {
  process.stdout.write('ERR:' + String(e).slice(0, 160));
  process.exitCode = 2;
}
`;

export interface ProbeSpawnSpec {
  command: string;
  args: string[];
  options: {
    stdio: ['ignore', 'pipe', 'pipe'];
    windowsHide: true;
    env: NodeJS.ProcessEnv;
  };
}

/**
 * 探针子进程的启动参数 —— **纯函数，可测**。
 *
 * 为什么需要 `ELECTRON_RUN_AS_NODE`：在打包后的 Electron 应用里
 * `process.execPath` 是 **Markus 主程序**，不是 node。用它跑 `-e` 脚本时，
 * Electron 把它当成 GUI 启动，**一行 stdout 都不产出、退出码还是 0**。
 * 于是探针永远返回 unknown、修复永远被跳过 —— 而且这是**每一个桌面用户**
 * 都会中的招，不是个别环境问题。
 *
 * 实测（同一台机器、同一个二进制）：
 *   Markus -e 'console.log("probe-alive")'                       → 无输出
 *   ELECTRON_RUN_AS_NODE=1 Markus -e 'console.log("probe-alive")' → probe-alive
 *
 * 在纯 node 里这个环境变量无副作用，所以无条件设置。
 */
export function buildProbeSpawnSpec(
  dbPath: string,
  execPath: string = process.execPath,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ProbeSpawnSpec {
  return {
    command: execPath,
    args: ['-e', PROBE_SOURCE, dbPath],
    options: {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上没有控制台时子进程会新开一个黑框 —— 一次启动探测弹一次窗。
      windowsHide: true,
      env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' },
    },
  };
}

export function probeDatabaseHealthInChild(dbPath: string, timeoutMs = 20_000): Promise<HealthProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: HealthProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const spec = buildProbeSpawnSpec(dbPath);
    let child;
    try {
      child = spawn(spec.command, spec.args, spec.options);
    } catch (err) {
      resolve({ status: 'unknown', detail: String(err), elapsedMs: Date.now() - started });
      return;
    }

    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ status: 'unknown', detail: `timeout after ${timeoutMs}ms`, elapsedMs: Date.now() - started });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', () => { /* 诊断信息无关结论 */ });
    child.on('error', (err) => finish({ status: 'unknown', detail: String(err), elapsedMs: Date.now() - started }));
    child.on('close', () => {
      const text = out.trim();
      if (text === 'ok') return finish({ status: 'ok', elapsedMs: Date.now() - started });
      if (text.length > 0) return finish({ status: 'corrupt', detail: text.slice(0, 240), elapsedMs: Date.now() - started });
      finish({ status: 'unknown', detail: 'no output', elapsedMs: Date.now() - started });
    });
  });
}
