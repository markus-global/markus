/**
 * 会话连续性 HTTP 层回归门禁。
 *
 * 与 `packages/core/test/session-continuity-smoke.test.ts` 的分工：
 *  - core 冒烟直接调 `agent.sendMessageStream(...)`，钉住「mailbox → worker → restore/绑定 → LLM」；
 *  - 本文件补的是**它上面那一层**：`POST /api/agents/:id/message` → `APIServer` 路由
 *    → 组装 `sessionRestore`（含 DB→内存会话绑定）→ `SSEHandler` / `agent.sendMessage`。
 *
 * 线上故障恰好发生在这一段的交接上：HTTP 线程算好/应用了会话状态，但真正跑这一轮的
 * worker 在另一个工作区里，于是第二轮「失忆」。core 冒烟覆盖不到 HTTP 线程这段代码。
 *
 * 基座：真 `APIServer` + 真 `AgentManager`/`Agent`（core）+ 真 SQLite storage
 * （临时 mkdtemp 路径）+ mock `LLMRouter`（零网络）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentManager, EventBus, RoleLoader, type Agent } from '@markus/core';
import { COMPLETION_MARKER, getTextContent, type LLMRequest } from '@markus/shared';
import { APIServer } from '../src/api-server.js';
import { TaskService } from '../src/task-service.js';
import { initStorage, type StorageBridge } from '../src/storage-bridge.js';
import type { OrganizationService } from '../src/org-service.js';
import { MockIncomingMessage, MockServerResponse } from './api-server-test-helpers.js';

// ─────────────────────────────────────────────────────────────────────────────
// mock LLM：记录每轮真正送进 LLM 的 prompt + 该轮使用的内存会话 id（零网络）
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedCall {
  sessionId?: string;
  text: string;
}

function makeRecordingRouter() {
  const calls: RecordedCall[] = [];
  const record = (request: LLMRequest, options?: { sessionId?: string }) => {
    const messages = request.messages.map(m => ({ role: String(m.role), text: getTextContent(m.content) }));
    calls.push({ sessionId: options?.sessionId, text: messages.map(m => m.text).join('\n') });
  };
  const reply = () => ({
    content: `reply ${COMPLETION_MARKER}`,
    finishReason: 'end_turn' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  });

  const router = {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async (request: LLMRequest, _p?: string, options?: { sessionId?: string }) => {
      record(request, options);
      return reply();
    }),
    chatStream: vi.fn(async (
      request: LLMRequest,
      onEvent?: (event: { type: string; content?: string }) => void,
      _provider?: string,
      _signal?: AbortSignal,
      options?: { sessionId?: string },
    ) => {
      record(request, options);
      onEvent?.({ type: 'text_delta', content: `reply ${COMPLETION_MARKER}` });
      return reply();
    }),
    resolveModalityCandidates: vi.fn(() => []),
    listProviders: vi.fn(() => ['anthropic']),
    getProvider: vi.fn(),
    getDefaultProvider: vi.fn(() => 'anthropic'),
    getActiveModelName: vi.fn(() => 'claude-http-gate'),
    getActiveModelContextWindow: vi.fn(() => 200000),
    getActiveModelMaxOutput: vi.fn(() => 8000),
    getModelContextWindow: vi.fn(() => 200000),
    getModelMaxOutput: vi.fn(() => 8000),
    getModelCost: vi.fn(),
    isCompactionSupported: vi.fn(() => true),
    modelSupportsVision: vi.fn(() => false),
    ensureMarkusCatalogLoaded: vi.fn(async () => {}),
  } as unknown as LLMRouter;

  return { router, calls };
}

type RecordingRouter = ReturnType<typeof makeRecordingRouter>;

// ─────────────────────────────────────────────────────────────────────────────
// 基座
// ─────────────────────────────────────────────────────────────────────────────

let dataDir: string;
let rolesDir: string;
let dbDir: string;
let storage: StorageBridge | null;
let manager: AgentManager;
let server: APIServer;
let taskService: TaskService;
let agent: Agent;
let savedEnv: Record<string, string | undefined>;

function createOrgService(agentManager: AgentManager): OrganizationService {
  return {
    getAgentManager: () => agentManager,
    resolveHumanIdentity: (id: string) => ({ id, name: 'Test User', role: 'owner' }),
    syncHumanIdentity: vi.fn(),
    // `/api/message` 需要先路由到一个 agent；入口矩阵用例用它把消息定向到本测试的 agent。
    routeMessage: (_orgId: string, req: { targetAgentId?: string }) => req.targetAgentId ?? agent.id,
  } as unknown as OrganizationService;
}

/** POST 一辆车；等待响应真正结束（异步路由 + agent 轮次）。 */
async function post(
  srv: APIServer,
  path: string,
  body: unknown,
  timeoutMs = 8000,
): Promise<MockServerResponse> {
  const req = new MockIncomingMessage(
    'POST',
    path,
    { 'content-type': 'application/json' },
    JSON.stringify(body),
  );
  const res = new MockServerResponse();
  srv.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  req._simulate();
  const deadline = Date.now() + timeoutMs;
  while (!res.ended && Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, 5));
  }
  return res;
}

function jsonOf(res: MockServerResponse): Record<string, unknown> {
  try {
    return res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {};
  } catch {
    return { _raw: res.body };
  }
}

/** 解析 SSE 响应体里的所有 data: 事件。 */
function sseEvents(body: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    try {
      out.push(JSON.parse(trimmed.slice('data:'.length).trim()) as Record<string, unknown>);
    } catch {
      /* ignore partial frames */
    }
  }
  return out;
}

async function newHarness(rec: RecordingRouter): Promise<void> {
  manager = new AgentManager({
    llmRouter: rec.router,
    roleLoader: new RoleLoader([rolesDir]),
    dataDir,
    eventBus: new EventBus(),
  });
  agent = await manager.createAgent({ name: 'HTTP Gate', roleName: 'developer', tools: [] });
  await manager.startAgent(agent.id);

  storage = await initStorage(`sqlite:${join(dbDir, 'data.db')}`);
  expect(storage, '真 SQLite storage 必须初始化成功').not.toBeNull();
  // chat_sessions.agent_id / agents.org_id 有外键约束 —— 真实链路里这些行由
  // org-manager 自己写入；测试基座必须先落这两行，否则 persistUserMessage 会
  // 因 FK 失败而静默返回 null（拿不到 sessionId，也就无从验证会话连续性）。
  storage!.orgRepo.createOrg({ id: 'default', name: 'Default Org', ownerId: 'anonymous' });
  storage!.agentRepo.create({
    id: agent.id,
    name: agent.config.name,
    orgId: 'default',
    roleId: 'developer',
    roleName: 'Developer',
  });

  taskService = new TaskService();
  server = new APIServer(createOrgService(manager), taskService, 0);
  server.setStorage(storage!);
  vi.spyOn(server['ws'] as { broadcast: (...a: unknown[]) => void }, 'broadcast').mockImplementation(() => {});
  vi.spyOn(server['ws'] as { sendToUser: (...a: unknown[]) => void }, 'sendToUser').mockImplementation(() => {});
}

beforeEach(() => {
  // 隔离环境：本机若有 OPENAI_API_KEY，语义检索会真打 embedding 接口并挂 ~10s。
  savedEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
    AUTH_ENABLED: process.env.AUTH_ENABLED,
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.EMBEDDING_API_KEY;
  process.env.AUTH_ENABLED = 'false';

  dataDir = mkdtempSync(join(tmpdir(), 'markus-http-cont-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-http-cont-roles-'));
  dbDir = mkdtempSync(join(tmpdir(), 'markus-http-cont-db-'));
  const roleDir = join(rolesDir, 'developer');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'ROLE.md'), '# Developer\nHTTP session-continuity gate role.');
  writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- idle');
});

afterEach(async () => {
  try { if (agent) await manager.stopAgent(agent.id); } catch { /* ignore */ }
  try { taskService?.stopTimeoutChecker(); } catch { /* ignore */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('会话连续性 HTTP 层（POST /api/agents/:id/message）', () => {
  it('非流式两连发：第二轮必须看到第一轮的历史（HTTP 层连续性）', { timeout: 15000 }, async () => {
    const rec = makeRecordingRouter();
    await newHarness(rec);

    const url = `/api/agents/${agent.id}/message`;
    const t1 = 'TURN1-HTTP-NONSTREAM';
    const t2 = 'TURN2-HTTP-NONSTREAM';

    const res1 = await post(server, url, { text: t1, stream: false });
    expect(res1.statusCode).toBe(200);
    const sessionId = jsonOf(res1)['sessionId'] as string;
    expect(sessionId, '第一轮必须返回新建的 DB 会话 id').toBeTruthy();

    const res2 = await post(server, url, { text: t2, stream: false, sessionId });
    expect(res2.statusCode).toBe(200);
    expect(jsonOf(res2)['sessionId']).toBe(sessionId);

    const turn2 = rec.calls.filter(c => c.text.includes(t2));
    expect(turn2.length, '第二轮必须真的发起 LLM 调用').toBeGreaterThan(0);
    expect(turn2[turn2.length - 1]!.text, '第二轮必须看到第一轮的用户消息').toContain(t1);
  });

  /**
   * 曾经是「已知缺陷」：HTTP 层首轮不建立 DB→内存 绑定（导致第二轮只能从瘦 DB 重建）。
   *
   * 第 0/1 步落地后已修复（会话身份契约 TurnSessionHint + 唯一解析点 resolveTurnSession()
   * + 入口显式传 dbSessionId），所以从 `it.fails` 改回普通 `it` —— 它现在是真正的回归门禁。
   * （当时的证据保留在 docs/SESSION-IDENTITY-PLAN.md 的「本次核查的边界」一节。）
   */
  it('HTTP 非流式首轮必须建立 DB→内存 绑定', { timeout: 15000 }, async () => {
    const rec = makeRecordingRouter();
    await newHarness(rec);

    const url = `/api/agents/${agent.id}/message`;
    const res1 = await post(server, url, { text: 'BIND-TURN1', stream: false });
    const sessionId = jsonOf(res1)['sessionId'] as string;
    expect(sessionId).toBeTruthy();

    expect(
      agent.getMemorySessionIdForDbSession(sessionId),
      '第一轮必须建立 DB→内存 会话绑定',
    ).toBeTruthy();
  });

  /**
   * 入口矩阵（第 1、3 步）：`POST /api/message` 原本**完全不带会话身份** → 每条消息都开新会话。
   * 现在它必须显式表态：带 channelId 时按频道绑定（同频道连续），否则声明 unknown（告警 + 保持当前会话）。
   * 这条锁住「显式契约」这个行为，避免再退回“静默新会话”。
   */
  it('入口矩阵：POST /api/message 带 channelId 时，同频道两连发落在同一会话且看到历史', { timeout: 20000 }, async () => {
    const rec = makeRecordingRouter();
    await newHarness(rec);

    const channelId = 'grp_matrix_1';
    const url = '/api/message';
    const res1 = await post(server, url, { text: 'CH_TURN1', stream: false, channelId, targetAgentId: agent.id });
    expect(res1.statusCode, '第一条必须成功').toBe(200);
    const res2 = await post(server, url, { text: 'CH_TURN2', stream: false, channelId, targetAgentId: agent.id });
    expect(res2.statusCode, '第二条必须成功').toBe(200);

    const turn2 = rec.calls.filter(c => c.text.includes('CH_TURN2'));
    expect(turn2.length, '第二轮必须真的发起 LLM 调用').toBeGreaterThan(0);
    expect(turn2[turn2.length - 1]!.text, '第二轮必须看到第一轮').toContain('CH_TURN1');
  });
});
