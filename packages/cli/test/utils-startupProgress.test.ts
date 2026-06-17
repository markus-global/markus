import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StartupProgress, STARTUP_STEPS } from '../src/utils/startupProgress.js';

describe('StartupProgress', () => {
  let tmpHome: string;
  let logPath: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-progress-'));
    process.env.HOME = tmpHome;
    logPath = join(tmpHome, 'startup.log');
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.HOME = originalHome;
    const { setSuppressConsole } = await import('../src/utils/logger.js');
    setSuppressConsole(false);
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('exports seven startup steps', () => {
    expect(STARTUP_STEPS).toHaveLength(7);
    expect(STARTUP_STEPS[0].label).toBe('Boot');
    expect(STARTUP_STEPS[6].label).toBe('Ready');
  });

  it('start prints banner in non-TTY mode', () => {
    const progress = new StartupProgress(logPath);
    progress.start();
    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Boot');
  });

  it('complete marks step done and writes log file', () => {
    const progress = new StartupProgress(logPath);
    progress.start();
    progress.complete(0, 'boot ok');
    progress.complete(1, 'config loaded');

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[OK]');
    expect(log).toContain('Boot');
    expect(log).toContain('config loaded');
  });

  it('fail marks step failed', () => {
    const progress = new StartupProgress(logPath);
    progress.start();
    progress.fail(2, 'no API key');

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[FAIL]');
    expect(log).toContain('no API key');
  });

  it('skip marks step skipped', () => {
    const progress = new StartupProgress(logPath);
    progress.start();
    progress.skip(3, 'optional service');

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[SKIP]');
  });

  it('setActive and updateDetail update step state', () => {
    const progress = new StartupProgress(logPath);
    progress.start();
    progress.setActive(4);
    progress.updateDetail(4, 'starting API server');

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('starting API server');
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('[INFO]');
  });

  it('finish prints final URL', () => {
    const progress = new StartupProgress(logPath);
    progress.start();
    progress.finish('http://localhost:8057');

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('http://localhost:8057');
    expect(output).toMatch(/running/i);
  });

  it('TTY mode renders animated progress', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const progress = new StartupProgress(logPath);
    progress.start();
    progress.setActive(1);
    progress.complete(1, 'config ok');

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Starting Markus|Config/);
  });

  it('TTY finish shows elapsed time and URL', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const progress = new StartupProgress(logPath);
    progress.start();
    progress.finish('http://localhost:9000');

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('http://localhost:9000');
    expect(output).toMatch(/running/i);
  });

  it('complete advances current step index', () => {
    const progress = new StartupProgress(logPath);
    progress.start();
    progress.complete(0);
    progress.complete(1);
    progress.complete(2, 'providers ready');

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('LLM Providers');
    expect(log).toContain('providers ready');
  });
});
