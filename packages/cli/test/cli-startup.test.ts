import { describe, it, expect } from 'vitest';

describe('cli startup performance', () => {
  it('lazy-loads command modules', async () => {
    const { readFileSync } = await import('node:fs');
    const indexSrc = readFileSync(
      new URL('../src/index.ts', import.meta.url),
      'utf-8',
    );
    // Should use dynamic import() for commands, not static import
    expect(indexSrc).toContain("await import('./commands/start.js')");
    expect(indexSrc).toContain("await import('./commands/doctor.js')");
    expect(indexSrc).toContain("await import('./commands/agent.js')");
    // Should NOT have static imports of command modules at top level
    const staticImports = indexSrc.match(/^import .* from '\.\/commands\//gm);
    expect(staticImports).toBeNull();
  });

  it('command modules import quickly in isolation', async () => {
    const start = performance.now();
    await import('../src/commands/agent.js');
    await import('../src/commands/models.js');
    await import('../src/commands/doctor.js');
    const elapsed = performance.now() - start;
    // Individual commands should not take long to import
    // 2000 ms 是「冷缓存下首次 import 三个重型 CLI 模块」的挂钟预算。实测在
    // 空载机器上就已经是 1.5–2 s，余量只有 ~0.25%：2026-09-19 在一次 `tsc -b`
    // 构建并行运行时它以 2005 ms 翻红（单独重跑 3/3 全过）。这种门禁会随机红，
    // 和假绿一样是噪声 —— 所以放宽到有成倍余量，但仍能拦住真正的回退
    // （某个命令模块退化成秒级 import）。
    expect(elapsed).toBeLessThan(5000);
  });
});
