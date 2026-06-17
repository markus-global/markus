import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockExecSync = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  };
});

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

describe('getEffectiveProxy', () => {
  const configPath = join(homedir(), '.markus', 'markus.json');
  const envKeys = [
    'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExecSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  async function loadProxy() {
    const mod = await import('../src/llm/proxy-fetch.js');
    return mod.getEffectiveProxy();
  }

  it('returns config proxy when markus.json has network.proxy', async () => {
    mockExistsSync.mockImplementation((p: string) => p === configPath);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      network: { proxy: 'http://127.0.0.1:7890' },
    }));

    const result = await loadProxy();
    expect(result).toEqual({ url: 'http://127.0.0.1:7890', source: 'config' });
  });

  it('returns disabled when proxyEnabled is false in config', async () => {
    mockExistsSync.mockImplementation((p: string) => p === configPath);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      network: { proxy: 'http://127.0.0.1:7890', proxyEnabled: false },
    }));
    process.env.HTTPS_PROXY = 'http://env-proxy:8080';

    const result = await loadProxy();
    expect(result).toEqual({ url: undefined, source: 'disabled' });
  });

  it('prefers config proxy over env vars', async () => {
    mockExistsSync.mockImplementation((p: string) => p === configPath);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      network: { proxy: 'http://config-proxy:3128' },
    }));
    process.env.HTTPS_PROXY = 'http://env-proxy:8080';

    const result = await loadProxy();
    expect(result.source).toBe('config');
    expect(result.url).toBe('http://config-proxy:3128');
  });

  it('falls back to HTTPS_PROXY env var', async () => {
    process.env.HTTPS_PROXY = 'http://env-proxy:8080';

    const result = await loadProxy();
    expect(result).toEqual({ url: 'http://env-proxy:8080', source: 'env' });
  });

  it('falls back to lowercase http_proxy env var', async () => {
    process.env.http_proxy = 'http://lower-proxy:9090';

    const result = await loadProxy();
    expect(result).toEqual({ url: 'http://lower-proxy:9090', source: 'env' });
  });

  it('falls back to ALL_PROXY env var', async () => {
    process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';

    const result = await loadProxy();
    expect(result).toEqual({ url: 'socks5://127.0.0.1:1080', source: 'env' });
  });

  it('returns none when no proxy is configured', async () => {
    const result = await loadProxy();
    expect(result).toEqual({ url: undefined, source: 'none' });
  });

  it('ignores empty proxy string in config', async () => {
    mockExistsSync.mockImplementation((p: string) => p === configPath);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      network: { proxy: '' },
    }));
    process.env.HTTP_PROXY = 'http://fallback:8080';

    const result = await loadProxy();
    expect(result.source).toBe('env');
  });
});
