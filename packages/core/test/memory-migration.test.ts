import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mig-test-'));
}

function rmdir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Inline SUT stubs (simulate migration logic)
// ---------------------------------------------------------------------------

/** Detect format: returns 'sqlite' or 'json' based on file existence */
function detectFormat(dir: string): 'sqlite' | 'json' {
  const dbPath = path.join(dir, 'memory.db');
  const sessionDir = path.join(dir, 'sessions');
  if (fs.existsSync(dbPath)) return 'sqlite';
  if (fs.existsSync(sessionDir)) return 'json';
  return 'json'; // default fallback
}

/** Migrate session JSON files into a SQLite-like store (simulated as a JSON array) */
function migrateSessionFilesToSQLite(sessionsDir: string, dbPath: string): number {
  if (!fs.existsSync(sessionsDir)) throw new Error(`Sessions directory not found: ${sessionsDir}`);
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  const sessions: unknown[] = [];
  for (const file of files) {
    const fullPath = path.join(sessionsDir, file);
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(raw);
      sessions.push(data);
    } catch {
      throw new Error(`Failed to parse ${file}`);
    }
  }
  fs.writeFileSync(dbPath, JSON.stringify({ migrated: true, sessions }), 'utf-8');
  return sessions.length;
}

/** Migrate knowledge-base directory to new format */
function migrateKnowledgeBase(kbDir: string, dbPath: string): number {
  if (!fs.existsSync(kbDir)) throw new Error(`Knowledge base dir not found: ${kbDir}`);
  const entries = fs.readdirSync(kbDir, { withFileTypes: true });
  const knowledge: Record<string, string> = {};
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile()) {
      const fullPath = path.join(kbDir, entry.name);
      knowledge[entry.name] = fs.readFileSync(fullPath, 'utf-8');
      count++;
    } else if (entry.isDirectory()) {
      const subDir = path.join(kbDir, entry.name);
      const subFiles = fs.readdirSync(subDir);
      for (const sf of subFiles) {
        const sfPath = path.join(subDir, sf);
        knowledge[`${entry.name}/${sf}`] = fs.readFileSync(sfPath, 'utf-8');
        count++;
      }
    }
  }
  fs.writeFileSync(dbPath, JSON.stringify({ migrated: true, knowledge }), 'utf-8');
  return count;
}

/** Double-write pattern: write to both JSON session file and SQLite DB */
function doubleWriteSession(
  sessionsDir: string,
  dbPath: string,
  sessionId: string,
  data: unknown,
): void {
  // Write old JSON
  const jsonPath = path.join(sessionsDir, `${sessionId}.json`);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
  // Write new SQLite (simulated as JSON array append)
  let store: { sessions: unknown[] } = { sessions: [] };
  if (fs.existsSync(dbPath)) {
    try { store = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch { store = { sessions: [] }; }
  }
  store.sessions.push({ id: sessionId, ...(data as object) });
  fs.writeFileSync(dbPath, JSON.stringify(store), 'utf-8');
}

/** Rollback: if a callback throws, undo the migration DB file */
function migrateWithRollback(sessionsDir: string, dbPath: string): number {
  if (fs.existsSync(dbPath)) {
    throw new Error('Target DB already exists — rollback');
  }
  try {
    return migrateSessionFilesToSQLite(sessionsDir, dbPath);
  } catch (err) {
    // Rollback: remove partially created DB
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('MemoryMigration — Session migration', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => { rmdir(tmp); });

  it('migrates a single session file', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(sessionsDir);
    writeFile(path.join(sessionsDir, 'session_001.json'), JSON.stringify({ id: 's1', messages: [] }));

    const count = migrateSessionFilesToSQLite(sessionsDir, dbPath);
    expect(count).toBe(1);
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    expect(db.migrated).toBe(true);
    expect(db.sessions).toHaveLength(1);
    expect(db.sessions[0].id).toBe('s1');
  });

  it('migrates multiple session files', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(sessionsDir);
    writeFile(path.join(sessionsDir, 'a.json'), JSON.stringify({ id: 'a' }));
    writeFile(path.join(sessionsDir, 'b.json'), JSON.stringify({ id: 'b' }));
    writeFile(path.join(sessionsDir, 'c.json'), JSON.stringify({ id: 'c' }));

    const count = migrateSessionFilesToSQLite(sessionsDir, dbPath);
    expect(count).toBe(3);
  });

  it('throws when sessions directory is missing', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    expect(() => migrateSessionFilesToSQLite(sessionsDir, path.join(tmp, 'db'))).toThrow(
      'Sessions directory not found',
    );
  });

  it('throws on corrupt JSON in a session file', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    fs.mkdirSync(sessionsDir);
    writeFile(path.join(sessionsDir, 'bad.json'), '{ not json');
    expect(() =>
      migrateSessionFilesToSQLite(sessionsDir, path.join(tmp, 'db')),
    ).toThrow(/Failed to parse/);
  });

  it('handles empty sessions directory', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    fs.mkdirSync(sessionsDir);
    const count = migrateSessionFilesToSQLite(sessionsDir, path.join(tmp, 'db'));
    expect(count).toBe(0);
  });
});

describe('MemoryMigration — Knowledge base migration', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => { rmdir(tmp); });

  it('migrates flat knowledge files', () => {
    const kbDir = path.join(tmp, 'knowledge-base');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(kbDir);
    writeFile(path.join(kbDir, 'doc1.txt'), 'content1');
    writeFile(path.join(kbDir, 'doc2.md'), '# Doc2');

    const count = migrateKnowledgeBase(kbDir, dbPath);
    expect(count).toBe(2);
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    expect(db.knowledge['doc1.txt']).toBe('content1');
    expect(db.knowledge['doc2.md']).toBe('# Doc2');
  });

  it('migrates nested knowledge directories', () => {
    const kbDir = path.join(tmp, 'knowledge-base');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(kbDir);
    fs.mkdirSync(path.join(kbDir, 'sub'));
    writeFile(path.join(kbDir, 'top.txt'), 'top');
    writeFile(path.join(kbDir, 'sub', 'inner.txt'), 'inner');

    const count = migrateKnowledgeBase(kbDir, dbPath);
    expect(count).toBe(2);
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    expect(db.knowledge['top.txt']).toBe('top');
    expect(db.knowledge['sub/inner.txt']).toBe('inner');
  });

  it('throws when knowledge-base directory is missing', () => {
    expect(() =>
      migrateKnowledgeBase(path.join(tmp, 'nonexistent'), path.join(tmp, 'db')),
    ).toThrow(/Knowledge base dir not found/);
  });
});

describe('MemoryMigration — Double-write pattern', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => { rmdir(tmp); });

  it('writes to both JSON session and SQLite DB', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(sessionsDir);

    doubleWriteSession(sessionsDir, dbPath, 's1', { messages: ['hi'] });
    expect(fs.existsSync(path.join(sessionsDir, 's1.json'))).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    const jsonData = JSON.parse(fs.readFileSync(path.join(sessionsDir, 's1.json'), 'utf-8'));
    expect(jsonData.messages).toEqual(['hi']);

    const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    expect(dbData.sessions).toHaveLength(1);
  });

  it('appends to DB on subsequent double-writes', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(sessionsDir);

    doubleWriteSession(sessionsDir, dbPath, 's1', { msg: 'first' });
    doubleWriteSession(sessionsDir, dbPath, 's2', { msg: 'second' });

    const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    expect(dbData.sessions).toHaveLength(2);
  });
});

describe('MemoryMigration — Format detection', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => { rmdir(tmp); });

  it('detects SQLite format when memory.db exists', () => {
    writeFile(path.join(tmp, 'memory.db'), '{}');
    expect(detectFormat(tmp)).toBe('sqlite');
  });

  it('detects JSON format when sessions/ directory exists', () => {
    fs.mkdirSync(path.join(tmp, 'sessions'));
    expect(detectFormat(tmp)).toBe('json');
  });

  it("defaults to 'json' when neither format marker exists", () => {
    expect(detectFormat(tmp)).toBe('json');
  });

  it('prefers SQLite when both db and sessions exist', () => {
    writeFile(path.join(tmp, 'memory.db'), '{}');
    fs.mkdirSync(path.join(tmp, 'sessions'));
    expect(detectFormat(tmp)).toBe('sqlite');
  });
});

describe('MemoryMigration — Backward compatibility', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => { rmdir(tmp); });

  it('reads old JSON session data alongside new DB', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(sessionsDir);
    writeFile(path.join(sessionsDir, 'legacy.json'), JSON.stringify({ id: 'legacy', data: 'old' }));
    doubleWriteSession(sessionsDir, dbPath, 'new-session', { data: 'new' });

    // Old file remains readable
    const oldRaw = fs.readFileSync(path.join(sessionsDir, 'legacy.json'), 'utf-8');
    expect(JSON.parse(oldRaw).data).toBe('old');

    // New DB also readable
    const dbRaw = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    expect(dbRaw.sessions).toHaveLength(1);
  });

  it('old data is preserved after migration', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(sessionsDir);
    writeFile(path.join(sessionsDir, 'old.json'), JSON.stringify({ key: 'value' }));

    migrateSessionFilesToSQLite(sessionsDir, dbPath);

    // Original JSON still intact
    expect(fs.existsSync(path.join(sessionsDir, 'old.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, 'old.json'), 'utf-8')).key).toBe('value');
  });
});

describe('MemoryMigration — Rollback support', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => { rmdir(tmp); });

  it('aborts migration when target DB already exists', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(sessionsDir);
    writeFile(path.join(sessionsDir, 's.json'), JSON.stringify({}));
    writeFile(dbPath, '{}'); // Pre-existing DB

    expect(() => migrateWithRollback(sessionsDir, dbPath)).toThrow(/already exists/);
  });

  it('removes partially created DB on error', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(sessionsDir);
    writeFile(path.join(sessionsDir, 'bad.json'), '{corrupt');

    expect(() => migrateWithRollback(sessionsDir, dbPath)).toThrow();
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('completes migration successfully when no error occurs', () => {
    const sessionsDir = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'memory.db');
    fs.mkdirSync(sessionsDir);
    writeFile(path.join(sessionsDir, 'ok.json'), JSON.stringify({ ok: true }));

    const count = migrateWithRollback(sessionsDir, dbPath);
    expect(count).toBe(1);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
