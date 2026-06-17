import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openSqlite,
  closeSqlite,
  SqliteOrgRepo,
  SqliteAgentRepo,
  SqliteTaskRepo,
  SqliteMessageRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-storage-edge-'));
  dbPath = join(tempDir, 'edge.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('sqlite-storage edge cases', () => {
  it('returns same db instance on repeated openSqlite calls', () => {
    const db1 = openSqlite(dbPath);
    const db2 = openSqlite(join(tempDir, 'other.db'));
    expect(db1).toBe(db2);
  });

  it('creates database directory if missing', () => {
    const nested = join(tempDir, 'nested', 'dir', 'test.db');
    openSqlite(nested);
    expect(existsSync(join(tempDir, 'nested', 'dir'))).toBe(true);
    closeSqlite();
  });

  it('stores and retrieves large task descriptions', async () => {
    const db = openSqlite(dbPath);
    const orgRepo = new SqliteOrgRepo(db);
    orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });
    const agentRepo = new SqliteAgentRepo(db);
    agentRepo.create({ id: 'a1', name: 'Agent', orgId: 'org-1', roleId: 'r1', roleName: 'Dev' });

    const largeDescription = 'x'.repeat(100_000);
    const taskRepo = new SqliteTaskRepo(db);
    await taskRepo.create({
      id: 'task-large',
      orgId: 'org-1',
      title: 'Large payload task',
      description: largeDescription,
      assignedAgentId: 'a1',
      reviewerId: 'a1',
    });

    const found = taskRepo.findById('task-large');
    expect(found?.description).toBe(largeDescription);
  });

  it('handles concurrent task creates from same connection', async () => {
    const db = openSqlite(dbPath);
    const orgRepo = new SqliteOrgRepo(db);
    orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });
    const agentRepo = new SqliteAgentRepo(db);
    agentRepo.create({ id: 'a1', name: 'Agent', orgId: 'org-1', roleId: 'r1', roleName: 'Dev' });

    const taskRepo = new SqliteTaskRepo(db);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        taskRepo.create({
          id: `concurrent-task-${i}`,
          orgId: 'org-1',
          title: `Task ${i}`,
          assignedAgentId: 'a1',
          reviewerId: 'a1',
        }),
      ),
    );

    const list = taskRepo.listByOrg('org-1');
    expect(list.length).toBe(20);
  });

  it('findById returns undefined for missing records', () => {
    const db = openSqlite(dbPath);
    const taskRepo = new SqliteTaskRepo(db);
    expect(taskRepo.findById('does-not-exist')).toBeUndefined();
  });

  it('updateStatus on missing task does not throw', async () => {
    const db = openSqlite(dbPath);
    const taskRepo = new SqliteTaskRepo(db);
    await expect(taskRepo.updateStatus('missing-task', 'completed')).resolves.toBeUndefined();
  });

  it('stores messages with unicode and special characters', () => {
    const db = openSqlite(dbPath);
    const orgRepo = new SqliteOrgRepo(db);
    orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });
    const agentRepo = new SqliteAgentRepo(db);
    agentRepo.create({ id: 'a1', name: 'Agent', orgId: 'org-1', roleId: 'r1', roleName: 'Dev' });

    const msgRepo = new SqliteMessageRepo(db);
    const text = '你好 🚀 emoji content';
    msgRepo.create({
      id: 'msg-1',
      platform: 'webui',
      direction: 'inbound',
      channelId: 'ch-1',
      senderId: 'user-1',
      senderName: 'Alice',
      agentId: 'a1',
      content: { type: 'text', text },
    });

    const rows = msgRepo.findByChannel('ch-1', 1) as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0].content) as { text: string };
    expect(parsed.text).toBe(text);
  });

  it('closeSqlite allows reopening a new database path', () => {
    openSqlite(dbPath);
    closeSqlite();
    const db2 = openSqlite(join(tempDir, 'reopened.db'));
    expect(db2).toBeDefined();
    const orgRepo = new SqliteOrgRepo(db2);
    orgRepo.createOrg({ id: 'org-new', name: 'New Org', ownerId: 'u1' });
    expect(orgRepo.findOrgById('org-new')).toBeDefined();
  });

  it('persists complex JSON in task subtasks field', async () => {
    const db = openSqlite(dbPath);
    const orgRepo = new SqliteOrgRepo(db);
    orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });
    const agentRepo = new SqliteAgentRepo(db);
    agentRepo.create({ id: 'a1', name: 'Agent', orgId: 'org-1', roleId: 'r1', roleName: 'Dev' });

    const subtasks = [
      { id: 'sub-1', title: 'Step 1', nested: { deep: true, items: [1, 2, 3] } },
      { id: 'sub-2', title: 'Step 2', emoji: '✅' },
    ];
    const taskRepo = new SqliteTaskRepo(db);
    await taskRepo.create({
      id: 'task-json',
      orgId: 'org-1',
      title: 'JSON task',
      assignedAgentId: 'a1',
      reviewerId: 'a1',
      subtasks,
    });

    const found = taskRepo.findById('task-json');
    expect(found?.subtasks).toEqual(subtasks);
  });
});
