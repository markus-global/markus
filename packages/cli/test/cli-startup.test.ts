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
    expect(elapsed).toBeLessThan(2000);
  });
});
