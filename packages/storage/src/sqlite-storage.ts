/**
 * SQLite storage backend — zero-dependency alternative to PostgreSQL.
 *
 * When no DATABASE_URL is configured, Markus uses this lightweight SQLite
 * implementation so users can run locally without Docker or external databases.
 *
 * Implements the same repo interfaces as the PostgreSQL Drizzle-based repos
 * so the rest of the application is completely unaware of the storage backend.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '@markus/shared';

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
  assigned_agent_id TEXT REFERENCES agents(id),
  parent_task_id TEXT,
  requirement_id TEXT,
  result TEXT,
  notes TEXT DEFAULT '[]',
  project_id TEXT,
  iteration_id TEXT,
  created_by TEXT,
  updated_by TEXT,
  started_at TEXT,
  completed_at TEXT,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, seq);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT,
  iteration_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  priority TEXT NOT NULL DEFAULT 'medium',
  source TEXT NOT NULL DEFAULT 'user',
  created_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  rejected_reason TEXT,
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
  iteration_model TEXT NOT NULL DEFAULT 'kanban',
  repositories TEXT DEFAULT '[]',
  team_ids TEXT DEFAULT '[]',
  governance_policy TEXT,
  archive_policy TEXT,
  report_schedule TEXT,
  onboarding_config TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

CREATE TABLE IF NOT EXISTS iterations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  goal TEXT,
  start_date TEXT,
  end_date TEXT,
  metrics TEXT,
  review_report TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_iterations_project ON iterations(project_id);

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
`;

// ─── Open / close ────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function openSqlite(dbPath: string): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

  for (const stmt of SCHEMA_SQL.split(';')
    .map(s => s.trim())
    .filter(Boolean)) {
    _db.exec(stmt);
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
  constructor(private db: Database.Database) {}

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
        `INSERT INTO organizations (id, name, owner_id, plan, max_agents, settings, created_at, updated_at)
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

  private _mapOrg(r: Record<string, unknown>) {
    return {
      ...r,
      settings: fromJson(r['settings'] as string),
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
    };
  }
}

export class SqliteAgentRepo {
  constructor(private db: Database.Database) {}

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
      this.db.prepare('SELECT * FROM agents WHERE org_id = ?').all(orgId) as Record<
        string,
        unknown
      >[]
    ).map(r => this._map(r));
  }

  listAll() {
    return (this.db.prepare('SELECT * FROM agents').all() as Record<string, unknown>[]).map(r =>
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

  delete(id: string) {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
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
      lastHeartbeat: toDate(r['last_heartbeat'] as string),
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
    };
  }
}

export class SqliteTaskRepo {
  constructor(private db: Database.Database) {}

  async create(data: {
    id: string;
    orgId: string;
    title: string;
    description?: string;
    priority?: string;
    assignedAgentId?: string;
    parentTaskId?: string;
    requirementId?: string;
    projectId?: string;
    iterationId?: string;
    createdBy?: string;
    dueAt?: Date;
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, org_id, title, description, priority, assigned_agent_id, parent_task_id, requirement_id, project_id, iteration_id, created_by, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.id,
        data.orgId,
        data.title,
        data.description ?? '',
        data.priority ?? 'medium',
        data.assignedAgentId ?? null,
        data.parentTaskId ?? null,
        data.requirementId ?? null,
        data.projectId ?? null,
        data.iterationId ?? null,
        data.createdBy ?? null,
        data.dueAt?.toISOString() ?? null,
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
    const vals: unknown[] = [status, ts];
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

  async assign(id: string, agentId: string | null) {
    this.db
      .prepare(
        "UPDATE tasks SET assigned_agent_id = ?, status = CASE WHEN ? IS NOT NULL THEN 'assigned' ELSE status END, updated_at = ? WHERE id = ?"
      )
      .run(agentId, agentId, now(), id);
  }

  async update(
    id: string,
    data: { title?: string; description?: string; priority?: string; notes?: string[]; projectId?: string | null; iterationId?: string | null }
  ) {
    const sets: string[] = [];
    const vals: unknown[] = [];
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
    if (data.projectId !== undefined) {
      sets.push('project_id = ?');
      vals.push(data.projectId);
    }
    if (data.iterationId !== undefined) {
      sets.push('iteration_id = ?');
      vals.push(data.iterationId);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  setResult(id: string, result: unknown) {
    this.db
      .prepare('UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?')
      .run(toJson(result), now(), id);
  }

  listByOrg(orgId: string, filters?: { status?: string; assignedAgentId?: string; projectId?: string; iterationId?: string }) {
    let q = 'SELECT * FROM tasks WHERE org_id = ?';
    const vals: unknown[] = [orgId];
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
    if (filters?.iterationId) {
      q += ' AND iteration_id = ?';
      vals.push(filters.iterationId);
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
      parentTaskId: r['parent_task_id'],
      requirementId: r['requirement_id'] as string | null,
      result: fromJson(r['result'] as string),
      notes: fromJson(r['notes'] as string),
      projectId: r['project_id'] as string | null,
      iterationId: r['iteration_id'] as string | null,
      createdBy: r['created_by'] as string | null,
      updatedBy: r['updated_by'] as string | null,
      startedAt: toDate(r['started_at'] as string),
      completedAt: toDate(r['completed_at'] as string),
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
      dueAt: toDate(r['due_at'] as string),
    };
  }
}

export class SqliteRequirementRepo {
  constructor(private db: Database.Database) {}

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
    iterationId?: string;
    approvedBy?: string;
    approvedAt?: Date;
    tags?: string[];
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO requirements (id, org_id, title, description, status, priority, source, created_by, project_id, iteration_id, approved_by, approved_at, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.id,
        data.orgId,
        data.title,
        data.description ?? '',
        data.status ?? 'draft',
        data.priority ?? 'medium',
        data.source,
        data.createdBy,
        data.projectId ?? null,
        data.iterationId ?? null,
        data.approvedBy ?? null,
        data.approvedAt?.toISOString() ?? null,
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
      .run('approved', approvedBy, ts, ts, id);
  }

  async reject(id: string, reason: string) {
    this.db
      .prepare('UPDATE requirements SET status = ?, rejected_reason = ?, updated_at = ? WHERE id = ?')
      .run('rejected', reason, now(), id);
  }

  async update(
    id: string,
    data: { title?: string; description?: string; priority?: string; tags?: string[]; projectId?: string | null; iterationId?: string | null }
  ) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (data.title !== undefined) { sets.push('title = ?'); vals.push(data.title); }
    if (data.description !== undefined) { sets.push('description = ?'); vals.push(data.description); }
    if (data.priority !== undefined) { sets.push('priority = ?'); vals.push(data.priority); }
    if (data.tags !== undefined) { sets.push('tags = ?'); vals.push(toJson(data.tags)); }
    if (data.projectId !== undefined) { sets.push('project_id = ?'); vals.push(data.projectId); }
    if (data.iterationId !== undefined) { sets.push('iteration_id = ?'); vals.push(data.iterationId); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE requirements SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  listByOrg(orgId: string, filters?: { status?: string; source?: string; projectId?: string; iterationId?: string }) {
    let q = 'SELECT * FROM requirements WHERE org_id = ?';
    const vals: unknown[] = [orgId];
    if (filters?.status) { q += ' AND status = ?'; vals.push(filters.status); }
    if (filters?.source) { q += ' AND source = ?'; vals.push(filters.source); }
    if (filters?.projectId) { q += ' AND project_id = ?'; vals.push(filters.projectId); }
    if (filters?.iterationId) { q += ' AND iteration_id = ?'; vals.push(filters.iterationId); }
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
      iterationId: r['iteration_id'] as string | null,
      title: r['title'],
      description: r['description'],
      status: r['status'],
      priority: r['priority'],
      source: r['source'],
      createdBy: r['created_by'],
      approvedBy: r['approved_by'] as string | null,
      approvedAt: toDate(r['approved_at'] as string),
      rejectedReason: r['rejected_reason'] as string | null,
      tags: fromJson<string[]>(r['tags'] as string),
      createdAt: toDate(r['created_at'] as string),
      updatedAt: toDate(r['updated_at'] as string),
    };
  }
}

export class SqliteProjectRepo {
  constructor(private db: Database.Database) {}

  async create(data: {
    id: string;
    orgId: string;
    name: string;
    description?: string;
    status?: string;
    iterationModel?: string;
    repositories?: unknown[];
    teamIds?: string[];
    governancePolicy?: unknown;
    archivePolicy?: unknown;
    reportSchedule?: unknown;
    onboardingConfig?: unknown;
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO projects (id, org_id, name, description, status, iteration_model, repositories, team_ids, governance_policy, archive_policy, report_schedule, onboarding_config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.id, data.orgId, data.name, data.description ?? '',
        data.status ?? 'active', data.iterationModel ?? 'kanban',
        toJson(data.repositories ?? []), toJson(data.teamIds ?? []),
        toJson(data.governancePolicy), toJson(data.archivePolicy),
        toJson(data.reportSchedule), toJson(data.onboardingConfig),
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
    const vals: unknown[] = [];
    const stringFields = ['name', 'description', 'status', 'iteration_model'] as const;
    const jsonFields = ['repositories', 'team_ids', 'governance_policy', 'archive_policy', 'report_schedule', 'onboarding_config'] as const;
    const fieldMap: Record<string, string> = {
      name: 'name', description: 'description', status: 'status',
      iterationModel: 'iteration_model', repositories: 'repositories',
      teamIds: 'team_ids', governancePolicy: 'governance_policy',
      archivePolicy: 'archive_policy', reportSchedule: 'report_schedule',
      onboardingConfig: 'onboarding_config',
    };
    for (const [key, col] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(jsonFields.includes(col as any) ? toJson(data[key]) : data[key]);
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async delete(id: string) {
    this.db.prepare('DELETE FROM iterations WHERE project_id = ?').run(id);
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
      iterationModel: r['iteration_model'] as string,
      repositories: fromJson<unknown[]>(r['repositories'] as string) ?? [],
      teamIds: fromJson<string[]>(r['team_ids'] as string) ?? [],
      governancePolicy: fromJson(r['governance_policy'] as string),
      archivePolicy: fromJson(r['archive_policy'] as string),
      reportSchedule: fromJson(r['report_schedule'] as string),
      onboardingConfig: fromJson(r['onboarding_config'] as string),
      createdAt: r['created_at'] as string,
      updatedAt: r['updated_at'] as string,
    };
  }
}

export class SqliteIterationRepo {
  constructor(private db: Database.Database) {}

  async create(data: {
    id: string;
    projectId: string;
    name: string;
    status?: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
  }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO iterations (id, project_id, name, status, goal, start_date, end_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(data.id, data.projectId, data.name, data.status ?? 'planning', data.goal ?? null, data.startDate ?? null, data.endDate ?? null, ts, ts);
    return this.findById(data.id)!;
  }

  findById(id: string) {
    const r = this.db.prepare('SELECT * FROM iterations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this._map(r) : undefined;
  }

  async updateStatus(id: string, status: string) {
    this.db.prepare('UPDATE iterations SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }

  async update(id: string, data: Record<string, unknown>) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const fieldMap: Record<string, string> = {
      name: 'name', status: 'status', goal: 'goal',
      startDate: 'start_date', endDate: 'end_date',
      metrics: 'metrics', reviewReport: 'review_report',
    };
    for (const [key, col] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(['metrics', 'reviewReport'].includes(key) ? toJson(data[key]) : data[key]);
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(id);
    this.db.prepare(`UPDATE iterations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  listByProject(projectId: string) {
    return (this.db.prepare('SELECT * FROM iterations WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Record<string, unknown>[]).map(r => this._map(r));
  }

  async delete(id: string) {
    this.db.prepare('DELETE FROM iterations WHERE id = ?').run(id);
  }

  private _map(r: Record<string, unknown>) {
    return {
      id: r['id'] as string,
      projectId: r['project_id'] as string,
      name: r['name'] as string,
      status: r['status'] as string,
      goal: r['goal'] as string | null,
      startDate: r['start_date'] as string | null,
      endDate: r['end_date'] as string | null,
      metrics: fromJson(r['metrics'] as string),
      reviewReport: fromJson(r['review_report'] as string),
      createdAt: r['created_at'] as string,
      updatedAt: r['updated_at'] as string,
    };
  }
}

export class SqliteTaskLogRepo {
  constructor(private db: Database.Database) {}

  async append(data: {
    taskId: string;
    agentId: string;
    seq: number;
    type: string;
    content: string;
    metadata?: unknown;
  }) {
    const id = generateId('tlog');
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO task_logs (id, task_id, agent_id, seq, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        data.taskId,
        data.agentId,
        data.seq,
        data.type,
        data.content,
        toJson(data.metadata ?? {}),
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
      createdAt: new Date(ts),
    };
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
      createdAt: toDate(r['created_at'] as string)!,
    }));
  }

  deleteByTask(taskId: string) {
    this.db.prepare('DELETE FROM task_logs WHERE task_id = ?').run(taskId);
  }
}

export class SqliteMessageRepo {
  constructor(private db: Database.Database) {}

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

export class SqliteMemoryRepo {
  constructor(private db: Database.Database) {}

  create(data: { id: string; agentId: string; type: string; content: string; metadata?: unknown }) {
    this.db
      .prepare(
        'INSERT INTO memories (id, agent_id, type, content, metadata, created_at) VALUES (?,?,?,?,?,?)'
      )
      .run(data.id, data.agentId, data.type, data.content, toJson(data.metadata ?? {}), now());
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(data.id);
  }

  findByAgent(agentId: string, type?: string, limit = 20) {
    if (type) {
      return this.db
        .prepare(
          'SELECT * FROM memories WHERE agent_id = ? AND type = ? ORDER BY created_at DESC LIMIT ?'
        )
        .all(agentId, type, limit);
    }
    return this.db
      .prepare('SELECT * FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, limit);
  }

  search(agentId: string, query: string, limit = 10) {
    return this.db
      .prepare(
        'SELECT * FROM memories WHERE agent_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(agentId, `%${query}%`, limit);
  }

  deleteByAgent(agentId: string) {
    this.db.prepare('DELETE FROM memories WHERE agent_id = ?').run(agentId);
  }
}

export class SqliteChatSessionRepo {
  constructor(private db: Database.Database) {}

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
      createdAt: new Date(ts),
      lastMessageAt: new Date(ts),
    };
  }

  getSessionsByAgent(agentId: string, limit = 50) {
    return (
      this.db
        .prepare(
          'SELECT * FROM chat_sessions WHERE agent_id = ? ORDER BY last_message_at DESC LIMIT ?'
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
    const vals: unknown[] = [sessionId];
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

  private _mapSession(r: Record<string, unknown>) {
    return {
      id: r['id'],
      agentId: r['agent_id'],
      userId: r['user_id'],
      title: r['title'],
      createdAt: toDate(r['created_at'] as string)!,
      lastMessageAt: toDate(r['last_message_at'] as string)!,
    };
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
  constructor(private db: Database.Database) {}

  async append(data: {
    orgId: string;
    channel: string;
    senderId: string;
    senderType: string;
    senderName: string;
    text: string;
    mentions?: string[];
  }) {
    const id = generateId('chm');
    const ts = now();
    this.db
      .prepare(
        'INSERT INTO channel_messages (id, org_id, channel, sender_id, sender_type, sender_name, text, mentions, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
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
      createdAt: new Date(ts),
    };
  }

  getMessages(channel: string, limit = 50, before?: string) {
    let q = 'SELECT * FROM channel_messages WHERE channel = ?';
    const vals: unknown[] = [channel];
    if (before) {
      q += ' AND created_at < ?';
      vals.push(before);
    }
    q += ' ORDER BY created_at DESC LIMIT ?';
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
      createdAt: toDate(r['created_at'] as string)!,
    }));
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse(), hasMore };
  }
}

export class SqliteUserRepo {
  constructor(private db: Database.Database) {}

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

  async delete(id: string) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  findByEmail(email: string) {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
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
      this.db.prepare('SELECT * FROM users WHERE org_id = ?').all(orgId) as Record<
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

  updateProfile(id: string, data: { name?: string; email?: string; role?: string }) {
    const sets: string[] = [];
    const vals: unknown[] = [];
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
    if (sets.length === 0) return null;
    vals.push(id);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.findById(id);
  }

  countByOrg(orgId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) as cnt FROM users WHERE org_id = ?').get(orgId) as {
      cnt: number;
    };
    return r.cnt;
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
      createdAt: toDate(r['created_at'] as string),
      lastLoginAt: toDate(r['last_login_at'] as string),
    };
  }
}

export class SqliteTeamRepo {
  constructor(private db: Database.Database) {}

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
    const vals: unknown[] = [];
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
      leadAgentId: r['lead_agent_id'],
      managerId: r['manager_id'],
      managerType: r['manager_type'],
      createdAt: toDate(r['created_at'] as string),
    };
  }
}

export class SqliteMarketplaceTemplateRepo {
  constructor(private db: Database.Database) {}

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
    const vals: unknown[] = [];
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
    const vals: unknown[] = [`%${query}%`, `%${query}%`];
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
    const vals: unknown[] = [];
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
  constructor(private db: Database.Database) {}

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
    const vals: unknown[] = [];
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
    const vals: unknown[] = [`%${query}%`, `%${query}%`];
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
  constructor(private db: Database.Database) {}

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
    const vals: unknown[] = [];
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
  constructor(private db: Database.Database) {}

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
    const vals: unknown[] = [agentId];
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
    const vals: unknown[] = [];
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
