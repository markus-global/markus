# Markus 本地开发指南

本文面向想在 Markus 源码上做开发（跑起来、改代码、提 PR）的开发者。完整贡献流程见根目录 [CONTRIBUTING.md](../CONTRIBUTING.md)。

---

## 1. 环境要求

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 22.0.0+ | 运行时（推荐 LTS，可用 `nvm`/`fnm` 管理） |
| pnpm | 9.0.0+ | 包管理器（`npm install -g pnpm`） |
| Docker | 24.0+ | 可选，仅 agent 沙箱容器与部分集成测试需要 |
| Git | 任意 | 版本控制 |

> macOS 若用 Homebrew：`brew install node pnpm`。Windows 建议 WSL2 或 Git Bash；核心脚本均跨平台，但 `scripts/install.sh` 等为 bash。

---

## 2. 快速开始

```bash
# 1. 克隆
git clone https://github.com/markus-global/markus.git
cd markus

# 2. 安装依赖（workspace 一次性装齐所有包）
pnpm install

# 3. 构建所有 TypeScript 包
pnpm build

# 4. 启动开发环境（API 8056 + Web UI 8057）
pnpm dev
```

启动成功后：

- **Web UI**：http://localhost:8057
- **API**：http://localhost:8056
- **首次登录**：`admin@markus.local` / `markus123`，引导向导会要求你设置自己的凭据
- **存储**：SQLite（零外部依赖），数据默认在 `~/.markus/` 下

> `pnpm dev` 会先 `pnpm build` 再同时起 API 与 Vite。首次启动需要一两分钟，看到两个进程（`api` 蓝色、`ui` 绿色）即成功。

---

## 3. dev 脚本详解

所有命令定义在根 [package.json](../package.json) 的 `scripts` 中。

| 命令 | 用途与内部行为 |
|------|---------------|
| `pnpm dev` | **推荐日常开发**。`pnpm build` → 同时启动 API（`node packages/cli/dist/index.js start`）与 Web UI（Vite，带 `/api` `/ws` 代理）。等待 API 就绪后 UI 自动启动（`scripts/wait-for-api.mjs`） |
| `pnpm dev:api` | 只启动 API 服务。**需要先 `pnpm build`**（它运行的是 `dist/` 产物；配合 `pnpm dev:watch` 的 tsc 监听可实现热重载） |
| `pnpm dev:ui` | 只启动 Web UI Vite dev server（假设 API 已在 8056 或 `~/.markus/markus.json` 指定端口运行） |
| `pnpm dev:watch` | 开发终极形态：`pnpm -r --parallel --filter=!@markus/web-ui dev` 让所有包 tsc 监听编译 + 同时启动 API + 启动 UI。改 `packages/*/src` 自动重编译重启 |
| `pnpm dev:desktop` | Electron 桌面开发：API + Vite + Electron 一起跑（`ELECTRON_DEV=1 electron .`，在 `packages/desktop/`） |
| `pnpm build` | 构建所有包（`pnpm -r build`），产物在各包 `dist/` |
| `pnpm test` | Vitest 全量测试 |
| `pnpm typecheck` | `tsc -b`（monorepo 引用构建）+ Web UI 独立 `tsc --noEmit` |
| `pnpm lint` | ESLint 检查 `packages/*/src/` |
| `pnpm quality` | `typecheck` + `test` 二连 |
| `pnpm clean` | 清理所有构建产物 |
| `pnpm markus` | 直接从源码运行 CLI（等价 `node packages/cli/dist/index.js`） |
| `pnpm build:publish` | 完整发布构建（build + web-ui + cli bundle） |
| `pnpm build:desktop` | 桌面安装包（Electron builder） |

### 端口与配置

- 默认端口：API **8056**、Web UI **8057**，可通过 `~/.markus/markus.json` 的 `server.apiPort` 修改（`scripts/wait-for-api.mjs` 会自动读取）。
- LLM 配置：复制 `markus.json.example` 为 `~/.markus/markus.json`，填入你的 LLM Provider API key（Anthropic / OpenAI / DeepSeek / Ollama / OpenRouter 等）。也可在 Web UI 设置页配置。
- 注意：根目录 `markus.json.example` 是配置样例，**不要**把真实 key 提交进仓库。

---

## 4. 项目结构速览

仓库是 pnpm workspace monorepo：

```
packages/
├── shared/           共享类型/常量/工具
├── core/             agent 运行时：LLM 路由、工具、技能、记忆、心跳、工作区隔离
├── storage/          SQLite/PostgreSQL 仓储层
├── org-manager/      REST API + WebSocket + 组织治理 + 任务生命周期
├── web-ui/           React + Vite + Tailwind 前端
├── desktop/          Electron 桌面端
├── cli/              命令行入口（@markus-global/cli）
├── comms/            Slack / Feishu / WhatsApp / Telegram 外部桥接
├── a2a/              Agent 间通信协议
├── gui/              GUI 自动化（VNC + OmniParser）
├── remote/           远程访问（Cloudflare Tunnel / Tailscale / FRP / ngrok）
├── chrome-extension/ 浏览器扩展
├── scripts/          构建/发布/工具脚本
├── templates/        Agent 角色（ROLE.md）与技能（SKILL.md）模板
├── docs/             设计文档（架构、API、记忆、技能生态…）
└── examples/         可运行示例
```

**新手指引**：先读 `docs/ARCHITECTURE.md`（系统架构）与 `docs/AGENT-RUNTIME.md`（agent 生命周期），再看你要改的包。

---

## 5. 测试

- 框架：**Vitest**（根 `vitest.config.ts`，自动发现 `packages/*/test/` 或 `*.test.ts`）。
- 只跑某个包/文件（本地开发更快）：
  ```bash
  pnpm test -- packages/core          # 按路径过滤
  pnpm test -- src/foo.test.ts        # 单文件
  pnpm test:watch                     # 监听模式
  pnpm test:coverage                  # 覆盖率
  ```
- 提交前务必全量 `pnpm test`。

> ⚠️ **已知环境性失败**：全量测试中有少量用例需要外部资源（本地 8056 端口被占用、搜索/图像 API key、外部模型调用等），在干净环境/CI 上会通过但本地可能失败。提交前若遇到失败，请用基线对比确认是否为你引入：`git stash && pnpm test -- <失败文件> && git stash pop`。

---

## 6. 调试与常见问题

| 问题 | 解决办法 |
|------|---------|
| 端口 8056 被占用 | 找到占用进程（`lsof -i :8056`），或在 `~/.markus/markus.json` 改 `server.apiPort`，UI 代理会跟随 |
| 改了 `packages/*/src` 不生效 | 用 `pnpm dev:watch`（tsc watch）；仅 `pnpm dev` 下改 API 需重启 API 进程 |
| 前端改了不刷新 | Vite 通常热更新；改了 `locales` 或常量则刷新浏览器即可 |
| `pnpm install` 报 peer 冲突 | 用 `pnpm install --fix-lockfile`（不要删 lockfile） |
| 开发数据脏了 | 删除 `~/.markus/` 下对应数据库文件重建（开发期可接受；生产数据先备份） |
| 想连真实 LLM | 在 `~/.markus/markus.json` 或 Web UI 设置页配置 provider key |
| 调试 API | `curl http://localhost:8056/api/health` 验活；REST 端点见 `docs/API.md` |

---

## 7. 提交前检查清单

```bash
pnpm typecheck   # 类型全过
pnpm lint        # 无新增 warning/error
pnpm test        # 测试全绿（先对比基线排除环境失败）
git commit -s    # DCO 签名提交（重要！见 CONTRIBUTING.md）
```

更多流程（PR 规范、代码标准、License 与 DCO）见 [CONTRIBUTING.md](../CONTRIBUTING.md)。