import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

function setupDb() {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-sqlite-repos-'));
  dbPath = join(tempDir, 'test.db');
  return openSqlite(dbPath);
}

function seedOrgAndAgent(db: ReturnType<typeof openSqlite>) {
  const orgRepo = new SqliteOrgRepo(db);
  orgRepo.createOrg({ id: 'org-1', name: 'Test Org', ownerId: 'user-1' });
  const agentRepo = new SqliteAgentRepo(db);
  agentRepo.create({
    id: 'agent-1',
    name: 'Worker',
    orgId: 'org-1',
    roleId: 'role-1',
    roleName: 'Developer',
  });
  return { orgRepo, agentRepo };
}

beforeEach(() => {
  setupDb();
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('openSqlite / closeSqlite', () => {
  it('creates schema tables on first open', () => {
    const db = openSqlite(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).toContain('organizations');
    expect(names).toContain('agents');
    expect(names).toContain('tasks');
    expect(names).toContain('messages');
  });

  it('applies column migrations idempotently on reopen', () => {
    const db1 = openSqlite(dbPath);
    const cols1 = (db1.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols1).toContain('blocked_by');
    expect(cols1).toContain('project_id');
    expect(cols1).toContain('subtasks');
    closeSqlite();
    const db2 = openSqlite(dbPath);
    const cols2 = (db2.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols2).toEqual(cols1);
  });

  it('migrates legacy task status pending_approval to pending', () => {
    const db = openSqlite(dbPath);
    seedOrgAndAgent(db);
    db.prepare(
      `INSERT INTO tasks (id, org_id, title, status, assigned_agent_id, reviewer_agent_id, created_at, updated_at)
       VALUES ('legacy-task', 'org-1', 'Legacy', 'pending_approval', 'agent-1', 'agent-1', datetime('now'), datetime('now'))`,
    ).run();
    closeSqlite();
    const db2 = openSqlite(dbPath);
    const row = db2.prepare('SELECT status FROM tasks WHERE id = ?').get('legacy-task') as { status: string };
    expect(row.status).toBe('pending');
  });
});

describe('SqliteOrgRepo', () => {
  it('creates and finds an organization', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteOrgRepo(db);
    const org = repo.createOrg({ id: 'org-1', name: 'Acme', ownerId: 'owner-1', plan: 'pro', maxAgents: 10 });
    expect(org.id).toBe('org-1');
    expect(org.name).toBe('Acme');
    expect(org.ownerId).toBe('owner-1');
    expect(org.plan).toBe('pro');
    expect(org.maxAgents).toBe(10);
    expect(org.settings).toEqual({});

    const found = repo.findOrgById('org-1');
    expect(found?.name).toBe('Acme');
  });

  it('returns undefined for missing org', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteOrgRepo(db);
    expect(repo.findOrgById('missing')).toBeUndefined();
  });

  it('ignores duplicate org id on create (INSERT OR IGNORE)', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteOrgRepo(db);
    repo.createOrg({ id: 'org-dup', name: 'First', ownerId: 'u1' });
    const second = repo.createOrg({ id: 'org-dup', name: 'Second', ownerId: 'u2' });
    expect(second.name).toBe('First');
    expect(repo.listOrgs()).toHaveLength(1);
  });

  it('lists all organizations', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteOrgRepo(db);
    repo.createOrg({ id: 'org-a', name: 'A', ownerId: 'u1' });
    repo.createOrg({ id: 'org-b', name: 'B', ownerId: 'u2' });
    expect(repo.listOrgs()).toHaveLength(2);
  });

  it('creates and lists teams', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteOrgRepo(db);
    repo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });
    const team = repo.createTeam({ id: 'team-1', orgId: 'org-1', name: 'Engineering', description: 'Dev team' });
    expect(team['name']).toBe('Engineering');
    expect(repo.listTeams('org-1')).toHaveLength(1);
  });

  it('updates manager agent id', async () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteOrgRepo(db);
    repo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });
    await repo.updateManagerAgentId('org-1', 'agent-mgr');
    expect(repo.findOrgById('org-1')?.managerAgentId).toBe('agent-mgr');
    await repo.updateManagerAgentId('org-1', null);
    expect(repo.findOrgById('org-1')?.managerAgentId).toBeNull();
  });
});

describe('SqliteAgentRepo', () => {
  it('creates, reads, and lists agents', () => {
    const db = openSqlite(dbPath);
    const { orgRepo } = seedOrgAndAgent(db);
    orgRepo.createOrg({ id: 'org-2', name: 'Other', ownerId: 'u2' });

    const repo = new SqliteAgentRepo(db);
    const agent = repo.create({
      id: 'agent-2',
      name: 'Reviewer',
      orgId: 'org-2',
      roleId: 'role-2',
      roleName: 'Reviewer',
      agentRole: 'manager',
      skills: ['git', 'review'],
      llmConfig: { model: 'gpt-4' },
      heartbeatIntervalMs: 60000,
    });

    expect(agent.name).toBe('Reviewer');
    expect(agent.skills).toEqual(['git', 'review']);
    expect(agent.llmConfig).toEqual({ model: 'gpt-4' });
    expect(agent.heartbeatIntervalMs).toBe(60000);

    expect(repo.findById('agent-2')?.agentRole).toBe('manager');
    expect(repo.findByOrgId('org-1')).toHaveLength(1);
    expect(repo.listAll()).toHaveLength(2);
  });

  it('returns undefined for missing or deleted agent', () => {
    const db = openSqlite(dbPath);
    const { agentRepo } = seedOrgAndAgent(db);
    expect(agentRepo.findById('missing')).toBeUndefined();
    agentRepo.delete('agent-1');
    expect(agentRepo.findById('agent-1')).toBeUndefined();
    expect(agentRepo.findByOrgId('org-1')).toHaveLength(0);
  });

  it('updates status, tokens, team, config, and avatar', async () => {
    const db = openSqlite(dbPath);
    const { orgRepo, agentRepo } = seedOrgAndAgent(db);
    orgRepo.createTeam({ id: 'team-1', orgId: 'org-1', name: 'Team' });

    agentRepo.updateStatus('agent-1', 'working', 'container-abc');
    expect(agentRepo.findById('agent-1')?.status).toBe('working');
    expect(agentRepo.findById('agent-1')?.containerId).toBe('container-abc');

    agentRepo.updateTokens('agent-1', 5000);
    expect(agentRepo.findById('agent-1')?.tokensUsedToday).toBe(5000);

    await agentRepo.updateTeamId('agent-1', 'team-1');
    expect(agentRepo.findById('agent-1')?.teamId).toBe('team-1');

    agentRepo.updateConfig('agent-1', {
      name: 'Renamed',
      skills: ['new-skill'],
      llmConfig: { model: 'claude' },
    });
    const updated = agentRepo.findById('agent-1');
    expect(updated?.name).toBe('Renamed');
    expect(updated?.skills).toEqual(['new-skill']);

    agentRepo.updateAvatarUrl('agent-1', 'https://example.com/avatar.png');
    expect(agentRepo.findById('agent-1')?.avatarUrl).toBe('https://example.com/avatar.png');

    await agentRepo.clearTeamReferences('team-1');
    expect(agentRepo.findById('agent-1')?.teamId).toBeNull();
  });
});

describe('SqliteTaskRepo', () => {
  it('creates and finds tasks with defaults and optional fields', async () => {
    const db = openSqlite(dbPath);
    seedOrgAndAgent(db);
    const repo = new SqliteTaskRepo(db);
    const dueAt = new Date('2026-12-31T00:00:00Z');

    const task = await repo.create({
      id: 'task-1',
      orgId: 'org-1',
      title: 'Build feature',
      description: 'Implement the thing',
      priority: 'high',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
      requirementId: 'req-1',
      projectId: 'proj-1',
      createdBy: 'user-1',
      dueAt,
      taskType: 'standard',
      scheduleConfig: { cron: '0 9 * * *' },
      blockedBy: ['task-0'],
      subtasks: [{ id: 's1', title: 'Step 1' }],
    });

    expect(task.status).toBe('pending');
    expect(task.priority).toBe('high');
    expect(task.requirementId).toBe('req-1');
    expect(task.projectId).toBe('proj-1');
    expect(task.blockedBy).toEqual(['task-0']);
    expect(task.subtasks).toEqual([{ id: 's1', title: 'Step 1' }]);
    expect(task.scheduleConfig).toEqual({ cron: '0 9 * * *' });
    expect(task.dueAt?.toISOString()).toBe(dueAt.toISOString());

    const found = repo.findById('task-1');
    expect(found?.title).toBe('Build feature');
  });

  it('updates status with timestamps and updatedBy', async () => {
    const db = openSqlite(dbPath);
    seedOrgAndAgent(db);
    const repo = new SqliteTaskRepo(db);
    await repo.create({
      id: 'task-status',
      orgId: 'org-1',
      title: 'Status task',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
    });

    await repo.updateStatus('task-status', 'in_progress', 'user-1');
    let task = repo.findById('task-status');
    expect(task?.status).toBe('in_progress');
    expect(task?.startedAt).toBeInstanceOf(Date);
    expect(task?.updatedBy).toBe('user-1');

    await repo.updateStatus('task-status', 'completed');
    task = repo.findById('task-status');
    expect(task?.status).toBe('completed');
    expect(task?.completedAt).toBeInstanceOf(Date);
  });

  it('assigns, updates fields, result, deliverables, and subtasks', async () => {
    const db = openSqlite(dbPath);
    seedOrgAndAgent(db);
    const repo = new SqliteTaskRepo(db);
    await repo.create({
      id: 'task-upd',
      orgId: 'org-1',
      title: 'Original',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
    });

    await repo.assign('task-upd', 'agent-1', 'manager-1');
    await repo.update('task-upd', {
      title: 'Updated title',
      description: 'New desc',
      priority: 'low',
      notes: ['note-1'],
      blockedBy: ['blocker'],
      projectId: 'proj-x',
      requirementId: 'req-x',
      reviewerId: 'agent-1',
      updatedBy: 'user-2',
    });

    await repo.setResult('task-upd', { output: 'done' });
    await repo.updateDeliverables('task-upd', [{ type: 'file', path: '/out.txt' }]);
    await repo.updateSubtasks('task-upd', [{ id: 'sub', done: true }]);
    await repo.updateExecutionRound('task-upd', 2);

    const task = repo.findById('task-upd');
    expect(task?.title).toBe('Updated title');
    expect(task?.priority).toBe('low');
    expect(task?.notes).toEqual(['note-1']);
    expect(task?.blockedBy).toEqual(['blocker']);
    expect(task?.result).toEqual({ output: 'done' });
    expect(task?.deliverables).toEqual([{ type: 'file', path: '/out.txt' }]);
    expect(task?.subtasks).toEqual([{ id: 'sub', done: true }]);
    expect(task?.executionRound).toBe(2);
  });

  it('lists tasks with filters and by agent', async () => {
    const db = openSqlite(dbPath);
    seedOrgAndAgent(db);
    const repo = new SqliteTaskRepo(db);

    await repo.create({
      id: 't-pending',
      orgId: 'org-1',
      title: 'Pending',
      status: 'pending',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
      projectId: 'proj-1',
      taskType: 'standard',
    });
    await repo.create({
      id: 't-done',
      orgId: 'org-1',
      title: 'Done',
      status: 'completed',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
      projectId: 'proj-2',
      taskType: 'scheduled',
    });

    expect(repo.listByOrg('org-1')).toHaveLength(2);
    expect(repo.listByOrg('org-1', { status: 'pending' })).toHaveLength(1);
    expect(repo.listByOrg('org-1', { projectId: 'proj-1' })).toHaveLength(1);
    expect(repo.listByOrg('org-1', { taskType: 'scheduled' })).toHaveLength(1);
    expect(repo.listByOrg('org-1', { assignedAgentId: 'agent-1' })).toHaveLength(2);
    expect(repo.listByAgent('agent-1')).toHaveLength(2);
  });

  it('ensureExists upserts and delete removes task', async () => {
    const db = openSqlite(dbPath);
    seedOrgAndAgent(db);
    const repo = new SqliteTaskRepo(db);

    await repo.ensureExists({
      id: 'task-upsert',
      orgId: 'org-1',
      title: 'First title',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
    });
    await repo.ensureExists({
      id: 'task-upsert',
      orgId: 'org-1',
      title: 'Second title',
      status: 'in_progress',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
    });
    expect(repo.findById('task-upsert')?.title).toBe('Second title');
    expect(repo.findById('task-upsert')?.status).toBe('in_progress');

    await repo.clearForRerun('task-upsert', 3);
    const rerun = repo.findById('task-upsert');
    expect(rerun?.executionRound).toBe(3);
    expect(rerun?.result).toBeNull();
    expect(rerun?.startedAt).toBeNull();

    await repo.delete('task-upsert');
    expect(repo.findById('task-upsert')).toBeUndefined();
  });
});

describe('SqliteMessageRepo', () => {
  it('creates and queries messages by channel, agent, and thread', () => {
    const db = openSqlite(dbPath);
    seedOrgAndAgent(db);
    const repo = new SqliteMessageRepo(db);

    repo.create({
      id: 'msg-1',
      platform: 'slack',
      direction: 'inbound',
      channelId: 'ch-1',
      senderId: 'user-1',
      senderName: 'Alice',
      agentId: 'agent-1',
      content: { type: 'text', text: 'Hello' },
      threadId: 'thread-1',
    });
    repo.create({
      id: 'msg-2',
      platform: 'slack',
      direction: 'outbound',
      channelId: 'ch-1',
      senderId: 'agent-1',
      senderName: 'Worker',
      agentId: 'agent-1',
      content: { type: 'text', text: 'Reply' },
      replyToId: 'msg-1',
      threadId: 'thread-1',
    });
    repo.create({
      id: 'msg-3',
      platform: 'webui',
      direction: 'inbound',
      channelId: 'ch-2',
      senderId: 'user-2',
      content: { type: 'text', text: 'Other channel' },
    });

    expect(repo.findByChannel('ch-1')).toHaveLength(2);
    expect(repo.findByChannel('ch-1', 1)).toHaveLength(1);
    expect(repo.findByAgent('agent-1')).toHaveLength(2);
    expect(repo.findByThread('thread-1')).toHaveLength(2);

    const thread = repo.findByThread('thread-1') as Array<{ id: string }>;
    expect(thread[0].id).toBe('msg-1');
    expect(thread[1].id).toBe('msg-2');
  });

  it('stores message content as JSON', () => {
    const db = openSqlite(dbPath);
    seedOrgAndAgent(db);
    const repo = new SqliteMessageRepo(db);
    const content = { type: 'multimodal', parts: [{ type: 'image', url: 'x' }] };
    repo.create({
      id: 'msg-json',
      platform: 'webui',
      direction: 'inbound',
      channelId: 'ch-json',
      senderId: 'user-1',
      content,
    });
    const rows = repo.findByChannel('ch-json') as Array<{ content: string }>;
    expect(JSON.parse(rows[0].content)).toEqual(content);
  });
});
