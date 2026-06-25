import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('doctor coding tool detection', () => {
  let tmpHome: string;
  let originalHome: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-doctor-ct-'));
    originalHome = process.env.HOME!;
    process.env.HOME = tmpHome;
    const markusDir = join(tmpHome, '.markus');
    mkdirSync(markusDir, { recursive: true });
    writeFileSync(join(markusDir, 'markus.json'), JSON.stringify({
      llm: { providers: {} },
    }));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string | URL | Request) => {
        const href = typeof url === 'string' ? url : url.toString();
        if (href.includes('anthropic.com')) {
          return { ok: true, status: 200, head: async () => ({}) };
        }
        return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
      }),
    );
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('outputs Coding Tools section in doctor output', async () => {
    const { runDoctor } = await import('../src/commands/doctor.js');
    await runDoctor({ verbose: false });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Coding Tools');
  });

  it('detects tools or shows not-found warning', async () => {
    const { runDoctor } = await import('../src/commands/doctor.js');
    await runDoctor({ verbose: false });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Claude Code');
    expect(output).toContain('Codex');
    expect(output).toContain('Cursor');
  });
});
