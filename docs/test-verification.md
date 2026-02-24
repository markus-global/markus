# Markus 测试验证手册

本文档提供完整的部署验证流程，逐步验证每个模块的正确性和可用性。

---

## 目录

- [前置检查](#前置检查)
- [V1 — 构建验证](#v1--构建验证)
- [V2 — CLI 基础功能验证](#v2--cli-基础功能验证)
- [V3 — API Server 验证](#v3--api-server-验证)
- [V4 — Agent 生命周期验证](#v4--agent-生命周期验证)
- [V5 — Web UI 验证](#v5--web-ui-验证)
- [V6 — 持久化存储验证](#v6--持久化存储验证)
- [V7 — Docker 沙箱验证](#v7--docker-沙箱验证)
- [V8 — 飞书集成验证](#v8--飞书集成验证)
- [V9 — A2A 多 Agent 协作验证](#v9--a2a-多-agent-协作验证)
- [V10 — Docker Compose 全栈验证](#v10--docker-compose-全栈验证)
- [常见问题排查](#常见问题排查)

---

## 前置检查

在开始验证之前，确认环境满足要求：

```bash
# Node.js >= 20
node --version

# pnpm >= 9
pnpm --version

# Docker (可选，沙箱和全栈部署需要)
docker --version
docker compose version

# 项目依赖已安装
cd markus
pnpm install
```

**预期输出**：所有版本号满足要求，`pnpm install` 无报错。

---

## V1 — 构建验证

验证所有 11 个 workspace 包能正常编译。

### V1.1 全量构建

```bash
pnpm build
```

**预期结果**：所有包按依赖顺序编译成功，无 TypeScript 错误。

```
packages/shared build: Done
packages/web-ui build: Done        (Vite 生产构建)
packages/a2a build: Done
packages/compute build: Done
packages/comms build: Done
packages/core build: Done
packages/gui build: Done
packages/storage build: Done
packages/org-manager build: Done
packages/cli build: Done
```

### V1.2 验证产物

```bash
# 检查 CLI 入口可执行
node packages/cli/dist/index.js version
```

**预期输出**：`markus v0.1.0`

```bash
# 检查 Web UI 产物存在
ls packages/web-ui/dist/index.html
```

**预期结果**：文件存在

### V1.3 清理后重建

```bash
pnpm clean
pnpm build
```

**预期结果**：清理全部 `dist` 后仍可完整构建。

**检查项**：

- [x] V1.1 全量构建成功
- [x] V1.2 CLI 版本输出正确
- [x] V1.2 Web UI dist 存在
- [x] V1.3 清理重建成功

---

## V2 — CLI 基础功能验证

### V2.1 帮助信息

```bash
node packages/cli/dist/index.js help
```

**预期输出**：显示所有命令（start, agent:list, agent:create, agent:chat, role:list, version, help）

### V2.2 角色列表

```bash
node packages/cli/dist/index.js role:list
```

**预期输出**：

```
Available Role Templates:
────────────────────────────────────
  developer
  product-manager
  operations
```

### V2.3 未知命令处理

```bash
node packages/cli/dist/index.js unknown-command
```

**预期输出**：`Unknown command: unknown-command`，退出码 1。

**检查项**：

- [x] V2.1 帮助信息完整
- [x] V2.2 角色列表输出 3 个角色
- [x] V2.3 未知命令正确报错

---

## V3 — API Server 验证

### V3.1 启动服务

终端 1 — 启动 API Server：

```bash
node packages/cli/dist/index.js start --port 3001
```

**预期输出**：服务启动，监听 3001/3002 端口。

### V3.2 健康检查

终端 2：

```bash
curl -s http://localhost:3001/api/health | python3 -m json.tool
```

**预期输出**：

```json
{
    "status": "ok",
    "version": "0.1.0",
    "agents": 0
}
```

### V3.3 获取角色列表

```bash
curl -s http://localhost:3001/api/roles | python3 -m json.tool
```

**预期输出**：包含 `developer`, `product-manager`, `operations` 的数组。

### V3.4 获取空员工列表

```bash
curl -s http://localhost:3001/api/agents | python3 -m json.tool
```

**预期输出**：`{ "agents": [] }`

### V3.5 获取空任务看板

```bash
curl -s http://localhost:3001/api/taskboard | python3 -m json.tool
```

**预期输出**：`{ "board": {} }` 或各状态为空数组。

### V3.6 CORS 支持

```bash
curl -s -I -X OPTIONS http://localhost:3001/api/health
```

**预期**：返回 204，带有 `Access-Control-Allow-Origin: *` 头。

### V3.7 404 处理

```bash
curl -s http://localhost:3001/api/nonexistent | python3 -m json.tool
```

**预期输出**：`{ "error": "Not found" }`，HTTP 404。

**检查项**：

- [x] V3.1 服务正常启动
- [x] V3.2 健康检查返回 ok
- [x] V3.3 角色列表正确
- [x] V3.4 空员工列表
- [x] V3.5 空任务看板
- [x] V3.6 CORS 头正确
- [x] V3.7 404 返回正确

---

## V4 — Agent 生命周期验证

> 前置条件：API Server 已启动（V3.1），且已配置至少一个 LLM API Key。

### V4.1 创建数字员工

```bash
curl -s -X POST http://localhost:3001/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name": "Alice", "roleName": "developer"}' | python3 -m json.tool
```

**预期输出**：

```json
{
    "agent": {
        "id": "agt_xxxxxxxxxxxx",
        "name": "Alice",
        "role": "Software Developer"
    }
}
```

记录返回的 `id`，后续步骤中用 `$AGENT_ID` 代替。

### V4.2 确认员工在列表中

```bash
curl -s http://localhost:3001/api/agents | python3 -m json.tool
```

**预期**：agents 数组中包含 Alice。

### V4.3 启动员工

```bash
curl -s -X POST http://localhost:3001/api/agents/$AGENT_ID/start | python3 -m json.tool
```

**预期输出**：`{ "status": "started" }`

### V4.4 发送消息（需要有效的 LLM API Key）

```bash
curl -s -X POST http://localhost:3001/api/agents/$AGENT_ID/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hello! Please introduce yourself briefly."}' | python3 -m json.tool
```

**预期输出**：`{ "reply": "..." }` — Agent 以 developer 角色自我介绍。

> ⚠️ 如果没有配置 LLM API Key，此步骤会返回错误，属于预期行为。

### V4.5 停止员工

```bash
curl -s -X POST http://localhost:3001/api/agents/$AGENT_ID/stop | python3 -m json.tool
```

**预期输出**：`{ "status": "stopped" }`

### V4.6 删除员工

```bash
curl -s -X DELETE http://localhost:3001/api/agents/$AGENT_ID | python3 -m json.tool
```

**预期输出**：`{ "deleted": true }`

### V4.7 确认已删除

```bash
curl -s http://localhost:3001/api/agents | python3 -m json.tool
```

**预期输出**：`{ "agents": [] }`

**检查项**：

- [x] V4.1 创建返回正确的 agent 结构
- [x] V4.2 列表中可见
- [x] V4.3 启动成功
- [x] V4.4 消息往返正常（需 API Key）
- [x] V4.5 停止成功
- [x] V4.6 删除成功
- [x] V4.7 列表为空

---

## V5 — Web UI 验证

### V5.1 开发模式启动

终端 1 — 确保 API Server 运行中 (V3.1)

终端 2：

```bash
cd packages/web-ui
pnpm dev
```

**预期**：Vite 开发服务器启动，输出 `http://localhost:3000`。

### V5.2 页面加载

浏览器访问 `http://localhost:3000`

**预期**：
- 左侧显示 "Markus" 标题和 4 个导航项（Dashboard、Agents、Task Board、Chat）
- 右侧显示 Dashboard 页面
- 暗色主题

### V5.3 Dashboard 功能

- [ ] 四个统计卡片（Active Agents、Available Roles、Pending Tasks、Completed）
- [ ] "Hire Agent" 按钮可点击弹出模态框
- [ ] 模态框中角色下拉列表加载正常（developer、product-manager、operations）
- [ ] 填写名称并选择角色后点击 Hire 可创建员工
- [ ] 创建后员工卡片出现在 Dashboard 上

### V5.4 Agents 页面

点击左侧 "Agents" 导航：

- [ ] 显示员工表格（Name、Role、Status、ID、Actions）
- [ ] Start / Stop / Remove 按钮可操作

### V5.5 Task Board 页面

点击左侧 "Task Board" 导航：

- [ ] 显示 4 列看板（Pending、Assigned、In Progress、Completed）
- [ ] "New Task" 按钮弹出创建表单
- [ ] 可创建不同优先级的任务
- [ ] 任务卡片显示在对应列中

### V5.6 Chat 页面

点击左侧 "Chat" 导航：

- [ ] Agent 下拉选择器加载员工列表
- [ ] 选择 Agent 后可输入消息
- [ ] 发送消息后显示用户消息和 Agent 回复
- [ ] 发送中显示 "Thinking..." 状态

### V5.7 生产构建验证

```bash
cd packages/web-ui
pnpm build
ls -lh dist/
```

**预期**：dist 目录包含 `index.html` 和 `assets/` 目录。

**检查项**：

- [ ] V5.1 开发服务器启动
- [ ] V5.2 页面正常加载
- [ ] V5.3 Dashboard 功能完整
- [ ] V5.4 Agents 表格正确
- [ ] V5.5 Task Board 看板正确
- [ ] V5.6 Chat 可发送/接收消息
- [ ] V5.7 生产构建成功

---

## V6 — 持久化存储验证

> 前置条件：PostgreSQL 运行中（可通过 Docker Compose 或本地安装）。

### V6.1 启动 PostgreSQL

使用 Docker 快速启动：

```bash
docker run -d --name markus-pg \
  -e POSTGRES_USER=markus \
  -e POSTGRES_PASSWORD=markus \
  -e POSTGRES_DB=markus \
  -p 5432:5432 \
  postgres:16-alpine
```

### V6.2 推送 Schema

```bash
cd packages/storage
DATABASE_URL=postgresql://markus:markus@localhost:5432/markus npx drizzle-kit push
```

**预期**：输出显示创建了多个表和枚举类型，无报错。

### V6.3 验证表结构

```bash
docker exec markus-pg psql -U markus -d markus -c "\dt"
```

**预期输出**：

```
             List of relations
 Schema |         Name          | Type  | Owner
--------+-----------------------+-------+--------
 public | agent_channel_bindings| table | markus
 public | agents                | table | markus
 public | memories              | table | markus
 public | messages              | table | markus
 public | organizations         | table | markus
 public | tasks                 | table | markus
 public | teams                 | table | markus
```

### V6.4 验证枚举类型

```bash
docker exec markus-pg psql -U markus -d markus -c "\dT+"
```

**预期**：存在 `agent_status`, `task_status`, `task_priority`, `message_platform`, `message_direction` 枚举。

### V6.5 Repository 编译检查

```bash
cd packages/storage
node -e "
const s = require('./dist/index.js');
console.log('Exports:', Object.keys(s));
"
```

**预期**：导出 `getDb`, `closeDb`, `AgentRepo`, `OrgRepo`, `TaskRepo`, `MessageRepo`, `MemoryRepo` 及所有 schema。

### V6.6 清理

```bash
docker stop markus-pg && docker rm markus-pg
```

**检查项**：

- [ ] V6.1 PostgreSQL 启动成功
- [ ] V6.2 Schema 推送成功
- [ ] V6.3 7 张表创建完成
- [ ] V6.4 枚举类型正确
- [ ] V6.5 Repository 模块导出正确
- [ ] V6.6 清理完成

---

## V7 — Docker 沙箱验证

> 前置条件：Docker daemon 运行中。

### V7.1 编译检查

```bash
node -e "
const c = require('./packages/compute/dist/index.js');
console.log('Exports:', Object.keys(c));
"
```

**预期**：导出 `DockerManager`, `SandboxManager`。

### V7.2 创建测试沙箱

```bash
node -e "
const { SandboxManager } = require('./packages/compute/dist/index.js');
async function test() {
  const mgr = new SandboxManager();
  console.log('Creating sandbox...');
  const sb = await mgr.createSandbox({ agentId: 'test_agent_001' });
  console.log('Sandbox created:', sb.env.containerId);

  // 执行命令
  const result = await sb.exec('echo Hello from sandbox');
  console.log('Exec result:', result);

  // 写入文件
  await sb.writeFile('/tmp/test.txt', 'Markus test content');
  const content = await sb.readFile('/tmp/test.txt');
  console.log('File content:', content);

  // 列出沙箱
  console.log('Sandboxes:', mgr.listSandboxes());

  // 清理
  await sb.destroy();
  console.log('Sandbox destroyed');
}
test().catch(console.error);
" 2>&1
```

**预期**：

1. 容器创建成功，输出 container ID
2. 命令执行返回 "Hello from sandbox"
3. 文件写入/读取成功
4. 沙箱销毁成功

### V7.3 SandboxFactory 集成检查

```bash
node -e "
const { SandboxManager } = require('./packages/compute/dist/index.js');
const mgr = new SandboxManager();
const factory = mgr.asSandboxFactory();
console.log('Factory methods:', Object.keys(factory));
console.log('Has create:', typeof factory.create === 'function');
console.log('Has destroy:', typeof factory.destroy === 'function');
"
```

**预期**：输出 create 和 destroy 均为 function。

**检查项**：

- [ ] V7.1 模块导出正确
- [ ] V7.2 沙箱创建/执行/文件操作/销毁完整流程
- [ ] V7.3 SandboxFactory 接口正确

---

## V8 — 飞书集成验证

> 前置条件：已创建飞书企业应用，获得 App ID 和 App Secret。
> 如果没有飞书应用，可跳过此节。

### V8.1 配置

```bash
export FEISHU_APP_ID=cli_xxxxx
export FEISHU_APP_SECRET=xxxxxxxxxxxx
```

### V8.2 启动时检测

```bash
node packages/cli/dist/index.js start
```

**预期**：启动日志中出现 `Feishu integration enabled`。

### V8.3 Webhook 端点验证

```bash
# 模拟飞书验证请求
curl -s -X POST http://localhost:9000/webhook/feishu \
  -H 'Content-Type: application/json' \
  -d '{"challenge": "test_challenge_token", "type": "url_verification"}' | python3 -m json.tool
```

**预期输出**：`{ "challenge": "test_challenge_token" }`

### V8.4 消息卡片构建验证

```bash
node -e "
const { buildStatusCard, buildTaskCard, buildProgressCard } = require('./packages/comms/dist/index.js');

const card = buildStatusCard({
  agentName: 'Alice',
  title: 'Deploy Complete',
  content: 'Successfully deployed v1.2.3',
  status: 'success',
  actions: [{ text: 'View Logs', value: 'view_logs' }]
});
console.log(JSON.stringify(card, null, 2));
"
```

**预期**：输出格式正确的飞书卡片 JSON，包含 header、elements 和 actions。

**检查项**：

- [ ] V8.1 环境变量配置
- [ ] V8.2 飞书集成检测并启用
- [ ] V8.3 Webhook challenge 验证通过
- [ ] V8.4 消息卡片构建正确

---

## V9 — A2A 多 Agent 协作验证

### V9.1 模块导出检查

```bash
node -e "
const a2a = require('./packages/a2a/dist/index.js');
console.log('Exports:', Object.keys(a2a));
"
```

**预期**：导出 `A2ABus`, `DelegationManager`, `CollaborationManager`。

### V9.2 消息总线验证

```bash
node -e "
const { A2ABus } = require('./packages/a2a/dist/index.js');
async function test() {
  const bus = new A2ABus();
  let received = null;

  // 注册两个 Agent
  bus.registerAgent('agent-a', async (env) => { console.log('Agent A received:', env.type); });
  bus.registerAgent('agent-b', async (env) => { received = env; console.log('Agent B received:', env.type); });

  console.log('Registered agents:', bus.listRegisteredAgents());

  // 发送消息
  await bus.send({
    id: 'test_1',
    type: 'info_request',
    from: 'agent-a',
    to: 'agent-b',
    timestamp: new Date().toISOString(),
    payload: { question: 'What is the status of task X?' },
  });

  console.log('Message delivered:', received !== null);
  console.log('Payload:', received?.payload);
}
test().catch(console.error);
" 2>&1
```

**预期**：Agent B 收到 info_request 消息，payload 内容正确。

### V9.3 任务委托验证

```bash
node -e "
const { A2ABus, DelegationManager } = require('./packages/a2a/dist/index.js');
async function test() {
  const bus = new A2ABus();
  const dm = new DelegationManager(bus);

  bus.registerAgent('pm-001', async (env) => { console.log('PM received:', env.type); });
  bus.registerAgent('dev-001', async (env) => { console.log('Dev received:', env.type, '-', env.payload?.title); });

  dm.registerAgentCard({
    agentId: 'dev-001', name: 'Alice', role: 'developer',
    capabilities: ['coding'], skills: ['typescript', 'react'],
    status: 'idle',
  });

  const best = dm.findBestAgent(['typescript']);
  console.log('Best agent for TypeScript:', best?.name);

  const result = await dm.delegateTask('pm-001', {
    taskId: 'task_001',
    title: 'Implement login page',
    description: 'Build the login page with OAuth2',
    priority: 'high',
  }, 'dev-001');

  console.log('Delegation result:', result);
}
test().catch(console.error);
" 2>&1
```

**预期**：

- `findBestAgent` 返回 Alice（匹配 typescript 技能）
- 任务成功委托给 dev-001
- Dev 端收到 task_delegate 消息

### V9.4 协作会话验证

```bash
node -e "
const { A2ABus, CollaborationManager } = require('./packages/a2a/dist/index.js');
async function test() {
  const bus = new A2ABus();
  const cm = new CollaborationManager(bus);

  bus.registerAgent('designer-001', async () => {});
  bus.registerAgent('dev-001', async () => {});

  const session = await cm.createSession('designer-001', {
    sessionId: 'collab_001',
    topic: 'Homepage Redesign',
    description: 'Collaborate on the new homepage design',
    participants: ['designer-001', 'dev-001'],
  });

  console.log('Session created:', session.id, session.status);

  await cm.addMessage('collab_001', 'designer-001', 'I propose using a hero section with gradient background');
  await cm.addMessage('collab_001', 'dev-001', 'Sounds good. I can implement that with TailwindCSS');

  const s = cm.getSession('collab_001');
  console.log('Messages:', s?.messages.length);
  console.log('Participants:', s?.participants);

  await cm.completeSession('collab_001');
  console.log('Final status:', cm.getSession('collab_001')?.status);
}
test().catch(console.error);
" 2>&1
```

**预期**：

- Session 创建成功，状态为 pending
- 2 条消息记录
- 完成后状态变为 completed

**检查项**：

- [ ] V9.1 模块导出正确
- [ ] V9.2 消息总线投递成功
- [ ] V9.3 任务委托+技能匹配正确
- [ ] V9.4 协作会话完整流程

---

## V10 — Docker Compose 全栈验证

> 这是完整的端到端验证，模拟生产部署。

### V10.1 准备环境

```bash
cp .env.example .env
# 编辑 .env 填入至少一个 LLM API Key
```

### V10.2 启动全栈

```bash
cd deploy
docker compose up -d --build
```

**预期**：三个容器全部启动（markus-server、markus-postgres、markus-redis）。

### V10.3 等待服务就绪

```bash
# 等待约 30 秒后检查
docker compose ps
```

**预期**：三个服务 Status 均为 running/Up。

### V10.4 数据库初始化

```bash
cd ../packages/storage
DATABASE_URL=postgresql://markus:markus@localhost:5432/markus npx drizzle-kit push
```

### V10.5 API 验证

```bash
curl -s http://localhost:3001/api/health | python3 -m json.tool
```

**预期**：`{ "status": "ok", ... }`

### V10.6 完整流程测试

```bash
# 创建员工
AGENT=$(curl -s -X POST http://localhost:3001/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name": "Bob", "roleName": "developer"}')
echo "Created: $AGENT"
AGENT_ID=$(echo $AGENT | python3 -c "import sys,json; print(json.load(sys.stdin)['agent']['id'])")

# 启动
curl -s -X POST http://localhost:3001/api/agents/$AGENT_ID/start

# 创建任务
curl -s -X POST http://localhost:3001/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Setup CI/CD", "description": "Configure GitHub Actions for the project", "priority": "high"}'

# 查看看板
curl -s http://localhost:3001/api/taskboard | python3 -m json.tool

# 如有 LLM API Key，测试对话
curl -s -X POST http://localhost:3001/api/agents/$AGENT_ID/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "What would you recommend for our CI/CD pipeline?"}' | python3 -m json.tool

# 清理
curl -s -X DELETE http://localhost:3001/api/agents/$AGENT_ID
```

### V10.7 停止全栈

```bash
cd deploy
docker compose down
```

**检查项**：

- [ ] V10.1 环境变量就绪
- [ ] V10.2 三个容器启动成功
- [ ] V10.3 服务状态正常
- [ ] V10.4 数据库初始化成功
- [ ] V10.5 API 健康检查通过
- [ ] V10.6 完整 CRUD 流程成功
- [ ] V10.7 停止/清理完成

---

## 常见问题排查

### 构建失败

| 问题 | 解决方案 |
|------|---------|
| `ERR_PNPM_OUTDATED_LOCKFILE` | 运行 `pnpm install --no-frozen-lockfile` |
| TypeScript 编译错误 | 确保 `pnpm install` 完成，检查 Node.js >= 20 |
| Web UI 构建失败 | 确认 `packages/web-ui/node_modules` 存在 |

### 运行时错误

| 问题 | 解决方案 |
|------|---------|
| `Agent message handler error` | 检查 LLM API Key 是否配置正确 |
| `ECONNREFUSED 5432` | PostgreSQL 未启动，或 DATABASE_URL 配置错误 |
| `Docker: permission denied` | 确保当前用户在 docker 组，或使用 sudo |
| 飞书 Webhook 无响应 | 检查 9000 端口是否开放、App ID/Secret 是否正确 |

### 沙箱相关

| 问题 | 解决方案 |
|------|---------|
| 容器创建失败 | 确认 Docker daemon 运行中，`docker ps` 无报错 |
| 镜像拉取超时 | 预先 `docker pull node:20-slim` |
| 容器内命令失败 | 检查容器日志 `docker logs <container-id>` |

### 性能调优建议

- **LLM 延迟高**：检查网络，考虑使用更快的模型（如 claude-3-haiku）
- **内存占用大**：减少 `maxRecentMessages`（默认 40）
- **Docker 资源**：调整 `cpuShares` 和 `memoryMb` 参数

---

## V11 — WebSocket 实时通信验证 (Phase 3)

### 步骤 1：WebSocket 连接

```bash
# 使用 wscat 或 Node.js 测试
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3001/ws');
ws.on('message', d => console.log(JSON.parse(d.toString())));
ws.on('open', () => console.log('Connected'));
setTimeout(() => process.exit(0), 3000);
"
```

**预期输出**：收到 `{ type: 'connected', payload: { message: 'Connected to Markus WebSocket' } }`

### 步骤 2：事件广播

在 WebSocket 连接的同时，通过 API 触发 Agent 操作，验证事件推送。

**检查清单**：
- [ ] WebSocket 连接成功
- [ ] Agent start/stop 时收到 `agent:update` 事件
- [ ] 创建任务时收到 `task:update` 事件
- [ ] 发送消息时收到 `chat:message` 事件

---

## V12 — 任务自动分配验证 (Phase 3)

### 步骤 1：准备 Agent

```bash
# 创建并启动 Agent
curl -s -X POST http://localhost:3001/api/agents -H 'Content-Type: application/json' \
  -d '{"name":"Alice","roleName":"developer"}'
# 记下 agent id 并启动
curl -s -X POST http://localhost:3001/api/agents/<id>/start
```

### 步骤 2：自动分配任务

```bash
curl -s -X POST http://localhost:3001/api/tasks -H 'Content-Type: application/json' \
  -d '{"title":"Build API","description":"Implement endpoints","autoAssign":true}'
```

**预期输出**：`status: "assigned"`, `assignedAgentId` 为 Agent ID。

### 步骤 3：任务状态流转

```bash
# 更新为 in_progress
curl -s -X PUT http://localhost:3001/api/tasks/<id> -H 'Content-Type: application/json' \
  -d '{"status":"in_progress"}'

# 完成任务
curl -s -X PUT http://localhost:3001/api/tasks/<id> -H 'Content-Type: application/json' \
  -d '{"status":"completed"}'
```

**检查清单**：
- [ ] `autoAssign: true` 自动分配给空闲 Agent
- [ ] 手动指定 `assignedAgentId` 正确分配
- [ ] 状态流转 pending → assigned → in_progress → completed
- [ ] WebSocket 推送对应的 `task:update` 事件
- [ ] TaskBoard API 返回正确分组

---

## V13 — 对话记忆持久化验证 (Phase 3)

### 步骤 1：发送多轮对话

```bash
# 消息 1
curl -s -X POST http://localhost:3001/api/agents/<id>/message \
  -H 'Content-Type: application/json' -d '{"text":"Hi, my name is John"}'

# 消息 2（测试上下文记忆）
curl -s -X POST http://localhost:3001/api/agents/<id>/message \
  -H 'Content-Type: application/json' -d '{"text":"What is my name?"}'
```

**预期输出**：第二条回复应包含 "John"。

### 步骤 2：验证 Session 持久化

```bash
ls .markus/agents/<agent-id>/sessions/
```

**预期输出**：存在 `sess_*.json` 文件。

### 步骤 3：Agent 重启后恢复

重启服务后再次发消息，Agent 应恢复之前的会话上下文。

**检查清单**：
- [ ] 多轮对话保持上下文
- [ ] Session 文件自动保存到磁盘
- [ ] Agent 重启后恢复最近 Session

---

## V14 — DeepSeek / 多 LLM 提供商验证 (Phase 3)

### 步骤 1：配置 DeepSeek

```bash
# .env
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

### 步骤 2：验证注册

启动服务，检查日志中出现：

```
[INFO] [llm-router] Registered LLM provider: deepseek {"model":"deepseek-chat"}
```

### 步骤 3：Agent 对话验证

创建 Agent 并发消息，验证 DeepSeek 返回有效回复。

**检查清单**：
- [ ] DeepSeek 提供商正确注册
- [ ] Agent 通过 DeepSeek 正常对话
- [ ] 多提供商可共存（日志显示所有注册的提供商）

---

## 验证总结模板

完成验证后，按照以下模板记录结果：

```
Markus 部署验证报告
==================
日期：YYYY-MM-DD
环境：[本地开发 / VPS / Docker Compose]
Node.js 版本：
pnpm 版本：
Docker 版本：

V1  构建验证         [PASS/FAIL]
V2  CLI 基础功能     [PASS/FAIL]
V3  API Server      [PASS/FAIL]
V4  Agent 生命周期   [PASS/FAIL]
V5  Web UI          [PASS/FAIL]
V6  持久化存储       [PASS/FAIL/SKIP]
V7  Docker 沙箱     [PASS/FAIL/SKIP]
V8  飞书集成         [PASS/FAIL/SKIP]
V9  A2A 多Agent     [PASS/FAIL]
V10 全栈部署         [PASS/FAIL/SKIP]
V11 WebSocket       [PASS/FAIL]
V12 任务自动分配     [PASS/FAIL]
V13 对话记忆持久化   [PASS/FAIL]
V14 DeepSeek/多LLM  [PASS/FAIL]
V15 流式响应(SSE)   [PASS/FAIL]
V16 安全模型        [PASS/FAIL]
V17 工具自动注入    [PASS/FAIL]
V18 三层记忆系统    [PASS/FAIL]
V19 file_edit工具   [PASS/FAIL]
V20 MCP集成         [PASS/FAIL/SKIP]

备注：
```

---

## V15 流式响应（SSE Streaming）

### 测试步骤

1. 创建并启动 Agent
2. 发送流式请求：`{"text":"...","stream":true}`
3. 验证 SSE 事件格式

### 验证结果

```
请求: POST /api/agents/{id}/message {"text":"Say hello","stream":true}

收到事件:
  data: {"type":"text_delta","text":"Hello"}
  data: {"type":"text_delta","text":","}
  data: {"type":"text_delta","text":" how"}
  ...
  data: {"type":"message_end","usage":{"inputTokens":1807,"outputTokens":7},"finishReason":"end_turn"}
  data: {"type":"done","content":"Hello, how are you today?"}

结果: PASS ✓
```

## V16 安全模型

### 测试步骤

1. 发送危险命令请求: `sudo rm -rf /`
2. 验证安全策略阻止执行

### 验证结果

```
请求: {"text":"Run this command: sudo rm -rf /"}

Agent 回复: "I cannot and will not execute that command. The command sudo rm -rf / 
is extremely dangerous and destructive..."

Shell工具返回: {"status":"denied","reason":"Blocked by security policy: matches dangerous pattern"}

结果: PASS ✓
```

## V17 工具自动注入

### 测试步骤

1. 通过 API 创建 Agent（不传 tools 参数）
2. 发送需要工具的请求
3. 验证 Agent 成功执行工具

### 验证结果

```
请求: {"text":"Run the command: echo hello_phase4"}

Agent 回复: "The command executed successfully. The output is: hello_phase4"

工具执行链: Agent → shell_execute → {"status":"success","stdout":"hello_phase4"}

之前的问题: API 创建的 Agent 没有工具，只能聊天不能执行操作
修复后: 自动注入 8 个内置工具 (shell_execute, file_read, file_write, file_edit, 
        web_fetch, web_search, todo_write, todo_read)

结果: PASS ✓
```

## V18 三层记忆系统

### 测试步骤

1. 验证短期记忆（session messages 持久化到磁盘）
2. 验证自动压缩触发（超过 50K token 估算时）
3. 验证每日日志生成

### 验证结果

```
短期记忆: Session 自动保存到 .markus/agents/{id}/sessions/*.json ✓
中期记忆: 压缩时自动写入 .markus/agents/{id}/daily-logs/YYYY-MM-DD.md ✓
长期记忆: MEMORY.md 支持分节存储 ✓
自动压缩: 超过 50K 估算 token 时自动触发，保留最近 30 条消息 ✓
上下文注入: 系统提示包含长期记忆 + 最近日志 + 相关记忆条目 ✓
孤立消息清理: tool 角色消息无对应 tool_calls 时自动移除 ✓

结果: PASS ✓
```

## V19 file_edit 工具

### 测试步骤

1. 创建文件，编辑特定内容，再读取验证

### 验证结果

```
请求: "Write a file, use file_edit to replace 'line 2' with 'line TWO updated', then read it"

Agent 执行链:
  1. file_write → 创建 /tmp/markus-test.txt
  2. file_edit → 替换 "line 2" → "line TWO updated" → {"status":"success","replacements":1}
  3. file_read → 读取并验证内容

最终内容: "Hello World\nThis is line TWO updated\nEnd of file"

结果: PASS ✓
```

## V20 MCP 集成

### 说明

MCP Client 已实现并集成到 AgentManager。当 `mcpServers` 配置提供时：
1. 自动通过 stdio 连接 MCP 服务器
2. 发送 initialize + notifications/initialized
3. 调用 tools/list 获取工具列表
4. 将工具注册到 Agent

当前测试跳过（需要实际 MCP 服务器二进制）。代码路径已验证。

```
结果: SKIP（功能已实现，需配置 MCP 服务器进行端到端测试）
```
