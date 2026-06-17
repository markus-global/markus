import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: vi.fn(
      () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
    ),
  };
});

describe('CLI startup logger', () => {
  let tmpHome: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalHome = process.env.HOME;
  let loggerMod: typeof import('../src/utils/logger.js');

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-cli-logger-'));
    process.env.HOME = tmpHome;
    mkdirSync(join(tmpHome, '.markus', 'logs'), { recursive: true });
    loggerMod = await import('../src/utils/logger.js');
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    loggerMod.closeStartupLogger();
    loggerMod.setSuppressConsole(false);
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    loggerMod.closeStartupLogger();
    loggerMod.setSuppressConsole(false);
  });

  it('getStartupLogPath includes date and startup prefix', () => {
    const date = new Date().toISOString().slice(0, 10);
    expect(loggerMod.getStartupLogPath()).toContain(`startup-${date}.log`);
    expect(loggerMod.getStartupLogPath()).toContain('.markus');
  });

  it('initStartupLogger returns consistent path', () => {
    const path = loggerMod.initStartupLogger();
    expect(path).toBe(loggerMod.getStartupLogFile());
    expect(path).toContain('startup-');
  });

  it('startupLog writes to console', () => {
    loggerMod.initStartupLogger();
    loggerMod.startupLog('OK', 'Server ready', 'port 8056');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[OK] Server ready'));
  });

  it('setSuppressConsole hides console output', () => {
    loggerMod.initStartupLogger();
    loggerMod.setSuppressConsole(true);
    loggerMod.startupLog('INFO', 'silent console');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('startupSection writes to console', () => {
    loggerMod.initStartupLogger();
    loggerMod.startupSection('Database');
    expect(logSpy).toHaveBeenCalledWith('\n--- Database ---');
  });

  it('appendLLMLog appends JSON lines to llm.log', () => {
    loggerMod.appendLLMLog({
      timestamp: '2024-01-01T00:00:00Z',
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 100,
      success: true,
    });
    const llmPath = loggerMod.getLLMLogPath();
    expect(existsSync(llmPath)).toBe(true);
    const line = readFileSync(llmPath, 'utf-8').trim();
    expect(JSON.parse(line).provider).toBe('openai');
  });
});
