import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { quickInit } from '../src/commands/init.js';
import * as shared from '@markus/shared';

const answerQueue: string[] = [];
const closeMock = vi.hoisted(() => vi.fn());

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (ans: string) => void) => {
      cb(answerQueue.shift() ?? '');
    },
    close: closeMock,
  }),
}));

describe('quickInit interactive mode', () => {
  let tmpHome: string;
  let configPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-init-interactive-'));
    process.env.HOME = tmpHome;
    configPath = join(tmpHome, '.markus', 'markus.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    answerQueue.length = 0;
    closeMock.mockClear();
    vi.spyOn(shared, 'getDefaultConfigPath').mockReturnValue(configPath);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('imports from environment in interactive mode', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.endsWith('_API_KEY')) delete process.env[key];
    }
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek1234567890';

    answerQueue.push('env', '9001');

    await quickInit();

    expect(existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.defaultProvider).toBe('deepseek');
    expect(cfg.llm.providers.deepseek.apiKey).toBe('sk-deepseek1234567890');
    expect(cfg.server.apiPort).toBe(9001);
    expect(closeMock).toHaveBeenCalled();
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('keeps existing config when overwrite declined', async () => {
    mkdirSync(join(tmpHome, '.markus'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ org: { id: 'keep-me' } }));

    answerQueue.push('n');

    await quickInit();

    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.org.id).toBe('keep-me');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Keeping existing config');
  });

  it('overwrites existing config when user confirms', async () => {
    mkdirSync(join(tmpHome, '.markus'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ org: { id: 'old' } }));
    process.env.OPENAI_API_KEY = 'sk-interactive123456789';

    answerQueue.push('y', 'manual', 'openai', 'sk-interactive123456789', '9100');

    await quickInit();

    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.llm.providers.openai.apiKey).toBe('sk-interactive123456789');
    expect(cfg.server.apiPort).toBe(9100);
    delete process.env.OPENAI_API_KEY;
  });
});
