/**
 * 第六刀 C2 —— `mailbox_items` 信封列的真实 SQLite 行为。
 *
 * 断言跑真实数据库文件：列存在、写进去读得回来、唯一性由**索引**裁决而不是调用方自觉。
 * 不用 `readFileSync + toContain` 那种文本栅栏——这里要能因实现被改坏而变红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openSqlite,
  closeSqlite,
  SqliteMailboxRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-mbx-env-'));
  dbPath = join(tempDir, 'data.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function repo() {
  const db = openSqlite(dbPath);
  return new SqliteMailboxRepo(db);
}

const baseItem = (over: Record<string, unknown> = {}) => ({
  id: 'mbx_1',
  agentId: 'agt_a',
  sourceType: 'human_chat',
  priority: 0,
  status: 'queued',
  payload: { summary: 'hi', content: 'hello' },
  metadata: {},
  queuedAt: '2026-11-12T00:00:00.000Z',
  ...over,
});

const envelopeJson = JSON.stringify({
  from: { kind: 'im', platform: 'feishu', nativeUserId: 'u1' },
  to: { kind: 'agent', agentId: 'agt_a' },
  subject: 'hello',
  messageId: 'native-1',
  intent: 'deliver',
  signalClass: 'chat',
  auth: null,
  replyTo: null,
  workUnitRef: null,
  externalThreadRef: null,
  fromVerified: false,
});

describe('mailbox_items — 信封列落库与读回', () => {
  it('写入 envelope / message_id / signal_class / intent，读回逐字段相等', () => {
    const r = repo();
    expect(r.save(baseItem({
      envelope: envelopeJson,
      messageId: 'native-1',
      signalClass: 'chat',
      intent: 'deliver',
    }))).toBe(true);

    const row = r.getById('mbx_1');
    expect(row?.envelope).toBe(envelopeJson);
    expect(row?.messageId).toBe('native-1');
    expect(row?.signalClass).toBe('chat');
    expect(row?.intent).toBe('deliver');
    expect(row?.dropReason).toBeNull();
    expect(row?.bounceTarget).toBeNull();
  });

  it('work_unit_ref 只加列、不写值（本卡不建引用，避免先建引用后建实体）', () => {
    const r = repo();
    r.save(baseItem({ envelope: envelopeJson, messageId: 'native-1' }));
    expect(r.getById('mbx_1')?.workUnitRef).toBeNull();
  });

  it('旧调用方（不传信封）仍然可写：新列落 NULL，不报错、不回填', () => {
    const r = repo();
    expect(r.save(baseItem())).toBe(true);
    const row = r.getById('mbx_1');
    expect(row?.envelope).toBeNull();
    expect(row?.messageId).toBeNull();
  });
});

describe('mailbox_items — messageId 幂等由索引裁决（V5）', () => {
  it('同一 (agent, messageId) 第二次插入被拒（返回 false）', () => {
    const r = repo();
    expect(r.save(baseItem({ envelope: envelopeJson, messageId: 'native-1' }))).toBe(true);
    expect(r.save(baseItem({ id: 'mbx_2', envelope: envelopeJson, messageId: 'native-1' }))).toBe(false);
    expect(r.getByAgent('agt_a').length).toBe(1);
  });

  it('不同 agent 的同名 messageId 互不影响（幂等域是 agent）', () => {
    const r = repo();
    expect(r.save(baseItem({ envelope: envelopeJson, messageId: 'native-1' }))).toBe(true);
    expect(r.save(baseItem({ id: 'mbx_2', agentId: 'agt_b', envelope: envelopeJson, messageId: 'native-1' }))).toBe(true);
  });

  it('退信行（bounced）不占用 messageId 唯一键：一 queued + 一条 duplicate 退信行可共存', () => {
    const r = repo();
    expect(r.save(baseItem({ envelope: envelopeJson, messageId: 'native-1' }))).toBe(true);
    // 退信行按实现约定不带 messageId（saveBounced 传 null），但即便带了也必须不冲突：
    // 谓词 `status <> 'bounced'` 就是为这条语义写的。
    expect(r.save(baseItem({
      id: 'mbx_bounce',
      status: 'bounced',
      dropReason: 'duplicate_message_id',
      envelope: envelopeJson,
      messageId: null,
    }))).toBe(true);
    expect(r.findByMessageId('agt_a', 'native-1')?.id).toBe('mbx_1');
    expect(r.getByAgent('agt_a', { status: 'bounced' }).length).toBe(1);
  });

  it('findByMessageId 排除退信行（退信记录不是「同一条消息的第二份」）', () => {
    const r = repo();
    r.save(baseItem({
      id: 'mbx_bounce', status: 'bounced', dropReason: 'duplicate_message_id',
      envelope: envelopeJson, messageId: 'native-9',
    }));
    expect(r.findByMessageId('agt_a', 'native-9')).toBeUndefined();
  });
});
