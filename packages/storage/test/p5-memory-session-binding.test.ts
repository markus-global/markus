/**
 * 【P5】按内存会话 id 反查 DB 会话 id（cs_*）—— `callback_result` 回复落库/广播的目标定位。
 *
 * 为什么需要：异步回调（`background_exec` 完成、a2a in_session 回复）回到发起它的那一轮时
 * 只知道**内存会话 id**（`sess_*`）。要把回复写回正确的对话、并把「后台任务完成」气泡广播
 * 给该对话，必须先把内存会话映射回 cs_*。绑定由
 * `updateSessionMetadata(dbSessionId, { memorySessionId })` 写入（org-manager 的
 * `persistMemorySessionBinding`）。
 *
 * 契约：**纯读**（不新增列、不改 schema、不动存量数据）；无绑定时返回 null —— 调用方
 * 「宁可缺失，也不落错会话」。
 */
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
    .prepare(`INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, ?, ?)`)
    .run(agentId, `Agent ${marker}`, orgId, 'role-' + marker, 'worker');
  return agentId;
}

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-mem-binding-'));
  dbPath = join(tempDir, 'binding.db');
  repo = new SqliteChatSessionRepo(db());
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SqliteChatSessionRepo.findSessionIdByMemorySessionId', () => {
  it('写入 memorySessionId 绑定后能按内存会话反查回 cs_*', () => {
    const agentId = seedAgent('p5a');
    const session = repo.getOrCreateMainSession(agentId, 'user-1');
    repo.updateSessionMetadata(session!.id, { memorySessionId: 'sess_abc' });

    expect(repo.findSessionIdByMemorySessionId(agentId, 'sess_abc')).toBe(session!.id);
  });

  it('未写绑定的会话 → null（不做任何猜测，绝不返回别的会话）', () => {
    const agentId = seedAgent('p5b');
    repo.getOrCreateMainSession(agentId, 'user-1');

    expect(repo.findSessionIdByMemorySessionId(agentId, 'sess_unknown')).toBeNull();
  });

  it('不跨 agent：同一个内存会话 id 只在该 agent 的会话里命中', () => {
    const agentA = seedAgent('p5c');
    const agentB = seedAgent('p5d');
    const sA = repo.getOrCreateMainSession(agentA, 'user-1');
    const sB = repo.getOrCreateMainSession(agentB, 'user-1');
    repo.updateSessionMetadata(sA!.id, { memorySessionId: 'sess_shared' });
    repo.updateSessionMetadata(sB!.id, { memorySessionId: 'sess_shared' });

    expect(repo.findSessionIdByMemorySessionId(agentA, 'sess_shared')).toBe(sA!.id);
    expect(repo.findSessionIdByMemorySessionId(agentB, 'sess_shared')).toBe(sB!.id);
  });

  it('元数据里有别的键但没有 memorySessionId → null（旧会话可原地回退）', () => {
    const agentId = seedAgent('p5e');
    const session = repo.getOrCreateMainSession(agentId, 'user-1');
    repo.updateSessionMetadata(session!.id, { title: 'x', something: 1 });

    expect(repo.findSessionIdByMemorySessionId(agentId, 'sess_nope')).toBeNull();
  });

  it('空参数/无元数据表行 → 安全 no-op（不抛异常）', () => {
    const agentId = seedAgent('p5f');
    repo.getOrCreateMainSession(agentId, 'user-1');

    expect(repo.findSessionIdByMemorySessionId(agentId, '')).toBeNull();
    expect(repo.findSessionIdByMemorySessionId('', 'sess_x')).toBeNull();
  });
});
