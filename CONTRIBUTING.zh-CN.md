# Markus 贡献指南

本指南面向 AI 编码助手与人工贡献者。请按此指南高效参与 Markus AI 数字员工平台的开源贡献。

## 前置要求

- Node.js >= 20
- pnpm >= 9
- Docker（可选；用于沙箱功能）

## 快速开发配置

```bash
pnpm install
pnpm build
pnpm dev
```

- API 服务：`http://localhost:3001`
- Web UI：`http://localhost:3000`
- 默认管理员：`admin@markus.local` / `markus123`

数据库：默认使用 SQLite（零配置）。可选 PostgreSQL。

## 项目结构

```
packages/
├── shared/       # 共享类型、常量、工具
├── core/         # Agent 运行时（核心引擎）
├── storage/      # 数据库模式与仓储层
├── org-manager/  # 组织管理、REST API、治理服务
├── compute/      # Docker 沙箱管理（可选）
├── comms/        # 通讯适配器（飞书等）
├── a2a/          # Agent 间协议
├── gui/          # GUI 自动化（VNC + OmniParser）
├── web-ui/       # Web 管理界面（React + Vite + Tailwind）
└── cli/          # CLI 入口与服务编排
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装依赖 |
| `pnpm build` | 构建所有包 |
| `pnpm dev` | 启动 API + Web UI |
| `pnpm test` | 运行测试（vitest） |
| `pnpm typecheck` | TypeScript 检查 |
| `pnpm lint` | ESLint |

## 代码风格与约定

- **TypeScript 严格模式**：所有包使用 `strict: true`
- **ESM 模块**：使用 `import`/`export`，不使用 CommonJS
- **禁止默认导出**：仅使用具名导出
- **类型导入**：类型仅导入使用 `import type { X }`（由 ESLint 强制）
- **未使用变量**：以 `_` 开头以忽略（如 `_unused`）

## 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

- `feat(scope): 描述`
- `fix(scope): 描述`
- `docs(scope): 描述`
- `chore(scope): 描述`

示例：`feat(api): add GET /api/health endpoint`

## 添加新 Agent 角色

1. 在 `templates/roles/<角色名>/` 下创建目录
2. 添加 `ROLE.md`，定义职责、能力、风格
3. 可选添加 `HEARTBEAT.md`、`POLICIES.md` 等
4. 如需引用共享内容，可参考 `templates/roles/SHARED.md`

## 添加新技能

1. 在 `templates/skills/<技能名>/` 下创建目录
2. 添加 `manifest.json`，包含：
   - `name`、`version`、`description`、`author`、`category`、`tags`
   - `requiredPermissions`、`requiredEnv`（数组）
   - `mcpServers`（若技能使用 MCP）
3. 添加 `SKILL.md`，说明 AI 使用场景、用法、工具参考
4. 技能从 `templates/skills/` 及 `WELL_KNOWN_SKILL_DIRS` 自动发现

## 添加新 API 端点

1. 打开 `packages/org-manager/src/api-server.ts`
2. 在 `route()` 中为路径和 HTTP 方法添加新分支
3. 模式：`if (path === '/api/your-resource' && req.method === 'GET') { ... }`
4. 使用 `this.readBody(req)` 读取请求体
5. 使用 `this.json(res, statusCode, payload)` 返回 JSON
6. 使用 `await this.requireAuth(req, res)` 做认证校验
7. 将新路由放在与相近端点一致的逻辑位置

## 测试规范

- **框架**：Vitest
- **位置**：`packages/<包名>/test/*.test.ts` 或与源码并排的 `*.test.ts`
- **运行**：`pnpm test`（全部）或 `pnpm --filter @markus/<包名> test`（单包）
- 为新行为补充测试，保持测试聚焦且确定

## Pull Request 流程

1. Fork 仓库
2. 创建分支：`git checkout -b feat/your-feature`
3. 修改代码，运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`
4. 使用 conventional 格式提交
5. 向主分支发起 PR
6. 根据评审反馈修改

## Code Review 期望

- 变更符合项目结构与约定
- 新代码在必要时添加测试
- 无多余依赖或复杂度
- TypeScript 类型正确，避免 `any`
- API 变更向后兼容或已文档化

## 许可

AGPL-3.0（提供商业双许可）。
