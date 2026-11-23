/**
 * C10-C §2.2 —— 跨组织策略的「人类批准抬升」（org-manager 唯一裁决点）。
 *
 * SSOT: docs/design/c10-c-trust-boundary-2026-11-23.md §2.1 / §2.2 / §4
 *       （验收条款来源 c10-external-adapters-plan-2026-11-19.md §C）
 *
 * 这一组锁的是「放宽信任边界必须留下一个人类」这条结构事实：
 *   S1 新组织默认 cross_org_policy='observe'（抬升是显式动作，不是默认态）；
 *   S2/S3 `OrganizationService.setCrossOrgPolicy(orgId, policy, actorUserId)` 的
 *        actor 必须是 users 表里的**人类行**：agent id / 未知 id / 空 actor 一律
 *        **拒绝且无副作用**（策略不变、audit_logs 零行）。拒绝发生在服务层，
 *        不是只在 HTTP 边界拦 —— 任何别的调用方也绕不过去；
 *   S4 人类 actor 抬升 observe→auto：策略落库 + **恰好一条**审计行
 *      （event_type='cross_org_policy_changed', user_id=actor, metadata 含 orgId/from/to, success=true）；
 *   S5 降级 auto→observe 同样留痕（双向可追溯，放权与收权都有人署名）；
 *   A1-A3 `POST /api/orgs/:orgId/cross-org-policy` 在 requireAuth + owner/admin 之后：
 *        401 未认证 / 403 已认证但非 owner|admin / 200 且策略+审计行落地。
 *
 * 只用真存储：临时 SQLite 文件 + 真实 repo（SqliteOrgRepo / SqliteUserRepo /
 * SqliteAuditRepo），审计行用**裸 SQL** 数（不信任何服务层回执）。
 * 列的默认值/落库形状由 packages/storage/test/c10-c-cross-org-policy.test.ts 负责，
 * 这里不重复测列（只读 repo 映射出的 crossOrgPolicy，也就是实现与 API 实际用的读法）。
 *
 * base（00358c88）上必须红：cross_org_policy 列不存在 / setCrossOrgPolicy 不存在 /
 * 路由不存在（404）。所有「期望抛错」的用例都先断言方法存在 —— 否则一个
 * `TypeError: not a function` 会被 try/catch 吞成「成功拒绝」，把空壳实现测成绿的。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as storage from '../../storage/src/sqlite-storage.js';
import { OrganizationService } from '../src/org-service.js';
import { APIServer } from '../src/api-server.js';
import { TaskService } from '../src/task-service.js';
import { signToken } from '../src/middleware/auth.js';
import { createMockAgentManager, request } from './api-server-test-helpers.js';
import type { StorageBridge } from '../src/storage-bridge.js';

const ORG = 'org_acme';
const HUMAN_OWNER = 'usr_human_owner';
const HUMAN_ADMIN = 'usr_human_admin';
const HUMAN_MEMBER = 'usr_human_member';
/** 真实的 agents 行（存在、但**不是**人类）：用来区分「id 不存在」与「不是人」。 */
const AGENT_ACTOR = 'agt_intruder';
/** users 表里没有的 id：不是人，也不是任何东西。 */
const GHOST_USER = 'usr_ghost';

/** §2.2 冻结的审计事件字面量。 */
const EVENT = 'cross_org_policy_changed';

/** API 面用的会话签名密钥（与 api-server 走同一个 resolveJwtSecret 读取路径）。 */
const TEST_JWT_SECRET = 'c10-c-policy-elevation-test-secret-2f9a1c';

type CrossOrgPolicy = 'observe' | 'auto';

/**
 * 契约面。实现尚未存在，所以测试按这个形状访问 —— 运行时缺失时由
 * `expectMethod()` 直接判红（而不是让后面的 `toThrow` 被 TypeError 蒙混过关）。
 */
interface PolicyApi {
  setCrossOrgPolicy(orgId: string, policy: CrossOrgPolicy, actorUserId?: string): unknown;
}

interface AuditRow {
  id: string;
  event_type: string;
  agent_id: string | null;
  user_id: string | null;
  details: string | null;
  metadata: string | null;
  created_at: string;
}

let tempDir: string;
let db: ReturnType<typeof storage.openSqlite>;
let orgRepo: storage.SqliteOrgRepo;
let userRepo: storage.SqliteUserRepo;
let bridge: StorageBridge;
let service: OrganizationService;
let policy: Partial<PolicyApi>;

beforeEach(async () => {
  storage.closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c10c-elevation-'));
  db = storage.openSqlite(join(tempDir, 'data.db'));

  orgRepo = new storage.SqliteOrgRepo(db);
  userRepo = new storage.SqliteUserRepo(db);
  // 真 repo 拼成的 storage 端口（三个 repo 都落在上面这个真库文件上，没有替身）。
  bridge = {
    orgRepo,
    userRepo,
    auditRepo: new storage.SqliteAuditRepo(db),
  } as unknown as StorageBridge;

  service = new OrganizationService(createMockAgentManager() as never, {} as never, bridge);
  policy = service as unknown as Partial<PolicyApi>;

  // 组织走服务自己的创建路径（内存 + 真库），因此无论实现从内存还是从 repo 读组织都成立。
  // 创建时**不**写策略列：'observe' 是列默认值，不是某个创建者的手写选择。
  await service.createOrganization('Acme', HUMAN_OWNER, ORG);
});

afterEach(() => {
  storage.closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** 实现与 API 读取策略的路径（repo 行映射），不看内存副本。 */
function policyOf(orgId = ORG): string | undefined {
  const row = orgRepo.findOrgById(orgId) as unknown as { crossOrgPolicy?: string } | undefined;
  return row?.crossOrgPolicy;
}

/** 人类 actor 必须是 users 表里的真行（agent 行在 agents 表，永不在此）。 */
function createHuman(id: string, role: 'owner' | 'admin' | 'member'): void {
  userRepo.create({ id, orgId: ORG, name: `Human ${role}`, email: `${id}@example.com`, role });
}

/** 真实 agent 行（agents 表），用于证明「agent 不是人类」而不是「id 不存在」。 */
function createAgentRow(id: string): void {
  db.prepare(
    "INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, 'role_w', 'worker')",
  ).run(id, `Agent ${id}`, ORG);
}

/** 裸 SQL：只数这一类事件行，不信服务层回执。 */
function eventRows(): AuditRow[] {
  return db
    .prepare('SELECT * FROM audit_logs WHERE event_type = ?')
    .all(EVENT) as unknown as AuditRow[];
}

function totalAuditRows(): number {
  return (db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c;
}

/**
 * 成功路径的审计写者本身是 async：给实现一点时间把行落库（最多 1s）。
 * 拒绝路径要的正好相反 —— 见 {@link settle}。
 */
async function eventRowsAtLeast(expected: number, timeoutMs = 1000): Promise<AuditRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = eventRows();
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    rows = eventRows();
  }
  return rows;
}

/** 让已经排队（未 await）的写者有机会落地，之后「零审计」才算真的零。 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 25));
}

/** metadata 是 §2.2 契约规定的载荷位置（auditRepo.insert 会把 orgId/action/success 合并进去）。 */
function metadataOf(row: AuditRow): Record<string, unknown> {
  expect(row.metadata, '审计行必须带 metadata（放权/收权要有可追溯的载荷）').toBeTruthy();
  return JSON.parse(String(row.metadata)) as Record<string, unknown>;
}

/** 接受同步抛出与 async 拒绝两种实现形态。 */
async function refusalOf(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (err) {
    return err;
  }
  throw new Error('expected setCrossOrgPolicy to REFUSE, but the call resolved');
}

/** 方法缺失时先红在这里 —— 否则拒绝用例会被 TypeError 假绿。 */
function expectMethod(): PolicyApi['setCrossOrgPolicy'] {
  const fn = policy.setCrossOrgPolicy;
  expect(typeof fn, 'OrganizationService.setCrossOrgPolicy 必须存在').toBe('function');
  return fn as PolicyApi['setCrossOrgPolicy'];
}

/** 把一组 (from -> to) 结构事实整理成可比较的集合（不依赖时间排序）。 */
function transitionPairs(rows: AuditRow[]): string[] {
  return rows
    .map(row => {
      const meta = metadataOf(row);
      return `${String(meta['from'])}->${String(meta['to'])}`;
    })
    .sort();
}

// ─── S1 ─────────────────────────────────────────────────────────────────────

describe('C10-C §2.1 —— 新组织的跨组织策略默认值', () => {
  it('S1: 新组织读 crossOrgPolicy=observe（从未显式写入）', () => {
    expect(orgRepo.findOrgById(ORG)).toBeDefined();
    expect(policyOf()).toBe('observe');
    // 有（人类）owner 行也不改变默认：抬升必须是显式动作，不是副产物。
    createHuman(HUMAN_OWNER, 'owner');
    expect(policyOf()).toBe('observe');
  });
});

// ─── S2 / S3 ────────────────────────────────────────────────────────────────

describe('C10-C §2.2 —— 没有人类批准行的抬升在服务层被拒（拒绝无副作用）', () => {
  it('S2: agent id 作 actor（agents 表有行、users 表没有）⇒ 抛错，策略不变、审计零行', async () => {
    const setCrossOrgPolicy = expectMethod();
    createAgentRow(AGENT_ACTOR);
    // 关键对照：这个 id **存在**（agents 行），被拒是因为它不是人类用户行。
    expect(userRepo.findById(AGENT_ACTOR) ?? null).toBeNull();
    expect(policyOf()).toBe('observe');

    const err = await refusalOf(() => setCrossOrgPolicy.call(policy, ORG, 'auto', AGENT_ACTOR));

    expect(err).toBeInstanceOf(Error);
    await settle();
    expect(policyOf(), '被拒的抬升不得改策略').toBe('observe');
    expect(eventRows(), '被拒的抬升不得写 cross_org_policy_changed 审计行').toHaveLength(0);
    expect(totalAuditRows(), '被拒的抬升不得写任何审计行').toBe(0);
  });

  it('S2b: 未知 id（users 表里根本没有）⇒ 抛错，策略不变、审计零行', async () => {
    const setCrossOrgPolicy = expectMethod();

    const err = await refusalOf(() => setCrossOrgPolicy.call(policy, ORG, 'auto', GHOST_USER));

    expect(err).toBeInstanceOf(Error);
    await settle();
    expect(policyOf()).toBe('observe');
    expect(eventRows()).toHaveLength(0);
    expect(totalAuditRows()).toBe(0);
  });

  it('S3: 缺失 / 空 actor（undefined / "" / 不传）⇒ 抛错，策略不变、审计零行', async () => {
    const setCrossOrgPolicy = expectMethod();
    createHuman(HUMAN_OWNER, 'owner');

    const missing = await refusalOf(() => setCrossOrgPolicy.call(policy, ORG, 'auto'));
    const undef = await refusalOf(() => setCrossOrgPolicy.call(policy, ORG, 'auto', undefined));
    const empty = await refusalOf(() => setCrossOrgPolicy.call(policy, ORG, 'auto', ''));

    for (const err of [missing, undef, empty]) expect(err).toBeInstanceOf(Error);
    await settle();
    expect(policyOf()).toBe('observe');
    expect(eventRows()).toHaveLength(0);
    expect(totalAuditRows()).toBe(0);
  });
});

// ─── S4 / S5 ────────────────────────────────────────────────────────────────

describe('C10-C §2.2 —— 人类 actor 抬升 / 降级 + 恰一条审计行', () => {
  it('S4: 人类 owner 抬升 observe→auto：策略落库 + 恰好一条审计行（type/user_id/metadata）', async () => {
    const setCrossOrgPolicy = expectMethod();
    createHuman(HUMAN_OWNER, 'owner');
    expect(policyOf()).toBe('observe');
    expect(totalAuditRows()).toBe(0);

    await setCrossOrgPolicy.call(policy, ORG, 'auto', HUMAN_OWNER);

    // 1) 策略真的落库（读回同一行，不是回执自说自话）
    expect(policyOf()).toBe('auto');

    // 2) 「恰一条」：这一类事件只有一条，且整个 audit_logs 也只有这一条
    const rows = await eventRowsAtLeast(1);
    expect(rows).toHaveLength(1);
    expect(totalAuditRows()).toBe(1);

    const row = rows[0]!;
    expect(row.event_type).toBe(EVENT);
    expect(row.user_id, '审计行的 user_id 必须是人工作者本人（谁放权，谁署名）').toBe(HUMAN_OWNER);

    // 3) metadata 含 orgId / from / to，且 success=true（§2.2 冻结载荷）
    const meta = metadataOf(row);
    expect(meta['orgId']).toBe(ORG);
    expect(meta['from']).toBe('observe');
    expect(meta['to']).toBe('auto');
    expect(meta['success']).toBe(true);
  });

  it('S5: 降级 auto→observe 同样留痕：两行审计，(from,to) 各为 observe->auto / auto->observe', async () => {
    const setCrossOrgPolicy = expectMethod();
    createHuman(HUMAN_OWNER, 'owner');

    await setCrossOrgPolicy.call(policy, ORG, 'auto', HUMAN_OWNER);
    await setCrossOrgPolicy.call(policy, ORG, 'observe', HUMAN_OWNER);

    expect(policyOf(), '降级后的终态必须真的落库').toBe('observe');

    const rows = await eventRowsAtLeast(2);
    expect(rows, '放权一次、收权一次 ⇒ 两条人类署名记录').toHaveLength(2);
    expect(totalAuditRows()).toBe(2);
    expect(rows.every(row => row.user_id === HUMAN_OWNER)).toBe(true);
    // 不按 created_at 排序断言（同一毫秒会撞），按 (from,to) 这对结构事实数。
    expect(transitionPairs(rows)).toEqual(['auto->observe', 'observe->auto']);
  });
});

// ─── A1-A3 ──────────────────────────────────────────────────────────────────

describe('C10-C §2.2 —— POST /api/orgs/:orgId/cross-org-policy（requireAuth + owner/admin）', () => {
  const PATH = `/api/orgs/${ORG}/cross-org-policy`;
  const nowSec = () => Math.floor(Date.now() / 1000);

  let server: APIServer;
  let taskService: TaskService;

  /** 真签的会话 cookie：与 api-server 同一个 JWT_SECRET，走真 verifyToken。 */
  const cookieFor = async (userId: string, role: string, orgId = ORG) =>
    `markus_token=${await signToken({ userId, orgId, role, exp: nowSec() + 3600 }, TEST_JWT_SECRET)}`;

  beforeEach(() => {
    // 认证**开着**：否则本机 loopback 会拿到 owner 身份（api-server getAuthUser），
    // 401 那一格就永远打不到 —— 矩阵会退化成「只会 403/200」。
    vi.stubEnv('AUTH_ENABLED', 'true');
    vi.stubEnv('JWT_SECRET', TEST_JWT_SECRET);
    taskService = new TaskService();
    // 真 OrganizationService（真 repo）+ 真 APIServer：路由打到的就是上面那个服务实例。
    server = new APIServer(service, taskService, 0);
    server.setStorage(bridge);
  });

  afterEach(() => {
    try {
      server.stop();
    } catch {
      /* 没有 start 过 —— 没有 http server 可关 */
    }
    try {
      taskService.stopTimeoutChecker();
    } catch {
      /* 未接 storage 时无害 */
    }
    vi.unstubAllEnvs();
  });

  it('A1: 无会话 ⇒ 401（不是 404/200），且策略与审计零副作用', async () => {
    createHuman(HUMAN_OWNER, 'owner');

    const res = await request(server, 'POST', PATH, { policy: 'auto' });

    // 401 必须来自 requireAuth（deny-by-default 闸门）。若有人把这条路由塞进
    // isPublicApiPath，这里会变成 200/500 而红。
    expect(res.status).toBe(401);
    await settle();
    expect(policyOf()).toBe('observe');
    expect(totalAuditRows()).toBe(0);
  });

  it('A2: 已认证但角色是 member ⇒ 403，策略不变、审计零行', async () => {
    createHuman(HUMAN_MEMBER, 'member');

    const res = await request(server, 'POST', PATH, { policy: 'auto' }, {
      cookie: await cookieFor(HUMAN_MEMBER, 'member'),
    });

    expect(res.status).toBe(403);
    await settle();
    expect(policyOf(), '被拒的 HTTP 抬升不得改策略').toBe('observe');
    expect(eventRows()).toHaveLength(0);
    expect(totalAuditRows()).toBe(0);
  });

  it('A3: owner 会话 ⇒ 200，策略落库为 auto + 一条审计行（actor 取自会话身份）', async () => {
    createHuman(HUMAN_OWNER, 'owner');

    const res = await request(server, 'POST', PATH, { policy: 'auto' }, {
      cookie: await cookieFor(HUMAN_OWNER, 'owner'),
    });

    expect(res.status).toBe(200);
    expect(policyOf()).toBe('auto');

    const rows = await eventRowsAtLeast(1);
    expect(rows, 'HTTP 路径与 Service 路径写同一种审计行').toHaveLength(1);
    const row = rows[0]!;
    expect(row.event_type).toBe(EVENT);
    expect(row.user_id, 'actor 必须是会话身份（不取 body 里的 userId）').toBe(HUMAN_OWNER);
    const meta = metadataOf(row);
    expect(meta['orgId']).toBe(ORG);
    expect(meta['from']).toBe('observe');
    expect(meta['to']).toBe('auto');
    expect(meta['success']).toBe(true);
  });

  it('A3b: admin 会话同样 200（§2.2 是 owner/admin，不是仅 owner）', async () => {
    createHuman(HUMAN_ADMIN, 'admin');

    const res = await request(server, 'POST', PATH, { policy: 'auto' }, {
      cookie: await cookieFor(HUMAN_ADMIN, 'admin'),
    });

    expect(res.status).toBe(200);
    expect(policyOf()).toBe('auto');
    const rows = await eventRowsAtLeast(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(HUMAN_ADMIN);
  });
});
