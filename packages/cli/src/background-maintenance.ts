/**
 * 后台自维护排期：完整性探针 + 旧库数据迁移。
 *
 * 为什么必须独立成一个入口
 * ──────────────────────
 * 这两件事原先写在 `startServerCore` 的「非 headless 尾段」。而桌面端走的是
 * `startServerHeadless()` → `{ headless: true }` → 在它们**之前**就 `return` 了。
 * 于是「装上新版就自动迁移」对**所有桌面用户**都不成立：不是某个用户的环境问题，
 * 而是主分发路径根本没跑到那段代码（实测证据：17 GB 的库连 "auto-check skipped"
 * 这行日志都没有，`data_migrations` 表为空）。
 *
 * 判据：自维护属于「服务已能接受请求之后的后台工作」，与是否 headless、是否打开
 * 浏览器无关。所以它只能在 headless 分支**之前**无条件排期一次 —— 唯一执行点。
 */

export interface MaintenanceStorage {
  databaseSizeBytes(): number;
  quickCheck(): { ok: boolean; errors?: string[]; elapsedMs: number };
  runMigrations(): Promise<unknown>;
  reclaimSpace(): { reclaimed: boolean; freeBytes: number; durationMs?: number; reason?: string };
}

export interface MaintenanceLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface MaintenanceOptions {
  /** 迁移启动延迟（默认 5 s，让启动路径先跑完）。 */
  migrationDelayMs?: number;
  /** 小库完整性自检延迟（默认 30 s）。 */
  integrityDelayMs?: number;
  /** 超过这个大小的库不跑**主进程内**的 quick_check（它是同步的，会冻住服务）。 */
  autoCheckMaxBytes?: number;
  /** 测试用：跳过延迟，立即执行。 */
  immediate?: boolean;
}

export interface MaintenanceHandle {
  cancel(): void;
}

/** 全仓唯一的自动自检上限；大于它的库走按需检查（子进程探针）。 */
export const AUTO_CHECK_MAX_BYTES = 512 * 1024 * 1024;

/**
 * 排期后台自维护。返回可取消句柄（测试与优雅退出用）。
 *
 * 幂等：同一进程内重复调用只会排一次（用模块级标记守，避免 headless 与
 * 非 headless 两条路径都走到时跑两遍）。测试可用 `resetMaintenanceForTest()`。
 */
let scheduled = false;

export function resetMaintenanceForTest(): void {
  scheduled = false;
}

export function scheduleBackgroundMaintenance(
  storage: MaintenanceStorage | undefined,
  log: MaintenanceLogger,
  opts: MaintenanceOptions = {},
): MaintenanceHandle {
  const delayM = opts.migrationDelayMs ?? 5_000;
  const delayI = opts.integrityDelayMs ?? 30_000;
  const maxBytes = opts.autoCheckMaxBytes ?? AUTO_CHECK_MAX_BYTES;

  if (scheduled) {
    return { cancel() { /* already scheduled */ } };
  }
  if (!storage) return { cancel() { /* nothing scheduled */ } };
  // 测试里 vitest 会把进程标记成 VITEST（防止真起服务）；`immediate` 用于
  // 单测本模块时绕过该闸门，生产路径永远不带这个选项。
  if (process.env['VITEST'] && !opts.immediate) {
    return { cancel() { /* nothing scheduled */ } };
  }
  scheduled = true;

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const arm = (fn: () => void, delay: number) => {
    const t = (opts.immediate ? setTimeout(fn, 0) : setTimeout(fn, delay)) as ReturnType<typeof setTimeout>;
    // 不阻止进程退出：这些是后台维护，不是「必须等它跑完」的工作。
    const unref = (t as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(t);
    timers.push(t);
  };

  // ① 完整性自检。只在小库上自动跑：quick_check 在 SQLite 里是同步的，
  //    实测 17 GB 要 155 s，在主进程里跑等于把流式与 API 一起冻住。
  let sizeBytes = 0;
  try {
    sizeBytes = storage.databaseSizeBytes();
  } catch { /* 拿不到大小就当小库处理，宁可多查一次 */ }

  if (sizeBytes > maxBytes) {
    log.info('Database integrity auto-check skipped (large database) — run on demand', {
      sizeMb: Math.round(sizeBytes / 1048576),
    });
  } else {
    arm(() => {
      try {
        const health = storage.quickCheck();
        if (health.ok) {
          log.info('Database integrity check passed', { elapsedMs: health.elapsedMs });
        } else {
          log.error('Database integrity check FAILED — some tables cannot be scanned', {
            errors: health.errors,
            elapsedMs: health.elapsedMs,
          });
        }
      } catch (err) {
        log.warn('Database integrity check could not run', { error: String(err) });
      }
    }, delayI);
  }

  // ② 旧库数据迁移。装上新版、重启、照常用 —— 零脚本、零进度条。
  arm(() => {
    try {
      storage.runMigrations()
        .then((status: unknown) => {
          log.info('Data migrations finished', { status });
          // 迁移只把行变短，页进了 freelist，文件大小不变。不 VACUUM 的话
          // 用户会看到磁盘反而多占（旧页 + 新 blob）—— 必须真正还盘。
          const r = storage.reclaimSpace();
          if (r.reclaimed) {
            log.info('Reclaimed disk space (VACUUM)', {
              freedMb: Math.round(r.freeBytes / 1048576),
              ms: r.durationMs,
            });
          } else {
            log.info('Space reclaim skipped', {
              reason: r.reason,
              candidateMb: Math.round(r.freeBytes / 1048576),
            });
          }
        })
        .catch((err: unknown) => {
          log.warn('Data migration interrupted — will resume on next start', { error: String(err) });
        });
    } catch (err) {
      log.warn('Data migration could not start', { error: String(err) });
    }
  }, delayM);

  return {
    cancel() {
      for (const t of timers) clearTimeout(t);
    },
  };
}
