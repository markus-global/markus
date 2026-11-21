/**
 * C10-0B §3.5 —— 每日真库身份审计的**实现侧**（core 只认 `IdentityAuditPort`）。
 *
 * 为什么住 org-manager：库在哪、记录写到哪，是装配知识；core 不得反向依赖它。
 * 时钟归 core 的 AgentClock（具名 source `identity-audit`，24h，无新 setInterval），
 * 本模块只回答「跑一次审计做什么」。
 *
 * 单写者：一天一条记录，用**独占创建**（flag 'wx'）裁决 —— 第一个到点的 agent
 * 创建当天记录并跑审计，其余 agent 看到 EEXIST 即跳过。不需要锁服务，也不允许
 * 第二个 agent 覆盖同一天的读数（覆盖 = 同一事实两个写者）。
 *
 * 三态（CTO 补口④）：pass / fail / epoch-unset（哨兵期，**绝不静默绿**）；
 * 仪器自身故障落 error —— 同样不是绿。纪元未定值时不建门禁、不读库，
 * 只写下 epoch-unset 状态并告警。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createLogger,
  makeIdentityGates,
  resolveIdentityFixEpoch,
  type IdentityAuditState,
} from '@markus/shared';
import type { IdentityAuditPort } from '@markus/core';

const defaultLog = createLogger('identity-audit');

export interface IdentityAuditRunnerOptions {
  agentId: string;
  /** 平台数据根（~/.markus）：记录落 `<markusHome>/records/identity-audit/`。 */
  markusHome: string;
  /** 真库路径（只读打开）。 */
  dbPath: string;
  log?: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
  now?: () => Date;
  /**
   * 纪元注入（测试 / 自检用）。缺省读产品常量 `IDENTITY_FIX_EPOCH`。
   * 显式 `null` = 哨兵期语义，与常量未定值相同。
   */
  epoch?: string | null;
}

export interface IdentityAuditRecord {
  date: string;
  ranAt: string;
  agentId: string;
  epoch: string | null;
  state: IdentityAuditState;
  dbPath: string;
  gates: Array<{ id: number; name: string; count: number; skipped?: boolean }>;
  error?: string;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some(c => c.name === column);
  } catch {
    return false;
  }
}

function openReadOnly(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    // 旧 node 不支持 readOnly 选项时退化：审计只跑 SELECT，不写。
    return new DatabaseSync(path);
  }
}

/**
 * 装配一个每日审计端口。`runDaily()` 幂等于「一天一次」：同一天第二次调用
 * （同一 agent 或别的 agent）直接跳过，不产生第二条记录。
 */
export function createIdentityAuditPort(opts: IdentityAuditRunnerOptions): { runDaily(): IdentityAuditRecord | undefined } {
  const log = opts.log ?? defaultLog;
  const recordsDir = join(opts.markusHome, 'records', 'identity-audit');

  return {
    runDaily(): IdentityAuditRecord | undefined {
      const now = opts.now?.() ?? new Date();
      const date = now.toISOString().slice(0, 10);
      const recordPath = join(recordsDir, `${date}.json`);
      const base = { date, ranAt: now.toISOString(), agentId: opts.agentId, dbPath: opts.dbPath };

      // 库不存在 = 没有生产库的装配（CI / 纯内存实例）：跳过，不是失败。
      if (!existsSync(opts.dbPath)) return undefined;

      mkdirSync(recordsDir, { recursive: true });
      try {
        // 独占创建：谁先创建谁跑审计。EEXIST = 今天已有人跑过 → 跳过。
        writeFileSync(recordPath, JSON.stringify({ ...base, state: 'running' }), { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
        throw err;
      }

      const finalize = (record: IdentityAuditRecord): IdentityAuditRecord => {
        writeFileSync(recordPath, JSON.stringify(record, null, 2));
        return record;
      };

      const epoch = resolveIdentityFixEpoch(opts.epoch);
      if (epoch === null) {
        // 哨兵期：独立状态 + 告警。绝不静默绿（CTO 裁决 A ③）。
        log.error('identity-audit: epoch unset (sentinel period) — NOT green; finalize after the fix build goes live', { agentId: opts.agentId, date });
        return finalize({ ...base, epoch: null, state: 'epoch-unset', gates: [] });
      }

      try {
        const gates = makeIdentityGates({ epoch });
        const db = openReadOnly(opts.dbPath);
        const results: IdentityAuditRecord['gates'] = [];
        try {
          for (const g of gates) {
            if (g.requiresColumn && !hasColumn(db, g.requiresColumn.table, g.requiresColumn.column)) {
              results.push({ id: g.id, name: g.name, count: 0, skipped: true });
              continue;
            }
            const row = db.prepare(g.sql).get() as { c: number | bigint };
            results.push({ id: g.id, name: g.name, count: Number(row.c) });
          }
        } finally {
          db.close();
        }
        const violations = results.filter(g => !g.skipped && g.count > 0);
        const state: IdentityAuditState = violations.length > 0 ? 'fail' : 'pass';
        const record = finalize({ ...base, epoch, state, gates: results });
        if (state === 'fail') {
          log.error('identity-audit: post-epoch identity violations detected', {
            agentId: opts.agentId, date, epoch,
            violations: violations.map(v => ({ gate: v.id, name: v.name, count: v.count })),
          });
        } else {
          log.info('identity-audit: all gates clean', { agentId: opts.agentId, date, epoch });
        }
        return record;
      } catch (err) {
        log.error('identity-audit: instrument failure (not green)', { agentId: opts.agentId, date, error: String(err) });
        return finalize({ ...base, epoch, state: 'error', gates: [], error: String(err) });
      }
    },
  };
}