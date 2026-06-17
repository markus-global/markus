import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockWriteStream = {
  write: vi.fn(),
  end: vi.fn(),
};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: vi.fn(() => mockWriteStream),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    appendFileSync: vi.fn(),
  };
});

describe('shared Logger', () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-shared-logger-'));
    process.env.HOME = tmpHome;
    mockWriteStream.write.mockClear();
    mockWriteStream.end.mockClear();
    delete process.env.LOG_LEVEL;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalLogLevel) process.env.LOG_LEVEL = originalLogLevel;
    else delete process.env.LOG_LEVEL;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function loadLogger() {
    return import('../src/utils/logger.js');
  }

  it('createLogger uses info level by default', async () => {
    const { createLogger } = await loadLogger();
    const log = createLogger('test');
    log.info('hello');
    expect(mockWriteStream.write).toHaveBeenCalled();
    const line = String(mockWriteStream.write.mock.calls[0][0]);
    expect(line).toContain('[INFO]');
    expect(line).toContain('[test]');
    expect(line).toContain('hello');
  });

  it('createLogger respects LOG_LEVEL env var', async () => {
    process.env.LOG_LEVEL = 'error';
    const { createLogger } = await loadLogger();
    const log = createLogger('env-test');
    log.info('hidden');
    log.error('visible');
    expect(mockWriteStream.write).toHaveBeenCalledTimes(1);
    expect(String(mockWriteStream.write.mock.calls[0][0])).toContain('visible');
  });

  it('filters messages below configured level', async () => {
    const { Logger } = await loadLogger();
    const log = new Logger('warn-only', 'warn');
    log.info('skipped');
    log.debug('skipped');
    log.warn('shown');
    expect(mockWriteStream.write).toHaveBeenCalledTimes(1);
    expect(String(mockWriteStream.write.mock.calls[0][0])).toContain('[WARN]');
  });

  it('includes JSON data suffix when provided', async () => {
    const { Logger } = await loadLogger();
    const log = new Logger('data-test', 'debug');
    log.debug('event', { userId: 'u1', count: 2 });
    const line = String(mockWriteStream.write.mock.calls[0][0]);
    expect(line).toContain('{"userId":"u1","count":2}');
  });

  it('child logger inherits parent level and prefixes name', async () => {
    const { Logger } = await loadLogger();
    const parent = new Logger('parent', 'info');
    const child = parent.child('child');
    child.info('nested');
    const line = String(mockWriteStream.write.mock.calls[0][0]);
    expect(line).toContain('[parent:child]');
  });

  it('closeRuntimeLogger ends the stream', async () => {
    const { createLogger, closeRuntimeLogger } = await loadLogger();
    createLogger('close-test').info('msg');
    closeRuntimeLogger();
    expect(mockWriteStream.end).toHaveBeenCalled();
  });
});
