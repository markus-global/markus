import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const execMock = vi.hoisted(() => vi.fn((_cmd: string, cb?: (err: null) => void) => cb?.(null)));
const httpGetMock = vi.hoisted(() => vi.fn());
const platformMock = vi.hoisted(() => vi.fn(() => 'darwin'));

vi.mock('node:child_process', () => ({ exec: execMock }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: platformMock };
});
vi.mock('node:http', () => ({ get: httpGetMock }));

describe('browser utils', () => {
  const originalNoBrowser = process.env.NO_BROWSER;

  beforeEach(() => {
    execMock.mockClear();
    httpGetMock.mockReset();
    delete process.env.NO_BROWSER;
    platformMock.mockReturnValue('darwin');
  });

  afterEach(() => {
    vi.resetModules();
    if (originalNoBrowser) process.env.NO_BROWSER = originalNoBrowser;
    else delete process.env.NO_BROWSER;
  });

  it('openBrowser skips when NO_BROWSER is set', async () => {
    process.env.NO_BROWSER = '1';
    const { openBrowser } = await import('../src/utils/browser.js');
    openBrowser('http://localhost:8056');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('openBrowser invokes platform-specific command', async () => {
    const { openBrowser } = await import('../src/utils/browser.js');
    openBrowser('http://localhost:8057');
    expect(execMock).toHaveBeenCalledWith('open "http://localhost:8057"', expect.any(Function));
  });

  it('openBrowserAfterHealthCheck opens browser on 2xx response', async () => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();

    httpGetMock.mockImplementation((_url, cb) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
      res.statusCode = 200;
      res.resume = vi.fn();
      cb(res);
      return req;
    });

    const { openBrowserAfterHealthCheck } = await import('../src/utils/browser.js');
    openBrowserAfterHealthCheck('http://localhost:8057', 'http://localhost:8056/health', 100, 500);
    expect(execMock).toHaveBeenCalledWith('open "http://localhost:8057"', expect.any(Function));
  });

  it('openBrowserAfterHealthCheck retries on connection error', async () => {
    vi.useFakeTimers();
    let attempt = 0;

    httpGetMock.mockImplementation((_url, cb) => {
      attempt++;
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      req.setTimeout = vi.fn((_ms, fn) => fn?.());
      req.destroy = vi.fn();

      if (attempt === 1) {
        process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
      } else {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
        res.statusCode = 200;
        res.resume = vi.fn();
        process.nextTick(() => cb(res));
      }
      return req;
    });

    const { openBrowserAfterHealthCheck } = await import('../src/utils/browser.js');
    openBrowserAfterHealthCheck('http://localhost:8057', 'http://localhost:8056/health', 50, 500);
    await vi.advanceTimersByTimeAsync(60);
    expect(execMock).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
