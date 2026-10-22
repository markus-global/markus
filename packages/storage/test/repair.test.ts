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
import { prepareDatabaseFile, tryApplyPendingRepair, runBackgroundRepair, verifyRecovered, type RepairTableReport } from '../src/index.js';
import { LARGE_DATABASE_BYTES } from '../src/health-probe.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'markus-repair-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeHealthyDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE keep (id INTEGER PRIMARY KEY, v TEXT)');
  db.exec('CREATE TABLE seq_t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  // 6300 条逐条 INSERT = 6300 次隐式提交 = 6300 次 fsync。WAL + synchronous=FULL
  // 下 Windows 实测 ~20 ms/次 → 这个夹具要跑约 2 分钟，而 vitest 的用例超时是 60 秒，
  // 于是 repair.test.ts 在 CI 上 8/11 个用例直接超时（macOS 上 fsync 只要 0.13 ms，
  // 整套夹具 0.8 秒，所以本地永远是绿的）。
  // 修法是「批量写放进一个事务」—— 真实客户端批量导入本来也该这么写，
  // 不是为了让测试变快而放宽断言。
  db.exec('BEGIN');
  const ins = db.prepare('INSERT INTO keep (v) VALUES (?)');
  for (let i = 0; i < 300; i += 1) ins.run(`row-${i}-${'x'.repeat(120)}`);
  const ins2 = db.prepare('INSERT INTO seq_t (v) VALUES (?)');
  for (let i = 0; i < 5; i += 1) ins2.run(`s${i}`);
  // "doomed" 建得最晚、行最多 → 它的页占据文件尾部，损坏只打在它身上
  db.exec('CREATE TABLE doomed (id INTEGER PRIMARY KEY, v TEXT)');
  const ins3 = db.prepare('INSERT INTO doomed (v) VALUES (?)');
  for (let i = 0; i < 6000; i += 1) ins3.run(`d-${i}-${'y'.repeat(200)}`);
  db.exec('COMMIT');
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

describe('两段式修复：陈旧快照绝不允许被换进活库', () => {
  it('重建完成后源库又被写过 → 拒绝替换，原库与那段写入都还在', async () => {
    const dbPath = join(dir, 'stale.db');
    makeHealthyDb(dbPath);
    corruptTail(dbPath);

    // 第一段：后台重建（只产工作文件，不动原库）
    const bg = await runBackgroundRepair(dbPath, () => {});
    expect(bg.action).toBe('scheduled');
    expect(existsSync(`${dbPath}.repair-ready.json`)).toBe(true);

    // 模拟「重建完成之后用户又用了十几分钟」：往完好的表里插一行
    const live = new DatabaseSync(dbPath);
    live.prepare('INSERT INTO keep (v) VALUES (?)').run('written-after-rebuild');
    live.close();

    // 第二段：下次启动换库 —— 必须发现源库变了并拒绝
    const applied = tryApplyPendingRepair(dbPath, () => {});
    expect(applied.action).toBe('aborted');
    expect(String(applied.reason)).toContain('stale-source');

    // 原库没被换掉：那行仍在（这是"不丢数据"的硬证据）
    const after = new DatabaseSync(dbPath);
    const still = after.prepare("SELECT COUNT(*) AS c FROM keep WHERE v = 'written-after-rebuild'").get() as { c: number };
    after.close();
    expect(still.c).toBe(1);

    // 陈旧的工作文件被丢弃，并排期为下一次启动在独占状态下重建
    expect(existsSync(`${dbPath}.repair-ready.json`)).toBe(false);
    expect(existsSync(`${dbPath}.repair-needed.json`)).toBe(true);
  });

  it('源库自重建以来没变过 → 正常换库（陈旧保护不能挡住正常路径）', async () => {
    const dbPath = join(dir, 'fresh.db');
    makeHealthyDb(dbPath);
    corruptTail(dbPath);
    await runBackgroundRepair(dbPath, () => {});

    const applied = tryApplyPendingRepair(dbPath, () => {});
    expect(applied.action).toBe('applied');

    const db = new DatabaseSync(dbPath);
    const keep = db.prepare('SELECT COUNT(*) AS c FROM keep').get() as { c: number };
    const seq = db.prepare('SELECT COUNT(*) AS c FROM seq_t').get() as { c: number };
    db.close();
    expect(keep.c).toBe(300);
    expect(seq.c).toBe(5);
  });

  it('旧格式就绪文件（没有源指纹）→ 一律当陈旧，拒绝换库', async () => {
    const dbPath = join(dir, 'legacy.db');
    makeHealthyDb(dbPath);
    corruptTail(dbPath);
    await runBackgroundRepair(dbPath, () => {});

    // 抹掉指纹字段，模拟上一版（无保护）写下的就绪文件
    const readyPath = `${dbPath}.repair-ready.json`;
    const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as Record<string, unknown>;
    delete ready['source'];
    writeFileSync(readyPath, JSON.stringify(ready), 'utf8');

    const applied = tryApplyPendingRepair(dbPath, () => {});
    expect(applied.action).toBe('aborted');
    expect(String(applied.reason)).toContain('no-source-fingerprint');
    expect(existsSync(readyPath)).toBe(false);
  });
});

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

  it('大库损坏：默认在启动路径上重建（独占窗口），不再排到后台等下次', async () => {
    const dbPath = join(dir, 'large.db');
    makeHealthyDb(dbPath);
    corruptTail(dbPath);

    // deferAboveBytes=1 → 把这份测试库当成"大库"
    const res = await prepareDatabaseFile(dbPath, { deferAboveBytes: 1 });
    expect(res.action).toBe('repaired');

    const db = new DatabaseSync(dbPath);
    const keep = db.prepare('SELECT COUNT(*) AS c FROM keep').get() as { c: number };
    db.close();
    expect(keep.c).toBe(300);
  });

  it('已有「需要重建」标记：跳过探测直接重建（库正被写时只标记，不重建）', async () => {
    const dbPath = join(dir, 'marked.db');
    makeHealthyDb(dbPath);
    corruptTail(dbPath);

    // ① 只探测：应用运行中，库正被写 → 只写标记，绝不重建
    const probeOnly = await prepareDatabaseFile(dbPath, { probeOnly: true });
    expect(probeOnly.action).toBe('scheduled');
    expect(probeOnly.reason).toBe('marked-for-repair');
    expect(existsSync(`${dbPath}.repair-needed.json`)).toBe(true);
    expect(readdirSyncSafe(dir).filter(f => f.includes('.repairing-'))).toEqual([]);

    // ② 下一次启动：读到标记 → 跳过探测（allowBlockingProbe:false 也不影响）直接重建
    const repaired = await prepareDatabaseFile(dbPath, { allowBlockingProbe: false, deferAboveBytes: 1 });
    expect(repaired.action).toBe('repaired');
    expect(existsSync(`${dbPath}.repair-needed.json`)).toBe(false);
  });

  it('已有标记 + probeOnly（应用正在运行）：仍然绝不重建', async () => {
    const dbPath = join(dir, 'marked-live.db');
    makeHealthyDb(dbPath);
    corruptTail(dbPath);
    writeFileSync(`${dbPath}.repair-needed.json`, JSON.stringify({ reason: 'corrupt', at: new Date().toISOString() }), 'utf8');

    const res = await prepareDatabaseFile(dbPath, { probeOnly: true });
    expect(res.action).toBe('scheduled');
    expect(readdirSyncSafe(dir).filter(f => f.includes('.repairing-'))).toEqual([]);
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
