import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initStorage } from '../src/storage-bridge.js';

// The bridge wires up every repository the storage package exports. Enumerating
// that list here made the fixture a liar: adding a repo to the bridge broke three
// unrelated tests with a confusing "expected null not to be null" (the missing
// constructor threw, and initSqliteStorage swallows wiring errors). Instead, mock
// the two functions the tests assert on and hand every `*Repo` name a no-op.
vi.mock('@markus/storage', () => {
  const mod: Record<string | symbol, unknown> = {
    openSqlite: vi.fn(() => ({})),
    runInTransaction: vi.fn((_db: unknown, fn: () => unknown) => fn()),
  };
  return new Proxy(mod, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.endsWith('Repo')) {
        const ctor = vi.fn();
        target[prop] = ctor;
        return ctor;
      }
      return undefined;
    },
    has(target, prop) {
      return prop in target || (typeof prop === 'string' && prop.endsWith('Repo'));
    },
  });
});

describe('initStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['DATABASE_URL'];
  });

  it('initializes sqlite storage with default path', async () => {
    const bridge = await initStorage();
    expect(bridge).not.toBeNull();
    expect(bridge?.orgRepo).toBeDefined();
    expect(bridge?.taskRepo).toBeDefined();
    expect(bridge?.integrationRepo).toBeDefined();
  });

  it('resolves sqlite: path with tilde', async () => {
    const bridge = await initStorage('sqlite:~/test-data.db');
    expect(bridge).not.toBeNull();
  });

  it('uses DATABASE_URL env when no arg', async () => {
    process.env['DATABASE_URL'] = 'sqlite:/tmp/markus-test.db';
    const bridge = await initStorage();
    expect(bridge).not.toBeNull();
  });

  it('returns null when sqlite init fails', async () => {
    const storage = await import('@markus/storage');
    vi.mocked(storage.openSqlite).mockImplementationOnce(() => { throw new Error('db fail'); });
    const bridge = await initStorage('sqlite:/bad/path.db');
    expect(bridge).toBeNull();
  });
});
