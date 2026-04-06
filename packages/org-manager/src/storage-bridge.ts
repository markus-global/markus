import { createLogger } from '@markus/shared';
import { homedir } from 'node:os';
import { join } from 'node:path';

const log = createLogger('storage-bridge');

/**
 * Storage bridge: initializes SQLite storage and provides access to repositories.
 *
 * Default SQLite path: ~/.markus/data.db
 * Override via DATABASE_URL=sqlite:/path/to/file.db
 *
 * Falls back gracefully to in-memory mode only if SQLite init fails.
 */
export interface StorageBridge {
  orgRepo: any;
  taskRepo: any;
  taskLogRepo: any;
  agentRepo: any;
  teamRepo: any;
  messageRepo: any;
  chatSessionRepo: any;
  channelMessageRepo: any;
  userRepo: any;
  taskCommentRepo?: any;
  requirementRepo?: any;
  projectRepo?: any;
  externalAgentRepo?: any;
  deliverableRepo?: any;
  activityRepo?: any;
  executionStreamRepo?: any;
}

function resolveSqlitePath(url?: string): string {
  if (url?.startsWith('sqlite:')) {
    let p = url.slice('sqlite:'.length);
    if (p.startsWith('~/') || p === '~') {
      p = join(homedir(), p.slice(2));
    }
    return p;
  }
  return join(homedir(), '.markus', 'data.db');
}

export async function initStorage(databaseUrl?: string): Promise<StorageBridge | null> {
  const url = databaseUrl ?? process.env['DATABASE_URL'];
  return initSqliteStorage(url);
}

async function initSqliteStorage(url?: string): Promise<StorageBridge | null> {
  try {
    const storage = await import('@markus/storage');
    const dbPath = resolveSqlitePath(url);
    const db = storage.openSqlite(dbPath);

    const bridge: StorageBridge = {
      orgRepo: new storage.SqliteOrgRepo(db) as any,
      taskRepo: new storage.SqliteTaskRepo(db) as any,
      taskLogRepo: new storage.SqliteTaskLogRepo(db) as any,
      agentRepo: new storage.SqliteAgentRepo(db) as any,
      teamRepo: new storage.SqliteTeamRepo(db) as any,
      messageRepo: new storage.SqliteMessageRepo(db) as any,
      chatSessionRepo: new storage.SqliteChatSessionRepo(db) as any,
      channelMessageRepo: new storage.SqliteChannelMessageRepo(db) as any,
      userRepo: new storage.SqliteUserRepo(db) as any,
      taskCommentRepo: new storage.SqliteTaskCommentRepo(db) as any,
      requirementRepo: new storage.SqliteRequirementRepo(db) as any,
      projectRepo: new storage.SqliteProjectRepo(db),
      externalAgentRepo: new storage.SqliteExternalAgentRepo(db),
      deliverableRepo: new storage.SqliteDeliverableRepo(db),
      activityRepo: new storage.SqliteActivityRepo(db),
      executionStreamRepo: new storage.SqliteExecutionStreamRepo(db),
    };
    log.info('SQLite storage initialized', { path: dbPath });
    return bridge;
  } catch (error) {
    log.warn('Failed to initialize SQLite storage, falling back to memory-only mode', {
      error: String(error),
    });
    return null;
  }
}
