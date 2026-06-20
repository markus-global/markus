# Markus Desktop App

Electron 桌面客户端，将 Markus AI 数字员工平台封装为原生桌面应用。

## 版本信息

| 项目 | 版本 |
|------|------|
| Markus | 0.8.3 |
| Electron | 35.x |
| electron-builder | 26.x |
| Node.js (runtime) | 22 |
| 构建工具 | esbuild 0.27 |
| 模块格式 | ESM (main) / CJS (preload) |

## 支持平台

| 平台 | 架构 | 输出格式 | 状态 |
|------|------|---------|------|
| macOS | arm64 | dmg | ✅ |
| macOS | x64 | dmg | ✅ |
| Windows | x64 | nsis installer | ✅ |
| Linux | x64 | AppImage | ✅ |

## 项目结构

```
packages/desktop/
├── build/                    # electron-builder 资源
│   ├── icon.png              # 应用图标 (512x512)
│   ├── icon.icns             # macOS 图标
│   ├── icon.ico              # Windows 图标
│   ├── splash.html           # 启动画面 (已弃用，实际使用 src/splash.html)
│   ├── entitlements.mac.plist
│   ├── entitlements.mac.inherit.plist
│   ├── entitlements.mas.plist
│   └── entitlements.mas.inherit.plist
├── src/
│   ├── main.ts               # 主进程入口，应用生命周期
│   ├── window.ts             # 窗口创建与状态持久化
│   ├── backend.ts            # 内嵌后端启动/关闭
│   ├── preload.ts            # preload 脚本 (contextBridge)
│   ├── menu.ts               # 应用菜单
│   ├── tray.ts               # 系统托盘
│   ├── notifications.ts      # OS 原生通知桥接
│   ├── updater.ts            # 自动更新 (electron-updater)
│   ├── protocol.ts           # 自定义协议 (markus://)
│   ├── ipc-handlers.ts       # IPC 通信处理
│   ├── splash.html           # 启动画面
│   └── shims.js              # ESM 兼容 shim (__dirname 等)
├── build.mjs                 # esbuild 构建脚本
├── electron-builder.yml      # 打包配置
├── package.json
└── dist/                     # 构建产物 (git ignored)
    ├── main.js               # 打包后的主进程
    ├── preload.js            # 打包后的 preload
    ├── splash.html           # 启动画面
    ├── icon.png              # 图标
    ├── web-ui/               # 前端静态资源
    └── templates/            # 内置团队/角色模板
```

## 架构设计

```
┌─────────────────────────────────────────────────┐
│                  Electron App                     │
├─────────────────┬───────────────────────────────┤
│  Main Process   │    Renderer Process            │
│                 │                                │
│  main.ts        │    Web UI (React + Vite)       │
│  backend.ts ────┼──→ localhost:8056              │
│  notifications  │    ↕ WebSocket                 │
│  updater        │                                │
│  menu / tray    │                                │
│                 │                                │
│  ┌───────────┐  │    ┌──────────────┐            │
│  │ Markus    │  │    │ BrowserWindow│            │
│  │ Backend   │  │    │ loadURL()    │            │
│  │ (in-proc) │  │    └──────────────┘            │
│  └───────────┘  │                                │
└─────────────────┴───────────────────────────────┘
```

**核心设计决策：**
- 后端 (API Server) 在主进程中内嵌启动，无需单独运行 CLI
- 前端通过 `win.loadURL('http://localhost:PORT')` 加载
- Preload 脚本通过 `contextBridge` 暴露有限 API
- 模板文件打包到 asar 内，通过 `MARKUS_TEMPLATES_DIR` 环境变量定位

## 开发指南

### 前置要求

- Node.js >= 22
- pnpm >= 9
- 已完成根目录 `pnpm install`

### 本地开发

```bash
# 1. 先构建依赖包
pnpm build

# 2. 构建 + 启动 Electron (dev 模式)
cd packages/desktop
pnpm dev
```

### 本地打包 (不签名)

```bash
# 构建 Electron 主进程
node packages/desktop/build.mjs

# 打包为目录 (快速测试)
cd packages/desktop
pnpm pack              # 生成 dist-electron/mac-arm64/Markus.app

# 打包为 dmg
pnpm dist:mac
```

### CI 发布流程

GitHub Actions 工作流 (`.github/workflows/publish.yml`) 在创建 tag 时自动触发：

1. `publish-npm` — 发布 CLI 到 npm
2. `build-desktop` — 并行构建 macOS (arm64/x64)、Windows、Linux
3. `github-release` — 上传所有产物到 GitHub Release

## 关键技术细节

### ESM 与 __dirname

Electron 主进程使用 ESM 格式打包，但 Node.js 内置的 `__dirname` 在 ESM 中不可用。通过 `src/shims.js` 注入兼容 shim：

```js
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

### asar 与 asarUnpack

打包时所有文件放入 `app.asar`，但以下文件需要解包（因为需要通过文件路径直接访问）：

- `dist/preload.js` — Electron 要求 preload 为真实文件路径
- `dist/splash.html` — `loadFile()` 需要真实文件系统路径
- `dist/icon.png` — splash.html 中引用

路径访问模式：
```typescript
// 打包后正确获取 unpacked 文件路径
const path = join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'dist', 'file');
```

### 窗口标题栏

macOS 使用 `hiddenInset` 样式，通过 CSS 注入实现侧边栏 48px padding 避让红绿灯。Windows/Linux 使用系统默认标题栏。

### 自动更新

通过 `electron-updater` 实现，发布到 GitHub Releases，应用启动时自动检查更新。

### 系统通知

桌面通知桥 (`notifications.ts`) 通过 WebSocket 监听后端事件：

| 事件 | 是否通知 | 说明 |
|------|---------|------|
| 任务完成 | ✅ | `task:update` (status=completed) 或 `task:completed` |
| 任务失败 | ✅ | `task:update` (status=failed) |
| 审批请求 | ✅ | `approval:requested` |
| 需要 Review | ✅ | `task:update` (status=review) |
| Agent @提及 | ✅ | `chat:message` (notifyUser=true) |
| Agent 启动/停止 | ❌ | 过于频繁，不打扰用户 |
| Agent 创建/删除 | ❌ | 同上 |

### OAuth 登录

外部登录弹窗策略：
- OAuth 回调 URL (`/auth/callback`, `/auth/login`, `/oauth`) → 新 Electron 窗口
- 其他外部链接 (如 Markus Hub) → 系统默认浏览器

## 构建产物

| 平台 | 文件 | 大小约 |
|------|------|--------|
| macOS arm64 | Markus-x.x.x-arm64.dmg | ~130 MB |
| macOS x64 | Markus-x.x.x-x64.dmg | ~140 MB |
| Windows | Markus-Setup-x.x.x.exe | ~120 MB |
| Linux | Markus-x.x.x.AppImage | ~130 MB |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MARKUS_MAS` | 是否为 MAS 构建 | `false` |
| `MARKUS_TEMPLATES_DIR` | 模板目录路径（运行时自动设置） | — |
| `CSC_IDENTITY_AUTO_DISCOVERY` | 禁用自动签名发现 | — |
| `GH_TOKEN` | GitHub token (用于发布) | — |

## 已知限制

1. Windows / Linux 尚未实际测试，仅 macOS 经过完整验证
2. MAS 版本需要额外的 provisioning profile 和证书配置
3. `webSecurity: false` 用于开发便利，生产版本应考虑收紧
4. 后端内嵌在同进程，崩溃会导致整个应用退出
