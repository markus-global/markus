import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite,
  closeSqlite,
  migrateToExecutionStreamLogs,
  SqliteOrgRepo,
  SqliteAgentRepo,
  SqliteTaskRepo,
  SqliteMessageRepo,
  SqliteRequirementRepo,
  SqliteProjectRepo,
  SqliteAuditRepo,
  SqliteTaskLogRepo,
  SqliteTaskCommentRepo,
  SqliteRequirementCommentRepo,
  SqliteChatSessionRepo,
  SqliteChannelMessageRepo,
  SqliteUserRepo,
  SqliteTeamRepo,
  SqliteMarketplaceTemplateRepo,
  SqliteMarketplaceSkillRepo,
  SqliteMarketplaceRatingRepo,
  SqliteAgentKnowledgeRepo,
  SqliteExternalAgentRepo,
  SqliteDeliverableRepo,
  SqliteActivityRepo,
  SqliteExecutionStreamRepo,
  SqliteMailboxRepo,
  SqliteDecisionRepo,
  SqliteNotificationRepo,
  SqliteApprovalRepo,
  SqliteGroupChatRepo,
  SqliteStatusTransitionRepo,
  SqliteIntegrationRepo,
  SqliteReadCursorRepo,
  SqliteWorkflowRunRepo,
  SqliteWorkflowScheduleRepo,
  ensureFtsIndex,
  escapeFtsQuery,
  isFtsAvailable,
} from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

function setupDb() {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-sqlite-comp-'));
  dbPath = join(tempDir, 'comp.db');
  return openSqlite(dbPath);
}

function seedBase(db: ReturnType<typeof openSqlite>) {
  const orgRepo = new SqliteOrgRepo(db);
  orgRepo.createOrg({ id: 'org-1', name: 'Test Org', ownerId: 'user-1', plan: 'pro', maxAgents: 20 });
  orgRepo.createTeam({ id: 'team-1', orgId: 'org-1', name: 'Engineering', description: 'Dev team' });

  const agentRepo = new SqliteAgentRepo(db);
  agentRepo.create({
    id: 'agent-1',
    name: 'Worker',
    orgId: 'org-1',
    teamId: 'team-1',
    roleId: 'role-1',
    roleName: 'Developer',
    agentRole: 'worker',
    skills: ['code'],
    llmConfig: { model: 'gpt-4' },
    computeConfig: { cpu: 2 },
    heartbeatIntervalMs: 30000,
  });
  agentRepo.create({
    id: 'agent-2',
    name: 'Manager',
    orgId: 'org-1',
    roleId: 'role-2',
    roleName: 'Manager',
    agentRole: 'manager',
  });

  const userRepo = new SqliteUserRepo(db);
  userRepo.create({ id: 'user-1', orgId: 'org-1', name: 'Alice', email: 'alice@example.com', role: 'admin' });
  userRepo.create({ id: 'user-2', orgId: 'org-1', name: 'Bob', email: 'bob@example.com', role: 'member', teamId: 'team-1' });

  return { orgRepo, agentRepo, userRepo };
}

beforeEach(() => {
  setupDb();
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('schema migrations and openSqlite', () => {
  it('migrates legacy requirement statuses on reopen', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    db.prepare(
      `INSERT INTO requirements (id, org_id, title, description, status, priority, source, created_by, created_at, updated_at)
       VALUES ('req-draft', 'org-1', 'Draft', '', 'draft', 'medium', 'user', 'user-1', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO requirements (id, org_id, title, description, status, priority, source, created_by, created_at, updated_at)
       VALUES ('req-approved', 'org-1', 'Approved', '', 'approved', 'medium', 'user', 'user-1', datetime('now'), datetime('now'))`,
    ).run();
    closeSqlite();
    const db2 = openSqlite(dbPath);
    expect(db2.prepare('SELECT status FROM requirements WHERE id = ?').get('req-draft')).toEqual({ status: 'pending' });
    expect(db2.prepare('SELECT status FROM requirements WHERE id = ?').get('req-approved')).toEqual({ status: 'in_progress' });
  });

  it('migrateToExecutionStreamLogs copies task_logs and activity_logs', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    db.prepare(
      `INSERT INTO tasks (id, org_id, title, status, assigned_agent_id, reviewer_agent_id, created_at, updated_at)
       VALUES ('task-mig', 'org-1', 'Mig', 'pending', 'agent-1', 'agent-1', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO task_logs (id, task_id, agent_id, seq, type, content, metadata, execution_round, created_at)
       VALUES ('tlog-1', 'task-mig', 'agent-1', 0, 'status', 'started', '{}', 1, datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO agent_activities (id, agent_id, type, label, started_at, created_at)
       VALUES ('act-1', 'agent-1', 'task', 'Run', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO agent_activity_logs (activity_id, seq, type, content, metadata, created_at)
       VALUES ('act-1', 0, 'log', 'step', '{}', datetime('now'))`,
    ).run();
    db.prepare('DELETE FROM execution_stream_logs').run();
    migrateToExecutionStreamLogs(db);
    const rows = db.prepare('SELECT * FROM execution_stream_logs').all();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    closeSqlite();
    const db2 = openSqlite(dbPath);
    const rows2 = db2.prepare('SELECT COUNT(*) as cnt FROM execution_stream_logs').get() as { cnt: number };
    expect(rows2.cnt).toBeGreaterThanOrEqual(2);
  });
});

describe('SqliteOrgRepo extended', () => {
  it('lists empty teams for unknown org', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteOrgRepo(db);
    expect(repo.listTeams('missing-org')).toEqual([]);
  });
});

describe('SqliteAgentRepo extended', () => {
  it('covers config updates, soft delete, and team lifecycle', async () => {
    const db = openSqlite(dbPath);
    const { orgRepo, agentRepo } = seedBase(db);

    agentRepo.updateConfig('agent-1', { agentRole: 'specialist', computeConfig: { mem: 8 } });
    expect(agentRepo.findById('agent-1')?.agentRole).toBe('specialist');
    expect(agentRepo.findById('agent-1')?.computeConfig).toEqual({ mem: 8 });

    agentRepo.updateAvatarUrl('agent-1', null);
    expect(agentRepo.findById('agent-1')?.avatarUrl).toBeNull();

    agentRepo.updateStatus('agent-2', 'online');
    expect(agentRepo.findById('agent-2')?.status).toBe('online');

    await agentRepo.updateTeamId('agent-2', 'team-1');
    await orgRepo.updateManagerAgentId('org-1', 'agent-2');
    await agentRepo.clearTeamReferences('team-1');
    expect(agentRepo.findById('agent-2')?.teamId).toBeNull();

    agentRepo.delete('agent-2');
    expect(agentRepo.listAll()).toHaveLength(1);
    expect(agentRepo.findByOrgId('org-1')).toHaveLength(1);
  });
});

describe('SqliteTaskRepo extended', () => {
  it('covers status transitions, filters, blockedBy, and assign branches', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteTaskRepo(db);

    await repo.create({
      id: 'task-full',
      orgId: 'org-1',
      title: 'Full task',
      executionMode: 'auto',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-2',
      reviewerType: 'agent',
    } as Parameters<SqliteTaskRepo['create']>[0] & { reviewerType: string });

    await repo.updateStatus('task-full', 'failed', 'user-1');
    let task = repo.findById('task-full');
    expect(task?.status).toBe('failed');
    expect(task?.completedAt).toBeInstanceOf(Date);

    await repo.updateStatus('task-full', 'cancelled');
    task = repo.findById('task-full');
    expect(task?.status).toBe('cancelled');

    await repo.assign('task-full', 'agent-2');
    await repo.updateBlockedBy('task-full', ['blocker-1']);
    await repo.update('task-full', {
      scheduleConfig: null,
      projectId: null,
      requirementId: null,
      reviewerId: 'agent-1',
      reviewerType: 'human',
    } as Parameters<SqliteTaskRepo['update']>[1] & { reviewerType: string });

    task = repo.findById('task-full');
    expect(task?.blockedBy).toEqual(['blocker-1']);
    expect(task?.assignedAgentId).toBe('agent-2');

    await repo.create({
      id: 'task-other',
      orgId: 'org-1',
      title: 'Other',
      status: 'pending',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
      projectId: 'proj-1',
      taskType: 'scheduled',
    });

    expect(repo.listByOrg('org-1', { status: 'cancelled' })).toHaveLength(1);
    expect(repo.listByOrg('org-1', { projectId: 'proj-1' })).toHaveLength(1);
    expect(repo.listByOrg('org-1', { taskType: 'scheduled' })).toHaveLength(1);
    expect(repo.listByOrg('org-empty')).toHaveLength(0);
    expect(repo.listByAgent('agent-1').length).toBeGreaterThanOrEqual(1);

    await repo.update('nonexistent', { title: 'noop' });
  });
});

describe('SqliteMessageRepo extended', () => {
  it('supports pagination limits and empty thread', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteMessageRepo(db);

    for (let i = 0; i < 5; i++) {
      repo.create({
        id: `msg-${i}`,
        platform: 'slack',
        direction: 'inbound',
        channelId: 'ch-pag',
        senderId: 'user-1',
        agentId: 'agent-1',
        content: { type: 'text', text: `Message ${i}` },
        threadId: 'thread-pag',
      });
    }

    expect(repo.findByChannel('ch-pag', 2)).toHaveLength(2);
    expect(repo.findByAgent('agent-1', 1)).toHaveLength(1);
    expect(repo.findByThread('empty-thread')).toEqual([]);
    expect(repo.findByChannel('missing')).toEqual([]);
  });
});

describe('SqliteRequirementRepo', () => {
  it('CRUD, approve/reject, filters, and clearRejectionMetadata', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteRequirementRepo(db);

    const req = await repo.create({
      id: 'req-1',
      orgId: 'org-1',
      title: 'Feature request',
      description: 'Build it',
      source: 'user',
      createdBy: 'user-1',
      projectId: 'proj-1',
      tags: ['feature', 'urgent'],
      priority: 'high',
    });
    expect(req.status).toBe('pending');
    expect(req.tags).toEqual(['feature', 'urgent']);

    expect(repo.listByOrg('org-1', { projectId: 'proj-1' })).toHaveLength(1);

    await repo.update('req-1', { title: 'Updated', description: 'New desc', tags: ['done'], projectId: null });
    await repo.approve('req-1', 'user-1');
    let found = repo.findById('req-1');
    expect(found?.status).toBe('in_progress');
    expect(found?.approvedBy).toBe('user-1');

    await repo.reject('req-1', 'Not feasible', 'user-2');
    found = repo.findById('req-1');
    expect(found?.status).toBe('rejected');
    expect(found?.rejectedReason).toBe('Not feasible');

    await repo.clearRejectionMetadata('req-1');
    found = repo.findById('req-1');
    expect(found?.rejectedReason).toBeNull();

    await repo.create({
      id: 'req-2',
      orgId: 'org-1',
      title: 'Second',
      source: 'import',
      createdBy: 'user-1',
      status: 'pending',
    });

    expect(repo.listByOrg('org-1')).toHaveLength(2);
    expect(repo.listByOrg('org-1', { status: 'pending' })).toHaveLength(1);
    expect(repo.listByOrg('org-1', { source: 'import' })).toHaveLength(1);
    expect(repo.findById('missing')).toBeUndefined();

    await repo.updateStatus('req-2', 'completed');
    await repo.delete('req-2');
    expect(repo.findById('req-2')).toBeUndefined();
  });
});

describe('SqliteProjectRepo', () => {
  it('create, update, list, delete', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteProjectRepo(db);

    const project = await repo.create({
      id: 'proj-1',
      orgId: 'org-1',
      name: 'Alpha',
      description: 'First project',
      repositories: [{ url: 'https://github.com/a/b' }],
      teamIds: ['team-1'],
      governancePolicy: { requireReview: true },
      archivePolicy: { days: 90 },
      reportSchedule: { cron: '0 0 * * 0' },
      onboardingConfig: { steps: ['setup'] },
      createdBy: 'user-1',
    });
    expect(project.name).toBe('Alpha');
    expect(project.repositories).toHaveLength(1);

    await repo.update('proj-1', { name: 'Alpha Renamed', status: 'archived', teamIds: [] });
    const updated = repo.findById('proj-1');
    expect(updated?.name).toBe('Alpha Renamed');
    expect(updated?.status).toBe('archived');

    await repo.create({ id: 'proj-2', orgId: 'org-1', name: 'Beta' });
    expect(repo.listByOrg('org-1')).toHaveLength(2);
    expect(repo.listAll()).toHaveLength(2);
    expect(repo.findById('missing')).toBeUndefined();

    await repo.update('missing', { name: 'x' });
    await repo.delete('proj-2');
    expect(repo.findById('proj-2')).toBeUndefined();
  });
});

describe('SqliteAuditRepo', () => {
  it('insert, save alias, and list with filters', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteAuditRepo(db);
    const createdAt = new Date('2026-01-15T10:00:00Z');

    await repo.insert({
      id: 'audit-1',
      orgId: 'org-1',
      agentId: 'agent-1',
      userId: 'user-1',
      type: 'task.completed',
      action: 'complete',
      detail: 'Task done',
      metadata: { taskId: 'task-1' },
      tokensUsed: 100,
      durationMs: 500,
      success: true,
      createdAt,
    });

    await repo.save({
      id: 'audit-2',
      orgId: 'org-1',
      type: 'login',
      action: 'auth',
      success: false,
      createdAt: new Date('2026-01-16T10:00:00Z'),
    });

    expect(repo.list({ orgId: 'org-1' })).toHaveLength(2);
    expect(repo.list({ eventType: 'task.completed' })).toHaveLength(1);
    expect(repo.list({ agentId: 'agent-1' })).toHaveLength(1);
    expect(repo.list({ userId: 'user-1' })).toHaveLength(1);
    expect(
      repo.list({
        dateRange: { from: new Date('2026-01-14'), to: new Date('2026-01-15T23:59:59Z') },
      }),
    ).toHaveLength(1);
    expect(repo.list({ limit: 1, offset: 1 })).toHaveLength(1);
    expect(repo.list()).toHaveLength(2);
  });
});

describe('SqliteTaskLogRepo', () => {
  it('append, query rounds, summary, and delete', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const taskRepo = new SqliteTaskRepo(db);
    await taskRepo.create({
      id: 'task-log',
      orgId: 'org-1',
      title: 'Logged',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
    });

    const repo = new SqliteTaskLogRepo(db);
    expect(await repo.getMaxSeq('task-log')).toBe(-1);

    await repo.append({ taskId: 'task-log', agentId: 'agent-1', seq: 0, type: 'status', content: 'started' });
    await repo.append({ taskId: 'task-log', agentId: 'agent-1', seq: 1, type: 'tool_end', content: 'grep', executionRound: 1 });
    await repo.append({ taskId: 'task-log', agentId: 'agent-1', seq: 0, type: 'status', content: 'completed', executionRound: 2 });

    expect(await repo.getMaxSeq('task-log')).toBe(1);
    expect(repo.getByTask('task-log')).toHaveLength(3);
    expect(repo.getByTaskRound('task-log', 2)).toHaveLength(1);

    const summary = repo.getRoundsSummary('task-log');
    expect(summary).toHaveLength(2);
    expect(summary[0]?.toolCount).toBe(1);

    repo.deleteByTask('task-log');
    expect(repo.getByTask('task-log')).toHaveLength(0);
  });
});

describe('SqliteTaskCommentRepo and SqliteRequirementCommentRepo', () => {
  it('adds threaded comments with replies', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const taskRepo = new SqliteTaskRepo(db);
    await taskRepo.create({
      id: 'task-cmt',
      orgId: 'org-1',
      title: 'Commented',
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-1',
    });

    const taskCommentRepo = new SqliteTaskCommentRepo(db);
    const parent = await taskCommentRepo.add({
      taskId: 'task-cmt',
      authorId: 'user-1',
      authorName: 'Alice',
      authorType: 'human',
      content: 'Parent comment',
      mentions: ['agent-1'],
      attachments: [{ type: 'file', name: 'a.txt' }],
    });
    const reply = await taskCommentRepo.add({
      taskId: 'task-cmt',
      authorId: 'agent-1',
      authorName: 'Worker',
      authorType: 'agent',
      content: 'Reply here',
      replyToId: parent.id,
      activityId: 'act-1',
    });
    expect(reply.replyToId).toBe(parent.id);

    const comments = taskCommentRepo.getByTask('task-cmt');
    expect(comments).toHaveLength(2);
    expect(comments[1]?.replyToAuthor).toBe('Alice');
    expect(comments[1]?.replyToContent).toContain('Parent');

    taskCommentRepo.deleteByTask('task-cmt');
    expect(taskCommentRepo.getByTask('task-cmt')).toHaveLength(0);

    const reqCommentRepo = new SqliteRequirementCommentRepo(db);
    const reqParent = await reqCommentRepo.add({
      requirementId: 'req-cmt',
      authorId: 'user-1',
      authorName: 'Alice',
      authorType: 'human',
      content: 'Req comment',
    });
    await reqCommentRepo.add({
      requirementId: 'req-cmt',
      authorId: 'user-2',
      authorName: 'Bob',
      authorType: 'human',
      content: 'Reply to req',
      replyToId: reqParent.id,
    });
    expect(reqCommentRepo.getByRequirement('req-cmt')).toHaveLength(2);
    reqCommentRepo.deleteByRequirement('req-cmt');
    expect(reqCommentRepo.getByRequirement('req-cmt')).toHaveLength(0);
  });
});

describe('SqliteChatSessionRepo', () => {
  it('sessions, messages, pagination, search, and migrations', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteChatSessionRepo(db);

    const session = repo.createSession('agent-1', 'user-1');
    expect(session.agentId).toBe('agent-1');

    const main = repo.getOrCreateMainSession('agent-1', 'user-1');
    expect(main.isMain).toBe(true);

    repo.appendMessage(session.id, 'agent-1', 'user', 'Hello world');
    repo.appendMessage(session.id, 'agent-1', 'assistant', 'Hi there', 50, { segments: [{ type: 'text', content: 'Hi' }] });
    repo.updateLastMessage(session.id, 'Chat title');

    const { messages, hasMore } = repo.getMessages(session.id, 1);
    expect(messages).toHaveLength(1);
    expect(hasMore).toBe(true);

    expect(repo.getMessageCount(session.id)).toBe(2);
    expect(repo.getSession(session.id)?.title).toBe('Chat title');
    expect(repo.getSessionsByAgent('agent-1', 10, 'user-1').length).toBeGreaterThanOrEqual(1);
    expect(repo.hasAnySessions('user-1')).toBe(true);
    expect(repo.hasAnySessions('nobody')).toBe(false);

    const deleted = repo.deleteLastAssistantMessage(session.id);
    expect(deleted?.content).toBe('Hi there');
    expect(repo.getMessageCount(session.id)).toBe(1);

    repo.appendMessage(session.id, 'agent-1', 'user', 'Retry prompt');
    repo.appendMessage(session.id, 'agent-1', 'assistant', 'Retry response');
    repo.deleteLastExchange(session.id);
    expect(repo.getMessageCount(session.id)).toBe(1);

    expect(repo.searchMessages('Hello').length).toBeGreaterThanOrEqual(1);

    db.prepare('INSERT INTO chat_sessions (id, agent_id, user_id, is_main, created_at, last_message_at) VALUES (?,?,NULL,0,?,?)').run(
      'legacy-session',
      'agent-1',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    expect(repo.migrateNullUserSessions('user-1')).toBe(1);

    db.prepare("UPDATE chat_sessions SET user_id = 'default' WHERE id = ?").run(session.id);
    expect(repo.migrateDefaultUserSessions('user-1')).toBeGreaterThanOrEqual(1);
    expect(repo.migrateDefaultUserSessions('default')).toBe(0);

    db.prepare(
      `INSERT INTO chat_messages (id, session_id, agent_id, role, content, tokens_used, created_at)
       VALUES ('legacy-msg', ?, 'agent-1', 'assistant', 'Plain text with <invoke name="grep">query</invoke>', 0, datetime('now'))`,
    ).run(session.id);
    expect(repo.migrateLegacyMessages()).toBeGreaterThanOrEqual(1);

    repo.deleteSession('legacy-session');
    expect(repo.getSession('legacy-session')).toBeNull();
  });

  it('FTS5: searchMessages returns results via FTS5 virtual table', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteChatSessionRepo(db);

    // insert enough data so FTS5 auto-populates via triggers
    const session = repo.createSession('agent-1', 'user-1');
    repo.appendMessage(session.id, 'agent-1', 'user', 'FTS5 full-text search test');
    repo.appendMessage(session.id, 'agent-1', 'assistant', 'This is a response about indexing');

    // FTS5 should find partial word matches
    const results = repo.searchMessages('full-text');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r: any) => String(r.content).includes('FTS5'))).toBe(true);
  });

  it('FTS5: ensureFtsIndex is idempotent', async () => {
    const db = openSqlite(':memory:');
    // Seed with agents so foreign keys are satisfied
    seedBase(db);
    // Insert a chat session + messages that triggers auto-indexing
    db.prepare(
      `INSERT INTO chat_sessions (id, agent_id, user_id, title) VALUES ('ses-fts-idem', 'agent-1', 'user-1', 'Idempotent Test')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, agent_id, role, content) VALUES ('msg-1', 'ses-fts-idem', 'agent-1', 'user', 'idempotent test message one')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, agent_id, role, content) VALUES ('msg-2', 'ses-fts-idem', 'agent-1', 'assistant', 'idempotent test message two')`
    ).run();

    // First call: should index any rows the trigger may have missed
    const countBefore = (db.prepare('SELECT COUNT(*) as cnt FROM chat_messages_fts').get() as { cnt: number }).cnt;
    ensureFtsIndex(db);
    const countAfter = (db.prepare('SELECT COUNT(*) as cnt FROM chat_messages_fts').get() as { cnt: number }).cnt;
    // Since auto-triggers already indexed the data on INSERT,
    // ensureFtsIndex should not double-count.
    expect(countAfter).toBeGreaterThanOrEqual(1);
    expect(countAfter).toBe(countBefore);

    // Second call: must not throw and must not change the count
    expect(() => ensureFtsIndex(db)).not.toThrow();
    const countAfterSecond = (db.prepare('SELECT COUNT(*) as cnt FROM chat_messages_fts').get() as { cnt: number }).cnt;
    expect(countAfterSecond).toBe(countAfter);

    closeSqlite(db);
  });

  it('FTS5: escapeFtsQuery handles special FTS5 characters', () => {
    // ASCII terms get prefix-match suffix
    expect(escapeFtsQuery('hello world')).toBe('hello* world*');
    expect(escapeFtsQuery('simple')).toBe('simple*');
    expect(escapeFtsQuery('')).toBe('');
    expect(escapeFtsQuery('  ')).toBe('');
    // CJK terms get quoted for phrase matching
    expect(escapeFtsQuery('搜索测试')).toBe('"搜索测试"');
    // Mixed CJK and ASCII
    const mixed = escapeFtsQuery('hello 测试');
    expect(mixed).toContain('hello*');
    expect(mixed).toContain('"测试"');
  });

  it('FTS5: ensureFtsIndex covers agent_activities with real data', async () => {
    const db = openSqlite(':memory:');
    seedBase(db);
    // Insert an activity that triggers FTS5 auto-indexing
    db.prepare(
      `INSERT INTO agent_activities (id, agent_id, type, label, summary, keywords, success, started_at)
       VALUES ('act-fts-1', 'agent-1', 'tool_call', 'FTS5 Test Activity',
               'This is a test activity about full-text indexing and search',
               'test,ftsearch,indexing', 1, datetime('now'))`
    ).run();

    // Verify auto-triggers populated the FTS table via insert (agent_activities_fts has rowid from agent_activities)
    const ftsCount = (db.prepare('SELECT COUNT(*) as cnt FROM agent_activities_fts').get() as { cnt: number }).cnt;
    expect(ftsCount).toBe(1);

    // ensureFtsIndex should not double-count
    ensureFtsIndex(db);
    const afterCount = (db.prepare('SELECT COUNT(*) as cnt FROM agent_activities_fts').get() as { cnt: number }).cnt;
    expect(afterCount).toBe(1);

    // Verify FTS5 can search the activity data
    const repo = new SqliteActivityRepo(db);
    const results = repo.searchActivities('agent-1', 'indexing');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.summary.includes('indexing'))).toBe(true);

    closeSqlite(db);
  });

  it('FTS5: isFtsAvailable returns true for node:sqlite', () => {
    const db = openSqlite(':memory:');
    expect(isFtsAvailable(db)).toBe(true);
    closeSqlite(db);
  });
});

describe('SqliteChannelMessageRepo', () => {
  it('append, paginate, search, and reply metadata', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteChannelMessageRepo(db);

    const first = await repo.append({
      orgId: 'org-1',
      channel: 'general',
      senderId: 'user-1',
      senderType: 'human',
      senderName: 'Alice',
      text: 'Hello channel',
      mentions: ['agent-1'],
      metadata: { pinned: false },
    });

    await repo.append({
      orgId: 'org-1',
      channel: 'general',
      senderId: 'agent-1',
      senderType: 'agent',
      senderName: 'Worker',
      text: 'Reply in channel',
      replyToId: first.id,
    });

    const page = repo.getMessages('general', 1);
    expect(page.messages).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.messages[0]?.replyToSender).toBe('Alice');

    const byId = repo.getMessageById(first.id);
    expect(byId?.text).toBe('Hello channel');
    expect(repo.getMessageById('missing')).toBeUndefined();

    expect(repo.searchMessages('Hello', 'general')).toHaveLength(1);
    expect(repo.searchMessages('Reply')).toHaveLength(1);
  });
});

describe('SqliteUserRepo', () => {
  it('CRUD, invites, hub linking, and migrations', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteUserRepo(db);

    await repo.upsert({
      id: 'user-3',
      orgId: 'org-1',
      name: 'Charlie',
      email: 'charlie@example.com',
      role: 'member',
      passwordHash: 'hash1',
    });
    await repo.upsert({
      id: 'user-3',
      orgId: 'org-1',
      name: 'Charlie Updated',
      email: 'charlie@example.com',
    });
    expect(repo.findById('user-3')?.name).toBe('Charlie Updated');

    repo.updateLastLogin('user-1');
    repo.updatePassword('user-1', 'newhash');
    repo.updateProfile('user-1', { name: 'Alice Admin', avatarUrl: 'https://example.com/a.png' });
    repo.updateAvatarUrl('user-2', null);
    repo.updateHubUserId('user-2', 'hub-123', 'bob_hub');
    expect(repo.findByHubUserId('hub-123')?.name).toBe('Bob');
    expect(repo.findByEmail('alice@example.com')?.role).toBe('admin');
    expect(repo.countByOrg('org-1')).toBe(3);

    repo.setInviteToken('user-3', 'invite-token', '2099-01-01T00:00:00Z');
    expect(repo.findByInviteToken('invite-token')?.id).toBe('user-3');
    repo.clearInviteToken('user-3');

    await repo.updateTeamId('user-2', null);
    await repo.clearTeamReferences('team-1');

    await repo.delete('user-3');
    expect(repo.findDeletedByEmail('charlie@example.com')).toBeTruthy();
    repo.reactivate('user-3', { name: 'Charlie Back', role: 'member' });
    expect(repo.findById('user-3')?.name).toBe('Charlie Back');

    repo.create({ id: 'default', orgId: 'org-1', name: 'Legacy Default' });
    expect(repo.migrateDefaultId('user-real')).toBe('user-real');
    expect(repo.findById('default')).toBeNull();

    expect(repo.updateProfile('missing', { name: 'x' })).toBeNull();
    expect(repo.listByOrg('org-1').length).toBeGreaterThanOrEqual(3);
  });
});

describe('SqliteTeamRepo', () => {
  it('create, update, find, delete', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteTeamRepo(db);

    const team = repo.create({
      id: 'team-2',
      orgId: 'org-1',
      name: 'QA',
      description: 'Quality',
      managerId: 'agent-2',
      managerType: 'agent',
    });
    expect(team.name).toBe('QA');

    repo.update('team-2', { name: 'QA Updated', description: 'New desc', managerId: null, managerType: null });
    expect(repo.findById('team-2')?.managerId).toBeNull();
    expect(repo.findByOrgId('org-1').length).toBeGreaterThanOrEqual(2);
    expect(repo.findById('missing')).toBeUndefined();

    repo.update('missing', { name: 'noop' });
    repo.delete('team-2');
    expect(repo.findById('team-2')).toBeUndefined();
  });
});

describe('Marketplace repos', () => {
  it('templates, skills, and ratings lifecycle', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const templateRepo = new SqliteMarketplaceTemplateRepo(db);
    const skillRepo = new SqliteMarketplaceSkillRepo(db);
    const ratingRepo = new SqliteMarketplaceRatingRepo(db);

    const template = templateRepo.create({
      id: 'tpl-1',
      name: 'Dev Template',
      description: 'A developer template',
      authorName: 'Alice',
      roleId: 'role-dev',
      category: 'development',
      skills: ['git'],
      tags: ['dev'],
      status: 'published',
      starterTasks: [{ title: 'Setup' }],
      config: { theme: 'dark' },
    });
    expect(template.status).toBe('published');
    expect(template.publishedAt).toBeInstanceOf(Date);

    templateRepo.update('tpl-1', { name: 'Updated Template', version: '2.0.0', icon: 'icon.png' });
    templateRepo.updateStatus('tpl-1', 'draft');
    templateRepo.incrementDownloads('tpl-1');
    templateRepo.updateRating('tpl-1', 45, 2);
    expect(templateRepo.findById('tpl-1')?.downloadCount).toBe(1);
    expect(templateRepo.list({ source: 'community', category: 'development' })).toHaveLength(1);
    expect(templateRepo.search('Dev', { category: 'development' })).toHaveLength(1);
    expect(templateRepo.countBySource()).toEqual({ community: 1 });

    const skill = skillRepo.create({
      id: 'skill-1',
      name: 'Git Skill',
      description: 'Git operations',
      authorName: 'Alice',
      category: 'vcs',
      tools: [{ name: 'git' }],
      readme: '# Git',
      requiredPermissions: ['read'],
      requiredEnv: ['GIT_TOKEN'],
      status: 'published',
    });
    expect(skill.status).toBe('published');
    skillRepo.updateStatus('skill-1', 'archived');
    skillRepo.incrementDownloads('skill-1');
    skillRepo.updateRating('skill-1', 50, 1);
    expect(skillRepo.list({ category: 'vcs' })).toHaveLength(1);
    expect(skillRepo.search('Git')).toHaveLength(1);

    const rating = ratingRepo.create({
      id: 'rate-1',
      targetType: 'template',
      targetId: 'tpl-1',
      userId: 'user-1',
      rating: 5,
      review: 'Great template',
    });
    expect(rating?.rating).toBe(5);
    ratingRepo.update('rate-1', { rating: 4, review: 'Good' });
    expect(ratingRepo.findByTarget('template', 'tpl-1')).toHaveLength(1);
    expect(ratingRepo.findByUser('user-1', 'template')).toHaveLength(1);
    expect(ratingRepo.findByUser('user-1')).toHaveLength(1);
    expect(ratingRepo.findUserRating('user-1', 'template', 'tpl-1')?.rating).toBe(4);
    expect(ratingRepo.getAggregation('template', 'tpl-1')).toEqual({ avg: 4, count: 1 });

    ratingRepo.update('missing', { rating: 1 });
    ratingRepo.delete('rate-1');
    expect(ratingRepo.findByTarget('template', 'tpl-1')).toHaveLength(0);

    templateRepo.delete('tpl-1');
    skillRepo.delete('skill-1');
  });
});

describe('SqliteAgentKnowledgeRepo', () => {
  it('CRUD, search, tags, and access tracking', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteAgentKnowledgeRepo(db);

    const entry = repo.create({
      id: 'know-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      category: 'patterns',
      title: 'Error handling',
      content: 'Always catch errors at boundaries',
      tags: ['errors', 'best-practice'],
      metadata: { source: 'docs' },
      importance: 80,
    });
    expect(entry.importance).toBe(80);

    expect(repo.findByAgent('agent-1', { category: 'patterns' })).toHaveLength(1);
    expect(repo.search('agent-1', 'boundaries')).toHaveLength(1);

    repo.update('know-1', { title: 'Updated', content: 'New content', tags: ['errors'], importance: 90 });
    repo.recordAccess('know-1');
    expect(repo.findById('know-1')?.accessCount).toBe(1);
    expect(repo.searchByTags('agent-1', ['errors'])).toHaveLength(1);
    expect(repo.searchByTags('agent-1', [])).toEqual([]);
    expect(repo.countByAgent('agent-1')).toBe(1);

    repo.delete('know-1');
    expect(repo.findById('know-1')).toBeUndefined();
    repo.create({ id: 'know-2', agentId: 'agent-1', orgId: 'org-1', category: 'x', title: 't', content: 'c' });
    repo.deleteByAgent('agent-1');
    expect(repo.countByAgent('agent-1')).toBe(0);
  });
});

describe('SqliteExternalAgentRepo', () => {
  it('save, update, load, delete', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteExternalAgentRepo(db);

    await repo.save({
      externalAgentId: 'ext-1',
      agentName: 'External Bot',
      orgId: 'org-1',
      capabilities: ['chat', 'search'],
      platform: 'slack',
      platformConfig: '{}',
      connected: false,
      registeredAt: new Date().toISOString(),
      markusAgentId: 'agent-1',
    });

    let all = await repo.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.capabilities).toEqual(['chat', 'search']);

    await repo.update('ext-1', 'org-1', { connected: true, lastHeartbeat: '2026-06-01T00:00:00Z' });
    all = await repo.loadAll();
    expect(all[0]?.connected).toBe(true);

    const deleted = await repo.delete('ext-1', 'org-1');
    expect(deleted).toBe(true);
    expect(await repo.delete('missing', 'org-1')).toBe(false);
    expect(await repo.loadAll()).toHaveLength(0);
  });
});

describe('SqliteDeliverableRepo', () => {
  it('create, search, update, access, remove, list', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteDeliverableRepo(db);

    const d = await repo.create({
      id: 'del-1',
      type: 'file',
      title: 'Report',
      summary: 'Monthly report',
      reference: '/files/report.pdf',
      format: 'pdf',
      tags: ['report'],
      taskId: 'task-1',
      agentId: 'agent-1',
      projectId: 'proj-1',
      diffStats: { additions: 10 },
      testResults: { passed: 5 },
      artifactType: 'document',
      artifactData: { pages: 3 },
    });
    expect(d?.title).toBe('Report');

    await repo.recordAccess('del-1');
    const found = await repo.findById('del-1');
    expect(found?.accessCount).toBe(1);

    expect((await repo.search({ query: 'Report', projectId: 'proj-1', agentId: 'agent-1' })).length).toBe(1);
    expect((await repo.search({ type: 'file', status: 'active' })).length).toBe(1);
    expect((await repo.listAll())).toHaveLength(1);
    expect((await repo.listTaskIdsWithDeliverables()).has('task-1')).toBe(true);

    await repo.update('del-1', { title: 'Updated Report', status: 'review', tags: ['updated'] });
    await repo.remove('del-1');
    expect((await repo.listAll())).toHaveLength(0);

    await repo.create({ id: 'del-2', type: 'file', title: 'Temp', summary: 's', taskId: 'task-2' });
    await repo.deleteByTask('task-2');
    expect(await repo.findById('del-2')).toBeNull();
  });
});

describe('SqliteActivityRepo', () => {
  it('insert, update, query, search, and batch lookup', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteActivityRepo(db);

    repo.insertActivity({
      id: 'act-1',
      agentId: 'agent-1',
      type: 'task',
      label: 'Build feature',
      taskId: 'task-1',
      mailboxItemId: 'mb-1',
      startedAt: '2026-06-01T10:00:00Z',
    });
    repo.updateActivity('act-1', {
      endedAt: '2026-06-01T11:00:00Z',
      totalTokens: 1000,
      totalTools: 5,
      success: true,
      summary: 'Completed build successfully',
      keywords: 'build feature deploy',
    });
    repo.insertActivityLog({ activityId: 'act-1', seq: 0, type: 'log', content: 'Started', metadata: { step: 1 } });

    expect(repo.getActivity('act-1')?.summary).toBe('Completed build successfully');
    expect(repo.getActivityLogs('act-1')).toHaveLength(1);
    expect(repo.getByMailboxItemId('mb-1')?.id).toBe('act-1');

    const batch = repo.getByMailboxItemIds(['mb-1', 'mb-missing']);
    expect(batch.get('mb-1')?.id).toBe('act-1');
    expect(repo.getByMailboxItemIds([]).size).toBe(0);

    expect(repo.queryActivities('agent-1', { type: 'task', taskId: 'task-1' })).toHaveLength(1);
    expect(repo.queryActivities('agent-1', { before: '2026-06-02T00:00:00Z', limit: 5 })).toHaveLength(1);
    expect(repo.searchActivities('agent-1', 'build feature')).toHaveLength(1);
    expect(repo.searchActivities('agent-1', 'a')).toEqual([]);

    repo.updateActivity('missing', { summary: 'noop' });
  });
});

describe('SqliteExecutionStreamRepo', () => {
  it('append, query, max seq, delete', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteExecutionStreamRepo(db);

    expect(repo.getMaxSeq('task', 'task-1')).toBe(-1);

    repo.append({
      sourceType: 'task',
      sourceId: 'task-1',
      agentId: 'agent-1',
      seq: 0,
      type: 'status',
      content: 'started',
      metadata: { round: 1 },
      executionRound: 1,
    });
    repo.append({
      sourceType: 'task',
      sourceId: 'task-1',
      agentId: 'agent-1',
      seq: 1,
      type: 'tool_end',
      content: 'done',
    });

    expect(repo.getMaxSeq('task', 'task-1')).toBe(1);
    expect(repo.getBySource('task', 'task-1')).toHaveLength(2);

    repo.deleteBySource('task', 'task-1');
    expect(repo.getBySource('task', 'task-1')).toHaveLength(0);
  });
});

describe('SqliteMailboxRepo and SqliteDecisionRepo', () => {
  it('mailbox lifecycle and decisions', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const mailbox = new SqliteMailboxRepo(db);
    const decisions = new SqliteDecisionRepo(db);

    mailbox.save({
      id: 'mb-1',
      agentId: 'agent-1',
      sourceType: 'task',
      priority: 1,
      status: 'queued',
      payload: { taskId: 'task-1' },
      metadata: { trace: 'abc' },
      queuedAt: new Date().toISOString(),
    });

    mailbox.updateStatus('mb-1', 'processing', {
      startedAt: new Date().toISOString(),
      retryCount: 1,
    });
    mailbox.updateStatus('mb-1', 'completed', { completedAt: new Date().toISOString() });

    mailbox.save({
      id: 'mb-2',
      agentId: 'agent-1',
      sourceType: 'chat',
      priority: 2,
      status: 'processing',
      payload: {},
      queuedAt: new Date().toISOString(),
    });
    expect(mailbox.markStaleProcessingAsDropped('agent-1')).toBe(1);

    mailbox.save({
      id: 'mb-3',
      agentId: 'agent-1',
      sourceType: 'heartbeat',
      priority: 3,
      status: 'processing',
      payload: {},
      queuedAt: new Date().toISOString(),
    });
    expect(mailbox.markStaleProcessingAsCompleted('agent-1')).toBe(1);

    expect(mailbox.getById('mb-1')?.status).toBe('completed');
    expect(mailbox.getByAgent('agent-1', { status: 'completed' }).length).toBeGreaterThanOrEqual(1);
    expect(mailbox.getStatusCounts('agent-1')['completed']).toBeGreaterThanOrEqual(1);
    expect(mailbox.getSourceTypeCounts('agent-1')['task']).toBe(1);
    expect(mailbox.getHistory('agent-1', { sourceTypes: ['task'], limit: 10 }).length).toBeGreaterThanOrEqual(1);

    decisions.save({
      id: 'dec-1',
      agentId: 'agent-1',
      decisionType: 'route',
      mailboxItemId: 'mb-1',
      context: { reason: 'priority' },
      reasoning: 'High priority task',
      outcome: 'accepted',
      createdAt: new Date().toISOString(),
    });
    expect(decisions.getByAgent('agent-1')).toHaveLength(1);
    expect(decisions.getByMailboxItemId('mb-1')).toHaveLength(1);
    const batch = decisions.getByMailboxItemIds(['mb-1']);
    expect(batch.get('mb-1')).toHaveLength(1);
    expect(decisions.getByMailboxItemIds([]).size).toBe(0);
  });
});

describe('SqliteNotificationRepo and SqliteApprovalRepo', () => {
  it('notifications and approvals with migrations', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const notifications = new SqliteNotificationRepo(db);
    const approvals = new SqliteApprovalRepo(db);

    notifications.insert({
      id: 'notif-1',
      userId: 'user-1',
      type: 'task',
      title: 'Task done',
      body: 'Your task completed',
      priority: 'normal',
      read: false,
      actionType: 'link',
      actionTarget: '/tasks/1',
      metadata: { taskId: 'task-1' },
      createdAt: new Date().toISOString(),
    });
    notifications.insert({
      id: 'notif-all',
      userId: 'all',
      type: 'system',
      title: 'Broadcast',
      body: 'Hello everyone',
      priority: 'low',
      read: false,
      actionType: 'none',
      actionTarget: null,
      metadata: null,
      createdAt: new Date().toISOString(),
    });

    expect(notifications.list('user-1')).toHaveLength(2);
    expect(notifications.list('user-1', { unreadOnly: true, type: 'task' })).toHaveLength(1);
    expect(notifications.count('user-1', true)).toBe(2);
    expect(notifications.markRead('notif-1')).toBe(true);
    expect(notifications.markAllRead('user-1')).toBeGreaterThanOrEqual(0);

    db.prepare("UPDATE user_notifications SET user_id = 'default' WHERE id = 'notif-1'").run();
    expect(notifications.migrateDefaultUserId('user-1')).toBe(1);
    expect(notifications.migrateDefaultUserId('default')).toBe(0);

    approvals.upsert({
      id: 'appr-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      type: 'deploy',
      title: 'Deploy to prod?',
      description: 'Ready for production',
      details: { env: 'prod' },
      status: 'pending',
      requestedAt: new Date().toISOString(),
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      allowFreeform: true,
      approverUserIds: ['user-1'],
      targetUserId: 'default',
    });
    expect(approvals.list('pending')).toHaveLength(1);
    expect(approvals.get('appr-1')?.allowFreeform).toBe(true);

    approvals.upsert({
      id: 'appr-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      type: 'deploy',
      title: 'Deploy to prod?',
      description: 'Ready',
      details: {},
      status: 'approved',
      requestedAt: new Date().toISOString(),
      respondedAt: new Date().toISOString(),
      respondedBy: 'user-1',
      selectedOption: 'yes',
    });
    expect(approvals.get('appr-1')?.status).toBe('approved');
    expect(approvals.migrateDefaultTargetUserId('user-1')).toBeGreaterThanOrEqual(0);
  });
});

describe('SqliteGroupChatRepo', () => {
  it('create, members, list, update, delete', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteGroupChatRepo(db);

    const gc = repo.create({
      orgId: 'org-1',
      name: 'Project Chat',
      creatorId: 'user-1',
      creatorName: 'Alice',
      members: [
        { id: 'user-1', type: 'human', name: 'Alice' },
        { id: 'agent-1', type: 'agent', name: 'Worker' },
      ],
    });
    expect(gc.members).toHaveLength(2);

    repo.addMember(gc.id, 'user-2', 'human', 'Bob');
    repo.removeMember(gc.id, 'user-2');
    repo.updateName(gc.id, 'Renamed Chat');

    expect(repo.list('org-1')).toHaveLength(1);
    expect(repo.listByMember('org-1', 'user-1')).toHaveLength(1);
    expect(repo.getById(gc.id)?.name).toBe('Renamed Chat');
    expect(repo.getByChannelKey(gc.channelKey)?.members.length).toBe(2);
    expect(repo.getAgentMemberIds(gc.channelKey)).toEqual(['agent-1']);
    expect(repo.getHumanMemberIds(gc.channelKey)).toEqual(['user-1']);
    expect(repo.getMembers(gc.id)).toHaveLength(2);
    expect(repo.getAgentMemberIds('missing')).toEqual([]);

    repo.delete(gc.id);
    expect(repo.getById(gc.id)).toBeUndefined();
  });
});

describe('SqliteStatusTransitionRepo', () => {
  it('records and retrieves transitions', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteStatusTransitionRepo(db);

    repo.record({
      entityType: 'task',
      entityId: 'task-1',
      fromStatus: 'pending',
      toStatus: 'in_progress',
      changedById: 'user-1',
      changedByType: 'human',
      changedByName: 'Alice',
      reason: 'Started work',
    });
    const rows = repo.getByEntity('task', 'task-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toStatus).toBe('in_progress');
  });
});

describe('SqliteIntegrationRepo', () => {
  it('create, list, update, delete', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const repo = new SqliteIntegrationRepo(db);

    const integration = await repo.create({
      orgId: 'org-1',
      platform: 'slack',
      displayName: 'Slack Workspace',
      enabled: true,
      config: { token: 'x' },
      forwardRules: [{ channel: '#general' }],
      lastVerifiedAt: '2026-06-01T00:00:00Z',
    });
    expect(integration.enabled).toBe(true);

    await repo.update(integration.id, {
      displayName: 'Slack Updated',
      enabled: false,
      lastError: 'Token expired',
      platform: 'slack',
    });
    expect(repo.findById(integration.id)?.enabled).toBe(false);
    expect(repo.listByOrg('org-1')).toHaveLength(1);
    expect(repo.listByPlatform('org-1', 'slack')).toHaveLength(1);

    await repo.update(integration.id, {});
    await repo.delete(integration.id);
    expect(repo.findById(integration.id)).toBeUndefined();
  });
});

describe('SqliteReadCursorRepo', () => {
  it('read cursors, unread counts, mark all read', () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const chatRepo = new SqliteChatSessionRepo(db);
    const channelRepo = new SqliteChannelMessageRepo(db);
    const groupRepo = new SqliteGroupChatRepo(db);
    const cursorRepo = new SqliteReadCursorRepo(db);

    const session = chatRepo.createSession('agent-1', 'user-1');
    chatRepo.appendMessage(session.id, 'agent-1', 'user', 'Unread message');

    const gc = groupRepo.create({
      orgId: 'org-1',
      name: 'Team',
      creatorId: 'user-1',
      creatorName: 'Alice',
      members: [{ id: 'user-1', type: 'human', name: 'Alice' }],
    });

    cursorRepo.setReadCursor('user-1', `session:${session.id}`, '2000-01-01T00:00:00Z');
    cursorRepo.setReadCursor('user-1', `channel:${gc.channelKey}`, '2000-01-01T00:00:00Z', 'msg-old');

    const unread = cursorRepo.getUnreadCounts('user-1');
    expect(unread[`session:${session.id}`]).toBeGreaterThanOrEqual(1);

    expect(cursorRepo.getReadCursors('user-1').length).toBeGreaterThanOrEqual(2);
    expect(cursorRepo.getSessionAgentMap()[session.id]).toBe('agent-1');

    cursorRepo.markAllRead('user-1');
    expect(cursorRepo.getReadCursors('user-1').length).toBeGreaterThanOrEqual(2);

    void channelRepo;
  });
});

describe('Workflow repos', () => {
  it('workflow runs and schedules', async () => {
    const db = openSqlite(dbPath);
    seedBase(db);
    const runRepo = new SqliteWorkflowRunRepo(db);
    const scheduleRepo = new SqliteWorkflowScheduleRepo(db);

    expect(await runRepo.getNextRunNumber('team-1', 'deploy')).toBe(1);

    await runRepo.create({
      id: 'run-1',
      team_id: 'team-1',
      workflow_name: 'deploy',
      run_number: 1,
      requirement_id: 'req-1',
      task_ids: '["task-1"]',
      params: '{}',
      role_mapping: '{}',
      status: 'running',
      triggered_by: 'manual',
      project_id: 'proj-1',
      started_at: new Date().toISOString(),
      completed_at: null,
    });

    expect(await runRepo.findById('run-1')).toBeTruthy();
    expect(await runRepo.findByTeamAndWorkflow('team-1', 'deploy')).toHaveLength(1);
    expect(await runRepo.findByRequirementId('req-1')).toBeTruthy();
    expect(await runRepo.findRunning('team-1', 'deploy')).toHaveLength(1);
    expect(await runRepo.findAllRunning()).toHaveLength(1);

    await runRepo.updateStatus('run-1', 'completed', new Date().toISOString());
    expect((await runRepo.findById('run-1'))?.status).toBe('completed');

    await runRepo.updateStatus('run-1', 'failed');
    expect((await runRepo.findById('run-1'))?.status).toBe('failed');

    await scheduleRepo.upsert({
      team_id: 'team-1',
      workflow_name: 'deploy',
      schedule: '{"cron":"0 9 * * *"}',
      next_run_at: '2026-06-17T09:00:00Z',
      total_runs: 1,
      last_run_at: '2026-06-16T09:00:00Z',
      paused: 0,
      last_role_mapping: '{}',
      updated_at: new Date().toISOString(),
    });
    expect(await scheduleRepo.findAll()).toHaveLength(1);
    expect(await scheduleRepo.findByTeam('team-1')).toHaveLength(1);

    await scheduleRepo.upsert({
      team_id: 'team-1',
      workflow_name: 'deploy',
      schedule: '{"cron":"0 10 * * *"}',
      next_run_at: null,
      total_runs: 2,
      last_run_at: null,
      paused: 1,
      last_role_mapping: '{"dev":"agent-1"}',
      updated_at: new Date().toISOString(),
    });
    expect((await scheduleRepo.findByTeam('team-1'))[0]?.paused).toBe(1);

    await scheduleRepo.remove('team-1', 'deploy');
    expect(await scheduleRepo.findAll()).toHaveLength(0);
  });
});
