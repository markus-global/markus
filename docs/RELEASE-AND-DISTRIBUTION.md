# Markus 发布与分发指南

## 概览

Markus 提供三种安装方式：

| 安装方式 | 适用人群 | 自动更新 | 需要 Node.js |
|---------|---------|---------|-------------|
| **Desktop App** (Electron) | 桌面用户，偏好 GUI | ✅ electron-updater | ❌ 内置 |
| **npm install** | 开发者、服务器部署 | ❌ 手动 | ✅ 需要 Node 22+ |
| **Server Binary** (Linux) | Linux 服务器/无头部署 | ❌ 手动 | ❌ 内嵌 Node.js |

---

## 1. Desktop App (Electron)

主要面向桌面用户的安装方式。

### 产物

| 平台 | 格式 | 文件名 |
|------|------|--------|
| macOS (Apple Silicon) | DMG | `Markus-{VER}-arm64.dmg` |
| Windows x64 | NSIS EXE | `Markus-Setup-{VER}.exe` |
| Linux x64 | AppImage | `Markus-{VER}.AppImage` |

### 签名与公证

| 平台 | 签名 | 公证 |
|------|------|------|
| macOS | Developer ID Application | Apple Notarization |
| Windows | — (计划中) | — |
| Linux | — | — |

### 自动更新

- `electron-updater`，发布到 GitHub Releases
- 更新检查：应用启动时

### 本地开发

```bash
cd packages/desktop && pnpm dev

# 打包测试 (不签名)
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --dir
open dist-electron/mac-arm64/Markus.app
```

---

## 2. npm 包

### 安装

```bash
npm install -g @markus-global/cli
npm install -g @markus-global/cli@next   # 预发布版
```

### 发布标签

| 版本格式 | npm tag | 说明 |
|---------|---------|------|
| `0.8.3` | `latest` | 正式版 |
| `0.8.4-rc.0` | `next` | 预发布版 |

---

## 3. Server Binary (Linux)

用于 Linux 服务器无头部署，内嵌 Node.js 运行时。

### 产物

| 格式 | 文件名 |
|------|--------|
| DEB | `markus-setup-linux-x64.deb` |
| tar.gz | `markus-v{VER}-linux-x64.tar.gz` |

### 一键安装脚本

```bash
# macOS / Linux
curl -fsSL https://markus.global/install.sh | bash

# Windows (PowerShell)
irm https://markus.global/install.ps1 | iex
```

---

## CI/CD 流程

### 触发条件

推送 `v*` 格式的 Git tag。

### 流水线

```
push tag v*
  │
  ├─→ publish-npm               发布到 npm
  │     │
  │     ├─→ build-server-binary  Linux x64 (.deb + .tar.gz)
  │     │
  │     └─→ build-desktop        3 平台 Electron 桌面版
  │           ├── macOS arm64    (.dmg)
  │           ├── Windows x64    (.exe)
  │           └── Linux x64      (.AppImage)
  │
  ├─→ github-release            创建 GitHub Release
  │
  └─→ upload-to-hub             上传到 R2 (仅正式版)
```

**5 个 CI job，6 个产物。**

### 所需 Secrets

| Secret | 用途 |
|--------|------|
| `NPM_TOKEN` | npm 发布 |
| `GITHUB_TOKEN` | Release 创建、Electron 更新源 |
| `APPLE_CERTIFICATE_P12` | macOS 代码签名 |
| `APPLE_CERTIFICATE_PASSWORD` | P12 密码 |
| `APPLE_ID` | Apple 公证 |
| `APPLE_ID_PASSWORD` | Apple App-Specific Password |
| `APPLE_TEAM_ID` | Apple Team ID |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 |
| `R2_ACCOUNT_ID` | Cloudflare R2 |
| `R2_BUCKET_NAME` | Cloudflare R2 |

---

## 分发渠道

| 渠道 | 内容 | URL |
|------|------|-----|
| GitHub Releases | 全部产物 | `github.com/markus-global/markus/releases` |
| npm | CLI 包 | `npmjs.com/package/@markus-global/cli` |
| Cloudflare R2 | 二进制 + Desktop (CN 加速) | `markus.global/releases/` |
| install.sh | 一键安装脚本 | `curl -fsSL https://markus.global/install.sh \| bash` |

---

## 平台支持

| 平台 | Desktop App | Server Binary | npm |
|------|-------------|--------------|-----|
| macOS arm64 | ✅ DMG | — | ✅ |
| Windows x64 | ✅ NSIS | — | ✅ |
| Linux x64 | ✅ AppImage | ✅ DEB | ✅ |

---

## 已知限制

1. **macOS x64 (Intel)** — 未单独构建，Apple Silicon 版本可通过 Rosetta 运行
2. **Windows 代码签名** — 未实现，用户会看到 SmartScreen 警告
3. **Linux arm64** — 暂不支持
