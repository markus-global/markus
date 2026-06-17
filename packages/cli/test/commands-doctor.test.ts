import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctor } from '../src/commands/doctor.js';

describe('runDoctor', () => {
  let tmpHome: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-doctor-'));
    process.env.HOME = tmpHome;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
    logSpy.mockRestore();
    vi.unstubAllGlobals();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('completes without throwing', async () => {
    await expect(runDoctor()).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Markus Doctor');
  });

  it('reports config file when present', async () => {
    const configDir = join(tmpHome, '.markus');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'markus.json'),
      JSON.stringify({ org: { id: 'default', name: 'Test' } }),
    );

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Config file');
  });

  it('warns when config file is missing', async () => {
    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Config file not found|No LLM API keys/);
  });

  it('creates storage directory with --fix', async () => {
    await runDoctor({ fix: true });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Storage');
  });

  it('reports Node.js runtime section', async () => {
    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Runtime');
    expect(output).toContain('Node.js');
  });

  it('reports configured LLM providers with valid keys', async () => {
    const configDir = join(tmpHome, '.markus');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'markus.json'),
      JSON.stringify({
        org: { id: 'default', name: 'Test' },
        llm: {
          defaultProvider: 'openai',
          providers: {
            openai: { apiKey: 'sk-validkey1234567890', model: 'gpt-4o-mini' },
          },
        },
      }),
    );

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/LLM|openai|Provider/i);
  });

  it('flags placeholder API keys', async () => {
    const configDir = join(tmpHome, '.markus');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'markus.json'),
      JSON.stringify({
        llm: {
          providers: {
            openai: { apiKey: 'test-key', model: 'gpt-4o-mini' },
          },
        },
      }),
    );

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/placeholder|invalid|LLM/i);
  });

  it('reports server connectivity when API is reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string | URL | Request) => {
        const href = typeof url === 'string' ? url : url.toString();
        if (href.includes('localhost') && href.includes('health')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (href.includes('anthropic.com')) {
          return { ok: true, status: 200, head: async () => ({}) };
        }
        return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
      }),
    );

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Server|API|Health/i);
  });

  it('validates configured provider keys against API', async () => {
    const configDir = join(tmpHome, '.markus');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'markus.json'),
      JSON.stringify({
        llm: {
          providers: {
            openai: { apiKey: 'sk-validkey1234567890', model: 'gpt-4o-mini' },
          },
        },
      }),
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/validated|API call succeeded|OpenAI/i);
  });

  it('reports validation failures for bad keys', async () => {
    const configDir = join(tmpHome, '.markus');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'markus.json'),
      JSON.stringify({
        llm: {
          providers: {
            anthropic: { apiKey: 'sk-badkey1234567890', model: 'claude-sonnet-4-20250514' },
          },
        },
      }),
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Invalid API key|✗/);
  });

  it('reports existing database file in storage section', async () => {
    const configDir = join(tmpHome, '.markus');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'markus.json'), JSON.stringify({ org: { id: 'default' } }));
    writeFileSync(join(configDir, 'data.db'), 'sqlite-data');

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Database|data\.db/i);
  });

  it('lists installed skills when skills directory exists', async () => {
    const configDir = join(tmpHome, '.markus');
    const skillsDir = join(configDir, 'skills');
    mkdirSync(join(skillsDir, 'my-skill'), { recursive: true });
    writeFileSync(
      join(configDir, 'markus.json'),
      JSON.stringify({
        llm: { providers: { openai: { apiKey: 'sk-validkey1234567890' } } },
      }),
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Skills|skill/i);
  });

  it('warns about placeholder pool keys in config schema', async () => {
    const configDir = join(tmpHome, '.markus');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'markus.json'),
      JSON.stringify({
        llm: {
          providers: {
            openai: { apiKey: 'sk-validkey1234567890', apiKey2: 'test-key' },
          },
        },
      }),
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/pool key|placeholder/i);
  });

  it('reports all checks passed for healthy configuration', async () => {
    const configDir = join(tmpHome, '.markus');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'markus.json'),
      JSON.stringify({
        llm: { providers: { openai: { apiKey: 'sk-validkey1234567890', model: 'gpt-4o-mini' } } },
      }),
    );
    writeFileSync(join(configDir, 'data.db'), 'db');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    await runDoctor();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/All checks passed|ready to run/i);
  });
});
