import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { createLogger } from '@markus/shared';
import { getDb } from './db.js';

const log = createLogger('migrations');

/**
 * Run pending drizzle migrations.
 * Idempotent: safe to call on every startup.
 * Migration files live in packages/storage/drizzle/
 */
export async function runMigrations(databaseUrl?: string): Promise<void> {
  const db = getDb(databaseUrl);
  try {
    // __dirname is not available in ESM; resolve relative to import.meta.url
    const migrationsFolder = new URL('../drizzle', import.meta.url).pathname;
    await migrate(db, { migrationsFolder });
    log.info('Database migrations applied successfully');
  } catch (err) {
    log.warn('Migration runner encountered an issue (tables may already exist via db:push)', {
      error: String(err),
    });
    // Non-fatal: if tables were created via db:push they are already up-to-date
  }

  // Ensure critical columns exist as a safety net (idempotent, safe to run every time)
  await applyEssentialColumns(db);
}

/**
 * Directly apply any essential column additions that might have been missed by the migrator.
 * Uses IF NOT EXISTS so it's completely safe to run on every startup.
 */
async function applyEssentialColumns(db: ReturnType<typeof getDb>): Promise<void> {
  const statements = [
    // chat_messages: segment metadata for persistent tool-call display
    `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata jsonb`,
    // channel_messages: metadata for thinking/tool-call display (separated from clean text)
    `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'`,
    // tasks: notes array for persistent task notes
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notes jsonb DEFAULT '[]'`,
    // agents: daily token tracking, active task persistence, and structured profile
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS tokens_used_today integer DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS active_task_ids jsonb DEFAULT '[]'`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile jsonb`,
    // task_logs: structured execution log entries (audit + live display)
    `CREATE TABLE IF NOT EXISTS task_logs (
      id varchar(64) PRIMARY KEY,
      task_id varchar(64) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id varchar(64) NOT NULL,
      seq integer NOT NULL DEFAULT 0,
      type varchar(32) NOT NULL,
      content text NOT NULL DEFAULT '',
      metadata jsonb DEFAULT '{}',
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs (task_id, seq)`,

    // Marketplace enums
    `DO $$ BEGIN CREATE TYPE template_source AS ENUM('official','community','custom'); EXCEPTION WHEN duplicate_object THEN null; END $$`,
    `DO $$ BEGIN CREATE TYPE marketplace_status AS ENUM('draft','pending_review','published','rejected','archived'); EXCEPTION WHEN duplicate_object THEN null; END $$`,

    // marketplace_templates
    `CREATE TABLE IF NOT EXISTS marketplace_templates (
      id varchar(64) PRIMARY KEY,
      name varchar(255) NOT NULL,
      description text NOT NULL,
      source template_source NOT NULL DEFAULT 'community',
      status marketplace_status NOT NULL DEFAULT 'draft',
      version varchar(32) NOT NULL DEFAULT '1.0.0',
      author_id varchar(64),
      author_name varchar(255) NOT NULL,
      role_id varchar(64) NOT NULL,
      agent_role varchar(16) NOT NULL DEFAULT 'worker',
      skills jsonb NOT NULL DEFAULT '[]',
      llm_provider varchar(64),
      tags jsonb NOT NULL DEFAULT '[]',
      category varchar(64) NOT NULL,
      icon varchar(16),
      heartbeat_interval_ms integer,
      starter_tasks jsonb DEFAULT '[]',
      config jsonb DEFAULT '{}',
      download_count integer NOT NULL DEFAULT 0,
      avg_rating integer NOT NULL DEFAULT 0,
      rating_count integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      published_at timestamp
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_templates_source ON marketplace_templates(source, status)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_templates_category ON marketplace_templates(category)`,

    // marketplace_skills
    `CREATE TABLE IF NOT EXISTS marketplace_skills (
      id varchar(64) PRIMARY KEY,
      name varchar(255) NOT NULL,
      description text NOT NULL,
      source template_source NOT NULL DEFAULT 'community',
      status marketplace_status NOT NULL DEFAULT 'draft',
      version varchar(32) NOT NULL DEFAULT '1.0.0',
      author_id varchar(64),
      author_name varchar(255) NOT NULL,
      category varchar(64) NOT NULL,
      tags jsonb NOT NULL DEFAULT '[]',
      tools jsonb NOT NULL DEFAULT '[]',
      readme text,
      required_permissions jsonb DEFAULT '[]',
      required_env jsonb DEFAULT '[]',
      config jsonb DEFAULT '{}',
      download_count integer NOT NULL DEFAULT 0,
      avg_rating integer NOT NULL DEFAULT 0,
      rating_count integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      published_at timestamp
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_skills_source ON marketplace_skills(source, status)`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_skills_category ON marketplace_skills(category)`,

    // marketplace_ratings
    `CREATE TABLE IF NOT EXISTS marketplace_ratings (
      id varchar(64) PRIMARY KEY,
      target_type varchar(16) NOT NULL,
      target_id varchar(64) NOT NULL,
      user_id varchar(64) NOT NULL,
      rating integer NOT NULL,
      review text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mkt_ratings_target ON marketplace_ratings(target_type, target_id)`,

    // memory_embeddings: vector store for semantic memory search (pgvector)
    // pgvector extension is optional — if not available, table is created without vector column
    `CREATE TABLE IF NOT EXISTS memory_embeddings (
      id varchar(64) PRIMARY KEY,
      agent_id varchar(64) NOT NULL,
      content text NOT NULL,
      type varchar(32) NOT NULL,
      embedding bytea,
      created_at timestamptz DEFAULT NOW(),
      updated_at timestamptz DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_agent ON memory_embeddings(agent_id)`,

    // task_comments: human/agent comments interleaved with execution logs
    `CREATE TABLE IF NOT EXISTS task_comments (
      id varchar(64) PRIMARY KEY,
      task_id varchar(64) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author_id varchar(128) NOT NULL,
      author_name varchar(255) NOT NULL,
      author_type varchar(16) NOT NULL,
      content text NOT NULL,
      attachments jsonb DEFAULT '[]',
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id, created_at)`,

    // tasks: project/iteration association
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id varchar(64)`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS iteration_id varchar(64)`,

    // tasks: scheduled task support
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type varchar(16) NOT NULL DEFAULT 'standard'`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_config jsonb`,

    // marketplace_templates: community features (visibility, fork, versioning)
    `ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS visibility varchar(16) NOT NULL DEFAULT 'public'`,
    `ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS forked_from varchar(64)`,
    `ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS fork_count integer DEFAULT 0`,
    `ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS version_history jsonb DEFAULT '[]'`,
    `ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS org_id varchar(64)`,
    // marketplace_skills: same community features
    `ALTER TABLE marketplace_skills ADD COLUMN IF NOT EXISTS visibility varchar(16) NOT NULL DEFAULT 'public'`,
    `ALTER TABLE marketplace_skills ADD COLUMN IF NOT EXISTS forked_from varchar(64)`,
    `ALTER TABLE marketplace_skills ADD COLUMN IF NOT EXISTS fork_count integer DEFAULT 0`,
    `ALTER TABLE marketplace_skills ADD COLUMN IF NOT EXISTS version_history jsonb DEFAULT '[]'`,
    `ALTER TABLE marketplace_skills ADD COLUMN IF NOT EXISTS org_id varchar(64)`,
  ];
  for (const stmt of statements) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err) {
      log.warn('Failed to apply essential column/table', { error: String(err) });
    }
  }
}
