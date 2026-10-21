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
      // ① 上一轮排期的修复若已就绪，现在换库（两个 rename，毫秒级）
      const applied = storage.tryApplyPendingRepair(dbPath, (message: string, data?: Record<string, unknown>) => log.warn(message, data));
      if (applied.action === 'applied') {
        log.warn('Applied pending database repair from previous run', applied as unknown as Record<string, unknown>);
      }

      // ② 探测：健康 → 什么都不做；小库损坏 → 当场修；大库损坏 → 派后台工人，下次启动换库
      //
      // 大库不在启动路径上探测：健康的大库整库扫描是分钟级（实测 16.7 GB 要 155 s），
      // 等它等于每次启动都冻住两分半 —— 那比"库坏了"更糟。所以大库一律丢到后台，
      // 探测结论照样能排期重建，只是换库要等到下一次启动。
      const preOpenRepair = (dbPath2: string, extra?: { probeOnly?: boolean }) => storage.prepareDatabaseFile(dbPath2, {
        log: (message: string, data?: Record<string, unknown>) => log.warn(message, data),
        ...(extra ?? {}),
      });

      let dbBytes = 0;
      try { dbBytes = statSync(dbPath).size; } catch { /* 拿不到按 0 处理 → 走同步探测 */ }

      const isLarge = dbBytes > storage.LARGE_DATABASE_BYTES;

      const reportRepair = (repair: Awaited<ReturnType<typeof storage.prepareDatabaseFile>>) => {
        if (repair.action === 'repaired') {
          log.warn('Database repaired before open — original preserved as backup', repair as unknown as Record<string, unknown>);
        } else if (repair.action === 'scheduled') {
          log.warn('Database is corrupt — marked for repair, will rebuild before the next open', repair as unknown as Record<string, unknown>);
        } else if (repair.action === 'aborted') {
          log.error('Database repair aborted — original left untouched', repair as unknown as Record<string, unknown>);
        } else if (repair.reason && repair.reason !== 'healthy' && repair.reason !== 'no-database' && repair.reason !== 'probe-deferred-background') {
          log.warn('Database repair skipped', { reason: repair.reason });
        }
      };

      if (isLarge) {
        // 不 await：启动立刻继续。
        //
        // 关键：这里只能 **probeOnly** —— 此刻库正被写入，任何重建快照都会陈旧，
        // 而陈旧快照换库 = 吃掉那段时间的写入。探到损坏只写一个“需要重建”标记，
        // 真正的重建放在下一次启动、库还没被任何进程打开的独占窗口里做。
        void preOpenRepair(dbPath, { probeOnly: true })
          .then(reportRepair)
          .catch(err => log.error('Background pre-open repair check failed (original database untouched)', { error: String(err) }));
        log.info('Large database — integrity probe deferred to background', { sizeMb: Math.round(dbBytes / 1048576) });
      } else {
        reportRepair(await preOpenRepair(dbPath));
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
          // 探针是后台任务，不在启动路径上 —— 所以超时按库大小给，而不是固定 20 s。
          // 实测健康的 16.7 GB 库整表扫描要 155 s；固定 20 s 会让**大库永远拿到
          // unknown → 永远不做出库**，静默退化成「什么也没省」。
          let dbMb = 0;
          try { dbMb = Math.round(statSync(dbPath).size / 1048576); } catch { /* 拿不到按最小值 */ }
          const probeTimeoutMs = Math.min(15 * 60_000, Math.max(20_000, dbMb * 12));
          const probe = await storage.probeDatabaseHealthInChild(dbPath, probeTimeoutMs);
          if (probe.status !== 'ok') {
            log.warn('Skipping bulk payload offload — database not confirmed healthy', {
              status: probe.status,
              detail: probe.detail,
              elapsedMs: probe.elapsedMs,
              probeTimeoutMs,
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
