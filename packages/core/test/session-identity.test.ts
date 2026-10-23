/**
 * 会话身份统一 —— 双读 / 单写 / 兼容旧数据。
 *
 * 背景（2026-10-23）：一个对话曾经有两个 id、两个写者，靠 `agent.ts` 里一张
 * **进程内** `dbSessionMap` 粘合。重启即失 → 从 DB 瘦重建 → tool calls 全丢；
 * 边界上任何一处拿两个 id 相比就出错（工具审批就是因为 `sess_ ≠ cs_` 被整段
 * 隐藏，长达 12 天无人发现）。
 *
 * 本文件钉死新的契约：
 *   单写  `MemoryStore.createSession(agentId, id?)` 是唯一创建点，给出 `cs_` 就用它
 *   双读  `getSession(id)` 按文件名直读，`cs_` / `sess_` / `hb_` 一律可读
 *   持久  旧会话的 `cs_ → sess_` 绑定落盘，跨实例（≈重启）仍然有效
 *
 * 注意：旧 `sess_*.json` 无法自动配对到 `cs_`（消息体只有 role/content，没有
 * messageId，也没有任何 cs_ 线索），因此「迁移」是零动作 —— 旧文件保留可读，
 * 新会话一律单 id。测试不为不可能的事伪造断言。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { SessionBindingStore } from '../src/session-bindings.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-session-identity-'));
});

const sessionsDir = () => join(dataDir, 'sessions');
const sessionFile = (id: string) => join(sessionsDir(), `${id}.json`);

describe('单写 · createSession 接受权威 id', () => {
  it('传入 cs_ 时以它为主键，并落盘同名文件', () => {
    const store = new MemoryStore(dataDir);
    const s = store.createSession('agt_a', 'cs_abc123');
    store.flushSession(s.id); // persistence is debounced by design — flush explicitly

    expect(s.id).toBe('cs_abc123');
    expect(existsSync(sessionFile('cs_abc123'))).toBe(true);
    expect(JSON.parse(readFileSync(sessionFile('cs_abc123'), 'utf-8')).id).toBe('cs_abc123');
  });

  it('不传 id 时仍生成 sess_（纯内部会话的兜底，语义不变）', () => {
    const store = new MemoryStore(dataDir);
    expect(store.createSession('agt_a').id).toMatch(/^sess_/);
  });

  it('同一个 cs_ 重复创建是幂等的 —— 不产生第二个文件、不丢已有消息', () => {
    const store = new MemoryStore(dataDir);
    const first = store.createSession('agt_a', 'cs_dup');
    store.appendMessage(first.id, { role: 'user', content: '第一条' });
    store.flushSession(first.id);

    const again = store.createSession('agt_a', 'cs_dup');
    expect(again.id).toBe('cs_dup');
    expect(again.messages).toHaveLength(1);
    expect(readdirSync(sessionsDir()).filter((f) => f.startsWith('cs_dup'))).toHaveLength(1);
  });
});

describe('双读 · 两套 id 都能按 id 读', () => {
  it('cs_ 与旧 sess_ 文件同时可读', () => {
    mkdirSync(sessionsDir(), { recursive: true });
    // 旧数据形态：一个历史上的 sess_ 文件（只有 role/content，无 messageId）
    writeFileSync(sessionFile('sess_old'), JSON.stringify({
      id: 'sess_old', agentId: 'agt_a',
      messages: [{ role: 'user', content: '旧对话' }],
      startedAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:00:00.000Z',
    }));

    const store = new MemoryStore(dataDir);
    store.createSession('agt_a', 'cs_new');

    expect(store.getSession('sess_old')?.messages[0]?.content).toBe('旧对话');
    expect(store.getSession('cs_new')?.id).toBe('cs_new');
  });

  it('新实例（≈重启）能按 cs_ 读回已落盘的会话', () => {
    const first = new MemoryStore(dataDir);
    const s = first.createSession('agt_a', 'cs_persist');
    first.appendMessage(s.id, { role: 'user', content: '重启前' });
    first.flushSession(s.id);

    const second = new MemoryStore(dataDir);
    expect(second.getSession('cs_persist')?.messages[0]?.content).toBe('重启前');
  });
});

describe('持久绑定 · 旧会话的 cs_ → sess_ 别名', () => {
  const bindings = () => new SessionBindingStore(join(sessionsDir(), '_bindings.json'));

  it('写入后新实例仍能解析（旧的进程内 Map 正是丢失在这）', () => {
    bindings().bind('cs_1', 'sess_1');
    expect(bindings().resolve('cs_1')).toBe('sess_1');
  });

  it('未绑定的 cs_ 返回 undefined', () => {
    expect(bindings().resolve('cs_none')).toBeUndefined();
  });

  it('重复绑定同一 cs_ 覆盖为最新值，且不重复记账', () => {
    const b = bindings();
    b.bind('cs_1', 'sess_1');
    b.bind('cs_1', 'sess_2');
    expect(bindings().resolve('cs_1')).toBe('sess_2');
    expect(Object.keys(JSON.parse(readFileSync(join(sessionsDir(), '_bindings.json'), 'utf-8')).bindings))
      .toEqual(['cs_1']);
  });

  it('解除绑定后不再解析', () => {
    const b = bindings();
    b.bind('cs_1', 'sess_1');
    b.unbind('cs_1');
    expect(bindings().resolve('cs_1')).toBeUndefined();
  });

  it('绑定文件损坏 → 降级为空绑定，不抛错（不能让坏文件卡住启动）', () => {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(join(sessionsDir(), '_bindings.json'), '{ 这不是 JSON');
    expect(bindings().resolve('cs_1')).toBeUndefined();
  });

  it('绑定文件是 JSON 但形状不对 → 同样降级', () => {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(join(sessionsDir(), '_bindings.json'), JSON.stringify({ bindings: 'nope' }));
    expect(bindings().resolve('cs_1')).toBeUndefined();
  });

  it('目标文件已被清理 → 视为无绑定（调用方回退到重建）', () => {
    const b = bindings();
    b.bind('cs_1', 'sess_gone');
    const store = new MemoryStore(dataDir);
    expect(store.getSession(b.resolve('cs_1')!)).toBeUndefined();
  });
});
