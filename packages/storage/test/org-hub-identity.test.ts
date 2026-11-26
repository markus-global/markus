/**
 * C10-D · 组织身份：org_slug 派生 + hub 对齐的库层不变量。
 *
 * 锁四件事，每一条都能因实现被换掉而变红：
 *   1. 占位 slug 是**合法地址段** —— 否则没连 hub 的用户拿到的地址根本解析不了；
 *   2. bindHubOrg 幂等 —— 同一 hub org 重复对齐不产生第二份历史；
 *   3. 已签发地址的组织**不改** slug —— 已发出的地址不能变成悬空引用；
 *   4. 对齐不碰本地主键 —— agents / teams / channel_bindings 全挂在 organizations.id 上。
 *
 * 判据：把 registryOrgSlug 改回 `org_<id>`，或删掉 bindHubOrg 里的「已签发」判断，
 * 本文件必红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqliteOrgRepo, registryOrgSlug } from '../src/sqlite-storage.js';
import { checkOrgSlug, MAX_ORG_SLUG_LENGTH } from '@markus/shared';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteOrgRepo;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-org-identity-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteOrgRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('registryOrgSlug — 离线占位必须可解析', () => {
  it('产出通过地址段规则（与被绑定的地址同一套校验，没有第二份）', () => {
    expect(checkOrgSlug(registryOrgSlug('default')).ok).toBe(true);
  });

  it('同一 orgId 恒得同一 slug（backfill 重跑是 no-op，不制造第二份历史）', () => {
    expect(registryOrgSlug('default')).toBe(registryOrgSlug('default'));
  });

  it('超长 id 也不会超出地址段 30 字符上限', () => {
    const slug = registryOrgSlug(`org-${'x'.repeat(80)}`);
    expect(slug.length).toBeLessThanOrEqual(MAX_ORG_SLUG_LENGTH);
    expect(checkOrgSlug(slug).ok).toBe(true);
  });

  it('不再含让旧占位不可寻址的下划线', () => {
    expect(registryOrgSlug('default')).not.toContain('_');
  });
});

describe('bindHubOrg — hub_org_id 的唯一写者', () => {
  it('记录 hub 身份，并把本地 slug 同步成 hub 的地址段', () => {
    repo.createOrg({ id: 'default', name: 'My Organization', ownerId: 'u1' });
    const r = repo.bindHubOrg('default', 'hub_1', 'acme');
    expect(r).toMatchObject({ ok: true, orgSlug: 'acme' });
    const org = repo.findOrgById('default')!;
    expect(org.hubOrgId).toBe('hub_1');
    expect(org.orgSlug).toBe('acme');
    expect(org.hubSyncedAt).toBeTruthy();
  });

  it('幂等：同一 hub org 再登录一次，读到的字节不变', () => {
    repo.createOrg({ id: 'default', name: 'O', ownerId: 'u1' });
    repo.bindHubOrg('default', 'hub_1', 'acme');
    const first = repo.findOrgById('default')!;
    const r = repo.bindHubOrg('default', 'hub_1', 'acme');
    const second = repo.findOrgById('default')!;
    expect(r).toMatchObject({ ok: true, orgSlug: 'acme' });
    expect(r).not.toHaveProperty('slugSkipped');
    expect(second.orgSlug).toBe(first.orgSlug);
    expect(second.hubOrgId).toBe(first.hubOrgId);
  });

  it('不新建组织、不改主键（子表引用稳）', () => {
    repo.createOrg({ id: 'default', name: 'O', ownerId: 'u1' });
    repo.bindHubOrg('default', 'hub_1', 'acme');
    expect(repo.listOrgs().map((o) => o.id)).toEqual(['default']);
  });

  it('已签发过地址时锁住 slug，但身份照样记下（可绑性优先于同步）', () => {
    repo.createOrg({ id: 'default', name: 'O', ownerId: 'u1' });
    db.prepare(
      "INSERT INTO channel_bindings (id, org_id, scope, agent_id, address) VALUES (?, ?, 'mailbox', 'a1', ?)",
    ).run('cb1', 'default', 'me.local-ab12cd34@markus.global');

    const r = repo.bindHubOrg('default', 'hub_1', 'acme');
    expect(r).toMatchObject({ ok: true, slugSkipped: 'already_issued' });
    const org = repo.findOrgById('default')!;
    expect(org.orgSlug).toBe(registryOrgSlug('default'));
    expect(org.hubOrgId).toBe('hub_1');
  });

  it('hub 给了非法 slug 时不污染本地列（占位保持合法）', () => {
    repo.createOrg({ id: 'default', name: 'O', ownerId: 'u1' });
    const r = repo.bindHubOrg('default', 'hub_1', 'Bad_Slug');
    expect(r).toMatchObject({ ok: true, slugSkipped: 'invalid_hub_slug' });
    const org = repo.findOrgById('default')!;
    expect(org.orgSlug).toBe(registryOrgSlug('default'));
    expect(checkOrgSlug(org.orgSlug!).ok).toBe(true);
  });

  it('组织不存在时明确拒绝，而不是静默 no-op', () => {
    expect(repo.bindHubOrg('nope', 'hub_1', 'acme')).toEqual({ ok: false, reason: 'org_not_found' });
  });
});
