# Markus 发布与分发指南

本文档详细说明 Markus 的所有发布产物、打包流程、分发渠道和平台支持情况。

## 概览

Markus 提供三种安装方式，覆盖不同用户场景：

| 安装方式 | 适用人群 | 自动更新 | 需要 Node.js |
|---------|---------|---------|-------------|
| **Desktop App** (Electron) | 桌面用户，偏好 GUI | ✅ electron-updater | ❌ 内置 |
| **Binary Installer** (.pkg/.exe/.deb) | 服务器/CLI 用户 | ✅ `markus update` | ❌ 内嵌 Node.js |
| **npm install** | 开发者 | ❌ 手动 | ✅ 需要 Node 22+ |

---

## 1. Desktop App (Electron)

### 产物

| 平台 | 架构 | 格式 | 文件名 |
|------|------|------|--------|
| macOS | arm64 | DMG | `Markus-{VER}-arm64.dmg` |
| macOS | x64 | DMG | `Markus-{VER}.dmg` |
| macOS | arm64 | ZIP | `Markus-{VER}-arm64-mac.zip` |
| macOS | x64 | ZIP | `Markus-{VER}-mac.zip` |
| macOS (MAS) | universal | PKG | 通过 App Store Connect 提交 |
| Windows | x64 | NSIS EXE | `Markus-Setup-{VER}.exe` |
| Linux | x64 | AppImage | `Markus-{VER}.AppImage` |
| Linux | x64 | DEB | `Markus_{VER}_amd64.deb` |

### 技术栈

- **Electron**: 35.x
- **构建工具**: esbuild (打包 main/preload) + electron-builder (打包分发)
- **前端**: 内嵌 Web UI 静态资源 (Vite + React)
- **后端**: 同进程内嵌运行

### 签名与公证

| 平台 | 签名方式 | 公证 |
|------|---------|------|
| macOS (DMG/ZIP) | Developer ID Application | Apple Notarization |
| macOS (MAS) | 3rd Party Mac Developer | App Store Review |
| Windows | — (计划中) | — |
| Linux | — | — |

### 自动更新

- 使用 `electron-updater`，发布到 GitHub Releases
- MAS 版本禁用自动更新（由 App Store 管理）
- 更新检查频率：应用启动时

### 构建命令

```bash
# 本地开发
cd packages/desktop && pnpm dev

# 构建 + 打包 (目录模式，快速测试)
node packages/desktop/build.mjs
cd packages/desktop && pnpm pack

# 完整打包
pnpm dist:mac       # macOS DMG + ZIP
pnpm dist:win       # Windows NSIS
pnpm dist:linux     # Linux AppImage + DEB
pnpm dist:mas       # Mac App Store
```

---

## 2. Binary Installer (CLI)

独立二进制包，内嵌 Node.js 运行时，用户无需预装任何依赖。

### 产物

| 平台 | 架构 | 格式 | 文件名 |
|------|------|------|--------|
| macOS | arm64 | PKG | `markus-v{VER}-darwin-arm64.pkg` |
| macOS | x64 | PKG | `markus-v{VER}-darwin-x64.pkg` |
| Windows | x64 | EXE (Inno Setup) | `markus-v{VER}-win-x64-setup.exe` |
| Linux | x64 | DEB | `markus-v{VER}-linux-x64.deb` |

另有固定文件名版本 (`markus-setup-{platform}-{arch}.{ext}`)，供 `/releases/latest/download/` 永久链接使用。

### 安装内容

安装后的目录结构 (以 macOS 为例)：

```
/usr/local/lib/markus/
├── bin/
│   ├── Markus              # Node.js 二进制 (重命名)
│   ├── node -> Markus      # 符号链接
│   ├── markus.mjs          # CLI 主入口 (esbuild 单文件打包)
│   ├── tray.mjs            # 系统托盘控制器
│   └── node_modules/       # 原生依赖 (ws, sharp, rfb2, systray2)
├── web-ui/                 # 前端静态资源
├── templates/              # 内置团队/角色/技能模板
├── chrome-extension/       # 浏览器扩展 zip
├── logo.png
├── markus.icns
├── markus                  # 启动器脚本 → /usr/local/bin/markus
└── package.json            # 版本标记
```

### 安装器行为

#### macOS (.pkg)
- **安装位置**: `/usr/local/lib/markus`
- **CLI 入口**: `/usr/local/bin/markus` (符号链接)
- **Markus.app**: 创建到 `/Applications/Markus.app` (托盘启动器)
- **开机自启**: `~/Library/LaunchAgents/global.markus.plist`
- **V8 JIT**: 自动签名 Node.js 二进制以获取 JIT entitlements
- **升级行为**: preinstall 脚本自动停止旧版本再覆盖安装

#### Windows (.exe)
- **安装位置**: `%LOCALAPPDATA%\markus`
- **CLI 入口**: 自动添加到 `PATH`
- **桌面快捷方式**: 指向 `markus-tray.vbs`（无控制台窗口启动）
- **开机自启**: 通过开始菜单 Startup 快捷方式

#### Linux (.deb)
- **安装位置**: `/usr/local/lib/markus`
- **CLI 入口**: `/usr/local/bin/markus` (符号链接)
- **桌面快捷方式**: `~/Desktop/markus.desktop`
- **开机自启**: `~/.config/autostart/markus.desktop`

### 便携归档

除安装器外，每个平台还生成便携归档：
- macOS/Linux: `.tar.gz`
- Windows: `.zip`

供 `install.sh` / `install.ps1` 脚本解压到 `~/.markus/app/`。

### 构建命令

```bash
# 构建某平台的安装器
bash scripts/build-binary.sh darwin arm64
bash scripts/build-binary.sh darwin x64
bash scripts/build-binary.sh win x64
bash scripts/build-binary.sh linux x64
```

---

## 3. npm 包

### 产物

| 包名 | 注册表 | 说明 |
|------|--------|------|
| `@markus-global/cli` | npmjs.com | CLI 入口 + 打包后的所有核心逻辑 |

### 安装

```bash
npm install -g @markus-global/cli
# 或
npm install -g @markus-global/cli@next   # 预发布版
```

### 发布标签

| 版本格式 | npm tag | 说明 |
|---------|---------|------|
| `0.8.3` | `latest` | 正式版 |
| `0.8.4-rc.0` | `next` | 预发布版 |

---

## 4. Docker (计划中)

目前已注释，计划恢复：

```yaml
# markus/markus:{version}
# markus/markus:latest
```

---

## CI/CD 流程

### 触发条件

推送 `v*` 格式的 Git tag 触发完整发布流程。

### 流水线

```
push tag v0.8.3
  │
  ├─→ publish-npm          发布 @markus-global/cli 到 npm
  │     │
  │     ├─→ build-binaries       并行构建 4 平台 CLI 安装器
  │     │     ├── linux-x64
  │     │     ├── darwin-arm64
  │     │     ├── darwin-x64
  │     │     └── win-x64
  │     │
  │     ├─→ build-desktop        并行构建 4 平台 Electron 桌面版
  │     │     ├── darwin-arm64
  │     │     ├── darwin-x64
  │     │     ├── win-x64
  │     │     └── linux-x64
  │     │
  │     └─→ build-desktop-mas    Mac App Store 构建 (仅正式版)
  │
  ├─→ github-release      创建 GitHub Release + 上传所有产物
  │
  └─→ upload-to-hub       上传二进制到 Cloudflare R2 (仅正式版)
```

### 所需 Secrets

| Secret | 用途 |
|--------|------|
| `NPM_TOKEN` | npm 发布 |
| `GITHUB_TOKEN` | Release 创建、Electron 更新源 |
| `APPLE_CERTIFICATE_P12` | macOS 代码签名 (Developer ID) |
| `APPLE_CERTIFICATE_PASSWORD` | P12 密码 |
| `APPLE_ID` | Apple 公证 |
| `APPLE_ID_PASSWORD` | Apple 公证 (App-Specific Password) |
| `APPLE_TEAM_ID` | Apple Team ID |
| `MAS_CERTIFICATE_P12` | MAS 签名证书 |
| `MAS_CERTIFICATE_PASSWORD` | MAS P12 密码 |
| `MAS_PROVISIONING_PROFILE` | MAS Provisioning Profile (base64) |
| `ASC_API_KEY` | App Store Connect API Key (base64) |
| `ASC_API_KEY_ID` | ASC Key ID |
| `ASC_API_ISSUER` | ASC Issuer ID |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 |
| `R2_ACCOUNT_ID` | Cloudflare R2 |
| `R2_BUCKET_NAME` | Cloudflare R2 |

---

## 5. 分发渠道

| 渠道 | 内容 | URL |
|------|------|-----|
| GitHub Releases | 全部产物 | `github.com/markus-global/markus/releases` |
| npm | CLI 包 | `npmjs.com/package/@markus-global/cli` |
| Mac App Store | Desktop App (MAS) | Apple App Store |
| Cloudflare R2 | 二进制安装器 | `markus.global/releases/` |
| install.sh | 一键安装脚本 | `curl -fsSL https://markus.global/install.sh \| bash` |
| install.ps1 | Windows 一键安装 | `irm https://markus.global/install.ps1 \| iex` |

---

## 6. 版本号规则

采用 [SemVer](https://semver.org/) 语义化版本：

```
{major}.{minor}.{patch}[-{prerelease}]
```

- **正式版** (`0.8.3`): 完整 CI 流程，上传到所有渠道
- **预发布版** (`0.8.4-rc.0`): npm tag 为 `next`，不提交 MAS，不上传到 R2

版本号统一在根 `package.json` 管理，各子包通过 `pnpm` workspace 协议引用。

---

## 7. 本地发布测试

### 测试桌面版打包

```bash
# 1. 构建所有依赖
pnpm build
pnpm --filter @markus/web-ui build

# 2. 构建 Electron 主进程
node packages/desktop/build.mjs

# 3. 打包为目录 (不签名，快速验证)
cd packages/desktop
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --dir

# 4. 启动测试
open dist-electron/mac-arm64/Markus.app
```

### 测试 CLI 二进制打包

```bash
# 构建 CLI bundle
pnpm --filter @markus-global/cli build:bundle

# 构建本机平台安装器
bash scripts/build-binary.sh darwin arm64

# 安装测试
sudo installer -pkg dist-binary/markus-v0.8.3-darwin-arm64.pkg -target /
```

---

## 8. 平台支持矩阵

| 平台 | 架构 | Desktop App | CLI Binary | npm | 测试状态 |
|------|------|-------------|-----------|-----|---------|
| macOS | arm64 | ✅ DMG/ZIP | ✅ PKG | ✅ | 🟢 主要开发平台 |
| macOS | x64 | ✅ DMG/ZIP | ✅ PKG | ✅ | 🟡 CI 构建通过 |
| Windows | x64 | ✅ NSIS | ✅ EXE | ✅ | 🟡 CI 构建通过 |
| Linux | x64 | ✅ AppImage/DEB | ✅ DEB | ✅ | 🟡 CI 构建通过 |
| Linux | arm64 | ❌ | ❌ | ✅ | — |
| Windows | arm64 | ❌ | ❌ | ✅ | — |

图例：🟢 完整测试  🟡 CI 验证  ❌ 暂不支持

---

## 9. 已知问题与限制

1. **Windows/Linux Desktop App 未实际测试** — 仅 CI 构建通过，需要在对应平台验证功能
2. **Windows 代码签名未实现** — 用户会看到 SmartScreen 警告
3. **Linux arm64 不支持** — Node.js 官方 arm64 binary 可用，但 native deps 需验证
4. **MAS 沙箱限制** — 部分功能（shell 执行、本地文件访问）在 MAS 版本中不可用
5. **Docker 镜像暂停** — 等待 headless 模式完善后恢复
