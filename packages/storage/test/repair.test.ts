/**
 * 开库前自愈的回归：备份 → 修复 → 校验 → 原子替换。
 *
 * 这里锁的是**安全属性**，不是实现细节：
 *   1. 健康的库：零动作、不动文件
 *   2. 损坏的库：备份先落盘且内容完整；修复后可读的表一行不少；
 *      读不动的表如实报告（不假装成功）；替换后新库自身完整
 *   3. 校验不通过：放弃替换，原库保持原样
 *   4. 自增序列被保留（否则新插入会撞主键 —— 这是"能用"和"坏了"的区别）
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, openSync, closeSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { prepareDatabaseFile, verifyRecovered, type RepairTableReport } from '../src/index.js';
import { LARGE_DATABASE_BYTES } from '../src/health-probe.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'markus-repair-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeHealthyDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE keep (id INTEGER PRIMARY KEY, v TEXT)');
  db.exec('CREATE TABLE seq_t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  const ins = db.prepare('INSERT INTO keep (v) VALUES (?)');
  for (let i = 0; i < 300; i += 1) ins.run(`row-${i}-${'x'.repeat(120)}`);
  const ins2 = db.prepare('INSERT INTO seq_t (v) VALUES (?)');
  for (let i = 0; i < 5; i += 1) ins2.run(`s${i}`);
  // "doomed" 建得最晚、行最多 → 它的页占据文件尾部，损坏只打在它身上
  db.exec('CREATE TABLE doomed (id INTEGER PRIMARY KEY, v TEXT)');
  const ins3 = db.prepare('INSERT INTO doomed (v) VALUES (?)');
  for (let i = 0; i < 6000; i += 1) ins3.run(`d-${i}-${'y'.repeat(200)}`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

/** 在文件**尾部**覆写 garbage：只破坏最后建的表，完好表必须被完整救回。 */
function corruptTail(path: string): void {
  const size = statSync(path).size;
  const buf = readFileSync(path);
  const offset = Math.max(0, size - 12 * 1024);
  buf.fill(0xff, offset, buf.length);
  writeFileSync(path, buf);
}

describe('prepareDatabaseFile', () => {
  it('健康库：零动作，不产生备份', async () => {
    const dbPath = join(dir, 'healthy.db');
    makeHealthyDb(dbPath);

    const res = await prepareDatabaseFile(dbPath);
    expect(res.action).toBe('none');
    expect(res.reason).toBe('healthy');
    const leftovers = readdirSyncSafe(dir).filter(f => f.includes('.backup-') || f.includes('.repairing-'));
    expect(leftovers).toEqual([]);
  });

  it('损坏库：备份保留、可读表不丢行、新库自身完整', async () => {
    const dbPath = join(dir, 'broken.db');
    makeHealthyDb(dbPath);
    const originalSize = statSync(dbPath).size;
    corruptTail(dbPath);

    // 确认这个夹具**真的**坏了（否则测试会自欺）
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    const verdict = String(Object.values(probe.prepare('PRAGMA quick_check(1)').get() ?? {})[0] ?? '');
    probe.close();
    expect(verdict).not.toBe('ok');

    const res = await prepareDatabaseFile(dbPath);
    expect(res.action).toBe('repaired');

    // 备份必须存在且内容完整（与损坏前等大）
    expect(res.backupPath).toBeTruthy();
    expect(existsSync(res.backupPath!)).toBe(true);
    expect(statSync(res.backupPath!).size).toBe(originalSize);

    // 可读的表一行不少（读到的行必须全部写进去）
    for (const t of res.tables ?? []) {
      expect(t.recovered).toBe(t.readRows);
    }

    // 替换后的库必须干净可用
    const after = new DatabaseSync(dbPath);
    const afterVerdict = String(Object.values(after.prepare('PRAGMA quick_check(1)').get() ?? {})[0] ?? '');
    expect(afterVerdict).toBe('ok');
    const keepCount = (after.prepare('SELECT COUNT(*) AS n FROM keep').get() as { n: number }).n;
    expect(keepCount).toBe(300);

    // 自增序列保留：新插入不能撞主键
    after.prepare('INSERT INTO seq_t (v) VALUES (?)').run('after-repair');
    const maxId = (after.prepare('SELECT MAX(id) AS m FROM seq_t').get() as { m: number }).m;
    expect(maxId).toBe(6);
    after.close();

    // 不留中间文件
    expect(readdirSyncSafe(dir).filter(f => f.includes('.repairing-'))).toEqual([]);
  }, 60_000);

  it('校验不通过时拒绝替换（原库保持原样）', () => {
    const work = join(dir, 'work.db');
    const db = new DatabaseSync(work);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO t (id) VALUES (1)').run();
    db.close();

    const lying: RepairTableReport[] = [{ name: 't', source: 1, recovered: 99, skippedWindows: 0 }];
    const res = verifyRecovered(work, lying);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('row count mismatch');
  });

  it('大库 + 禁止阻塞探测：启动路径一行都不等，交给后台', async () => {
    // 用稀疏文件造一个 >512 MB 的"大库"：瞬间创建、不占磁盘。
    const dbPath = join(dir, 'large.db');
    const fd = openSync(dbPath, 'w');
    closeSync(fd);
    truncateSync(dbPath, LARGE_DATABASE_BYTES + 64 * 1024 * 1024);

    const started = Date.now();
    const res = await prepareDatabaseFile(dbPath, { allowBlockingProbe: false });
    const elapsed = Date.now() - started;

    expect(res.action).toBe('none');
    expect(res.reason).toBe('probe-deferred-background');
    // 关键：没有把分钟级的整库扫描压在启动路径上。
    expect(elapsed).toBeLessThan(2_000);
    // 也没有偷偷排期/写备份 —— 那要等后台探测拿到结论之后。
    expect(readdirSyncSafe(dir).filter(f => f.includes('.repair'))).toEqual([]);
  });

  it('不存在的库：视为全新安装，不做任何事', async () => {
    const res = await prepareDatabaseFile(join(dir, 'nope.db'));
    expect(res.action).toBe('none');
    expect(res.reason).toBe('no-database');
  });
});

function readdirSyncSafe(p: string): string[] {
  try {
    // 延迟 import 避免顶部噪声
    return require('node:fs').readdirSync(p) as string[];
  } catch { return []; }
}
