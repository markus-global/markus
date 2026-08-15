import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite,
  closeSqlite,
  SqliteChatSessionRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;
let repo: SqliteChatSessionRepo;

function db() {
  return openSqlite(dbPath);
}

/** 创建一个可用的 agent 行（满足 org/team FK），返回 id。 */
function seedAgent(marker: string): string {
  const orgId = `org-${marker}`;
  const agentId = `agt-${marker}`;
  db().prepare(`INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)`).run(orgId, `Org ${marker}`, 'owner-' + marker);
  db()
    .prepare(
      `INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, ?, ?)`
    )
    .run(agentId, `Agent ${marker}`, orgId, 'role-' + marker, 'worker');
  return agentId;
}

/** 直接 SQL 调整某条消息的 created_at（用于可控的时间过滤测试）。 */
function setMsgTime(sessionId: string, idx: number, iso: string): void {
  const row = db()
    .prepare(
      `SELECT id FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 1 OFFSET ?`
    )
    .get(sessionId, idx) as { id: string } | undefined;
  if (!row) throw new Error(`no message at index ${idx} for session ${sessionId}`);
  db().prepare(`UPDATE chat_messages SET created_at = ? WHERE id = ?`).run(iso, row.id);
}

/** 直接 SQL 调整 session 的 last_message_at。 */
function setSessionTime(sessionId: string, iso: string): void {
  db().prepare(`UPDATE chat_sessions SET last_message_at = ? WHERE id = ?`).run(iso, sessionId);
}

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-session-query-'));
  dbPath = join(tempDir, 'session.db');
  repo = new SqliteChatSessionRepo(db());
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SqliteChatSessionRepo.listSessionsPaginated', () => {
  function makeSession(agentId: string, i: number): string {
    return repo.createSession(agentId, `user${i}`).id;
  }

  it('列出某 agent 的全部 session（>默认 pageSize 也分页完整）', () => {
    const agentA = seedAgent('A');
    for (let i = 0; i < 5; i++) makeSession(agentA, i);
    makeSession(seedAgent('B'), 99); // 其他 agent 的不应混入

    const r = repo.listSessionsPaginated(agentA, { page: 1, pageSize: 3 });
    expect(r.total).toBe(5);
    expect(r.sessions).toHaveLength(3);
    expect(r.hasMore).toBe(true);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(3);

    const r2 = repo.listSessionsPaginated(agentA, { page: 2, pageSize: 3 });
    expect(r2.sessions).toHaveLength(2);
    expect(r2.hasMore).toBe(false);

    // 所有页的 id 组合 = 该 agent 全部 session
    const allIds = [...r.sessions, ...r2.sessions].map(s => s.id);
    expect(allIds).toHaveLength(5);
    expect(new Set(allIds).size).toBe(5);
  });

  it('按 last_message_at 时间范围过滤（since/until）', () => {
    const agent = seedAgent('T');
    const s1 = repo.createSession(agent, 'u1').id; // 最旧
    const s2 = repo.createSession(agent, 'u2').id;
    const s3 = repo.createSession(agent, 'u3').id;
    // 给三个 session 设定不同的 last_message_at：s1 较早、s3 较晚
    setSessionTime(s1, '2026-01-01T00:00:00.000Z');
    setSessionTime(s2, '2026-06-01T00:00:00.000Z');
    setSessionTime(s3, '2026-10-01T00:00:00.000Z');

    // 只取 2026-06-01 之后
    const r = repo.listSessionsPaginated(agent, { since: '2026-06-01T00:00:00.000Z' });
    const ids = r.sessions.map(s => s.id).sort();
    expect(ids).toEqual([s2, s3].sort());
    expect(r.total).toBe(2);

    // 只取 2026-06-01 之前（含边界 06-01：s1 早于、s2 等于边界）
    const rBefore = repo.listSessionsPaginated(agent, { until: '2026-06-01T00:00:00.000Z' });
    expect(rBefore.sessions.map(s => s.id).sort()).toEqual([s1, s2].sort());
    expect(rBefore.total).toBe(2);
  });

  it('空结果返回 total=0 / 空数组 / hasMore=false', () => {
    const r = repo.listSessionsPaginated(seedAgent('none'), { page: 1, pageSize: 20 });
    expect(r.total).toBe(0);
    expect(r.sessions).toEqual([]);
    expect(r.hasMore).toBe(false);
  });

  it('pageSize 超过上限被钳制，负页码归一', () => {
    const agent = seedAgent('C');
    for (let i = 0; i < 3; i++) makeSession(agent, i);
    const r = repo.listSessionsPaginated(agent, { page: 0, pageSize: 9999 });
    expect(r.sessions.length).toBeLessThanOrEqual(50);
    expect(r.page).toBe(1);
  });

  it('返回的字段映射正确（ChatSession 形态）', () => {
    const agent = seedAgent('M');
    const id = repo.createSession(agent, 'u-map').id;
    const r = repo.listSessionsPaginated(agent, { page: 1, pageSize: 10 });
    const s = r.sessions.find(x => x.id === id)!;
    expect(s.agentId).toBe(agent);
    expect(s.userId).toBe('u-map');
    expect(s.createdAt).toBeInstanceOf(Date);
    expect(s.lastMessageAt).toBeInstanceOf(Date);
  });
});

describe('SqliteChatSessionRepo.listMessagesPaginated', () => {
  it('返回消息正序（旧→新）+ 分页 + total', () => {
    const agent = seedAgent('msg');
    const sid = repo.createSession(agent).id;
    for (let i = 0; i < 7; i++) {
      repo.appendMessage(sid, agent, i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`);
    }
    const r = repo.listMessagesPaginated(sid, { page: 1, pageSize: 3 });
    expect(r.total).toBe(7);
    expect(r.messages).toHaveLength(3);
    // 正序：最先插入的在最前
    expect(r.messages[0].content).toBe('msg-0');
    expect(r.messages[1].content).toBe('msg-1');
    expect(r.hasMore).toBe(true);

    const r3 = repo.listMessagesPaginated(sid, { page: 3, pageSize: 3 });
    expect(r3.messages).toHaveLength(1);
    expect(r3.messages[0].content).toBe('msg-6');
    expect(r3.hasMore).toBe(false);
  });

  it('按 created_at 时间范围过滤消息（since/until）', () => {
    const agent = seedAgent('msgT');
    const sid = repo.createSession(agent).id;
    for (let i = 0; i < 5; i++) repo.appendMessage(sid, agent, 'user', `m${i}`);
    // 设定时间：m0 最早，m4 最晚
    setMsgTime(sid, 0, '2026-01-01T00:00:00.000Z');
    setMsgTime(sid, 1, '2026-02-01T00:00:00.000Z');
    setMsgTime(sid, 2, '2026-03-01T00:00:00.000Z');
    setMsgTime(sid, 3, '2026-04-01T00:00:00.000Z');
    setMsgTime(sid, 4, '2026-05-01T00:00:00.000Z');

    const r = repo.listMessagesPaginated(sid, {
      since: '2026-03-01T00:00:00.000Z',
      until: '2026-05-01T00:00:00.000Z',
    });
    // 边界含 3 月到 5 月（含两端），应为 m2, m3, m4
    expect(r.messages.map(m => m.content)).toEqual(['m2', 'm3', 'm4']);
    expect(r.total).toBe(3);
  });

  it('消息字段映射正确且正序稳定', () => {
    const agent = seedAgent('msgMap');
    const sid = repo.createSession(agent).id;
    repo.appendMessage(sid, agent, 'user', 'hello', 10, { foo: 'bar' });
    const r = repo.listMessagesPaginated(sid, { page: 1, pageSize: 10 });
    const m = r.messages[0];
    expect(m.role).toBe('user');
    expect(m.content).toBe('hello');
    expect(m.tokensUsed).toBe(10);
    expect(m.metadata).toEqual({ foo: 'bar' });
    expect(m.createdAt).toBeInstanceOf(Date);
  });
});
