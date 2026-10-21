import { createLogger, markusDbPath } from '@markus/shared';
import { statSync, statfsSync } from 'node:fs';
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
  /** Run a synchronous function inside a SQLite transaction (auto-rollback on throw). */
  runInTransaction<T>(fn: () => T): T;
  /** M0: integrity probe (`PRAGMA quick_check`). Never throws. Blocks the
   *  event loop for ~file-size-dependent time — call it on demand or gate it. */
  quickCheck(): { ok: boolean; errors: string[]; elapsedMs: number };
  /** Size of the SQLite file in bytes (0 when unavailable) — used to decide
   *  whether an automatic integrity check is affordable. */
  databaseSizeBytes(): number;
  /** Flush the buffered execution-stream rows (clean shutdown). */
  disposeStreams(): void;
  /** 附件存储（图片 base64 出库后的读写入口）。 */
  attachmentStore: any;
  /** 后台数据迁移：启动后自动跑，断点续跑，幂等。 */
  runMigrations(): Promise<unknown>;
  migrationStatus(): unknown;
  /** 把迁移释放的页真正还给文件系统（VACUUM；不满足条件时是 no-op）。 */
  reclaimSpace(): { reclaimed: boolean; freeBytes: number; reason?: string; durationMs?: number };
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
  requirementCommentRepo?: any;
  requirementRepo?: any;
  projectRepo?: any;
  externalAgentRepo?: any;
  deliverableRepo?: any;
  activityRepo?: any;
  executionStreamRepo?: any;
  mailboxRepo?: any;
  decisionRepo?: any;
  notificationRepo?: any;
  approvalRepo?: any;
  groupChatRepo?: any;
  auditRepo?: any;
  statusTransitionRepo?: any;
  readCursorRepo?: any;
  workflowRunRepo?: any;
  workflowScheduleRepo?: any;
  pendingCallbackRepo?: any;
  integrationRepo?: any;
  /** Messaging gateway: bot instances + channel bindings (G1 tables). */
  platformInstanceRepo?: any;
  channelBindingRepo?: any;
}

function resolveSqlitePath(url?: string): string {
  if (url?.startsWith('sqlite:')) {
    let p = url.slice('sqlite:'.length);
    if (p.startsWith('~/') || p === '~') {
      p = join(homedir(), p.slice(2));
    }
    return p;
  }
  return markusDbPath();
}

export async function initStorage(databaseUrl?: string): Promise<StorageBridge | null> {
  const url = databaseUrl ?? process.env['DATABASE_URL'];
  return initSqliteStorage(url);
}

async function initSqliteStorage(url?: string): Promise<StorageBridge | null> {
  try {
    const storage = await import('@markus/storage');
    const dbPath = resolveSqlitePath(url);
    // 开库前自愈：探测 → 备份 → 修复 → 校验 → 原子替换（备份永不删除）。
    // 健康库上这是一次子进程探测的 no-op；损坏库则在这里被修好，用户无感。
    try {
      const repair = await storage.prepareDatabaseFile(dbPath, {
        log: (message: string, data?: Record<string, unknown>) => log.warn(message, data),
      });
      if (repair.action === 'repaired') {
        log.warn('Database repaired before open — original preserved as backup', repair as unknown as Record<string, unknown>);
      } else if (repair.action === 'aborted') {
        log.error('Database repair aborted — original left untouched', repair as unknown as Record<string, unknown>);
      } else if (repair.reason && repair.reason !== 'healthy' && repair.reason !== 'no-database') {
        log.warn('Database repair skipped', { reason: repair.reason });
      }
    } catch (err) {
      // 自愈本身失败绝不能让应用起不来：原库未动，照常打开
      log.error('Pre-open repair check failed (continuing with original database)', { error: String(err) });
    }

    const db = storage.openSqlite(dbPath);

    // 附件 + 后台迁移：blob 根目录与数据库同级，可用 MARKUS_BLOB_DIR 覆盖（测试/多实例）。
    const blobs = process.env['MARKUS_BLOB_DIR']
      ? new storage.BlobStore(process.env['MARKUS_BLOB_DIR'])
      : new storage.BlobStore();
    const attachmentStore = new storage.AttachmentStore(db, blobs);
    const migrationRunner = new storage.MigrationRunner(db, attachmentStore, blobs, {
      batchSize: 50,
      delayMs: 25,
    });

    const bridge: StorageBridge = {
      runInTransaction: <T>(fn: () => T) => storage.runInTransaction(db, fn),
      quickCheck: () => storage.quickCheckDatabase(db),
      databaseSizeBytes: () => { try { return statSync(dbPath).size; } catch { return 0; } },
      disposeStreams: () => { try { bridge.executionStreamRepo?.dispose?.(); } catch { /* already closed */ } },
      attachmentStore: attachmentStore,
      runMigrations: async () => {
        // 损坏的库无法 VACUUM —— 搬出去的数据不会还盘，只会让磁盘多占一份。
        // 所以"大载荷出库"要先过完整性闸门：库不健康就只做安全的图片迁移。
        // 闸门必须在**子进程**里跑：实测 16.7 GB 的库 quick_check 要 155 秒，
        // 跑在主进程会把服务（含所有 SSE）冻住两分半。
        const bulk = '002-large-payloads-to-blobs';
        const pending = (migrationRunner.status() as Array<{ id: string; status: string }>)
          .find(p => p.id === bulk);
        if (!pending || pending.status !== 'done') {
          const probe = await storage.probeDatabaseHealthInChild(dbPath, 20_000);
          if (probe.status !== 'ok') {
            log.warn('Skipping bulk payload offload — database not confirmed healthy', {
              status: probe.status,
              detail: probe.detail,
              elapsedMs: probe.elapsedMs,
              why: 'offloading without VACUUM would double disk usage',
            });
            return migrationRunner.run({ skip: [bulk] });
          }
        }
        return migrationRunner.run();
      },
      migrationStatus: () => migrationRunner.status(),
      reclaimSpace: () => storage.reclaimSpace(db, {
        freeDiskBytes: () => {
          try {
            const s = statfsSync(dbPath) as unknown as { bsize?: number; bavail?: number };
            return Number(s.bsize ?? 0) * Number(s.bavail ?? 0);
          } catch { return 0; }
        },
      }),
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
      requirementCommentRepo: new storage.SqliteRequirementCommentRepo(db) as any,
      requirementRepo: new storage.SqliteRequirementRepo(db) as any,
      projectRepo: new storage.SqliteProjectRepo(db),
      externalAgentRepo: new storage.SqliteExternalAgentRepo(db),
      deliverableRepo: new storage.SqliteDeliverableRepo(db),
      activityRepo: new storage.SqliteActivityRepo(db),
      executionStreamRepo: new storage.SqliteExecutionStreamRepo(db),
      mailboxRepo: new storage.SqliteMailboxRepo(db),
      decisionRepo: new storage.SqliteDecisionRepo(db),
      notificationRepo: new storage.SqliteNotificationRepo(db),
      approvalRepo: new storage.SqliteApprovalRepo(db),
      groupChatRepo: new storage.SqliteGroupChatRepo(db),
      auditRepo: new storage.SqliteAuditRepo(db),
      statusTransitionRepo: new storage.SqliteStatusTransitionRepo(db),
      readCursorRepo: new storage.SqliteReadCursorRepo(db),
      workflowRunRepo: new storage.SqliteWorkflowRunRepo(db),
      workflowScheduleRepo: new storage.SqliteWorkflowScheduleRepo(db),
      integrationRepo: new storage.SqliteIntegrationRepo(db),
      platformInstanceRepo: new storage.SqlitePlatformInstanceRepo(db),
      channelBindingRepo: new storage.SqliteChannelBindingRepo(db),
      pendingCallbackRepo: new storage.SqlitePendingCallbackRepo(db),
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
