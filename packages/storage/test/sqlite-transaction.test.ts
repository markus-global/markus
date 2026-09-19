/**
 * storage 层事务原语 `runInTransaction` 的**直接**测试（真实 SQLite，不 mock 数据库）。
 *
 * 背景：`runInTransaction`（packages/storage/src/sqlite-storage.ts:927）是 storage 层唯一的
 * 事务原语，内层用 SAVEPOINT 支持嵌套，被 deleteLastExchange / migrateLegacyMessages /
 * migrateToExecutionStreamLogs 三个多语句写入点依赖 —— 属于数据一致性级基础设施，此前无直接测试。
 *
 * 本文件锁定四类契约：
 *   1. 基础语义：成功必 COMMIT（落盘）、失败必整体 ROLLBACK、错误原样上抛；
 *   2. 嵌套语义：内层失败只回滚到内层 SAVEPOINT、外层失败含内层成功写入一起回滚；
 *   3. 一致性：**中途失败不留半套数据** —— 恢复后状态严格等于事务前快照；
 *   4. 真实调用点：deleteLastExchange / migrateLegacyMessages 的多语句写入确实原子。
 *
 * 注：SQLite 没有「事务内中间态可被外部观测」的钩子，故用 **SQLite 触发器**在真实写入路径上
 * 注入中途失败（RAISE(ABORT)），从而在不改 src 的前提下确定性地制造「写了一半后失败」。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openSqlite,
  closeSqlite,
  runInTransaction,
  SqliteOrgRepo,
  SqliteAgentRepo,
  SqliteChatSessionRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;
let db: ReturnType<typeof openSqlite>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-tx-test-'));
  dbPath = join(tempDir, 'test.db');
  db = openSqlite(dbPath);
  ensureProbeTable();
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── 探针表：事务语义只关心「写没写进去」，与业务表形状无关 ────────────────────

/** 幂等建一张最小探针表（重开连接后仍需存在，故用 IF NOT EXISTS）。 */
function ensureProbeTable(): void {
  db.exec('CREATE TABLE IF NOT EXISTS tx_probe (id TEXT PRIMARY KEY, val TEXT)');
}

/** 探针表写入。 */
function insProbe(id: string, val = 'v'): void {
  db.prepare('INSERT INTO tx_probe (id, val) VALUES (?, ?)').run(id, val);
}

/** 探针表完整快照（行序无关的稳定序列化），用于「事务前后逐字一致」断言。 */
function snapshotProbe(): string {
  const rows = db.prepare('SELECT id, val FROM tx_probe ORDER BY id').all() as Array<{
    id: string;
    val: string | null;
  }>;
  return JSON.stringify(rows);
}

/** 以 id 升序返回某表全部行 id，便于稳定断言「集合相等」而非依赖插入顺序。 */
function idsOf(table: string): string[] {
  const rows = db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// ─── 1. 基础事务语义 ─────────────────────────────────────────────────────────

describe('runInTransaction · 基础事务语义', () => {
  it('成功路径：fn 正常返回 → COMMIT 落盘，重开连接后仍能读到', () => {
    const ret = runInTransaction(db, () => {
      insProbe('ok1');
      return 'ret-ok';
    });

    expect(ret, '返回值原样透出').toBe('ret-ok');
    expect(db.isTransaction, 'COMMIT 之后连接不再处于事务中').toBe(false);
    expect(idsOf('tx_probe')).toEqual(['ok1']);

    // 仅凭同一连接读到自己刚写的东西无法证明「已 COMMIT」，故真正关闭连接再重开同一文件。
    closeSqlite();
    db = openSqlite(dbPath);
    expect(idsOf('tx_probe'), 'COMMIT 之后数据已持久化到库文件').toEqual(['ok1']);
  });

  it('fn 抛错 → 整体回滚；事务前已提交的数据不受影响', () => {
    insProbe('committed-before', 'keep-me'); // 事务外写入，必须存活

    expect(() =>
      runInTransaction(db, () => {
        insProbe('rolled-back');
        throw new Error('业务失败');
      })
    ).toThrow('业务失败');

    expect(idsOf('tx_probe'), '事务内写入全部撤销，事务前数据保留').toEqual(['committed-before']);
    expect(db.isTransaction, '回滚之后没有残留事务').toBe(false);
  });

  it('fn 抛错时原始错误对象被原样上抛（不包装、不吞掉）', () => {
    const original = new Error('原始错误消息');
    let caught: unknown;
    try {
      runInTransaction(db, () => {
        throw original;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, '抛出的必须是同一个错误实例').toBe(original);
  });

  it('非 Error 抛出物（字符串）也原样上抛，且写入被回滚', () => {
    let caught: unknown;
    try {
      runInTransaction(db, () => {
        insProbe('string-throw');
        throw 'plain-string'; // eslint-disable-line no-throw-literal
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe('plain-string');
    expect(idsOf('tx_probe')).toEqual([]);
  });
});

// ─── 2. 嵌套 SAVEPOINT 语义 ──────────────────────────────────────────────────

describe('runInTransaction · 嵌套 SAVEPOINT 语义', () => {
  it('内层抛错 → 只回滚到内层 SAVEPOINT，外层此前已写入的数据仍在', () => {
    runInTransaction(db, () => {
      insProbe('outer-kept');

      let innerErr: unknown;
      try {
        runInTransaction(db, () => {
          insProbe('inner-lost');
          throw new Error('内层失败');
        });
      } catch (e) {
        innerErr = e;
      }
      expect((innerErr as Error).message, '内层原始错误不被掩盖').toBe('内层失败');

      insProbe('outer-after');
    });

    expect(idsOf('tx_probe'), '内层写入被撤销，外层前后两次写入都保留').toEqual([
      'outer-after',
      'outer-kept',
    ]);
  });

  it('外层抛错 → 全部回滚，含内层已成功提交到 SAVEPOINT 的写入', () => {
    insProbe('pre-existing', 'survives');

    expect(() =>
      runInTransaction(db, () => {
        insProbe('outer-1');
        runInTransaction(db, () => {
          insProbe('inner-succeeded'); // 内层无异常，已 RELEASE SAVEPOINT
        });
        insProbe('outer-2');
        throw new Error('外层失败');
      })
    ).toThrow('外层失败');

    expect(idsOf('tx_probe'), '内层成功写入也必须随外层一起回滚').toEqual(['pre-existing']);
  });

  it('嵌套三层：最内层失败被中间层 catch 后继续 → 只回滚最内层，其余全部提交', () => {
    runInTransaction(db, () => {
      insProbe('L1-a');
      runInTransaction(db, () => {
        insProbe('L2-a');
        try {
          runInTransaction(db, () => {
            insProbe('L3-lost');
            throw new Error('第三层失败');
          });
        } catch {
          /* 中间层吞掉最内层的失败，继续自己的写入 */
        }
        insProbe('L2-b');
      });
      insProbe('L1-b');
    });

    expect(idsOf('tx_probe'), '仅 L3 的写入消失，L1/L2 的写入全部提交').toEqual([
      'L1-a',
      'L1-b',
      'L2-a',
      'L2-b',
    ]);
  });

  it('内层失败向外传播 → 外层不吞异常，则整体回滚（嵌套不改变最终原子性）', () => {
    insProbe('pre-existing-2', 'survives');

    expect(() =>
      runInTransaction(db, () => {
        insProbe('L1');
        runInTransaction(db, () => {
          insProbe('L2');
          runInTransaction(db, () => {
            insProbe('L3');
            throw new Error('第三层失败并向外传播');
          });
        });
      })
    ).toThrow('第三层失败并向外传播');

    expect(idsOf('tx_probe')).toEqual(['pre-existing-2']);
  });

  it('同一外层事务内大量「内层失败被吞掉」后，外层仍能正确提交且只保留成功的写入', () => {
    runInTransaction(db, () => {
      for (let i = 0; i < 50; i++) {
        insProbe(`good-${String(i).padStart(2, '0')}`);
        try {
          runInTransaction(db, () => {
            insProbe(`bad-${String(i).padStart(2, '0')}`);
            throw new Error('每次内层都失败');
          });
        } catch {
          /* 吞掉，验证 savepoint 反复建/回滚不会污染外层 */
        }
      }
    });

    const ids = idsOf('tx_probe');
    expect(ids).toHaveLength(50);
    expect(ids.every(id => id.startsWith('good-'))).toBe(true);
    expect(ids.some(id => id.startsWith('bad-'))).toBe(false);
  });
});

// ─── 3. 失败后数据一致性：中途失败不留半套数据 ────────────────────────────────

describe('runInTransaction · 失败后数据一致性（中途失败不留半套数据）', () => {
  it('fn 内写一半后 throw：恢复后的状态严格等于事务前快照', () => {
    insProbe('seed-1', 'A');
    insProbe('seed-2', 'B');
    const before = snapshotProbe();

    let midState = '';
    expect(() =>
      runInTransaction(db, () => {
        // 写一半：2 条 INSERT + 1 条 UPDATE + 1 条 DELETE，然后失败。
        insProbe('half-1', '1');
        insProbe('half-2', '2');
        db.prepare('UPDATE tx_probe SET val = ? WHERE id = ?').run('CHANGED', 'seed-1');
        db.prepare('DELETE FROM tx_probe WHERE id = ?').run('seed-2');

        // 事务内可见：此刻确实处于「写了一半」的中间态（证明失败点不在开头）。
        midState = snapshotProbe();
        expect(midState, '失败前事务内已可见半套修改').not.toBe(before);

        throw new Error('中途失败');
      })
    ).toThrow('中途失败');

    expect(midState).not.toBe(before); // 自证：中途态确实偏离快照
    expect(snapshotProbe(), '回滚后必须逐字等于事务前快照，不留半套数据').toBe(before);
  });

  it('嵌套内层中途失败被吞掉后外层继续：外层快照仍自洽，内层半套修改不泄漏到外层', () => {
    insProbe('stable', 'S');
    const beforeOuter = snapshotProbe();

    runInTransaction(db, () => {
      insProbe('outer-write', 'O');
      try {
        runInTransaction(db, () => {
          insProbe('inner-half', 'H');
          db.prepare('UPDATE tx_probe SET val = ? WHERE id = ?').run('HACKED', 'stable');
          throw new Error('内层中途失败');
        });
      } catch {
        /* 吞掉 */
      }
      insProbe('outer-after', 'O2');
    });

    const afterRows = JSON.parse(snapshotProbe()) as Array<{ id: string; val: string }>;
    const stable = afterRows.find(r => r.id === 'stable');
    expect(stable!.val, '内层对既有行的半套修改必须被回滚').toBe('S');
    expect(afterRows.map(r => r.id)).toEqual(['outer-after', 'outer-write', 'stable']);
    expect(afterRows.some(r => r.id === 'inner-half'), '内层写入不得泄漏').toBe(false);
    // 事务前快照整体仍是「子集关系」：原样保留的数据 + 外层新增
    expect(beforeOuter).toContain('"stable"');
  });
});

// ─── 4. 真实调用点：多语句写入的原子性 ────────────────────────────────────────

/** 建一套最小 chat 夹具（org → agent → session），让 chat_messages 的外键约束真实生效。 */
function seedChatFixture(): { repo: SqliteChatSessionRepo; sessionId: string } {
  new SqliteOrgRepo(db).createOrg({ id: 'org_tx', name: 'Tx Org', ownerId: 'u_tx' });
  new SqliteAgentRepo(db).create({
    id: 'agt_tx',
    name: 'Tx Agent',
    orgId: 'org_tx',
    roleId: 'role_tx',
    roleName: 'Dev',
  });
  const repo = new SqliteChatSessionRepo(db);
  const session = repo.createSession('agt_tx', 'u_tx');
  return { repo, sessionId: session.id };
}

/** 直接插入 chat_messages（显式 created_at，避免同毫秒并列导致 ORDER BY created_at DESC 不稳定）。 */
function insertMsg(id: string, sessionId: string, role: string, content: string, createdAt: string): void {
  db.prepare(
    'INSERT INTO chat_messages (id, session_id, agent_id, role, content, metadata, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, sessionId, 'agt_tx', role, content, null, createdAt);
}

const chatMeta = (id: string): string | null =>
  (db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(id) as { metadata: string | null })
    .metadata;

describe('真实调用点 · deleteLastExchange 多语句删除的原子性', () => {
  it('正常路径：删除最后一轮 user+assistant 并提交（夹具可真实触达）', () => {
    const { repo, sessionId } = seedChatFixture();
    insertMsg('cm_u1', sessionId, 'user', '第一轮问题', '2024-01-01T00:00:01.000Z');
    insertMsg('cm_a1', sessionId, 'assistant', '第一轮回答', '2024-01-01T00:00:02.000Z');
    insertMsg('cm_u2', sessionId, 'user', '第二轮问题', '2024-01-01T00:00:03.000Z');
    insertMsg('cm_a2', sessionId, 'assistant', '第二轮回答', '2024-01-01T00:00:04.000Z');

    repo.deleteLastExchange(sessionId);

    expect(idsOf('chat_messages'), '最后一轮被删除，首轮保留').toEqual(['cm_a1', 'cm_u1']);
    expect(db.isTransaction).toBe(false);
  });

  it('中途失败（第 2 条 DELETE 被触发器中止）→ 已删除的行全部恢复，不留半删状态', () => {
    const { repo, sessionId } = seedChatFixture();
    insertMsg('cm_u1', sessionId, 'user', '第一轮问题', '2024-01-01T00:00:01.000Z');
    insertMsg('cm_a1', sessionId, 'assistant', '第一轮回答', '2024-01-01T00:00:02.000Z');
    insertMsg('cm_u2', sessionId, 'user', '第二轮问题', '2024-01-01T00:00:03.000Z');
    insertMsg('cm_a2', sessionId, 'assistant', '第二轮回答', '2024-01-01T00:00:04.000Z');
    const before = idsOf('chat_messages');

    // 逆序处理：cm_a2 先被删除 → 处理 cm_u2 时中止 ⇒ 事务确实处在「删了一半」的中间态。
    db.exec(`
      CREATE TRIGGER cm_del_bomb BEFORE DELETE ON chat_messages
      WHEN OLD.id = 'cm_u2'
      BEGIN SELECT RAISE(ABORT, '删除中途失败'); END;
    `);

    expect(() => repo.deleteLastExchange(sessionId)).toThrow('删除中途失败');

    expect(idsOf('chat_messages'), '半删状态必须被完整回滚到事务前快照').toEqual(before);
    expect(db.isTransaction).toBe(false);
  });
});

describe('真实调用点 · migrateLegacyMessages 多语句更新的原子性', () => {
  /** 造 2 条「缺 segments」的 legacy assistant 消息。 */
  function seedLegacy(): { repo: SqliteChatSessionRepo; sessionId: string } {
    const fx = seedChatFixture();
    insertMsg('cm_mig1', fx.sessionId, 'assistant', '普通文本一', '2024-01-01T00:00:01.000Z');
    insertMsg('cm_mig2', fx.sessionId, 'assistant', '普通文本二', '2024-01-01T00:00:02.000Z');
    return fx;
  }

  it('正常路径：把缺 segments 的消息一次性迁移完并提交', () => {
    const { repo } = seedLegacy();

    expect(repo.migrateLegacyMessages()).toBe(2);

    expect(chatMeta('cm_mig1')).toContain('segments');
    expect(chatMeta('cm_mig2')).toContain('segments');
    expect(repo.migrateLegacyMessages(), '已迁移的行不再重复处理（幂等）').toBe(0);
  });

  it('(前置校验) 同一夹具下确实产生 2 次 UPDATE —— 证明「中途失败」发生在第 2 行', () => {
    const { repo } = seedLegacy();
    db.exec('CREATE TABLE tx_upd_counter (n INTEGER NOT NULL)');
    db.exec('INSERT INTO tx_upd_counter (n) VALUES (0)');
    db.exec('CREATE TRIGGER cm_upd_count AFTER UPDATE ON chat_messages BEGIN UPDATE tx_upd_counter SET n = n + 1; END');

    expect(repo.migrateLegacyMessages()).toBe(2);
    expect((db.prepare('SELECT n FROM tx_upd_counter').get() as { n: number }).n, '共 2 次 UPDATE').toBe(2);
  });

  it('中途失败（第 2 次 UPDATE 被触发器中止）→ 已迁移的 metadata 全部回滚，不留半套', () => {
    const { repo } = seedLegacy();
    // 计数器 + BEFORE 触发器：第 1 次 UPDATE 成功后，第 2 次 UPDATE 前中止。
    // 中止发生在第 2 行 ⇒ 第 1 行的 UPDATE 已在事务内生效，形成真实的「写了一半」。
    db.exec('CREATE TABLE tx_upd_counter (n INTEGER NOT NULL)');
    db.exec('INSERT INTO tx_upd_counter (n) VALUES (0)');
    db.exec('CREATE TRIGGER cm_upd_count AFTER UPDATE ON chat_messages BEGIN UPDATE tx_upd_counter SET n = n + 1; END');
    db.exec(`
      CREATE TRIGGER cm_upd_bomb BEFORE UPDATE ON chat_messages
      WHEN (SELECT n FROM tx_upd_counter) >= 1
      BEGIN SELECT RAISE(ABORT, '迁移中途失败'); END;
    `);

    expect(() => repo.migrateLegacyMessages()).toThrow('迁移中途失败');

    expect(chatMeta('cm_mig1'), '第 1 行已写入的 segments 必须被回滚').toBeNull();
    expect(chatMeta('cm_mig2')).toBeNull();
    expect(db.isTransaction).toBe(false);

    // 更强的断言：回滚后的库必须仍是「可继续使用」的一致状态 —— 去掉炸弹后能完整重跑。
    db.exec('DROP TRIGGER cm_upd_bomb');
    db.exec('DROP TRIGGER cm_upd_count');
    expect(repo.migrateLegacyMessages(), '回滚后不留半迁移痕迹，重跑仍能迁移全部 2 行').toBe(2);
    expect(chatMeta('cm_mig1')).toContain('segments');
    expect(chatMeta('cm_mig2')).toContain('segments');
  });
});

// ─── 5. 事务原语健壮性（异步陷阱 / 回滚掩错 / savepoint 残留）────────────────
//
// 这一组最初是「缺陷锁定」：补测时发现 runInTransaction 有三个真实缺陷（异步 fn 立即
// COMMIT、catch 里裸 ROLLBACK 掩盖原始错误、ROLLBACK TO 后未 RELEASE）。src 修好之后，
// 断言已反转为**期望语义**，用来防止这三个缺陷回归。

describe('runInTransaction 健壮性 · 异步陷阱 / 回滚掩错 / savepoint 残留', () => {
  it('async fn 必须被当场拒绝（否则 await 之后的写入会静默逃出事务）', () => {
    // 成因（修复前）：fn 是 async 时其同步段先执行、随后返回 Promise（不会同步 throw），
    // 于是 COMMIT 立刻执行；await 之后的写入落在自动提交模式，事务外且无法回滚。
    expect(() =>
      runInTransaction(db, (async () => {
        insProbe('async-before-await'); // 若被误执行，这一笔会随 COMMIT 永久落库
        await Promise.resolve();
        insProbe('async-after-await'); // 修复前：已无事务包裹 → 自动提交，永久落库
        throw new Error('异步体失败');
      }) as unknown as () => void),
    ).toThrow(TypeError);

    // 关键：拒绝发生在 fn 被调用**之前**，所以连同步段都没写进去。
    expect(idsOf('tx_probe')).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });

  it('返回 Promise 的普通箭头函数同样被拒绝（构造器检查看不见它，靠返回值兜底）', () => {
    expect(() =>
      runInTransaction(db, (() => {
        insProbe('promise-fn');
        return Promise.resolve('nope');
      }) as unknown as () => void),
    ).toThrow(TypeError);

    // 同步段已经跑了一笔，但识别到 thenable → 回滚，数据不得落库。
    expect(idsOf('tx_probe')).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });

  it('缺陷②（:947）：fn 内部触发 SQLite 自动回滚时，原始错误被 "cannot rollback" 掩盖', () => {
    // RAISE(ROLLBACK) 会让 SQLite 直接把整个事务回滚掉（SQLITE_FULL / SQLITE_IOERR /
    // SQLITE_BUSY / SQLITE_NOMEM 等致命错误也是同样语义）。此时 catch 里无保护的
    // db.exec('ROLLBACK') 会再抛一次错，把原始错误对象整个替换掉。
    db.exec(`
      CREATE TRIGGER tx_probe_autorb BEFORE INSERT ON tx_probe
      WHEN NEW.id = 'rb'
      BEGIN SELECT RAISE(ROLLBACK, '原始业务错误'); END;
    `);

    let caught: unknown;
    try {
      runInTransaction(db, () => {
        insProbe('rb-1');
        insProbe('rb'); // ← 触发 RAISE(ROLLBACK)，SQLite 自动回滚整个事务
      });
    } catch (e) {
      caught = e;
    }

    // 修复后：catch 里的 ROLLBACK 已容错，原始错误原样传出。
    expect((caught as Error).message).toBe('原始业务错误');
    expect(idsOf('tx_probe'), '数据一致性本身正确').toEqual([]);
  });

  it('缺陷②的嵌套变体（:937）：内层自动回滚后 ROLLBACK TO 报 "no such savepoint"，内层错误被二次掩盖', () => {
    db.exec(`
      CREATE TRIGGER tx_probe_autorb_nested BEFORE INSERT ON tx_probe
      WHEN NEW.id = 'rb-nested'
      BEGIN SELECT RAISE(ROLLBACK, '内层原始错误'); END;
    `);

    const messages: string[] = [];
    try {
      runInTransaction(db, () => {
        insProbe('outer-1');
        try {
          runInTransaction(db, () => {
            insProbe('inner-1');
            insProbe('rb-nested');
          });
        } catch (e) {
          messages.push(`内层捕获: ${(e as Error).message}`);
          throw e; // 向外传播，最终由最外层收尾
        }
      });
    } catch (e) {
      messages.push(`最外层捕获: ${(e as Error).message}`);
    }

    // 修复后：内层自动回滚引发的 "no such savepoint" 被容错，原始错误逐层原样传播。
    expect(messages[0]).toBe('内层捕获: 内层原始错误');
    expect(messages[1]).toBe('最外层捕获: 内层原始错误');
    expect(idsOf('tx_probe'), '数据一致性本身正确').toEqual([]);
  });

  it('SQLite 语义佐证：ROLLBACK TO 不会移除 savepoint，故失败路径必须显式 RELEASE', () => {
    // SQLite 规范里 ROLLBACK TO 只回退数据、**不移除** savepoint —— 用裸 SQL 复现：
    db.exec('BEGIN');
    db.exec('SAVEPOINT sp_leak_probe');
    db.exec('ROLLBACK TO sp_leak_probe');
    expect(
      () => db.exec('RELEASE sp_leak_probe'),
      'ROLLBACK TO 之后 savepoint 仍存在（RELEASE 成功）→ 失败路径若不 RELEASE 即为残留'
    ).not.toThrow();
    db.exec('ROLLBACK');

    expect(db.isTransaction).toBe(false);
  });

  it('源码契约：失败路径必须 RELEASE savepoint（残留无法经公开 API 观测，故钉实现）', () => {
    // savepoint 名随机，且外层 COMMIT/ROLLBACK 会清掉全部 savepoint —— 残留无法通过
    // 公开 API 观测，数据也不受影响，所以这一条只能钉实现。
    // 去掉 swallow(`RELEASE ${sp}`) 会让本用例变红。
    const src = readFileSync(resolve(process.cwd(), 'packages/storage/src/sqlite-storage.ts'), 'utf-8');
    expect(src).toContain('ROLLBACK TO ${sp}');
    expect(src).toContain('RELEASE ${sp}');
  });
});
