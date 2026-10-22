/**
 * 打包后的 Electron 里，`process.execPath` 是 **Markus 主程序**，不是 node。
 * 任何「用 execPath 跑一个 .js / -e 脚本」的地方，都必须带
 * `ELECTRON_RUN_AS_NODE=1`，否则：脚本一行都不执行、退出码还是 0，
 * 而且通常还是 detached + stdio:'ignore' —— 完全静默。
 *
 * 这一类缺陷不会在 CLI / 单测里暴露，只在打包产物里发作，所以每个 spawn 点
 * 都用一个纯函数产出参数，并在这里钉死。
 */
import { describe, it, expect } from 'vitest';
import { buildProbeSpawnSpec } from '../src/health-probe.js';
import { buildRepairWorkerSpawnSpec } from '../src/repair.js';

describe('every execPath spawn is Electron-safe', () => {
  it('health probe', () => {
    const spec = buildProbeSpawnSpec('/tmp/x.db', '/App/Markus', { PATH: '/usr/bin' });
    expect(spec.options.env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(spec.options.env['PATH']).toBe('/usr/bin');
    // Windows：没有控制台的父进程 spawn 子进程会新开一个黑框。
    expect(spec.options.windowsHide).toBe(true);
  });

  it('repair worker — inline source goes through -e', () => {
    const spec = buildRepairWorkerSpawnSpec('/tmp/x.db', null, '/App/Markus', { PATH: '/usr/bin' }, 'console.log(1)');
    expect(spec.options.env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(spec.options.env['PATH']).toBe('/usr/bin');
    expect(spec.options.env['MARKUS_REPAIR_DB']).toBe('/tmp/x.db');
    // 内联源码走 -e：没有可能丢失的第二个文件。
    expect(spec.args).toEqual(['-e', 'console.log(1)']);
    expect(spec.options.detached).toBe(true);
    expect(spec.options.windowsHide).toBe(true);
  });

  it('repair worker — file fallback keeps dbPath in env, not argv', () => {
    // `-e` 模式下 argv 位移与普通脚本不同，所以库路径统一走环境变量。
    const self = new URL(import.meta.url).pathname;
    const spec = buildRepairWorkerSpawnSpec('/tmp/x.db', self, '/App/Markus', { PATH: '/usr/bin' }, null);
    expect(spec.args).toEqual([self]);
    expect(spec.options.env['MARKUS_REPAIR_DB']).toBe('/tmp/x.db');
    expect(spec.options.env['ELECTRON_RUN_AS_NODE']).toBe('1');
  });

  it('repair worker — missing worker file throws instead of pretending to work', () => {
    // 这就是本轮事故的形态：路径不存在时 spawn 依然「成功」，工人毫秒级退出，
    // 而 stdio:'ignore' 让一切不可见。现在缺失必须在派单时抛错。
    expect(() => buildRepairWorkerSpawnSpec('/tmp/x.db', '/nope/repair-worker.js', '/App/Markus', {}, null))
      .toThrow(/repair-worker-missing/);
  });

  it('repair worker — no inline source and no path is an error, not a silent no-op', () => {
    expect(() => buildRepairWorkerSpawnSpec('/tmp/x.db', null, '/App/Markus', {}, null))
      .toThrow(/repair-worker-missing/);
  });
});
