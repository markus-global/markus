/**
 * SQLite storage backend — zero-dependency alternative to PostgreSQL.
 *
 * When no DATABASE_URL is configured, Markus uses this lightweight SQLite
 * implementation so users can run locally without Docker or external databases.
 *
 * Implements the same repo interfaces as the PostgreSQL Drizzle-based repos
 * so the rest of the application is completely unaware of the storage backend.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '@markus/shared';

type SqlParams = SQLInputValue[];

const log = createLogger('sqlite-storage');

function generateId(prefix = ''): string {
  const uuid = randomUUID().replace(/-/g, '').slice(0, 16);
  return prefix ? `${prefix}_${uuid}` : uuid;
}

function now(): string {
  return new Date().toISOString();
}
function toJson(v: unknown): string {
  return JSON.stringify(v ?? null);
}
function fromJson<T = unknown>(v: string | null): T {
  return v ? (JSON.parse(v) as T) : (null as T);
}
function toDate(v: string | null): Date | null {
  return v ? new Date(v) : null;
}

// ─── Schema creation ─────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  max_agents INTEGER NOT NULL DEFAULT 5,
  manager_agent_id TEXT,
  settings TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  lead_agent_id TEXT,
  manager_id TEXT,
  manager_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  team_id TEXT REFERENCES teams(id),
  role_id TEXT NOT NULL,
  role_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  skills TEXT DEFAULT '[]',
  llm_config TEXT DEFAULT '{}',
  compute_config TEXT DEFAULT '{}',
  channels TEXT DEFAULT '[]',
  agent_role TEXT NOT NULL DEFAULT 'worker',
  heartbeat_interval_ms INTEGER NOT NULL DEFAULT 1800000,
  container_id TEXT,
  tokens_used_today INTEGER NOT NULL DEFAULT 0,
  active_task_ids TEXT DEFAULT '[]',
  profile TEXT,
  last_heartbeat TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'medium',
  execution_mode TEXT,
  assigned_agent_id TEXT NOT NULL REFERENCES agents(id),
  reviewer_agent_id TEXT NOT NULL,
  execution_round INTEGER NOT NULL DEFAULT 1,
  subtasks TEXT DEFAULT '[]',
  requirement_id TEXT,
  blocked_by TEXT DEFAULT '[]',
  result TEXT,
  deliverables TEXT,
  notes TEXT DEFAULT '[]',
  project_id TEXT,
  created_by TEXT,
  updated_by TEXT,
  started_at TEXT,
  completed_at TEXT,
  task_type TEXT NOT NULL DEFAULT 'standard',
  schedule_config TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  direction TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  agent_id TEXT REFERENCES agents(id),
  content TEXT NOT NULL,
  reply_to_id TEXT,
  thread_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT,
  title TEXT,
  is_main INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent ON chat_sessions(agent_id, last_message_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS channel_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  text TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  reply_to_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel, created_at);

CREATE TABLE IF NOT EXISTS task_logs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT DEFAULT '{}',
  execution_round INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, seq);

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_type TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT DEFAULT '[]',
  mentions TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);

CREATE TABLE IF NOT EXISTS requirement_comments (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_type TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT DEFAULT '[]',
  mentions TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requirement_comments_req ON requirement_comments(requirement_id, created_at);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'medium',
  source TEXT NOT NULL DEFAULT 'user',
  created_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  rejected_reason TEXT,
  rejected_by TEXT,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requirements_org ON requirements(org_id);
CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(project_id);
CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  repositories TEXT DEFAULT '[]',
  team_ids TEXT DEFAULT '[]',
  governance_policy TEXT,
  archive_policy TEXT,
  report_schedule TEXT,
  onboarding_config TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

CREATE TABLE IF NOT EXISTS agent_knowledge (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'agent',
  metadata TEXT DEFAULT '{}',
  importance INTEGER NOT NULL DEFAULT 50,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_agent ON agent_knowledge(agent_id, category);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_org ON agent_knowledge(org_id);

CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'file',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  task_id TEXT,
  agent_id TEXT,
  project_id TEXT,
  requirement_id TEXT,
  diff_stats TEXT,
  test_results TEXT,
  artifact_type TEXT,
  artifact_data TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_agent ON deliverables(agent_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_task ON deliverables(task_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_status ON deliverables(status);

CREATE TABLE IF NOT EXISTS marketplace_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'community',
  status TEXT NOT NULL DEFAULT 'draft',
  version TEXT NOT NULL DEFAULT '1.0.0',
  author_id TEXT,
  author_name TEXT NOT NULL,
  role_id TEXT NOT NULL,
  agent_role TEXT NOT NULL DEFAULT 'worker',
  skills TEXT NOT NULL DEFAULT '[]',
  llm_provider TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL,
  icon TEXT,
  heartbeat_interval_ms INTEGER,
  starter_tasks TEXT DEFAULT '[]',
  config TEXT DEFAULT '{}',
  download_count INTEGER NOT NULL DEFAULT 0,
  avg_rating INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public',
  forked_from TEXT,
  fork_count INTEGER DEFAULT 0,
  version_history TEXT DEFAULT '[]',
  org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mkt_templates_source ON marketplace_templates(source, status);
CREATE INDEX IF NOT EXISTS idx_mkt_templates_category ON marketplace_templates(category);

CREATE TABLE IF NOT EXISTS marketplace_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'community',
  status TEXT NOT NULL DEFAULT 'draft',
  version TEXT NOT NULL DEFAULT '1.0.0',
  author_id TEXT,
  author_name TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  tools TEXT NOT NULL DEFAULT '[]',
  readme TEXT,
  required_permissions TEXT DEFAULT '[]',
  required_env TEXT DEFAULT '[]',
  config TEXT DEFAULT '{}',
  download_count INTEGER NOT NULL DEFAULT 0,
  avg_rating INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public',
  forked_from TEXT,
  fork_count INTEGER DEFAULT 0,
  version_history TEXT DEFAULT '[]',
  org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mkt_skills_source ON marketplace_skills(source, status);
CREATE INDEX IF NOT EXISTS idx_mkt_skills_category ON marketplace_skills(category);

CREATE TABLE IF NOT EXISTS marketplace_ratings (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  review TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_ratings_target ON marketplace_ratings(target_type, target_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'member',
  team_id TEXT,
  password_hash TEXT,
  invite_token TEXT,
  invite_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  embedding BLOB,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_agent ON memory_embeddings(agent_id);

CREATE TABLE IF NOT EXISTS external_agent_registrations (
  external_agent_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  markus_agent_id TEXT,
  capabilities TEXT DEFAULT '[]',
  platform TEXT,
  platform_config TEXT,
  agent_card_url TEXT,
  openclaw_config TEXT,
  connected INTEGER NOT NULL DEFAULT 0,
  last_heartbeat TEXT,
  registered_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (external_agent_id, org_id)
);

CREATE TABLE IF NOT EXISTS gateway_message_queue (
  id TEXT PRIMARY KEY,
  target_agent_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  from_agent_name TEXT,
  content TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gw_msg_target ON gateway_message_queue(target_agent_id, delivered);

CREATE TABLE IF NOT EXISTS agent_activities (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mailbox_item_id TEXT,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  task_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  total_tokens INTEGER DEFAULT 0,
  total_tools INTEGER DEFAULT 0,
  success INTEGER DEFAULT 1,
  summary TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_activities_agent ON agent_activities(agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id TEXT NOT NULL REFERENCES agent_activities(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_activity ON agent_activity_logs(activity_id, seq);

CREATE TABLE IF NOT EXISTS execution_stream_logs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT DEFAULT '{}',
  execution_round INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exec_stream_source ON execution_stream_logs(source_type, source_id, seq);

CREATE TABLE IF NOT EXISTS mailbox_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  deferred_until TEXT,
  merged_into TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mailbox_agent_status ON mailbox_items(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_mailbox_agent_queued ON mailbox_items(agent_id, priority, queued_at);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  mailbox_item_id TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',
  reasoning TEXT NOT NULL DEFAULT '',
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_agent ON agent_decisions(agent_id, created_at);

CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  read INTEGER NOT NULL DEFAULT 0,
  action_type TEXT NOT NULL DEFAULT 'none',
  action_target TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, read, created_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  responded_by TEXT,
  response_comment TEXT,
  expires_at TEXT,
  options TEXT,
  allow_freeform INTEGER NOT NULL DEFAULT 0,
  selected_option TEXT,
  approver_user_ids TEXT,
  target_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at DESC);

CREATE TABLE IF NOT EXISTS group_chats (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  channel_key TEXT NOT NULL UNIQUE,
  creator_id TEXT NOT NULL,
  creator_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_chat_members (
  group_chat_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  member_type TEXT NOT NULL CHECK(member_type IN ('human', 'agent')),
  member_name TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_chat_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_group_chat_members_group ON group_chat_members(group_chat_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  agent_id TEXT,
  user_id TEXT,
  details TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_agent ON audit_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
`;

// ─── Open / close ────────────────────────────────────────────────────────────

let _db: DatabaseSync | null = null;

export function openSqlite(dbPath: string): DatabaseSync {
  if (_db) return _db;
  mkdirSync(dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _db.exec('PRAGMA busy_timeout = 5000');

  for (const stmt of SCHEMA_SQL.split(';')
    .map(s => s.trim())
    .filter(Boolean)) {
    _db.exec(stmt);
  }

  // Migrations for existing databases: add columns that were introduced after initial schema
  const migrations: Array<{ table: string; column: string; sql: string }> = [
    { table: 'tasks', column: 'blocked_by', sql: "ALTER TABLE tasks ADD COLUMN blocked_by TEXT DEFAULT '[]'" },
    { table: 'tasks', column: 'deliverables', sql: "ALTER TABLE tasks ADD COLUMN deliverables TEXT" },
    { table: 'tasks', column: 'project_id', sql: "ALTER TABLE tasks ADD COLUMN project_id TEXT" },
    { table: 'tasks', column: 'created_by', sql: "ALTER TABLE tasks ADD COLUMN created_by TEXT" },
    { table: 'tasks', column: 'updated_by', sql: "ALTER TABLE tasks ADD COLUMN updated_by TEXT" },
    { table: 'tasks', column: 'task_type', sql: "ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'standard'" },
    { table: 'tasks', column: 'schedule_config', sql: "ALTER TABLE tasks ADD COLUMN schedule_config TEXT" },
    { table: 'tasks', column: 'due_at', sql: "ALTER TABLE tasks ADD COLUMN due_at TEXT" },
    { table: 'channel_messages', column: 'metadata', sql: "ALTER TABLE channel_messages ADD COLUMN metadata TEXT DEFAULT '{}'" },
    { table: 'task_logs', column: 'execution_round', sql: "ALTER TABLE task_logs ADD COLUMN execution_round INTEGER NOT NULL DEFAULT 1" },
    { table: 'tasks', column: 'execution_round', sql: "ALTER TABLE tasks ADD COLUMN execution_round INTEGER NOT NULL DEFAULT 1" },
    { table: 'tasks', column: 'reviewer_agent_id', sql: "ALTER TABLE tasks ADD COLUMN reviewer_agent_id TEXT NOT NULL DEFAULT ''" },
    { table: 'tasks', column: 'subtasks', sql: "ALTER TABLE tasks ADD COLUMN subtasks TEXT DEFAULT '[]'" },
    { table: 'deliverables', column: 'artifact_type', sql: "ALTER TABLE deliverables ADD COLUMN artifact_type TEXT" },
    { table: 'deliverables', column: 'artifact_data', sql: "ALTER TABLE deliverables ADD COLUMN artifact_data TEXT" },
    { table: 'organizations', column: 'manager_agent_id', sql: "ALTER TABLE organizations ADD COLUMN manager_agent_id TEXT" },
    { table: 'task_comments', column: 'mentions', sql: "ALTER TABLE task_comments ADD COLUMN mentions TEXT DEFAULT '[]'" },
    { table: 'task_comments', column: 'activity_id', sql: "ALTER TABLE task_comments ADD COLUMN activity_id TEXT" },
    { table: 'requirement_comments', column: 'activity_id', sql: "ALTER TABLE requirement_comments ADD COLUMN activity_id TEXT" },
    { table: 'agent_activities', column: 'mailbox_item_id', sql: "ALTER TABLE agent_activities ADD COLUMN mailbox_item_id TEXT" },
    { table: 'agent_activities', column: 'summary', sql: "ALTER TABLE agent_activities ADD COLUMN summary TEXT DEFAULT ''" },
    { table: 'agent_activities', column: 'keywords', sql: "ALTER TABLE agent_activities ADD COLUMN keywords TEXT DEFAULT ''" },
    { table: 'chat_sessions', column: 'is_main', sql: "ALTER TABLE chat_sessions ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0" },
    { table: 'mailbox_items', column: 'retry_count', sql: "ALTER TABLE mailbox_items ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0" },
    { table: 'users', column: 'avatar_url', sql: "ALTER TABLE users ADD COLUMN avatar_url TEXT" },
    { table: 'users', column: 'invite_token', sql: "ALTER TABLE users ADD COLUMN invite_token TEXT" },
    { table: 'users', column: 'invite_expires_at', sql: "ALTER TABLE users ADD COLUMN invite_expires_at TEXT" },
    { table: 'agents', column: 'avatar_url', sql: "ALTER TABLE agents ADD COLUMN avatar_url TEXT" },
    { table: 'channel_messages', column: 'reply_to_id', sql: "ALTER TABLE channel_messages ADD COLUMN reply_to_id TEXT" },
    { table: 'approvals', column: 'approver_user_ids', sql: "ALTER TABLE approvals ADD COLUMN approver_user_ids TEXT" },
    { table: 'requirements', column: 'rejected_by', sql: 'ALTER TABLE requirements ADD COLUMN rejected_by TEXT' },
    { table: 'projects', column: 'created_by', sql: 'ALTER TABLE projects ADD COLUMN created_by TEXT' },
    { table: 'approvals', column: 'target_user_id', sql: 'ALTER TABLE approvals ADD COLUMN target_user_id TEXT' },
    { table: 'users', column: 'deleted_at', sql: 'ALTER TABLE users ADD COLUMN deleted_at TEXT' },
    { table: 'agents', column: 'deleted_at', sql: 'ALTER TABLE agents ADD COLUMN deleted_at TEXT' },
  ];
  for (const m of migrations) {
    const cols = _db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === m.column)) {
      _db.exec(m.sql);
      log.info(`Migration: added column ${m.column} to ${m.table}`);
    }
  }

  // Indexes that depend on migrated columns (must run AFTER column migrations)
  _db.exec('CREATE INDEX IF NOT EXISTS idx_agent_activities_mailbox ON agent_activities(mailbox_item_id)');

  migrateToExecutionStreamLogs(_db);

  // Status unification migration: rename legacy status values
  const statusMigrations = [
    { sql: "UPDATE tasks SET status = 'pending' WHERE status = 'pending_approval'", desc: 'tasks: pending_approval → pending' },
    { sql: "UPDATE requirements SET status = 'pending' WHERE status = 'draft'", desc: 'requirements: draft → pending' },
    { sql: "UPDATE requirements SET status = 'pending' WHERE status = 'pending_review'", desc: 'requirements: pending_review → pending' },
    { sql: "UPDATE requirements SET status = 'in_progress' WHERE status = 'approved'", desc: 'requirements: approved → in_progress' },
  ];
  for (const m of statusMigrations) {
    const result = _db.prepare(m.sql).run();
    if (result.changes > 0) {
      log.info(`Status migration: ${m.desc} (${result.changes} rows)`);
    }
  }

  log.info('SQLite database opened', { path: dbPath });
  return _db;
}

export function closeSqlite(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ─── Repo implementations ────────────────────────────────────────────────────

export class SqliteOrgRepo {
  constructor(private db: DatabaseSync) {}

  createOrg(data: {
    id: string;
    name: string;
    ownerId: string;
    plan?: string;
    maxAgents?: number;
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO organizations (id, name, owner_id, plan, max_agents, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`
      )
      .run(data.id, data.name, data.ownerId, data.plan ?? 'free', data.maxAgents ?? 5, ts, ts);
    return this.findOrgById(data.id)!;
  }

  findOrgById(id: string) {
    const row = this.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this._mapOrg(row) : undefined;
  }

  listOrgs() {
    return (this.db.prepare('SELECT * FROM organizations').all() as Record<string, unknown>[]).map(
      r => this._mapOrg(r)
    );
  }

  createTeam(data: { id: string; orgId: string; name: string; description?: string }) {
    this.db
      .prepare(
        `INSERT INTO teams (id, org_id, name, description, created_at)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(data.id, data.orgId, data.name, data.description ?? null, now());
    return this.db.prepare('SELECT * FROM teams WHERE id = ?').get(data.id) as Record<
      string,
      unknown
    >;
  }

  listTeams(orgId: string) {
    return this.db.prepare('SELECT * FROM teams WHERE org_id = ?').all(orgId) as Record<
      string,
      unknown
    >[];
  }

  async updateManagerAgentId(orgId: string, managerAgentId: string | null) {
    this.db
      .prepare('UPDATE organizations SET manager_agent_id = ?, updated_at = ? WHERE id = ?')
      .run(managerAgentId, now(), orgId);
  }

  private _mapOrg(r: Record<string, unknown>) {
    return {
      id: r['id'] as string,
      name: r['name'] as string,
      ownerId: r['owner_id'] as string,
      plan: r['plan'] as string,
      maxAgents: r['max_agents'] as number,
      managerAgentId: r['manager_agent_id'] as string | null,
      settings: fromJson(r['settings'] as string),
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
    };
  }
}

export class SqliteAgentRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    id: string;
    name: string;
    orgId: string;
    teamId?: string;
    roleId: string;
    roleName: string;
    agentRole?: string;
    skills?: string[];
    llmConfig?: unknown;
    computeConfig?: unknown;
    heartbeatIntervalMs?: number;
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO agents (id, name, org_id, team_id, role_id, role_name, agent_role, skills, llm_config, compute_config, heartbeat_interval_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.id,
        data.name,
        data.orgId,
        data.teamId ?? null,
        data.roleId,
        data.roleName,
        data.agentRole ?? 'worker',
        toJson(data.skills ?? []),
        toJson(data.llmConfig ?? {}),
        toJson(data.computeConfig ?? {}),
        data.heartbeatIntervalMs ?? 1800000,
        ts,
        ts
      );
    return this.findById(data.id)!;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : undefined;
  }

  findByOrgId(orgId: string) {
    return (
      this.db.prepare('SELECT * FROM agents WHERE org_id = ? AND deleted_at IS NULL').all(orgId) as Record<
        string,
        unknown
      >[]
    ).map(r => this._map(r));
  }

  listAll() {
    return (this.db.prepare('SELECT * FROM agents WHERE deleted_at IS NULL').all() as Record<string, unknown>[]).map(r =>
      this._map(r)
    );
  }

  updateStatus(id: string, status: string, containerId?: string) {
    this.db
      .prepare('UPDATE agents SET status = ?, container_id = ?, updated_at = ? WHERE id = ?')
      .run(status, containerId ?? null, now(), id);
  }

  updateTokens(id: string, tokensUsed: number) {
    this.db
      .prepare('UPDATE agents SET tokens_used_today = ?, updated_at = ? WHERE id = ?')
      .run(tokensUsed, now(), id);
  }

  async updateTeamId(id: string, teamId: string | null) {
    this.db.prepare('UPDATE agents SET team_id = ?, updated_at = ? WHERE id = ?').run(teamId, now(), id);
  }

  async clearTeamReferences(teamId: string) {
    this.db.prepare('UPDATE agents SET team_id = NULL, updated_at = ? WHERE team_id = ?').run(now(), teamId);
  }

  delete(id: string) {
    this.db.prepare("UPDATE agents SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  }

  updateAvatarUrl(id: string, avatarUrl: string | null) {
    this.db.prepare('UPDATE agents SET avatar_url = ?, updated_at = ? WHERE id = ?').run(avatarUrl, now(), id);
  }

  updateConfig(id: string, data: { name?: string; agentRole?: string; skills?: unknown; llmConfig?: unknown; computeConfig?: unknown; heartbeatIntervalMs?: number }) {
    const sets: string[] = ['updated_at = ?'];
    const vals: SqlParams = [now()];
    if (data.name !== undefined) { sets.push('name = ?'); vals.push(data.name); }
    if (data.agentRole !== undefined) { sets.push('agent_role = ?'); vals.push(data.agentRole); }
    if (data.skills !== undefined) { sets.push('skills = ?'); vals.push(toJson(data.skills)); }
    if (data.llmConfig !== undefined) { sets.push('llm_config = ?'); vals.push(toJson(data.llmConfig)); }
    if (data.computeConfig !== undefined) { sets.push('compute_config = ?'); vals.push(toJson(data.computeConfig)); }
    if (data.heartbeatIntervalMs !== undefined) { sets.push('heartbeat_interval_ms = ?'); vals.push(data.heartbeatIntervalMs); }
    vals.push(id);
    this.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'],
      name: r['name'],
      orgId: r['org_id'],
      teamId: r['team_id'],
      roleId: r['role_id'],
      roleName: r['role_name'],
      agentRole: r['agent_role'],
      status: r['status'],
      skills: fromJson(r['skills'] as string),
      llmConfig: fromJson(r['llm_config'] as string),
      computeConfig: fromJson(r['compute_config'] as string),
      channels: fromJson(r['channels'] as string),
      heartbeatIntervalMs: r['heartbeat_interval_ms'],
      containerId: r['container_id'],
      tokensUsedToday: r['tokens_used_today'],
      activeTaskIds: fromJson(r['active_task_ids'] as string),
      profile: fromJson(r['profile'] as string),
      avatarUrl: r['avatar_url'] as string | null,
      lastHeartbeat: toDate(r['last_heartbeat'] as string),
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
    };
  }
}

export class SqliteTaskRepo {
  constructor(private db: DatabaseSync) {}

  async create(data: {
    id: string;
    orgId: string;
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    executionMode?: string;
    assignedAgentId: string;
    reviewerAgentId: string;
    executionRound?: number;
    requirementId?: string;
    blockedBy?: string[];
    projectId?: string;
    createdBy?: string;
    dueAt?: Date;
    taskType?: string;
    scheduleConfig?: Record<string, unknown>;
    subtasks?: unknown[];
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, org_id, title, description, status, priority, execution_mode, assigned_agent_id, reviewer_agent_id, execution_round, subtasks, requirement_id, blocked_by, project_id, created_by, due_at, task_type, schedule_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.id,
        data.orgId,
        data.title,
        data.description ?? '',
        data.status ?? 'pending',
        data.priority ?? 'medium',
        data.executionMode ?? null,
        data.assignedAgentId,
        data.reviewerAgentId,
        data.executionRound ?? 1,
        toJson(data.subtasks ?? []),
        data.requirementId ?? null,
        toJson(data.blockedBy ?? []),
        data.projectId ?? null,
        data.createdBy ?? null,
        data.dueAt?.toISOString() ?? null,
        data.taskType ?? 'standard',
        data.scheduleConfig ? toJson(data.scheduleConfig) : null,
        ts,
        ts
      );
    return this.findById(data.id)!;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : undefined;
  }

  async updateStatus(id: string, status: string, updatedBy?: string) {
    const ts = now();
    const sets = ['status = ?', 'updated_at = ?'];
    const vals: SqlParams = [status, ts];
    if (updatedBy) { sets.push('updated_by = ?'); vals.push(updatedBy); }
    if (status === 'in_progress') {
      sets.push("started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END");
      vals.push(ts);
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      sets.push('completed_at = ?');
      vals.push(ts);
    }
    vals.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async assign(id: string, agentId: string, updatedBy?: string) {
    if (updatedBy) {
      this.db
        .prepare(
          'UPDATE tasks SET assigned_agent_id = ?, updated_by = ?, updated_at = ? WHERE id = ?'
        )
        .run(agentId, updatedBy, now(), id);
    } else {
      this.db
        .prepare(
          'UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?'
        )
        .run(agentId, now(), id);
    }
  }

  async update(
    id: string,
    data: { title?: string; description?: string; priority?: string; notes?: string[]; blockedBy?: string[]; projectId?: string | null; requirementId?: string | null; scheduleConfig?: Record<string, unknown> | null; reviewerAgentId?: string; updatedBy?: string }
  ) {
    const sets: string[] = [];
    const vals: SqlParams = [];
    if (data.title !== undefined) {
      sets.push('title = ?');
      vals.push(data.title);
    }
    if (data.description !== undefined) {
      sets.push('description = ?');
      vals.push(data.description);
    }
    if (data.priority !== undefined) {
      sets.push('priority = ?');
      vals.push(data.priority);
    }
    if (data.notes !== undefined) {
      sets.push('notes = ?');
      vals.push(toJson(data.notes));
    }
    if (data.blockedBy !== undefined) {
      sets.push('blocked_by = ?');
      vals.push(toJson(data.blockedBy));
    }
    if (data.projectId !== undefined) {
      sets.push('project_id = ?');
      vals.push(data.projectId);
    }
    if (data.requirementId !== undefined) {
      sets.push('requirement_id = ?');
      vals.push(data.requirementId);
    }
    if (data.scheduleConfig !== undefined) {
      sets.push('schedule_config = ?');
      vals.push(data.scheduleConfig ? toJson(data.scheduleConfig) : null);
    }
    if (data.reviewerAgentId !== undefined) {
      sets.push('reviewer_agent_id = ?');
      vals.push(data.reviewerAgentId);
    }
    if (data.updatedBy !== undefined) {
      sets.push('updated_by = ?');
      vals.push(data.updatedBy);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async updateExecutionRound(id: string, round: number) {
    this.db
      .prepare('UPDATE tasks SET execution_round = ?, updated_at = ? WHERE id = ?')
      .run(round, now(), id);
  }

  async clearForRerun(id: string, executionRound: number) {
    this.db
      .prepare('UPDATE tasks SET execution_round = ?, result = NULL, started_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?')
      .run(executionRound, now(), id);
  }

  async setResult(id: string, result: unknown) {
    this.db
      .prepare('UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?')
      .run(toJson(result), now(), id);
  }

  async updateDeliverables(id: string, deliverables: unknown[]) {
    this.db
      .prepare('UPDATE tasks SET deliverables = ?, updated_at = ? WHERE id = ?')
      .run(toJson(deliverables), now(), id);
  }

  listByOrg(orgId: string, filters?: { status?: string; assignedAgentId?: string; projectId?: string; taskType?: string }) {
    let q = 'SELECT * FROM tasks WHERE org_id = ?';
    const vals: SqlParams = [orgId];
    if (filters?.status) {
      q += ' AND status = ?';
      vals.push(filters.status);
    }
    if (filters?.assignedAgentId) {
      q += ' AND assigned_agent_id = ?';
      vals.push(filters.assignedAgentId);
    }
    if (filters?.projectId) {
      q += ' AND project_id = ?';
      vals.push(filters.projectId);
    }
    if (filters?.taskType) {
      q += ' AND task_type = ?';
      vals.push(filters.taskType);
    }
    q += ' ORDER BY created_at DESC';
    return (this.db.prepare(q).all(...vals) as Record<string, unknown>[]).map(r => this._map(r));
  }

  listByAgent(agentId: string) {
    return (
      this.db
        .prepare('SELECT * FROM tasks WHERE assigned_agent_id = ? ORDER BY created_at DESC')
        .all(agentId) as Record<string, unknown>[]
    ).map(r => this._map(r));
  }

  async updateBlockedBy(id: string, blockedBy: string[]) {
    this.db
      .prepare('UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ?')
      .run(toJson(blockedBy), now(), id);
  }

  async updateSubtasks(id: string, subtasks: unknown[]) {
    this.db
      .prepare('UPDATE tasks SET subtasks = ?, updated_at = ? WHERE id = ?')
      .run(toJson(subtasks), now(), id);
  }

  async ensureExists(data: {
    id: string;
    orgId: string;
    title: string;
    description?: string;
    priority?: string;
    status?: string;
    assignedAgentId: string;
    reviewerAgentId: string;
    executionRound?: number;
    requirementId?: string;
    projectId?: string;
    createdBy?: string;
    blockedBy?: string[];
    dueAt?: Date;
    taskType?: string;
    scheduleConfig?: Record<string, unknown>;
    subtasks?: unknown[];
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, org_id, title, description, status, priority, assigned_agent_id, reviewer_agent_id, execution_round, subtasks, requirement_id, blocked_by, project_id, created_by, due_at, task_type, schedule_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         status = excluded.status,
         assigned_agent_id = excluded.assigned_agent_id,
         execution_round = excluded.execution_round,
         updated_at = excluded.updated_at`
      )
      .run(
        data.id,
        data.orgId,
        data.title,
        data.description ?? '',
        data.status ?? 'pending',
        data.priority ?? 'medium',
        data.assignedAgentId,
        data.reviewerAgentId,
        data.executionRound ?? 1,
        toJson(data.subtasks ?? []),
        data.requirementId ?? null,
        toJson(data.blockedBy ?? []),
        data.projectId ?? null,
        data.createdBy ?? null,
        data.dueAt?.toISOString() ?? null,
        data.taskType ?? 'standard',
        data.scheduleConfig ? toJson(data.scheduleConfig) : null,
        ts,
        ts
      );
  }

  async delete(id: string) {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'],
      orgId: r['org_id'],
      title: r['title'],
      description: r['description'],
      status: r['status'],
      priority: r['priority'],
      executionMode: r['execution_mode'],
      assignedAgentId: r['assigned_agent_id'],
      reviewerAgentId: r['reviewer_agent_id'],
      executionRound: r['execution_round'] ?? 1,
      subtasks: fromJson<unknown[]>(r['subtasks'] as string) ?? [],
      requirementId: r['requirement_id'] as string | null,
      blockedBy: fromJson<string[]>(r['blocked_by'] as string) ?? [],
      result: fromJson(r['result'] as string),
      deliverables: fromJson(r['deliverables'] as string),
      notes: fromJson(r['notes'] as string),
      projectId: r['project_id'] as string | null,
      createdBy: r['created_by'] as string | null,
      updatedBy: r['updated_by'] as string | null,
      startedAt: toDate(r['started_at'] as string),
      completedAt: toDate(r['completed_at'] as string),
      taskType: (r['task_type'] as string) ?? 'standard',
      scheduleConfig: fromJson(r['schedule_config'] as string),
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
      dueAt: toDate(r['due_at'] as string),
    };
  }
}

export class SqliteRequirementRepo {
  constructor(private db: DatabaseSync) {}

  async create(data: {
    id: string;
    orgId: string;
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    source: string;
    createdBy: string;
    projectId?: string;
    approvedBy?: string;
    approvedAt?: Date;
    tags?: string[];
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO requirements (id, org_id, title, description, status, priority, source, created_by, project_id, approved_by, approved_at, rejected_reason, rejected_by, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.id,
        data.orgId,
        data.title,
        data.description ?? '',
        data.status ?? 'pending',
        data.priority ?? 'medium',
        data.source,
        data.createdBy,
        data.projectId ?? null,
        data.approvedBy ?? null,
        data.approvedAt?.toISOString() ?? null,
        null,
        null,
        toJson(data.tags ?? []),
        ts,
        ts
      );
    return this.findById(data.id)!;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : undefined;
  }

  async updateStatus(id: string, status: string) {
    this.db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }

  async approve(id: string, approvedBy: string) {
    const ts = now();
    this.db
      .prepare('UPDATE requirements SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?')
      .run('in_progress', approvedBy, ts, ts, id);
  }

  async reject(id: string, reason: string, rejectedBy?: string) {
    this.db
      .prepare('UPDATE requirements SET status = ?, rejected_reason = ?, rejected_by = ?, updated_at = ? WHERE id = ?')
      .run('rejected', reason, rejectedBy ?? null, now(), id);
  }

  /** Clear rejection columns when resubmitting or similar. */
  async clearRejectionMetadata(id: string): Promise<void> {
    this.db
      .prepare('UPDATE requirements SET rejected_reason = NULL, rejected_by = NULL, updated_at = ? WHERE id = ?')
      .run(now(), id);
  }

  async update(
    id: string,
    data: { title?: string; description?: string; priority?: string; tags?: string[]; projectId?: string | null }
  ) {
    const sets: string[] = [];
    const vals: SqlParams = [];
    if (data.title !== undefined) { sets.push('title = ?'); vals.push(data.title); }
    if (data.description !== undefined) { sets.push('description = ?'); vals.push(data.description); }
    if (data.priority !== undefined) { sets.push('priority = ?'); vals.push(data.priority); }
    if (data.tags !== undefined) { sets.push('tags = ?'); vals.push(toJson(data.tags)); }
    if (data.projectId !== undefined) { sets.push('project_id = ?'); vals.push(data.projectId); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE requirements SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  listByOrg(orgId: string, filters?: { status?: string; source?: string; projectId?: string }) {
    let q = 'SELECT * FROM requirements WHERE org_id = ?';
    const vals: SqlParams = [orgId];
    if (filters?.status) { q += ' AND status = ?'; vals.push(filters.status); }
    if (filters?.source) { q += ' AND source = ?'; vals.push(filters.source); }
    if (filters?.projectId) { q += ' AND project_id = ?'; vals.push(filters.projectId); }
    q += ' ORDER BY created_at DESC';
    return (this.db.prepare(q).all(...vals) as Record<string, unknown>[]).map(r => this._map(r));
  }

  async delete(id: string) {
    this.db.prepare('DELETE FROM requirements WHERE id = ?').run(id);
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'],
      orgId: r['org_id'],
      projectId: r['project_id'] as string | null,
      title: r['title'],
      description: r['description'],
      status: r['status'],
      priority: r['priority'],
      source: r['source'],
      createdBy: r['created_by'],
      approvedBy: r['approved_by'] as string | null,
      approvedAt: toDate(r['approved_at'] as string),
      rejectedReason: r['rejected_reason'] as string | null,
      rejectedBy: r['rejected_by'] as string | null,
      tags: fromJson<string[]>(r['tags'] as string),
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
    };
  }
}

export class SqliteProjectRepo {
  constructor(private db: DatabaseSync) {}

  async create(data: {
    id: string;
    orgId: string;
    name: string;
    description?: string;
    status?: string;
    repositories?: unknown[];
    teamIds?: string[];
    governancePolicy?: unknown;
    archivePolicy?: unknown;
    reportSchedule?: unknown;
    onboardingConfig?: unknown;
    createdBy?: string;
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO projects (id, org_id, name, description, status, repositories, team_ids, governance_policy, archive_policy, report_schedule, onboarding_config, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.id, data.orgId, data.name, data.description ?? '',
        data.status ?? 'active',
        toJson(data.repositories ?? []), toJson(data.teamIds ?? []),
        toJson(data.governancePolicy), toJson(data.archivePolicy),
        toJson(data.reportSchedule), toJson(data.onboardingConfig),
        data.createdBy ?? null,
        ts, ts
      );
    return this.findById(data.id)!;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this._map(r) : undefined;
  }

  async update(id: string, data: Record<string, unknown>) {
    const sets: string[] = [];
    const vals: SqlParams = [];
    const stringFields = ['name', 'description', 'status'] as const;
    const jsonFields = ['repositories', 'team_ids', 'governance_policy', 'archive_policy', 'report_schedule', 'onboarding_config'] as const;
    const fieldMap: Record<string, string> = {
      name: 'name', description: 'description', status: 'status',
      repositories: 'repositories',
      teamIds: 'team_ids', governancePolicy: 'governance_policy',
      archivePolicy: 'archive_policy', reportSchedule: 'report_schedule',
      onboardingConfig: 'onboarding_config',
    };
    for (const [key, col] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(jsonFields.includes(col as any) ? toJson(data[key]) : data[key] as SQLInputValue);
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async delete(id: string) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  listByOrg(orgId: string) {
    return (this.db.prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC').all(orgId) as Record<string, unknown>[]).map(r => this._map(r));
  }

  listAll() {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(r => this._map(r));
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'] as string,
      orgId: r['org_id'] as string,
      name: r['name'] as string,
      description: r['description'] as string | null,
      status: r['status'] as string,
      repositories: fromJson<unknown[]>(r['repositories'] as string) ?? [],
      teamIds: fromJson<string[]>(r['team_ids'] as string) ?? [],
      governancePolicy: fromJson(r['governance_policy'] as string),
      archivePolicy: fromJson(r['archive_policy'] as string),
      reportSchedule: fromJson(r['report_schedule'] as string),
      onboardingConfig: fromJson(r['onboarding_config'] as string),
      createdBy: r['created_by'] as string | null,
      createdAt: r['created_at'] as string,
      updatedAt: r['updated_at'] as string,
    };
  }
}

/** Persists audit log rows consumed by org-manager AuditService. */
export class SqliteAuditRepo {
  constructor(private db: DatabaseSync) {}

  /** Alias for {@link insert} — same row shape as `AuditLogRepository.insert`. */
  save(row: Parameters<SqliteAuditRepo['insert']>[0]): ReturnType<SqliteAuditRepo['insert']> {
    return this.insert(row);
  }

  async insert(row: {
    id: string;
    orgId: string;
    agentId?: string;
    userId?: string;
    type: string;
    action: string;
    detail?: string;
    metadata?: Record<string, unknown>;
    tokensUsed?: number;
    durationMs?: number;
    success: boolean;
    createdAt: Date;
  }): Promise<void> {
    const meta: Record<string, unknown> = {
      orgId: row.orgId,
      action: row.action,
      success: row.success,
      ...(row.metadata ? row.metadata : {}),
    };
    if (row.tokensUsed !== null && row.tokensUsed !== undefined) meta['tokensUsed'] = row.tokensUsed;
    if (row.durationMs !== null && row.durationMs !== undefined) meta['durationMs'] = row.durationMs;

    const ts = row.createdAt.toISOString();
    this.db
      .prepare(
        `INSERT INTO audit_logs (id, event_type, agent_id, user_id, details, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.type, row.agentId ?? null, row.userId ?? null, row.detail ?? null, toJson(meta), ts);
  }

  list(options?: {
    eventType?: string;
    agentId?: string;
    userId?: string;
    orgId?: string;
    dateRange?: { from?: Date; to?: Date };
    limit?: number;
    offset?: number;
  }): Array<{
    id: string;
    eventType: string;
    agentId: string | null;
    userId: string | null;
    details: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }> {
    const clauses: string[] = [];
    const params: SqlParams = [];
    if (options?.eventType) {
      clauses.push('event_type = ?');
      params.push(options.eventType);
    }
    if (options?.agentId) {
      clauses.push('agent_id = ?');
      params.push(options.agentId);
    }
    if (options?.userId) {
      clauses.push('user_id = ?');
      params.push(options.userId);
    }
    if (options?.orgId) {
      clauses.push(`json_extract(metadata, '$.orgId') = ?`);
      params.push(options.orgId);
    }
    if (options?.dateRange?.from) {
      clauses.push('created_at >= ?');
      params.push(options.dateRange.from.toISOString());
    }
    if (options?.dateRange?.to) {
      clauses.push('created_at <= ?');
      params.push(options.dateRange.to.toISOString());
    }
    let q = 'SELECT id, event_type, agent_id, user_id, details, metadata, created_at FROM audit_logs';
    if (clauses.length) q += ' WHERE ' + clauses.join(' AND ');
    q += ' ORDER BY created_at DESC';
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
    const offset = Math.max(options?.offset ?? 0, 0);
    q += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = this.db.prepare(q).all(...params) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r['id'] as string,
      eventType: r['event_type'] as string,
      agentId: r['agent_id'] as string | null,
      userId: r['user_id'] as string | null,
      details: r['details'] as string | null,
      metadata: (fromJson(r['metadata'] as string) as Record<string, unknown>) ?? {},
      createdAt: r['created_at'] as string,
    }));
  }
}

export class SqliteTaskLogRepo {
  constructor(private db: DatabaseSync) {}

  async append(data: {
    taskId: string;
    agentId: string;
    seq: number;
    type: string;
    content: string;
    metadata?: unknown;
    executionRound?: number;
  }) {
    const id = generateId('tlog');
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO task_logs (id, task_id, agent_id, seq, type, content, metadata, execution_round, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        data.taskId,
        data.agentId,
        data.seq,
        data.type,
        data.content,
        toJson(data.metadata ?? {}),
        data.executionRound ?? 1,
        ts
      );
    return {
      id,
      taskId: data.taskId,
      agentId: data.agentId,
      seq: data.seq,
      type: data.type,
      content: data.content,
      metadata: data.metadata ?? {},
      executionRound: data.executionRound ?? 1,
      createdAt: new Date(ts),
    };
  }

  async getMaxSeq(taskId: string): Promise<number> {
    const row = this.db.prepare('SELECT MAX(seq) as maxSeq FROM task_logs WHERE task_id = ?').get(taskId) as { maxSeq: number | null } | undefined;
    return row?.maxSeq ?? -1;
  }

  getByTask(taskId: string) {
    return (
      this.db
        .prepare('SELECT * FROM task_logs WHERE task_id = ? ORDER BY seq ASC')
        .all(taskId) as Record<string, unknown>[]
    ).map(r => ({
      id: r['id'] as string,
      taskId: r['task_id'] as string,
      agentId: r['agent_id'] as string,
      seq: r['seq'] as number,
      type: r['type'] as string,
      content: r['content'] as string,
      metadata: fromJson(r['metadata'] as string),
      executionRound: (r['execution_round'] as number) ?? 1,
      createdAt: toDate(r['created_at'] as string)!,
    }));
  }

  getByTaskRound(taskId: string, round: number) {
    return (
      this.db
        .prepare('SELECT * FROM task_logs WHERE task_id = ? AND execution_round = ? ORDER BY seq ASC')
        .all(taskId, round) as Record<string, unknown>[]
    ).map(r => ({
      id: r['id'] as string,
      taskId: r['task_id'] as string,
      agentId: r['agent_id'] as string,
      seq: r['seq'] as number,
      type: r['type'] as string,
      content: r['content'] as string,
      metadata: fromJson(r['metadata'] as string),
      executionRound: (r['execution_round'] as number) ?? 1,
      createdAt: toDate(r['created_at'] as string)!,
    }));
  }

  getRoundsSummary(taskId: string) {
    return (
      this.db
        .prepare(`
          SELECT
            execution_round as round,
            COUNT(*) as log_count,
            SUM(CASE WHEN type = 'tool_end' THEN 1 ELSE 0 END) as tool_count,
            MIN(created_at) as first_at,
            MAX(created_at) as last_at,
            MAX(CASE WHEN type = 'status' AND content IN ('completed','failed','cancelled','execution_finished') THEN content ELSE NULL END) as terminal_status
          FROM task_logs
          WHERE task_id = ?
          GROUP BY execution_round
          ORDER BY execution_round ASC
        `)
        .all(taskId) as Record<string, unknown>[]
    ).map(r => ({
      round: (r['round'] as number) ?? 1,
      logCount: (r['log_count'] as number) ?? 0,
      toolCount: (r['tool_count'] as number) ?? 0,
      firstAt: r['first_at'] as string,
      lastAt: r['last_at'] as string,
      status: (r['terminal_status'] as string) ?? 'running',
    }));
  }

  deleteByTask(taskId: string) {
    this.db.prepare('DELETE FROM task_logs WHERE task_id = ?').run(taskId);
  }
}

export class SqliteTaskCommentRepo {
  constructor(private db: DatabaseSync) {}

  async add(data: {
    taskId: string;
    authorId: string;
    authorName: string;
    authorType: string;
    content: string;
    attachments?: unknown[];
    mentions?: string[];
    activityId?: string;
  }) {
    const id = generateId('tc');
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO task_comments (id, task_id, author_id, author_name, author_type, content, attachments, mentions, activity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, data.taskId, data.authorId, data.authorName, data.authorType, data.content, toJson(data.attachments ?? []), toJson(data.mentions ?? []), data.activityId ?? null, ts);
    return {
      id,
      taskId: data.taskId,
      authorId: data.authorId,
      authorName: data.authorName,
      authorType: data.authorType,
      content: data.content,
      attachments: data.attachments ?? [],
      mentions: data.mentions ?? [],
      activityId: data.activityId,
      createdAt: new Date(ts),
    };
  }

  getByTask(taskId: string) {
    return (
      this.db
        .prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC')
        .all(taskId) as Record<string, unknown>[]
    ).map(r => ({
      id: r['id'] as string,
      taskId: r['task_id'] as string,
      authorId: r['author_id'] as string,
      authorName: r['author_name'] as string,
      authorType: r['author_type'] as string,
      content: r['content'] as string,
      attachments: fromJson(r['attachments'] as string),
      mentions: (fromJson(r['mentions'] as string) ?? []) as string[],
      activityId: r['activity_id'] as string | undefined,
      createdAt: toDate(r['created_at'] as string)!,
    }));
  }

  deleteByTask(taskId: string) {
    this.db.prepare('DELETE FROM task_comments WHERE task_id = ?').run(taskId);
  }
}

export class SqliteRequirementCommentRepo {
  constructor(private db: DatabaseSync) {}

  async add(data: {
    requirementId: string;
    authorId: string;
    authorName: string;
    authorType: string;
    content: string;
    attachments?: unknown[];
    mentions?: string[];
    activityId?: string;
  }) {
    const id = generateId('rc');
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO requirement_comments (id, requirement_id, author_id, author_name, author_type, content, attachments, mentions, activity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, data.requirementId, data.authorId, data.authorName, data.authorType, data.content, toJson(data.attachments ?? []), toJson(data.mentions ?? []), data.activityId ?? null, ts);
    return {
      id,
      requirementId: data.requirementId,
      authorId: data.authorId,
      authorName: data.authorName,
      authorType: data.authorType,
      content: data.content,
      attachments: data.attachments ?? [],
      mentions: data.mentions ?? [],
      activityId: data.activityId,
      createdAt: new Date(ts),
    };
  }

  getByRequirement(requirementId: string) {
    return (
      this.db
        .prepare('SELECT * FROM requirement_comments WHERE requirement_id = ? ORDER BY created_at ASC')
        .all(requirementId) as Record<string, unknown>[]
    ).map(r => ({
      id: r['id'] as string,
      requirementId: r['requirement_id'] as string,
      authorId: r['author_id'] as string,
      authorName: r['author_name'] as string,
      authorType: r['author_type'] as string,
      content: r['content'] as string,
      attachments: fromJson(r['attachments'] as string),
      mentions: (fromJson(r['mentions'] as string) ?? []) as string[],
      activityId: r['activity_id'] as string | undefined,
      createdAt: toDate(r['created_at'] as string)!,
    }));
  }

  deleteByRequirement(requirementId: string) {
    this.db.prepare('DELETE FROM requirement_comments WHERE requirement_id = ?').run(requirementId);
  }
}

export class SqliteMessageRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    id: string;
    platform: string;
    direction: string;
    channelId: string;
    senderId: string;
    senderName?: string;
    agentId?: string;
    content: unknown;
    replyToId?: string;
    threadId?: string;
  }) {
    this.db
      .prepare(
        'INSERT INTO messages (id, platform, direction, channel_id, sender_id, sender_name, agent_id, content, reply_to_id, thread_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        data.id,
        data.platform,
        data.direction,
        data.channelId,
        data.senderId,
        data.senderName ?? null,
        data.agentId ?? null,
        toJson(data.content),
        data.replyToId ?? null,
        data.threadId ?? null,
        now()
      );
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(data.id);
  }

  findByChannel(channelId: string, limit = 50) {
    return this.db
      .prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(channelId, limit);
  }

  findByAgent(agentId: string, limit = 50) {
    return this.db
      .prepare('SELECT * FROM messages WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, limit);
  }

  findByThread(threadId: string) {
    return this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC')
      .all(threadId);
  }
}

export class SqliteChatSessionRepo {
  constructor(private db: DatabaseSync) {}

  createSession(agentId: string, userId?: string) {
    const id = generateId('cs');
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO chat_sessions (id, agent_id, user_id, created_at, last_message_at) VALUES (?,?,?,?,?)'
      )
      .run(id, agentId, userId ?? null, ts, ts);
    return {
      id,
      agentId,
      userId: userId ?? null,
      title: null,
      isMain: false,
      createdAt: new Date(ts),
      lastMessageAt: new Date(ts),
    };
  }

  getOrCreateMainSession(agentId: string, userId?: string) {
    const existing = userId
      ? this.db.prepare('SELECT * FROM chat_sessions WHERE agent_id = ? AND user_id = ? AND is_main = 1 LIMIT 1').get(agentId, userId)
      : this.db.prepare('SELECT * FROM chat_sessions WHERE agent_id = ? AND is_main = 1 LIMIT 1').get(agentId);
    if (existing) return this._mapSession(existing as Record<string, unknown>);
    // Promote the oldest existing session for this user to main
    const oldest = userId
      ? this.db.prepare('SELECT * FROM chat_sessions WHERE agent_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 1').get(agentId, userId)
      : this.db.prepare('SELECT * FROM chat_sessions WHERE agent_id = ? ORDER BY created_at ASC LIMIT 1').get(agentId);
    if (oldest) {
      const row = oldest as Record<string, unknown>;
      const title = (row['title'] as string) || 'Main';
      this.db.prepare('UPDATE chat_sessions SET is_main = 1, title = ? WHERE id = ?')
        .run(title, row['id'] as string);
      row['is_main'] = 1;
      row['title'] = title;
      return this._mapSession(row);
    }
    const id = generateId('cs');
    const ts = now();
    this.db
      .prepare('INSERT INTO chat_sessions (id, agent_id, user_id, title, is_main, created_at, last_message_at) VALUES (?,?,?,?,1,?,?)')
      .run(id, agentId, userId ?? null, 'Main', ts, ts);
    return { id, agentId, userId: userId ?? null, title: 'Main', isMain: true, createdAt: new Date(ts), lastMessageAt: new Date(ts) };
  }

  getSessionsByAgent(agentId: string, limit = 50, userId?: string) {
    if (userId) {
      return (
        this.db
          .prepare(
            'SELECT * FROM chat_sessions WHERE agent_id = ? AND user_id = ? ORDER BY is_main DESC, last_message_at DESC LIMIT ?'
          )
          .all(agentId, userId, limit) as Record<string, unknown>[]
      ).map(r => this._mapSession(r));
    }
    return (
      this.db
        .prepare(
          'SELECT * FROM chat_sessions WHERE agent_id = ? ORDER BY is_main DESC, last_message_at DESC LIMIT ?'
        )
        .all(agentId, limit) as Record<string, unknown>[]
    ).map(r => this._mapSession(r));
  }

  getSession(sessionId: string) {
    const r = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return r ? this._mapSession(r) : null;
  }

  updateLastMessage(sessionId: string, title?: string) {
    if (title) {
      this.db
        .prepare('UPDATE chat_sessions SET last_message_at = ?, title = ? WHERE id = ?')
        .run(now(), title, sessionId);
    } else {
      this.db
        .prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?')
        .run(now(), sessionId);
    }
  }

  deleteSession(sessionId: string) {
    this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
  }

  appendMessage(
    sessionId: string,
    agentId: string,
    role: string,
    content: string,
    tokensUsed?: number,
    metadata?: unknown
  ) {
    const id = generateId('cm');
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO chat_messages (id, session_id, agent_id, role, content, metadata, tokens_used, created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        sessionId,
        agentId,
        role,
        content,
        metadata ? toJson(metadata) : null,
        tokensUsed ?? 0,
        ts
      );
    return {
      id,
      sessionId,
      agentId,
      role,
      content,
      metadata: metadata ?? null,
      tokensUsed: tokensUsed ?? 0,
      createdAt: new Date(ts),
    };
  }

  getMessages(sessionId: string, limit = 50, before?: string) {
    let q = 'SELECT * FROM chat_messages WHERE session_id = ?';
    const vals: SqlParams = [sessionId];
    if (before) {
      q += ' AND created_at < ?';
      vals.push(before);
    }
    q += ' ORDER BY created_at DESC LIMIT ?';
    vals.push(limit + 1);
    const rows = (this.db.prepare(q).all(...vals) as Record<string, unknown>[]).map(r =>
      this._mapMsg(r)
    );
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse(), hasMore };
  }

  getMessageCount(sessionId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) as cnt FROM chat_messages WHERE session_id = ?')
      .get(sessionId) as { cnt: number };
    return r.cnt;
  }

  /**
   * Remove only the last assistant message from a session (for resume).
   * Returns the deleted message's content and metadata so the caller can
   * reconstruct a trimmed version for the LLM context.
   */
  deleteLastAssistantMessage(sessionId: string): { content: string; metadata?: Record<string, unknown> } | null {
    const row = this.db.prepare(
      'SELECT id, content, metadata FROM chat_messages WHERE session_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1'
    ).get(sessionId, 'assistant') as Record<string, unknown> | undefined;
    if (!row) return null;
    const id = row['id'] as string;
    const content = row['content'] as string;
    const rawMeta = row['metadata'] as string | null;
    this.db.prepare('DELETE FROM chat_messages WHERE id = ?').run(id);
    return { content, metadata: rawMeta ? JSON.parse(rawMeta) : undefined };
  }

  /**
   * Remove the last user+assistant exchange from a session (for retry).
   * Deletes from the end backwards through the last assistant message
   * and its preceding user message.
   */
  deleteLastExchange(sessionId: string): void {
    const rows = this.db.prepare(
      'SELECT id, role FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 10'
    ).all(sessionId) as Array<Record<string, unknown>>;
    let foundAssistant = false;
    for (const row of rows) {
      const role = row['role'] as string;
      const id = row['id'] as string;
      this.db.prepare('DELETE FROM chat_messages WHERE id = ?').run(id);
      if (role === 'assistant') foundAssistant = true;
      if (role === 'user' && foundAssistant) break;
    }
  }

  private _mapSession(r: Record<string, unknown>) {
    return {
      id: r['id'],
      agentId: r['agent_id'],
      userId: r['user_id'],
      title: r['title'],
      isMain: !!(r['is_main']),
      createdAt: toDate(r['created_at'] as string)!,
      lastMessageAt: toDate(r['last_message_at'] as string)!,
    };
  }

  /**
   * Migrate legacy assistant messages that lack segments metadata.
   * Parses raw text content to extract tool calls and clean text into proper segments.
   * Should be called once at startup.
   */
  migrateLegacyMessages(): number {
    const rows = this.db.prepare(
      `SELECT id, content, metadata, created_at FROM chat_messages
       WHERE role = 'assistant'
         AND (metadata IS NULL OR metadata = 'null' OR json_extract(metadata, '$.segments') IS NULL)
         AND content IS NOT NULL AND content != ''`
    ).all() as Array<Record<string, unknown>>;

    if (rows.length === 0) return 0;

    const update = this.db.prepare(
      'UPDATE chat_messages SET metadata = ? WHERE id = ?'
    );
    let migrated = 0;

    for (const row of rows) {
      const id = row['id'] as string;
      const content = row['content'] as string;
      const rawMeta = row['metadata'] as string | null;
      const existingMeta = rawMeta && rawMeta !== 'null' ? JSON.parse(rawMeta) : {};
      const createdAt = row['created_at'] as string | null;

      const segments = this._parseContentToSegments(content, createdAt ?? undefined);
      if (segments.length === 0) continue;

      existingMeta.segments = segments;
      update.run(JSON.stringify(existingMeta), id);
      migrated++;
    }

    if (migrated > 0) {
      log.info(`Migrated ${migrated} legacy chat messages to segment format`);
    }
    return migrated;
  }

  /**
   * Migrate sessions with user_id = NULL to the given default userId.
   * Called once at startup to fix legacy data from before per-user session isolation.
   */
  migrateNullUserSessions(defaultUserId: string): number {
    const result = this.db.prepare(
      'UPDATE chat_sessions SET user_id = ? WHERE user_id IS NULL'
    ).run(defaultUserId);
    const count = Number(result.changes);
    if (count > 0) {
      log.info(`Migrated ${count} chat sessions with NULL user_id to user ${defaultUserId}`);
    }
    return count;
  }

  /**
   * Migrate sessions with user_id = 'default' to the real owner userId.
   * Called once at startup for legacy data from before auto-generated user IDs.
   */
  migrateDefaultUserSessions(realOwnerId: string): number {
    if (realOwnerId === 'default') return 0;
    const result = this.db.prepare(
      "UPDATE chat_sessions SET user_id = ? WHERE user_id = 'default'"
    ).run(realOwnerId);
    const count = Number(result.changes);
    if (count > 0) {
      log.info(`Migrated ${count} chat sessions from user_id='default' to ${realOwnerId}`);
    }
    return count;
  }

  private _parseContentToSegments(content: string, msgCreatedAt?: string): Array<Record<string, unknown>> {
    const segments: Array<Record<string, unknown>> = [];
    let remaining = content;

    remaining = remaining.replace(/<think>[\s\S]*?<\/think>/g, '');

    const toolPattern = /<(?:invoke|function_calls|antml:\w+)\b[\s\S]*?(?:<\/(?:invoke|function_calls|antml:\w+)>|$)/g;
    const parts = remaining.split(toolPattern);
    const tools = remaining.match(toolPattern) ?? [];

    const baseMs = msgCreatedAt ? new Date(msgCreatedAt).getTime() : Date.now();
    let cursorMs = baseMs;

    for (let i = 0; i < parts.length; i++) {
      const text = parts[i]!.replace(/<\/?(invoke|function_calls|antml:\w+)[^>]*>/g, '').trim();
      if (text) {
        segments.push({ type: 'text', content: text, createdAt: new Date(cursorMs).toISOString() });
        cursorMs += 1000;
      }
      if (i < tools.length) {
        const toolXml = tools[i]!;
        const nameMatch = toolXml.match(/name="([^"]+)"/);
        const toolName = nameMatch?.[1] ?? 'unknown_tool';
        segments.push({ type: 'tool', tool: toolName, status: 'done', createdAt: new Date(cursorMs).toISOString() });
        cursorMs += 2000;
      }
    }

    return segments;
  }

  private _mapMsg(r: Record<string, unknown>) {
    return {
      id: r['id'],
      sessionId: r['session_id'],
      agentId: r['agent_id'],
      role: r['role'],
      content: r['content'],
      metadata: fromJson(r['metadata'] as string),
      tokensUsed: r['tokens_used'],
      createdAt: toDate(r['created_at'] as string)!,
    };
  }
}

export class SqliteChannelMessageRepo {
  constructor(private db: DatabaseSync) {}

  async append(data: {
    orgId: string;
    channel: string;
    senderId: string;
    senderType: string;
    senderName: string;
    text: string;
    mentions?: string[];
    metadata?: Record<string, unknown>;
    replyToId?: string;
  }) {
    const id = generateId('chm');
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO channel_messages (id, org_id, channel, sender_id, sender_type, sender_name, text, mentions, metadata, reply_to_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        data.orgId,
        data.channel,
        data.senderId,
        data.senderType,
        data.senderName,
        data.text,
        toJson(data.mentions ?? []),
        toJson(data.metadata ?? {}),
        data.replyToId ?? null,
        ts
      );
    return {
      id,
      orgId: data.orgId,
      channel: data.channel,
      senderId: data.senderId,
      senderType: data.senderType,
      senderName: data.senderName,
      text: data.text,
      mentions: data.mentions ?? [],
      metadata: data.metadata ?? null,
      replyToId: data.replyToId,
      createdAt: new Date(ts),
    };
  }

  getMessages(channel: string, limit = 50, before?: string) {
    let q = `SELECT m.*, r.sender_name AS reply_to_sender, SUBSTR(r.text, 1, 120) AS reply_to_text
      FROM channel_messages m LEFT JOIN channel_messages r ON m.reply_to_id = r.id
      WHERE m.channel = ?`;
    const vals: SqlParams = [channel];
    if (before) {
      q += ' AND m.created_at < ?';
      vals.push(before);
    }
    q += ' ORDER BY m.created_at DESC LIMIT ?';
    vals.push(limit + 1);
    const rows = (this.db.prepare(q).all(...vals) as Record<string, unknown>[]).map(r => ({
      id: r['id'],
      orgId: r['org_id'],
      channel: r['channel'],
      senderId: r['sender_id'],
      senderType: r['sender_type'],
      senderName: r['sender_name'],
      text: r['text'],
      mentions: fromJson<string[]>(r['mentions'] as string),
      metadata: fromJson<Record<string, unknown>>(r['metadata'] as string),
      replyToId: (r['reply_to_id'] as string) ?? undefined,
      replyToSender: (r['reply_to_sender'] as string) ?? undefined,
      replyToText: (r['reply_to_text'] as string) ?? undefined,
      createdAt: toDate(r['created_at'] as string)!,
    }));
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse(), hasMore };
  }

  getMessageById(id: string) {
    const r = this.db.prepare('SELECT * FROM channel_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r['id'] as string,
      senderName: r['sender_name'] as string,
      senderType: r['sender_type'] as string,
      senderId: r['sender_id'] as string,
      text: r['text'] as string,
    };
  }
}

export class SqliteUserRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    id: string;
    orgId: string;
    name: string;
    email?: string;
    role?: string;
    teamId?: string;
    passwordHash?: string;
  }) {
    this.db
      .prepare(
        'INSERT INTO users (id, org_id, name, email, role, team_id, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        data.id,
        data.orgId,
        data.name,
        data.email ?? null,
        data.role ?? 'member',
        data.teamId ?? null,
        data.passwordHash ?? null,
        now()
      );
    return this.findById(data.id)!;
  }

  async upsert(data: {
    id: string;
    orgId: string;
    name: string;
    email?: string;
    role?: string;
    teamId?: string;
    passwordHash?: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO users (id, org_id, name, email, role, team_id, password_hash, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, role = excluded.role, team_id = excluded.team_id, password_hash = COALESCE(excluded.password_hash, password_hash)`
      )
      .run(
        data.id,
        data.orgId,
        data.name,
        data.email ?? null,
        data.role ?? 'member',
        data.teamId ?? null,
        data.passwordHash ?? null,
        now()
      );
  }

  async updateTeamId(id: string, teamId: string | null) {
    this.db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(teamId, id);
  }

  async clearTeamReferences(teamId: string) {
    this.db.prepare('UPDATE users SET team_id = NULL WHERE team_id = ?').run(teamId);
  }

  async delete(id: string) {
    this.db.prepare("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(id);
  }

  findByEmail(email: string) {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').get(email) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : null;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : null;
  }

  listByOrg(orgId: string) {
    return (
      this.db.prepare('SELECT * FROM users WHERE org_id = ? AND deleted_at IS NULL').all(orgId) as Record<
        string,
        unknown
      >[]
    ).map(r => this._map(r));
  }

  updateLastLogin(id: string) {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), id);
  }

  updatePassword(id: string, passwordHash: string) {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  updateProfile(id: string, data: { name?: string; email?: string; role?: string; avatarUrl?: string | null }) {
    const sets: string[] = [];
    const vals: SqlParams = [];
    if (data.name !== undefined) {
      sets.push('name = ?');
      vals.push(data.name);
    }
    if (data.email !== undefined) {
      sets.push('email = ?');
      vals.push(data.email);
    }
    if (data.role !== undefined) {
      sets.push('role = ?');
      vals.push(data.role);
    }
    if (data.avatarUrl !== undefined) {
      sets.push('avatar_url = ?');
      vals.push(data.avatarUrl);
    }
    if (sets.length === 0) return null;
    vals.push(id);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.findById(id);
  }

  countByOrg(orgId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) as cnt FROM users WHERE org_id = ? AND deleted_at IS NULL').get(orgId) as {
      cnt: number;
    };
    return r.cnt;
  }

  updateAvatarUrl(id: string, avatarUrl: string | null) {
    this.db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, id);
  }

  setInviteToken(id: string, token: string, expiresAt: string) {
    this.db.prepare('UPDATE users SET invite_token = ?, invite_expires_at = ? WHERE id = ?').run(token, expiresAt, id);
  }

  findByInviteToken(token: string) {
    const r = this.db.prepare('SELECT * FROM users WHERE invite_token = ? AND deleted_at IS NULL').get(token) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : null;
  }

  clearInviteToken(id: string) {
    this.db.prepare('UPDATE users SET invite_token = NULL, invite_expires_at = NULL WHERE id = ?').run(id);
  }

  findDeletedByEmail(email: string) {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NOT NULL').get(email) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : null;
  }

  reactivate(id: string, data: { name: string; role: string }) {
    this.db.prepare('UPDATE users SET deleted_at = NULL, name = ?, role = ?, invite_token = NULL, invite_expires_at = NULL WHERE id = ?')
      .run(data.name, data.role, id);
  }

  /**
   * Migrate the legacy 'default' user row to a real auto-generated ID.
   * Returns the new ID if migration happened, or null if no legacy row existed.
   */
  migrateDefaultId(newId: string): string | null {
    const existing = this.findById('default');
    if (!existing) return null;

    // Check if a row with the newId already exists (from a prior ensureAdminUser)
    const alreadyMigrated = this.findById(newId);
    if (alreadyMigrated) {
      // Just delete the legacy 'default' row
      this.db.prepare("DELETE FROM users WHERE id = 'default'").run();
      return newId;
    }

    // Rename the row
    this.db.prepare("UPDATE users SET id = ? WHERE id = 'default'").run(newId);
    log.info(`Migrated user id='default' to '${newId}'`);
    return newId;
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'],
      orgId: r['org_id'],
      name: r['name'],
      email: r['email'],
      role: r['role'],
      teamId: r['team_id'],
      passwordHash: r['password_hash'],
      avatarUrl: r['avatar_url'] as string | null,
      inviteToken: r['invite_token'] as string | null,
      inviteExpiresAt: r['invite_expires_at'] as string | null,
      createdAt: toDate(r['created_at'] as string),
      lastLoginAt: toDate(r['last_login_at'] as string),
    };
  }
}

export class SqliteTeamRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    id: string;
    orgId: string;
    name: string;
    description?: string;
    managerId?: string;
    managerType?: string;
  }) {
    this.db
      .prepare(
        'INSERT INTO teams (id, org_id, name, description, manager_id, manager_type, created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        data.id,
        data.orgId,
        data.name,
        data.description ?? null,
        data.managerId ?? null,
        data.managerType ?? null,
        now()
      );
    return this.findById(data.id)!;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : undefined;
  }

  findByOrgId(orgId: string) {
    return (
      this.db.prepare('SELECT * FROM teams WHERE org_id = ?').all(orgId) as Record<
        string,
        unknown
      >[]
    ).map(r => this._map(r));
  }

  update(
    id: string,
    data: {
      name?: string;
      description?: string;
      managerId?: string | null;
      managerType?: string | null;
    }
  ) {
    const sets: string[] = [];
    const vals: SqlParams = [];
    if (data.name !== undefined) {
      sets.push('name = ?');
      vals.push(data.name);
    }
    if (data.description !== undefined) {
      sets.push('description = ?');
      vals.push(data.description);
    }
    if (data.managerId !== undefined) {
      sets.push('manager_id = ?');
      vals.push(data.managerId);
    }
    if (data.managerType !== undefined) {
      sets.push('manager_type = ?');
      vals.push(data.managerType);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'],
      orgId: r['org_id'],
      name: r['name'],
      description: r['description'],
      managerId: r['manager_id'],
      managerType: r['manager_type'],
      createdAt: toDate(r['created_at'] as string),
    };
  }
}

export class SqliteMarketplaceTemplateRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    id: string;
    name: string;
    description: string;
    source?: string;
    status?: string;
    version?: string;
    authorId?: string;
    authorName: string;
    roleId: string;
    agentRole?: string;
    skills?: string[];
    llmProvider?: string;
    tags?: string[];
    category: string;
    icon?: string;
    heartbeatIntervalMs?: number;
    starterTasks?: unknown[];
    config?: Record<string, unknown>;
  }) {
    const ts = now();
    const status = data.status ?? 'draft';
    this.db
      .prepare(
        `INSERT INTO marketplace_templates (id, name, description, source, status, version, author_id, author_name, role_id, agent_role, skills, llm_provider, tags, category, icon, heartbeat_interval_ms, starter_tasks, config, published_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        data.id,
        data.name,
        data.description,
        data.source ?? 'community',
        status,
        data.version ?? '1.0.0',
        data.authorId ?? null,
        data.authorName,
        data.roleId,
        data.agentRole ?? 'worker',
        toJson(data.skills ?? []),
        data.llmProvider ?? null,
        toJson(data.tags ?? []),
        data.category,
        data.icon ?? null,
        data.heartbeatIntervalMs ?? null,
        toJson(data.starterTasks ?? []),
        toJson(data.config ?? {}),
        status === 'published' ? ts : null,
        ts,
        ts
      );
    return this.findById(data.id)!;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM marketplace_templates WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : undefined;
  }

  list(opts?: {
    source?: string;
    status?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }) {
    let q = 'SELECT * FROM marketplace_templates WHERE 1=1';
    const vals: SqlParams = [];
    if (opts?.source) {
      q += ' AND source = ?';
      vals.push(opts.source);
    }
    if (opts?.status) {
      q += ' AND status = ?';
      vals.push(opts.status);
    }
    if (opts?.category) {
      q += ' AND category = ?';
      vals.push(opts.category);
    }
    q += ' ORDER BY download_count DESC, avg_rating DESC LIMIT ? OFFSET ?';
    vals.push(opts?.limit ?? 50, opts?.offset ?? 0);
    return (this.db.prepare(q).all(...vals) as Record<string, unknown>[]).map(r => this._map(r));
  }

  search(query: string, opts?: { source?: string; category?: string; limit?: number }) {
    let q = 'SELECT * FROM marketplace_templates WHERE (name LIKE ? OR description LIKE ?)';
    const vals: SqlParams = [`%${query}%`, `%${query}%`];
    if (opts?.source) {
      q += ' AND source = ?';
      vals.push(opts.source);
    }
    if (opts?.category) {
      q += ' AND category = ?';
      vals.push(opts.category);
    }
    q += ' ORDER BY download_count DESC LIMIT ?';
    vals.push(opts?.limit ?? 20);
    return (this.db.prepare(q).all(...vals) as Record<string, unknown>[]).map(r => this._map(r));
  }

  updateStatus(id: string, status: string) {
    const pubAt = status === 'published' ? now() : null;
    this.db
      .prepare(
        'UPDATE marketplace_templates SET status = ?, published_at = COALESCE(?, published_at), updated_at = ? WHERE id = ?'
      )
      .run(status, pubAt, now(), id);
  }

  incrementDownloads(id: string) {
    this.db
      .prepare('UPDATE marketplace_templates SET download_count = download_count + 1 WHERE id = ?')
      .run(id);
  }

  updateRating(id: string, avgRating: number, ratingCount: number) {
    this.db
      .prepare(
        'UPDATE marketplace_templates SET avg_rating = ?, rating_count = ?, updated_at = ? WHERE id = ?'
      )
      .run(avgRating, ratingCount, now(), id);
  }

  update(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      version: string;
      skills: string[];
      tags: string[];
      category: string;
      icon: string;
      config: Record<string, unknown>;
    }>
  ) {
    const sets: string[] = [];
    const vals: SqlParams = [];
    if (data.name !== undefined) {
      sets.push('name = ?');
      vals.push(data.name);
    }
    if (data.description !== undefined) {
      sets.push('description = ?');
      vals.push(data.description);
    }
    if (data.version !== undefined) {
      sets.push('version = ?');
      vals.push(data.version);
    }
    if (data.skills !== undefined) {
      sets.push('skills = ?');
      vals.push(toJson(data.skills));
    }
    if (data.tags !== undefined) {
      sets.push('tags = ?');
      vals.push(toJson(data.tags));
    }
    if (data.category !== undefined) {
      sets.push('category = ?');
      vals.push(data.category);
    }
    if (data.icon !== undefined) {
      sets.push('icon = ?');
      vals.push(data.icon);
    }
    if (data.config !== undefined) {
      sets.push('config = ?');
      vals.push(toJson(data.config));
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db
      .prepare(`UPDATE marketplace_templates SET ${sets.join(', ')} WHERE id = ?`)
      .run(...vals);
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM marketplace_templates WHERE id = ?').run(id);
  }

  countBySource() {
    const rows = this.db
      .prepare('SELECT source, COUNT(*) as cnt FROM marketplace_templates GROUP BY source')
      .all() as Array<{ source: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const r of rows) result[r.source] = r.cnt;
    return result;
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'],
      name: r['name'],
      description: r['description'],
      source: r['source'],
      status: r['status'],
      version: r['version'],
      authorId: r['author_id'],
      authorName: r['author_name'],
      roleId: r['role_id'],
      agentRole: r['agent_role'],
      skills: fromJson<string[]>(r['skills'] as string),
      llmProvider: r['llm_provider'],
      tags: fromJson<string[]>(r['tags'] as string),
      category: r['category'],
      icon: r['icon'],
      heartbeatIntervalMs: r['heartbeat_interval_ms'],
      starterTasks: fromJson(r['starter_tasks'] as string),
      config: fromJson(r['config'] as string),
      downloadCount: r['download_count'],
      avgRating: r['avg_rating'],
      ratingCount: r['rating_count'],
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
      publishedAt: toDate(r['published_at'] as string),
    };
  }
}

export class SqliteMarketplaceSkillRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    id: string;
    name: string;
    description: string;
    source?: string;
    status?: string;
    version?: string;
    authorId?: string;
    authorName: string;
    category: string;
    tags?: string[];
    tools?: unknown[];
    readme?: string;
    requiredPermissions?: string[];
    requiredEnv?: string[];
    config?: Record<string, unknown>;
  }) {
    const ts = now();
    const status = data.status ?? 'draft';
    this.db
      .prepare(
        `INSERT INTO marketplace_skills (id, name, description, source, status, version, author_id, author_name, category, tags, tools, readme, required_permissions, required_env, config, published_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        data.id,
        data.name,
        data.description,
        data.source ?? 'community',
        status,
        data.version ?? '1.0.0',
        data.authorId ?? null,
        data.authorName,
        data.category,
        toJson(data.tags ?? []),
        toJson(data.tools ?? []),
        data.readme ?? null,
        toJson(data.requiredPermissions ?? []),
        toJson(data.requiredEnv ?? []),
        toJson(data.config ?? {}),
        status === 'published' ? ts : null,
        ts,
        ts
      );
    return this.findById(data.id)!;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM marketplace_skills WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : undefined;
  }

  list(opts?: {
    source?: string;
    status?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }) {
    let q = 'SELECT * FROM marketplace_skills WHERE 1=1';
    const vals: SqlParams = [];
    if (opts?.source) {
      q += ' AND source = ?';
      vals.push(opts.source);
    }
    if (opts?.status) {
      q += ' AND status = ?';
      vals.push(opts.status);
    }
    if (opts?.category) {
      q += ' AND category = ?';
      vals.push(opts.category);
    }
    q += ' ORDER BY download_count DESC, avg_rating DESC LIMIT ? OFFSET ?';
    vals.push(opts?.limit ?? 50, opts?.offset ?? 0);
    return (this.db.prepare(q).all(...vals) as Record<string, unknown>[]).map(r => this._map(r));
  }

  search(query: string, opts?: { source?: string; category?: string; limit?: number }) {
    let q = 'SELECT * FROM marketplace_skills WHERE (name LIKE ? OR description LIKE ?)';
    const vals: SqlParams = [`%${query}%`, `%${query}%`];
    if (opts?.source) {
      q += ' AND source = ?';
      vals.push(opts.source);
    }
    if (opts?.category) {
      q += ' AND category = ?';
      vals.push(opts.category);
    }
    q += ' ORDER BY download_count DESC LIMIT ?';
    vals.push(opts?.limit ?? 20);
    return (this.db.prepare(q).all(...vals) as Record<string, unknown>[]).map(r => this._map(r));
  }

  updateStatus(id: string, status: string) {
    const pubAt = status === 'published' ? now() : null;
    this.db
      .prepare(
        'UPDATE marketplace_skills SET status = ?, published_at = COALESCE(?, published_at), updated_at = ? WHERE id = ?'
      )
      .run(status, pubAt, now(), id);
  }

  incrementDownloads(id: string) {
    this.db
      .prepare('UPDATE marketplace_skills SET download_count = download_count + 1 WHERE id = ?')
      .run(id);
  }

  updateRating(id: string, avgRating: number, ratingCount: number) {
    this.db
      .prepare(
        'UPDATE marketplace_skills SET avg_rating = ?, rating_count = ?, updated_at = ? WHERE id = ?'
      )
      .run(avgRating, ratingCount, now(), id);
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM marketplace_skills WHERE id = ?').run(id);
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'],
      name: r['name'],
      description: r['description'],
      source: r['source'],
      status: r['status'],
      version: r['version'],
      authorId: r['author_id'],
      authorName: r['author_name'],
      category: r['category'],
      tags: fromJson<string[]>(r['tags'] as string),
      tools: fromJson(r['tools'] as string),
      readme: r['readme'],
      requiredPermissions: fromJson<string[]>(r['required_permissions'] as string),
      requiredEnv: fromJson<string[]>(r['required_env'] as string),
      config: fromJson(r['config'] as string),
      downloadCount: r['download_count'],
      avgRating: r['avg_rating'],
      ratingCount: r['rating_count'],
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
      publishedAt: toDate(r['published_at'] as string),
    };
  }
}

export class SqliteMarketplaceRatingRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    id: string;
    targetType: string;
    targetId: string;
    userId: string;
    rating: number;
    review?: string;
  }) {
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO marketplace_ratings (id, target_type, target_id, user_id, rating, review, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        data.id,
        data.targetType,
        data.targetId,
        data.userId,
        data.rating,
        data.review ?? null,
        ts,
        ts
      );
    return this.findByTarget(data.targetType as 'template' | 'skill', data.targetId)[0];
  }

  findByTarget(targetType: string, targetId: string, opts?: { limit?: number; offset?: number }) {
    return (
      this.db
        .prepare(
          'SELECT * FROM marketplace_ratings WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
        )
        .all(targetType, targetId, opts?.limit ?? 50, opts?.offset ?? 0) as Record<
        string,
        unknown
      >[]
    ).map(r => this._map(r));
  }

  findByUser(userId: string, targetType?: string) {
    if (targetType) {
      return (
        this.db
          .prepare('SELECT * FROM marketplace_ratings WHERE user_id = ? AND target_type = ?')
          .all(userId, targetType) as Record<string, unknown>[]
      ).map(r => this._map(r));
    }
    return (
      this.db.prepare('SELECT * FROM marketplace_ratings WHERE user_id = ?').all(userId) as Record<
        string,
        unknown
      >[]
    ).map(r => this._map(r));
  }

  findUserRating(userId: string, targetType: string, targetId: string) {
    const r = this.db
      .prepare(
        'SELECT * FROM marketplace_ratings WHERE user_id = ? AND target_type = ? AND target_id = ?'
      )
      .get(userId, targetType, targetId) as Record<string, unknown> | undefined;
    return r ? this._map(r) : undefined;
  }

  update(id: string, data: { rating?: number; review?: string }) {
    const sets: string[] = [];
    const vals: SqlParams = [];
    if (data.rating !== undefined) {
      sets.push('rating = ?');
      vals.push(data.rating);
    }
    if (data.review !== undefined) {
      sets.push('review = ?');
      vals.push(data.review);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE marketplace_ratings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM marketplace_ratings WHERE id = ?').run(id);
  }

  getAggregation(targetType: string, targetId: string) {
    const r = this.db
      .prepare(
        'SELECT AVG(rating) as avg, COUNT(*) as count FROM marketplace_ratings WHERE target_type = ? AND target_id = ?'
      )
      .get(targetType, targetId) as { avg: number | null; count: number };
    return { avg: Math.round(r.avg ?? 0), count: r.count };
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'],
      targetType: r['target_type'],
      targetId: r['target_id'],
      userId: r['user_id'],
      rating: r['rating'],
      review: r['review'],
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
    };
  }
}

export class SqliteAgentKnowledgeRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    id: string;
    agentId: string;
    orgId: string;
    category: string;
    title: string;
    content: string;
    tags?: string[];
    source?: string;
    metadata?: Record<string, unknown>;
    importance?: number;
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO agent_knowledge (id, agent_id, org_id, category, title, content, tags, source, metadata, importance, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        data.id,
        data.agentId,
        data.orgId,
        data.category,
        data.title,
        data.content,
        toJson(data.tags ?? []),
        data.source ?? 'agent',
        toJson(data.metadata ?? {}),
        data.importance ?? 50,
        ts,
        ts
      );
    return this.findById(data.id)!;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM agent_knowledge WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this._map(r) : undefined;
  }

  findByAgent(agentId: string, opts?: { category?: string; limit?: number }) {
    let q = 'SELECT * FROM agent_knowledge WHERE agent_id = ?';
    const vals: SqlParams = [agentId];
    if (opts?.category) {
      q += ' AND category = ?';
      vals.push(opts.category);
    }
    q += ' ORDER BY updated_at DESC LIMIT ?';
    vals.push(opts?.limit ?? 50);
    return (this.db.prepare(q).all(...vals) as Record<string, unknown>[]).map(r => this._map(r));
  }

  search(agentId: string, query: string, limit = 10) {
    return (
      this.db
        .prepare(
          'SELECT * FROM agent_knowledge WHERE agent_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY importance DESC, updated_at DESC LIMIT ?'
        )
        .all(agentId, `%${query}%`, `%${query}%`, limit) as Record<string, unknown>[]
    ).map(r => this._map(r));
  }

  searchByTags(agentId: string, tags: string[], limit = 10) {
    if (tags.length === 0) return [];
    const conditions = tags.map(() => `tags LIKE ?`).join(' OR ');
    const vals = [agentId, ...tags.map(t => `%"${t}"%`), limit];
    return (
      this.db
        .prepare(
          `SELECT * FROM agent_knowledge WHERE agent_id = ? AND (${conditions}) ORDER BY importance DESC LIMIT ?`
        )
        .all(...vals) as Record<string, unknown>[]
    ).map(r => this._map(r));
  }

  recordAccess(id: string) {
    this.db
      .prepare(
        'UPDATE agent_knowledge SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?'
      )
      .run(now(), id);
  }

  update(
    id: string,
    data: Partial<{
      title: string;
      content: string;
      category: string;
      tags: string[];
      importance: number;
      metadata: Record<string, unknown>;
    }>
  ) {
    const sets: string[] = [];
    const vals: SqlParams = [];
    if (data.title !== undefined) {
      sets.push('title = ?');
      vals.push(data.title);
    }
    if (data.content !== undefined) {
      sets.push('content = ?');
      vals.push(data.content);
    }
    if (data.category !== undefined) {
      sets.push('category = ?');
      vals.push(data.category);
    }
    if (data.tags !== undefined) {
      sets.push('tags = ?');
      vals.push(toJson(data.tags));
    }
    if (data.importance !== undefined) {
      sets.push('importance = ?');
      vals.push(data.importance);
    }
    if (data.metadata !== undefined) {
      sets.push('metadata = ?');
      vals.push(toJson(data.metadata));
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE agent_knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM agent_knowledge WHERE id = ?').run(id);
  }

  deleteByAgent(agentId: string) {
    this.db.prepare('DELETE FROM agent_knowledge WHERE agent_id = ?').run(agentId);
  }

  countByAgent(agentId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) as cnt FROM agent_knowledge WHERE agent_id = ?')
      .get(agentId) as { cnt: number };
    return r.cnt;
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'],
      agentId: r['agent_id'],
      orgId: r['org_id'],
      category: r['category'],
      title: r['title'],
      content: r['content'],
      tags: fromJson<string[]>(r['tags'] as string),
      source: r['source'],
      metadata: fromJson<Record<string, unknown>>(r['metadata'] as string),
      importance: r['importance'],
      accessCount: r['access_count'],
      lastAccessedAt: toDate(r['last_accessed_at'] as string),
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
    };
  }
}

// ─── External Agent Registration ──────────────────────────────────────────────

export interface SqliteExternalAgentRegistration {
  externalAgentId: string;
  agentName: string;
  orgId: string;
  capabilities: string[];
  platform?: string;
  platformConfig?: string;
  agentCardUrl?: string;
  /** @deprecated Use platformConfig */
  openClawConfig?: string;
  registeredAt: string;
  markusAgentId?: string;
  lastHeartbeat?: string;
  connected: boolean;
}

export class SqliteExternalAgentRepo {
  constructor(private db: DatabaseSync) {}

  async save(reg: SqliteExternalAgentRegistration): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO external_agent_registrations
        (external_agent_id, org_id, agent_name, markus_agent_id, capabilities,
         platform, platform_config, agent_card_url, openclaw_config,
         connected, last_heartbeat, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reg.externalAgentId,
      reg.orgId,
      reg.agentName,
      reg.markusAgentId ?? null,
      toJson(reg.capabilities),
      reg.platform ?? null,
      reg.platformConfig ?? null,
      reg.agentCardUrl ?? null,
      reg.openClawConfig ?? null,
      reg.connected ? 1 : 0,
      reg.lastHeartbeat ?? null,
      reg.registeredAt,
      now(),
    );
  }

  async delete(externalAgentId: string, orgId: string): Promise<boolean> {
    const result = this.db.prepare(
      'DELETE FROM external_agent_registrations WHERE external_agent_id = ? AND org_id = ?'
    ).run(externalAgentId, orgId);
    return result.changes > 0;
  }

  async update(externalAgentId: string, orgId: string, patch: { connected?: boolean; lastHeartbeat?: string }): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const vals: SqlParams = [now()];
    if (patch.connected !== undefined) { sets.push('connected = ?'); vals.push(patch.connected ? 1 : 0); }
    if (patch.lastHeartbeat !== undefined) { sets.push('last_heartbeat = ?'); vals.push(patch.lastHeartbeat); }
    vals.push(externalAgentId, orgId);
    this.db.prepare(`UPDATE external_agent_registrations SET ${sets.join(', ')} WHERE external_agent_id = ? AND org_id = ?`).run(...vals);
  }

  async loadAll(): Promise<SqliteExternalAgentRegistration[]> {
    const rows = this.db.prepare('SELECT * FROM external_agent_registrations').all() as Record<string, unknown>[];
    return rows.map(r => ({
      externalAgentId: r['external_agent_id'] as string,
      agentName: r['agent_name'] as string,
      orgId: r['org_id'] as string,
      capabilities: fromJson<string[]>(r['capabilities'] as string) ?? [],
      platform: r['platform'] as string | undefined,
      platformConfig: r['platform_config'] as string | undefined,
      agentCardUrl: r['agent_card_url'] as string | undefined,
      openClawConfig: r['openclaw_config'] as string | undefined,
      registeredAt: r['registered_at'] as string,
      markusAgentId: r['markus_agent_id'] as string | undefined,
      lastHeartbeat: r['last_heartbeat'] as string | undefined,
      connected: !!(r['connected'] as number),
    }));
  }
}

// ─── Deliverables ──────────────────────────────────────────────────────────────

export class SqliteDeliverableRepo {
  constructor(private db: DatabaseSync) {}

  async create(data: {
    id: string; type: string; title: string; summary: string; reference?: string;
    tags?: string[]; status?: string; taskId?: string; agentId?: string;
    projectId?: string; requirementId?: string;
    diffStats?: Record<string, number>; testResults?: Record<string, number>;
    artifactType?: string; artifactData?: Record<string, unknown>;
  }) {
    const n = now();
    this.db.prepare(`
      INSERT INTO deliverables (id, type, title, summary, reference, tags, status,
        task_id, agent_id, project_id, requirement_id, diff_stats, test_results,
        artifact_type, artifact_data, access_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      data.id, data.type, data.title, data.summary, data.reference ?? '',
      toJson(data.tags ?? []), data.status ?? 'active',
      data.taskId ?? null, data.agentId ?? null, data.projectId ?? null,
      data.requirementId ?? null,
      data.diffStats ? toJson(data.diffStats) : null,
      data.testResults ? toJson(data.testResults) : null,
      data.artifactType ?? null,
      data.artifactData ? toJson(data.artifactData) : null,
      n, n,
    );
    return this.findById(data.id);
  }

  async findById(id: string) {
    const r = this.db.prepare('SELECT * FROM deliverables WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.mapRow(r) : null;
  }

  async search(opts: { query?: string; projectId?: string; agentId?: string; taskId?: string; type?: string; status?: string; limit?: number }) {
    const where: string[] = [];
    const params: SqlParams = [];
    if (opts.query) { where.push("(title LIKE ? OR summary LIKE ? OR tags LIKE ?)"); const q = `%${opts.query}%`; params.push(q, q, q); }
    if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
    if (opts.agentId) { where.push('agent_id = ?'); params.push(opts.agentId); }
    if (opts.taskId) { where.push('task_id = ?'); params.push(opts.taskId); }
    if (opts.type) { where.push('type = ?'); params.push(opts.type); }
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const rows = this.db.prepare(`SELECT * FROM deliverables ${clause} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async update(id: string, patch: Record<string, unknown>) {
    const sets: string[] = ['updated_at = ?'];
    const vals: SqlParams = [now()];
    if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title as SQLInputValue); }
    if (patch.summary !== undefined) { sets.push('summary = ?'); vals.push(patch.summary as SQLInputValue); }
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status as SQLInputValue); }
    if (patch.tags !== undefined) { sets.push('tags = ?'); vals.push(toJson(patch.tags)); }
    if (patch.reference !== undefined) { sets.push('reference = ?'); vals.push(patch.reference as SQLInputValue); }
    if (patch.type !== undefined) { sets.push('type = ?'); vals.push(patch.type as SQLInputValue); }
    if (patch.artifactType !== undefined) { sets.push('artifact_type = ?'); vals.push(patch.artifactType as SQLInputValue); }
    if (patch.artifactData !== undefined) { sets.push('artifact_data = ?'); vals.push(toJson(patch.artifactData)); }
    if (patch.diffStats !== undefined) { sets.push('diff_stats = ?'); vals.push(toJson(patch.diffStats)); }
    if (patch.testResults !== undefined) { sets.push('test_results = ?'); vals.push(toJson(patch.testResults)); }
    vals.push(id);
    this.db.prepare(`UPDATE deliverables SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.findById(id);
  }

  async recordAccess(id: string) {
    this.db.prepare('UPDATE deliverables SET access_count = access_count + 1 WHERE id = ?').run(id);
  }

  async remove(id: string) {
    this.db.prepare("UPDATE deliverables SET status = 'outdated', updated_at = ? WHERE id = ?").run(now(), id);
  }

  async listAll(limit = 500) {
    const rows = this.db.prepare("SELECT * FROM deliverables WHERE status != 'outdated' ORDER BY updated_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async listTaskIdsWithDeliverables(): Promise<Set<string>> {
    const rows = this.db.prepare('SELECT DISTINCT task_id FROM deliverables WHERE task_id IS NOT NULL').all() as Array<{ task_id: string }>;
    return new Set(rows.map(r => r.task_id));
  }

  async deleteByTask(taskId: string) {
    this.db.prepare('DELETE FROM deliverables WHERE task_id = ?').run(taskId);
  }

  private mapRow(r: Record<string, unknown>) {
    return {
      id: r['id'] as string,
      type: r['type'] as string,
      title: r['title'] as string,
      summary: r['summary'] as string,
      reference: r['reference'] as string,
      tags: fromJson<string[]>(r['tags'] as string) ?? [],
      status: r['status'] as string,
      taskId: r['task_id'] as string | null,
      agentId: r['agent_id'] as string | null,
      projectId: r['project_id'] as string | null,
      requirementId: r['requirement_id'] as string | null,
      diffStats: fromJson<Record<string, number>>(r['diff_stats'] as string),
      testResults: fromJson<Record<string, number>>(r['test_results'] as string),
      artifactType: r['artifact_type'] as string | null,
      artifactData: r['artifact_data'] ? fromJson<Record<string, unknown>>(r['artifact_data'] as string) : null,
      accessCount: (r['access_count'] as number) ?? 0,
      createdAt: r['created_at'] ? new Date(r['created_at'] as string) : new Date(),
      updatedAt: r['updated_at'] ? new Date(r['updated_at'] as string) : new Date(),
    };
  }
}

// ─── Activity Repository ──────────────────────────────────────────────────────

export interface ActivityRecord {
  id: string;
  agentId: string;
  mailboxItemId?: string;
  type: string;
  label: string;
  taskId?: string | null;
  startedAt: string;
  endedAt?: string | null;
  totalTokens: number;
  totalTools: number;
  success: boolean;
  summary: string;
  keywords: string;
  createdAt: string;
}

export interface ActivityLogRecord {
  id: number;
  activityId: string;
  seq: number;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export class SqliteActivityRepo {
  constructor(private db: DatabaseSync) {}

  insertActivity(data: {
    id: string;
    agentId: string;
    type: string;
    label: string;
    taskId?: string;
    mailboxItemId?: string;
    startedAt: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO agent_activities (id, agent_id, mailbox_item_id, type, label, task_id, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(data.id, data.agentId, data.mailboxItemId ?? null, data.type, data.label, data.taskId ?? null, data.startedAt, now());
  }

  updateActivity(
    activityId: string,
    update: { endedAt?: string; totalTokens?: number; totalTools?: number; success?: boolean; summary?: string; keywords?: string }
  ): void {
    const sets: string[] = [];
    const vals: SqlParams = [];
    if (update.endedAt !== undefined) { sets.push('ended_at = ?'); vals.push(update.endedAt); }
    if (update.totalTokens !== undefined) { sets.push('total_tokens = ?'); vals.push(update.totalTokens); }
    if (update.totalTools !== undefined) { sets.push('total_tools = ?'); vals.push(update.totalTools); }
    if (update.success !== undefined) { sets.push('success = ?'); vals.push(update.success ? 1 : 0); }
    if (update.summary !== undefined) { sets.push('summary = ?'); vals.push(update.summary); }
    if (update.keywords !== undefined) { sets.push('keywords = ?'); vals.push(update.keywords); }
    if (sets.length === 0) return;
    vals.push(activityId);
    this.db.prepare(`UPDATE agent_activities SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  insertActivityLog(data: {
    activityId: string;
    seq: number;
    type: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        'INSERT INTO agent_activity_logs (activity_id, seq, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(data.activityId, data.seq, data.type, data.content, toJson(data.metadata ?? {}), now());
  }

  queryActivities(
    agentId: string,
    opts?: { type?: string; limit?: number; before?: string }
  ): ActivityRecord[] {
    const conditions = ['agent_id = ?'];
    const params: SqlParams = [agentId];

    if (opts?.type) {
      const types = opts.type.split(',').map(t => t.trim()).filter(Boolean);
      if (types.length > 0) {
        conditions.push(`type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
    }
    if (opts?.before) {
      conditions.push('started_at < ?');
      params.push(opts.before);
    }

    const limit = opts?.limit ?? 30;
    params.push(limit);

    const sql = `SELECT * FROM agent_activities WHERE ${conditions.join(' AND ')} ORDER BY started_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.mapActivity(r));
  }

  getActivityLogs(activityId: string): ActivityLogRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_activity_logs WHERE activity_id = ? ORDER BY seq ASC')
      .all(activityId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r['id'] as number,
      activityId: r['activity_id'] as string,
      seq: r['seq'] as number,
      type: r['type'] as string,
      content: r['content'] as string,
      metadata: fromJson<Record<string, unknown>>(r['metadata'] as string) ?? {},
      createdAt: r['created_at'] as string,
    }));
  }

  getActivity(activityId: string): ActivityRecord | null {
    const r = this.db.prepare('SELECT * FROM agent_activities WHERE id = ?').get(activityId) as Record<string, unknown> | undefined;
    return r ? this.mapActivity(r) : null;
  }

  getByMailboxItemId(mailboxItemId: string): ActivityRecord | null {
    const r = this.db.prepare('SELECT * FROM agent_activities WHERE mailbox_item_id = ? LIMIT 1').get(mailboxItemId) as Record<string, unknown> | undefined;
    return r ? this.mapActivity(r) : null;
  }

  searchActivities(
    agentId: string,
    query: string,
    opts?: { limit?: number }
  ): ActivityRecord[] {
    const limit = opts?.limit ?? 10;
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    if (terms.length === 0) return [];

    const conditions = ['agent_id = ?'];
    const params: SqlParams = [agentId];

    const searchClauses = terms.map(() =>
      "(LOWER(summary) LIKE '%' || ? || '%' OR LOWER(keywords) LIKE '%' || ? || '%' OR LOWER(label) LIKE '%' || ? || '%')"
    );
    conditions.push(`(${searchClauses.join(' AND ')})`);
    for (const t of terms) {
      params.push(t, t, t);
    }

    params.push(limit);
    const sql = `SELECT * FROM agent_activities WHERE ${conditions.join(' AND ')} ORDER BY started_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.mapActivity(r));
  }

  private mapActivity(r: Record<string, unknown>): ActivityRecord {
    return {
      id: r['id'] as string,
      agentId: r['agent_id'] as string,
      mailboxItemId: (r['mailbox_item_id'] as string | null) ?? undefined,
      type: r['type'] as string,
      label: r['label'] as string,
      taskId: r['task_id'] as string | null,
      startedAt: r['started_at'] as string,
      endedAt: r['ended_at'] as string | null,
      totalTokens: (r['total_tokens'] as number) ?? 0,
      totalTools: (r['total_tools'] as number) ?? 0,
      success: (r['success'] as number) !== 0,
      summary: (r['summary'] as string) ?? '',
      keywords: (r['keywords'] as string) ?? '',
      createdAt: r['created_at'] as string,
    };
  }
}

// ─── Unified Execution Stream Repo ──────────────────────────────────────────

export interface ExecutionStreamRow {
  id: string;
  sourceType: string;
  sourceId: string;
  agentId: string;
  seq: number;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
  executionRound: number | null;
  createdAt: string;
}

export class SqliteExecutionStreamRepo {
  constructor(private db: DatabaseSync) {}

  append(data: {
    sourceType: string;
    sourceId: string;
    agentId: string;
    seq: number;
    type: string;
    content: string;
    metadata?: unknown;
    executionRound?: number;
  }): ExecutionStreamRow {
    const id = generateId('esl');
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO execution_stream_logs (id, source_type, source_id, agent_id, seq, type, content, metadata, execution_round, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, data.sourceType, data.sourceId, data.agentId, data.seq, data.type, data.content, toJson(data.metadata ?? {}), data.executionRound ?? null, ts);
    return {
      id,
      sourceType: data.sourceType,
      sourceId: data.sourceId,
      agentId: data.agentId,
      seq: data.seq,
      type: data.type,
      content: data.content,
      metadata: (data.metadata as Record<string, unknown>) ?? {},
      executionRound: data.executionRound ?? null,
      createdAt: ts,
    };
  }

  getBySource(sourceType: string, sourceId: string): ExecutionStreamRow[] {
    const rows = this.db
      .prepare('SELECT * FROM execution_stream_logs WHERE source_type = ? AND source_id = ? ORDER BY seq ASC')
      .all(sourceType, sourceId) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  getMaxSeq(sourceType: string, sourceId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) as maxSeq FROM execution_stream_logs WHERE source_type = ? AND source_id = ?')
      .get(sourceType, sourceId) as { maxSeq: number | null } | undefined;
    return row?.maxSeq ?? -1;
  }

  deleteBySource(sourceType: string, sourceId: string): void {
    this.db.prepare('DELETE FROM execution_stream_logs WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
  }

  private mapRow(r: Record<string, unknown>): ExecutionStreamRow {
    return {
      id: r['id'] as string,
      sourceType: r['source_type'] as string,
      sourceId: r['source_id'] as string,
      agentId: r['agent_id'] as string,
      seq: r['seq'] as number,
      type: r['type'] as string,
      content: r['content'] as string,
      metadata: fromJson<Record<string, unknown>>(r['metadata'] as string) ?? {},
      executionRound: r['execution_round'] as number | null,
      createdAt: r['created_at'] as string,
    };
  }
}

// ─── Mailbox persistence ──────────────────────────────────────────────────────

export interface MailboxItemRow {
  id: string;
  agentId: string;
  sourceType: string;
  priority: number;
  status: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  deferredUntil: string | null;
  mergedInto: string | null;
  retryCount: number;
}

export class SqliteMailboxRepo {
  constructor(private db: DatabaseSync) {}

  save(item: {
    id: string;
    agentId: string;
    sourceType: string;
    priority: number;
    status: string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    queuedAt: string;
  }): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        item.id, item.agentId, item.sourceType, item.priority,
        item.status, toJson(item.payload), toJson(item.metadata ?? {}),
        item.queuedAt,
      );
  }

  updateStatus(itemId: string, status: string, extra?: Record<string, unknown>): void {
    const parts = ['status = ?'];
    const params: (string | number | null)[] = [status];
    if (extra?.startedAt) { parts.push('started_at = ?'); params.push(extra.startedAt as string); }
    if (extra?.completedAt) { parts.push('completed_at = ?'); params.push(extra.completedAt as string); }
    if (extra?.deferredUntil !== undefined) { parts.push('deferred_until = ?'); params.push((extra.deferredUntil as string) ?? null); }
    if (extra?.mergedInto !== undefined) { parts.push('merged_into = ?'); params.push((extra.mergedInto as string) ?? null); }
    if (extra?.retryCount !== undefined) { parts.push('retry_count = ?'); params.push(extra.retryCount as number); }
    params.push(itemId);
    this.db.prepare(`UPDATE mailbox_items SET ${parts.join(', ')} WHERE id = ?`).run(...params);
  }

  markStaleProcessingAsDropped(agentId: string): number {
    const result = this.db
      .prepare("UPDATE mailbox_items SET status = 'dropped' WHERE agent_id = ? AND status = 'processing'")
      .run(agentId);
    return (result as { changes?: number }).changes ?? 0;
  }

  getByAgent(agentId: string, options?: { status?: string; limit?: number }): MailboxItemRow[] {
    let sql = 'SELECT * FROM mailbox_items WHERE agent_id = ?';
    const params: (string | number | null)[] = [agentId];
    if (options?.status) { sql += ' AND status = ?'; params.push(options.status); }
    sql += ' ORDER BY priority ASC, queued_at ASC';
    if (options?.limit) { sql += ' LIMIT ?'; params.push(options.limit); }
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(r => this.mapRow(r));
  }

  getById(id: string): MailboxItemRow | undefined {
    const row = this.db.prepare('SELECT * FROM mailbox_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getHistory(agentId: string, opts?: { limit?: number; offset?: number; sourceTypes?: string[]; status?: string }): MailboxItemRow[] {
    const conditions = ['agent_id = ?'];
    const params: (string | number)[] = [agentId];
    if (opts?.sourceTypes && opts.sourceTypes.length > 0) {
      conditions.push(`source_type IN (${opts.sourceTypes.map(() => '?').join(',')})`);
      params.push(...opts.sourceTypes);
    }
    if (opts?.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    params.push(limit, offset);
    return (this.db
      .prepare(`SELECT * FROM mailbox_items WHERE ${conditions.join(' AND ')} ORDER BY queued_at DESC LIMIT ? OFFSET ?`)
      .all(...params) as Record<string, unknown>[]).map(r => this.mapRow(r));
  }

  private mapRow(r: Record<string, unknown>): MailboxItemRow {
    return {
      id: r['id'] as string,
      agentId: r['agent_id'] as string,
      sourceType: r['source_type'] as string,
      priority: r['priority'] as number,
      status: r['status'] as string,
      payload: fromJson<Record<string, unknown>>(r['payload'] as string) ?? {},
      metadata: fromJson<Record<string, unknown>>(r['metadata'] as string) ?? {},
      queuedAt: r['queued_at'] as string,
      startedAt: r['started_at'] as string | null,
      completedAt: r['completed_at'] as string | null,
      deferredUntil: r['deferred_until'] as string | null,
      mergedInto: r['merged_into'] as string | null,
      retryCount: (r['retry_count'] as number) ?? 0,
    };
  }
}

export interface DecisionRow {
  id: string;
  agentId: string;
  decisionType: string;
  mailboxItemId: string;
  context: Record<string, unknown>;
  reasoning: string;
  outcome: string | null;
  createdAt: string;
}

export class SqliteDecisionRepo {
  constructor(private db: DatabaseSync) {}

  save(decision: {
    id: string;
    agentId: string;
    decisionType: string;
    mailboxItemId: string;
    context: Record<string, unknown>;
    reasoning: string;
    outcome?: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO agent_decisions (id, agent_id, decision_type, mailbox_item_id, context, reasoning, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        decision.id, decision.agentId, decision.decisionType,
        decision.mailboxItemId, toJson(decision.context), decision.reasoning,
        decision.outcome ?? null, decision.createdAt,
      );
  }

  getByAgent(agentId: string, limit = 50, offset = 0): DecisionRow[] {
    return (this.db
      .prepare('SELECT * FROM agent_decisions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(agentId, limit, offset) as Record<string, unknown>[]).map(r => this.mapRow(r));
  }

  getByMailboxItemId(mailboxItemId: string): DecisionRow[] {
    return (this.db
      .prepare('SELECT * FROM agent_decisions WHERE mailbox_item_id = ? ORDER BY created_at ASC')
      .all(mailboxItemId) as Record<string, unknown>[]).map(r => this.mapRow(r));
  }

  private mapRow(r: Record<string, unknown>): DecisionRow {
    return {
      id: r['id'] as string,
      agentId: r['agent_id'] as string,
      decisionType: r['decision_type'] as string,
      mailboxItemId: r['mailbox_item_id'] as string,
      context: fromJson<Record<string, unknown>>(r['context'] as string) ?? {},
      reasoning: r['reasoning'] as string,
      outcome: r['outcome'] as string | null,
      createdAt: r['created_at'] as string,
    };
  }
}

// ─── User Notifications ──────────────────────────────────────────────────────

export interface NotificationRow {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  read: boolean;
  actionType: string;
  actionTarget: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export class SqliteNotificationRepo {
  constructor(private db: DatabaseSync) {}

  insert(n: NotificationRow): void {
    this.db.prepare(
      `INSERT INTO user_notifications (id, user_id, type, title, body, priority, read, action_type, action_target, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      n.id,
      n.userId,
      n.type,
      n.title,
      n.body,
      n.priority,
      n.read ? 1 : 0,
      n.actionType,
      n.actionTarget,
      n.metadata ? JSON.stringify(n.metadata) : null,
      n.createdAt,
    );
  }

  list(userId: string, opts?: { unreadOnly?: boolean; limit?: number; offset?: number; type?: string }): NotificationRow[] {
    const conditions = ['(user_id = ? OR user_id = ?)'];
    const params: SQLInputValue[] = [userId, 'all'];

    if (opts?.unreadOnly) {
      conditions.push('read = 0');
    }
    if (opts?.type) {
      conditions.push('type = ?');
      params.push(opts.type);
    }

    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const sql = `SELECT * FROM user_notifications WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(r => this.mapRow(r));
  }

  count(userId: string, unreadOnly = false): number {
    const conditions = ['(user_id = ? OR user_id = ?)'];
    const params: SQLInputValue[] = [userId, 'all'];
    if (unreadOnly) conditions.push('read = 0');

    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM user_notifications WHERE ${conditions.join(' AND ')}`
    ).get(...params) as { cnt: number };
    return row.cnt;
  }

  markRead(id: string): boolean {
    const info = this.db.prepare('UPDATE user_notifications SET read = 1 WHERE id = ?').run(id);
    return info.changes > 0;
  }

  markAllRead(userId: string): number {
    const info = this.db.prepare(
      'UPDATE user_notifications SET read = 1 WHERE (user_id = ? OR user_id = ?) AND read = 0'
    ).run(userId, 'all');
    return Number(info.changes);
  }

  /**
   * Migrate notifications with user_id = 'default' to the real owner userId.
   */
  migrateDefaultUserId(realOwnerId: string): number {
    if (realOwnerId === 'default') return 0;
    const result = this.db.prepare(
      "UPDATE user_notifications SET user_id = ? WHERE user_id = 'default'"
    ).run(realOwnerId);
    const count = Number(result.changes);
    if (count > 0) {
      log.info(`Migrated ${count} notifications from user_id='default' to ${realOwnerId}`);
    }
    return count;
  }

  private mapRow(r: Record<string, unknown>): NotificationRow {
    return {
      id: r['id'] as string,
      userId: r['user_id'] as string,
      type: r['type'] as string,
      title: r['title'] as string,
      body: r['body'] as string,
      priority: r['priority'] as string,
      read: !!(r['read'] as number),
      actionType: r['action_type'] as string,
      actionTarget: r['action_target'] as string | null,
      metadata: fromJson<Record<string, unknown>>(r['metadata'] as string),
      createdAt: r['created_at'] as string,
    };
  }
}

// ─── SQLite Approval Repo ────────────────────────────────────────────────────

export interface ApprovalRow {
  id: string;
  agentId: string;
  agentName: string;
  type: string;
  title: string;
  description: string;
  details: Record<string, unknown>;
  status: string;
  requestedAt: string;
  respondedAt?: string;
  respondedBy?: string;
  responseComment?: string;
  expiresAt?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  allowFreeform?: boolean;
  selectedOption?: string;
  approverUserIds?: string[];
  targetUserId?: string;
}

export class SqliteApprovalRepo {
  constructor(private db: DatabaseSync) {}

  upsert(a: ApprovalRow): void {
    this.db.prepare(
      `INSERT INTO approvals (id, agent_id, agent_name, type, title, description, details, status, requested_at, responded_at, responded_by, response_comment, expires_at, options, allow_freeform, selected_option, approver_user_ids, target_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         responded_at = excluded.responded_at,
         responded_by = excluded.responded_by,
         response_comment = excluded.response_comment,
         selected_option = excluded.selected_option`
    ).run(
      a.id,
      a.agentId,
      a.agentName,
      a.type,
      a.title,
      a.description,
      JSON.stringify(a.details),
      a.status,
      a.requestedAt,
      a.respondedAt ?? null,
      a.respondedBy ?? null,
      a.responseComment ?? null,
      a.expiresAt ?? null,
      a.options ? JSON.stringify(a.options) : null,
      a.allowFreeform ? 1 : 0,
      a.selectedOption ?? null,
      a.approverUserIds?.length ? JSON.stringify(a.approverUserIds) : null,
      a.targetUserId ?? null,
    );
  }

  list(status?: string): ApprovalRow[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM approvals ${where} ORDER BY requested_at DESC LIMIT 200`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(r => this.mapRow(r));
  }

  get(id: string): ApprovalRow | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.mapRow(r) : undefined;
  }

  private mapRow(r: Record<string, unknown>): ApprovalRow {
    return {
      id: r['id'] as string,
      agentId: r['agent_id'] as string,
      agentName: r['agent_name'] as string,
      type: r['type'] as string,
      title: r['title'] as string,
      description: r['description'] as string,
      details: fromJson<Record<string, unknown>>(r['details'] as string) ?? {},
      status: r['status'] as string,
      requestedAt: r['requested_at'] as string,
      respondedAt: r['responded_at'] as string | undefined,
      respondedBy: r['responded_by'] as string | undefined,
      responseComment: r['response_comment'] as string | undefined,
      expiresAt: r['expires_at'] as string | undefined,
      options: fromJson<Array<{ id: string; label: string; description?: string }>>(r['options'] as string) ?? undefined,
      allowFreeform: !!(r['allow_freeform'] as number),
      selectedOption: r['selected_option'] as string | undefined,
      approverUserIds: fromJson<string[]>(r['approver_user_ids'] as string) ?? undefined,
      targetUserId: (r['target_user_id'] as string) ?? undefined,
    };
  }

  /**
   * Migrate approvals with target_user_id = 'default' to real owner ID.
   */
  migrateDefaultTargetUserId(realOwnerId: string): number {
    if (realOwnerId === 'default') return 0;
    const result = this.db.prepare(
      "UPDATE approvals SET target_user_id = ? WHERE target_user_id = 'default'"
    ).run(realOwnerId);
    const count = Number(result.changes);
    if (count > 0) {
      log.info(`Migrated ${count} approvals from target_user_id='default' to ${realOwnerId}`);
    }
    return count;
  }
}

// ─── Group Chat Repo ──────────────────────────────────────────────────────────

import type { GroupChat, GroupChatMember } from './types.ts';

export class SqliteGroupChatRepo {
  constructor(private db: DatabaseSync) {}

  create(data: {
    orgId: string;
    name: string;
    creatorId: string;
    creatorName: string;
    members: Array<{ id: string; type: 'human' | 'agent'; name: string }>;
  }): GroupChat & { members: GroupChatMember[] } {
    const id = generateId('gc');
    const channelKey = `group:custom:${id}`;
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO group_chats (id, org_id, name, channel_key, creator_id, creator_name, created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(id, data.orgId, data.name, channelKey, data.creatorId, data.creatorName, ts);

    const insertMember = this.db.prepare(
      'INSERT OR IGNORE INTO group_chat_members (group_chat_id, member_id, member_type, member_name, added_at) VALUES (?,?,?,?,?)'
    );
    const members: GroupChatMember[] = [];
    for (const m of data.members) {
      insertMember.run(id, m.id, m.type, m.name, ts);
      members.push({ groupChatId: id, memberId: m.id, memberType: m.type as 'human' | 'agent', memberName: m.name, addedAt: new Date(ts) });
    }

    return {
      id, orgId: data.orgId, name: data.name, channelKey, creatorId: data.creatorId,
      creatorName: data.creatorName, createdAt: new Date(ts), members,
    };
  }

  list(orgId: string): Array<GroupChat & { memberCount: number }> {
    const rows = this.db.prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM group_chat_members WHERE group_chat_id = g.id) AS member_count
       FROM group_chats g WHERE g.org_id = ? ORDER BY g.created_at DESC`
    ).all(orgId) as Record<string, unknown>[];
    return rows.map(r => ({
      ...this.mapRow(r),
      memberCount: r['member_count'] as number,
    }));
  }

  getById(id: string): (GroupChat & { members: GroupChatMember[] }) | undefined {
    const r = this.db.prepare('SELECT * FROM group_chats WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const members = this.getMembers(id);
    return { ...this.mapRow(r), members };
  }

  getByChannelKey(channelKey: string): (GroupChat & { members: GroupChatMember[] }) | undefined {
    const r = this.db.prepare('SELECT * FROM group_chats WHERE channel_key = ?').get(channelKey) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const gc = this.mapRow(r);
    return { ...gc, members: this.getMembers(gc.id) };
  }

  getMembers(groupChatId: string): GroupChatMember[] {
    const rows = this.db.prepare('SELECT * FROM group_chat_members WHERE group_chat_id = ?').all(groupChatId) as Record<string, unknown>[];
    return rows.map(r => ({
      groupChatId: r['group_chat_id'] as string,
      memberId: r['member_id'] as string,
      memberType: r['member_type'] as 'human' | 'agent',
      memberName: r['member_name'] as string,
      addedAt: toDate(r['added_at'] as string)!,
    }));
  }

  getAgentMemberIds(channelKey: string): string[] {
    const gc = this.db.prepare('SELECT id FROM group_chats WHERE channel_key = ?').get(channelKey) as { id: string } | undefined;
    if (!gc) return [];
    const rows = this.db.prepare(
      "SELECT member_id FROM group_chat_members WHERE group_chat_id = ? AND member_type = 'agent'"
    ).all(gc.id) as Array<{ member_id: string }>;
    return rows.map(r => r.member_id);
  }

  getHumanMemberIds(channelKey: string): string[] {
    const gc = this.db.prepare('SELECT id FROM group_chats WHERE channel_key = ?').get(channelKey) as { id: string } | undefined;
    if (!gc) return [];
    const rows = this.db.prepare(
      "SELECT member_id FROM group_chat_members WHERE group_chat_id = ? AND member_type = 'human'"
    ).all(gc.id) as Array<{ member_id: string }>;
    return rows.map(r => r.member_id);
  }

  addMember(groupChatId: string, memberId: string, memberType: 'human' | 'agent', memberName: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO group_chat_members (group_chat_id, member_id, member_type, member_name, added_at) VALUES (?,?,?,?,?)'
    ).run(groupChatId, memberId, memberType, memberName, now());
  }

  removeMember(groupChatId: string, memberId: string): void {
    this.db.prepare('DELETE FROM group_chat_members WHERE group_chat_id = ? AND member_id = ?').run(groupChatId, memberId);
  }

  updateName(id: string, name: string): void {
    this.db.prepare('UPDATE group_chats SET name = ? WHERE id = ?').run(name, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM group_chats WHERE id = ?').run(id);
  }

  private mapRow(r: Record<string, unknown>): GroupChat {
    return {
      id: r['id'] as string,
      orgId: r['org_id'] as string,
      name: r['name'] as string,
      channelKey: r['channel_key'] as string,
      creatorId: r['creator_id'] as string,
      creatorName: r['creator_name'] as string,
      createdAt: toDate(r['created_at'] as string)!,
    };
  }
}

// ─── Auto-migration: task_logs + agent_activity_logs -> execution_stream_logs ─

export function migrateToExecutionStreamLogs(db: DatabaseSync): void {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM execution_stream_logs').get() as { cnt: number };
  if (countRow.cnt > 0) return;

  const taskLogCount = (db.prepare('SELECT COUNT(*) as cnt FROM task_logs').get() as { cnt: number }).cnt;
  if (taskLogCount > 0) {
    db.exec(`
      INSERT INTO execution_stream_logs (id, source_type, source_id, agent_id, seq, type, content, metadata, execution_round, created_at)
      SELECT id, 'task', task_id, agent_id, seq, type, content, metadata, execution_round, created_at
      FROM task_logs
    `);
    log.info(`Migration: copied ${taskLogCount} task_logs to execution_stream_logs`);
  }

  const actLogCount = (db.prepare('SELECT COUNT(*) as cnt FROM agent_activity_logs').get() as { cnt: number }).cnt;
  if (actLogCount > 0) {
    db.exec(`
      INSERT INTO execution_stream_logs (id, source_type, source_id, agent_id, seq, type, content, metadata, execution_round, created_at)
      SELECT 'alog_' || id, 'activity', activity_id,
             COALESCE((SELECT agent_id FROM agent_activities WHERE id = activity_id), ''),
             seq, type, content, metadata, NULL, created_at
      FROM agent_activity_logs
    `);
    log.info(`Migration: copied ${actLogCount} agent_activity_logs to execution_stream_logs`);
  }
}
