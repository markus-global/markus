import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initStorage } from '../src/storage-bridge.js';

// The bridge wires up every repository the storage package exports. Enumerating
// that list here made the fixture a liar: adding a repo to the bridge broke three
// unrelated tests with a confusing "expected null not to be null" (the missing
// constructor threw, and initSqliteStorage swallows wiring errors). Instead, mock
// the two functions the tests assert on and hand every `*Repo` name a no-op.
//
// The same trap fired again when the bridge started constructing BlobStore,
// AttachmentStore and MigrationRunner alongside the repos: none of them ends in
// `Repo`, so all three resolved to undefined and `new undefined()` made
// initStorage return null. Two changes keep that from repeating:
//   1. the non-repo primitives the bridge uses are stubbed explicitly below;
//   2. an unknown capitalised name throws a message naming the missing stub,
//      so a future gap fails as "X is not stubbed" instead of a mystery null.
vi.mock('@markus/storage', () => {
  const noopCtor = function noopCtor(this: Record<string, unknown>) {
    this.status = () => [];
    this.run = async () => ({});
  } as unknown as new (...args: unknown[]) => unknown;

  const mod: Record<string | symbol, unknown> = {
    openSqlite: vi.fn(() => ({})),
    runInTransaction: vi.fn((_db: unknown, fn: () => unknown) => fn()),
    // Primitives constructed directly by initSqliteStorage (not `*Repo`).
    BlobStore: noopCtor,
    AttachmentStore: noopCtor,
    MigrationRunner: noopCtor,
    LARGE_DATABASE_BYTES: 512 * 1024 * 1024,
    // Closed by the pre-open self-heal path; both must resolve to something the
    // bridge can read `.action` off.
    tryApplyPendingRepair: vi.fn(() => ({ action: 'none' })),
    prepareDatabaseFile: vi.fn(async () => ({ action: 'none', reason: 'healthy' })),
    probeDatabaseHealthInChild: vi.fn(async () => ({ status: 'ok', detail: '', elapsedMs: 0 })),
    quickCheckDatabase: vi.fn(() => ({ ok: true, errors: [], elapsedMs: 0 })),
    reclaimSpace: vi.fn(() => ({ reclaimed: false, freeBytes: 0 })),
  };

  return new Proxy(mod, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.endsWith('Repo')) {
        const ctor = vi.fn();
        target[prop] = ctor;
        return ctor;
      }
      if (typeof prop === 'string' && /^[A-Z]/.test(prop)) {
        throw new Error(`@markus/storage mock is missing '${prop}' — add it to the fixture`);
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
