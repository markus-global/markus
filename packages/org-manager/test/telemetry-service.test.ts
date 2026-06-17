import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('TelemetryService', () => {
  let TelemetryService: typeof import('../src/telemetry-service.js').TelemetryService;
  let configDir: string;

  beforeEach(async () => {
    vi.resetModules();
    configDir = mkdtempSync(join(tmpdir(), 'telemetry-'));
    mkdirSync(join(configDir, '.markus', 'logs'), { recursive: true });
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => configDir };
    });
    ({ TelemetryService } = await import('../src/telemetry-service.js'));
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ status: 200, headers: { get: () => null } });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('loads config, toggles enabled, and reports stats', async () => {
    mkdirSync(join(configDir, '.markus'), { recursive: true });
    writeFileSync(join(configDir, '.markus', 'telemetry.json'), JSON.stringify({ enabled: false }));
    writeFileSync(join(configDir, '.markus', 'hub-token'), 'hub-tok');

    const svc = new TelemetryService('https://hub.test', 'inst-1');
    expect(svc.isEnabled()).toBe(false);
    svc.setEnabled(true);
    expect(svc.isEnabled()).toBe(true);

    svc.setStatsProvider(() => ({
      agentCount: 2, taskCount: 5, toolCallCount: 10, teamCount: 1, plan: 'free',
    }));

    vi.useFakeTimers();
    svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetch).toHaveBeenCalled();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(String(url)).toContain('/api/telemetry');
    expect(JSON.parse(String(init?.body)).instanceId).toBe('inst-1');

    svc.destroy();
    vi.useRealTimers();
  });

  it('follows redirects in hubFetch', async () => {
    mockFetch
      .mockResolvedValueOnce({ status: 302, headers: { get: () => 'https://hub.test/redirect' } })
      .mockResolvedValueOnce({ status: 200, headers: { get: () => null } });

    const svc = new TelemetryService('https://hub.test', 'inst-2');
    svc.setEnabled(true);
    svc.setStatsProvider(() => ({
      agentCount: 1, taskCount: 1, toolCallCount: 1, teamCount: 1, plan: 'free',
    }));
    vi.useFakeTimers();
    svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    svc.destroy();
  });

  it('handles report failures silently', async () => {
    mockFetch.mockRejectedValue(new Error('network'));
    const svc = new TelemetryService('https://hub.test', 'inst-3');
    svc.setEnabled(true);
    svc.setStatsProvider(() => ({
      agentCount: 1, taskCount: 1, toolCallCount: 1, teamCount: 1, plan: 'free',
    }));
    vi.useFakeTimers();
    svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    svc.destroy();
    expect(true).toBe(true);
  });
});
