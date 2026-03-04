import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openSqlite,
  closeSqlite,
  SqliteOrgRepo,
  SqliteAgentRepo,
  SqliteTaskRepo,
  SqliteTaskLogRepo,
  SqliteUserRepo,
  SqliteTeamRepo,
  SqliteChatSessionRepo,
  SqliteChannelMessageRepo,
  SqliteMemoryRepo,
  SqliteMessageRepo,
  SqliteMarketplaceTemplateRepo,
  SqliteMarketplaceSkillRepo,
  SqliteMarketplaceRatingRepo,
  SqliteAgentKnowledgeRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-sqlite-test-'));
  db = openSqlite(join(tempDir, 'test.db'));
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SQLite Storage Backend', () => {
  describe('OrgRepo', () => {
    it('should create and find an organization', () => {
      const repo = new SqliteOrgRepo(db);
      repo.createOrg({ id: 'org-1', name: 'Test Org', ownerId: 'user-1' });
      const found = repo.findOrgById('org-1');
      expect(found).toBeDefined();
      expect(found!.name).toBe('Test Org');
    });

    it('should list organizations', () => {
      const repo = new SqliteOrgRepo(db);
      repo.createOrg({ id: 'org-1', name: 'Org 1', ownerId: 'u1' });
      repo.createOrg({ id: 'org-2', name: 'Org 2', ownerId: 'u2' });
      const list = repo.listOrgs();
      expect(list.length).toBe(2);
    });
  });

  describe('AgentRepo', () => {
    it('should CRUD agents', () => {
      const orgRepo = new SqliteOrgRepo(db);
      orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });

      const repo = new SqliteAgentRepo(db);
      const created = repo.create({
        id: 'agent-1',
        name: 'Dev Agent',
        orgId: 'org-1',
        roleId: 'role-dev',
        roleName: 'Developer',
        skills: ['coding', 'testing'],
      });
      expect(created.name).toBe('Dev Agent');
      expect(created.skills).toEqual(['coding', 'testing']);

      repo.updateStatus('agent-1', 'working');
      const updated = repo.findById('agent-1');
      expect(updated!.status).toBe('working');

      const byOrg = repo.findByOrgId('org-1');
      expect(byOrg.length).toBe(1);

      repo.delete('agent-1');
      expect(repo.findById('agent-1')).toBeUndefined();
    });
  });

  describe('TaskRepo', () => {
    it('should create, update, and query tasks', () => {
      const orgRepo = new SqliteOrgRepo(db);
      orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });

      const repo = new SqliteTaskRepo(db);
      repo.create({ id: 'task-1', orgId: 'org-1', title: 'Build feature', priority: 'high' });
      repo.updateStatus('task-1', 'in_progress');

      const task = repo.findById('task-1');
      expect(task!.status).toBe('in_progress');
      expect(task!.priority).toBe('high');

      const list = repo.listByOrg('org-1', { status: 'in_progress' });
      expect(list.length).toBe(1);
    });
  });

  describe('UserRepo', () => {
    it('should create, find by email, and upsert users', () => {
      const orgRepo = new SqliteOrgRepo(db);
      orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });

      const repo = new SqliteUserRepo(db);
      repo.create({
        id: 'u1',
        orgId: 'org-1',
        name: 'Alice',
        email: 'alice@test.com',
        role: 'admin',
      });

      const found = repo.findByEmail('alice@test.com');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Alice');

      repo.upsert({ id: 'u1', orgId: 'org-1', name: 'Alice Updated', email: 'alice@test.com' });
      const updated = repo.findById('u1');
      expect(updated!.name).toBe('Alice Updated');

      expect(repo.countByOrg('org-1')).toBe(1);
    });
  });

  describe('ChatSessionRepo', () => {
    it('should manage chat sessions and messages', () => {
      const orgRepo = new SqliteOrgRepo(db);
      orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });
      const agentRepo = new SqliteAgentRepo(db);
      agentRepo.create({ id: 'a1', name: 'Agent', orgId: 'org-1', roleId: 'r1', roleName: 'Dev' });

      const repo = new SqliteChatSessionRepo(db);
      const session = repo.createSession('a1', 'u1');
      expect(session.agentId).toBe('a1');

      repo.appendMessage(session.id, 'a1', 'user', 'Hello!');
      repo.appendMessage(session.id, 'a1', 'assistant', 'Hi there!');

      const { messages, hasMore } = repo.getMessages(session.id);
      expect(messages.length).toBe(2);
      expect(hasMore).toBe(false);
      expect(messages[0]!.content).toBe('Hello!');

      expect(repo.getMessageCount(session.id)).toBe(2);

      const sessions = repo.getSessionsByAgent('a1');
      expect(sessions.length).toBe(1);
    });
  });

  describe('ChannelMessageRepo', () => {
    it('should append and retrieve channel messages', () => {
      const repo = new SqliteChannelMessageRepo(db);
      repo.append({
        orgId: 'org-1',
        channel: '#general',
        senderId: 'u1',
        senderType: 'human',
        senderName: 'Alice',
        text: 'Hello team!',
      });
      repo.append({
        orgId: 'org-1',
        channel: '#general',
        senderId: 'a1',
        senderType: 'agent',
        senderName: 'Bot',
        text: 'Hi Alice!',
      });

      const { messages } = repo.getMessages('#general');
      expect(messages.length).toBe(2);
    });
  });

  describe('MarketplaceTemplateRepo', () => {
    it('should create, list, and search templates', () => {
      const repo = new SqliteMarketplaceTemplateRepo(db);
      repo.create({
        id: 'tpl-1',
        name: 'My Template',
        description: 'A test template',
        authorName: 'Alice',
        roleId: 'dev',
        category: 'development',
        tags: ['coding', 'ai'],
        source: 'community',
        status: 'published',
      });

      const list = repo.list({ status: 'published' });
      expect(list.length).toBe(1);
      expect(list[0]!.tags).toEqual(['coding', 'ai']);

      const results = repo.search('template');
      expect(results.length).toBe(1);

      repo.incrementDownloads('tpl-1');
      const updated = repo.findById('tpl-1');
      expect(updated!.downloadCount).toBe(1);
    });
  });

  describe('AgentKnowledgeRepo', () => {
    it('should CRUD knowledge entries and search by tags', () => {
      const orgRepo = new SqliteOrgRepo(db);
      orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });
      const agentRepo = new SqliteAgentRepo(db);
      agentRepo.create({ id: 'a1', name: 'Agent', orgId: 'org-1', roleId: 'r1', roleName: 'Dev' });

      const repo = new SqliteAgentKnowledgeRepo(db);
      repo.create({
        id: 'k1',
        agentId: 'a1',
        orgId: 'org-1',
        category: 'code',
        title: 'TypeScript patterns',
        content: 'Use generics for type safety',
        tags: ['typescript', 'patterns'],
        importance: 80,
      });

      const found = repo.search('a1', 'TypeScript');
      expect(found.length).toBe(1);

      const byTags = repo.searchByTags('a1', ['typescript']);
      expect(byTags.length).toBe(1);

      expect(repo.countByAgent('a1')).toBe(1);

      repo.recordAccess('k1');
      const k = repo.findById('k1');
      expect(k!.accessCount).toBe(1);
    });
  });

  describe('TaskLogRepo', () => {
    it('should append and retrieve task logs', () => {
      const orgRepo = new SqliteOrgRepo(db);
      orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });
      const taskRepo = new SqliteTaskRepo(db);
      taskRepo.create({ id: 't1', orgId: 'org-1', title: 'Task' });

      const repo = new SqliteTaskLogRepo(db);
      repo.append({ taskId: 't1', agentId: 'a1', seq: 0, type: 'status', content: 'started' });
      repo.append({ taskId: 't1', agentId: 'a1', seq: 1, type: 'text', content: 'working on it' });

      const logs = repo.getByTask('t1');
      expect(logs.length).toBe(2);
      expect(logs[0]!.type).toBe('status');
      expect(logs[1]!.seq).toBe(1);
    });
  });

  describe('TeamRepo', () => {
    it('should create and manage teams', () => {
      const orgRepo = new SqliteOrgRepo(db);
      orgRepo.createOrg({ id: 'org-1', name: 'Org', ownerId: 'u1' });

      const repo = new SqliteTeamRepo(db);
      repo.create({
        id: 'team-1',
        orgId: 'org-1',
        name: 'Backend Team',
        description: 'Handles backend',
      });

      const team = repo.findById('team-1');
      expect(team!.name).toBe('Backend Team');

      repo.update('team-1', { name: 'Core Team' });
      expect(repo.findById('team-1')!.name).toBe('Core Team');

      const teams = repo.findByOrgId('org-1');
      expect(teams.length).toBe(1);

      repo.delete('team-1');
      expect(repo.findById('team-1')).toBeUndefined();
    });
  });

  describe('MarketplaceRatingRepo', () => {
    it('should handle ratings and aggregation', () => {
      const repo = new SqliteMarketplaceRatingRepo(db);
      repo.create({
        id: 'r1',
        targetType: 'template',
        targetId: 'tpl-1',
        userId: 'u1',
        rating: 5,
        review: 'Great!',
      });
      repo.create({ id: 'r2', targetType: 'template', targetId: 'tpl-1', userId: 'u2', rating: 3 });

      const agg = repo.getAggregation('template', 'tpl-1');
      expect(agg.count).toBe(2);
      expect(agg.avg).toBe(4); // Math.round((5+3)/2) = 4

      const userRating = repo.findUserRating('u1', 'template', 'tpl-1');
      expect(userRating).toBeDefined();
      expect(userRating!.rating).toBe(5);
    });
  });
});
