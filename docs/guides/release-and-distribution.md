# Markus Release and Distribution Guide

## Overview

Markus offers three installation methods:

| Installation method | Audience | Auto-update | Requires Node.js |
|---------|---------|---------|-------------|
| **Desktop App** (Electron) | Desktop users who prefer a GUI | ✅ electron-updater | ❌ bundled |
| **npm install** | Developers, server deployments | ❌ manual | ✅ requires Node 22+ |
| **Server Binary** (Linux) | Linux servers / headless deployments | ❌ manual | ❌ embeds Node.js |

---

## 1. Desktop App (Electron)

The installation method primarily aimed at desktop users.

### Artifacts

| Platform | Format | File name |
|------|------|--------|
| macOS (Apple Silicon) | DMG | `Markus-{VER}-arm64.dmg` |
| macOS (Intel) | DMG | `Markus-{VER}.dmg` |
| Windows x64 | NSIS EXE | `Markus-Setup-{VER}.exe` |
| Linux x64 | AppImage | `Markus-{VER}.AppImage` |

### Signing and Notarization

| Platform | Signing | Notarization |
|------|------|------|
| macOS | Developer ID Application | Apple Notarization |
| Windows | Certum SimplySign (SHA-256) | — |
| Linux | — | — |

### Auto-update

- `electron-updater`, published to GitHub Releases
- Update check: on app launch (after a 10 s delay), then every 4 hours

### Local Development

```bash
cd packages/desktop && pnpm dev

# Packaging test (no signing)
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --dir
open dist-electron/mac-arm64/Markus.app
```

---

## 2. npm Package

### Installation

```bash
npm install -g @markus-global/cli
npm install -g @markus-global/cli@next   # pre-release
```

### Release Tags

| Version format | npm tag | Description |
|---------|---------|------|
| `0.8.3` | `latest` | Stable release |
| `0.8.4-rc.0` | `next` | Pre-release |

---

## 3. Server Binary (Linux only)

For headless deployment on Linux servers, with an embedded Node.js runtime. macOS / Windows no longer provide standalone binaries; use the Desktop App or npm instead.

### Artifacts

| Format | File name |
|------|--------|
| DEB | `markus-setup-linux-x64.deb` |
| tar.gz | `markus-v{VER}-linux-x64.tar.gz` |

### One-line Install Script

```bash
curl -fsSL https://markus.global/install.sh | bash
```

On Linux, this script auto-detects Node.js: if present it installs via npm; if not it downloads the standalone binary. macOS users who run this script are prompted to install Node.js or download the Desktop App.

---

## CI/CD Pipeline

### Trigger

Pushing a Git tag in the `v*` format.

### Pipeline

```
push tag v*
  │
  ├─→ publish-npm               Publish to npm
  │     │
  │     ├─→ build-server-binary  Linux x64 (.deb + .tar.gz)
  │     │
  │     ├─→ build-desktop        3-platform Electron desktop build (macOS + Linux)
  │     │     ├── macOS arm64    (.dmg)
  │     │     ├── macOS x64      (.dmg)
  │     │     └── Linux x64      (.AppImage)
  │     │
  │     └─→ build-desktop-windows  Windows x64 (.exe, signed)
  │
  ├─→ github-release            Create GitHub Release
  │
  └─→ upload-to-hub             Upload to R2 (stable releases only)
```

**6 CI jobs, 7 artifacts.**

### Required Secrets

| Secret | Purpose |
|--------|------|
| `GITHUB_TOKEN` | Release creation, Electron update feed |
| `APPLE_CERTIFICATE_P12` | macOS code signing |
| `APPLE_CERTIFICATE_PASSWORD` | P12 password |
| `APPLE_ID` | Apple notarization |
| `APPLE_ID_PASSWORD` | Apple App-Specific Password |
| `APPLE_TEAM_ID` | Apple Team ID |
| `CERTUM_EMAIL` | Windows code signing — SimplySign login email |
| `CERTUM_OTP` | Windows code signing — SimplySign TOTP seed |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 |
| `R2_ACCOUNT_ID` | Cloudflare R2 |
| `R2_BUCKET_NAME` | Cloudflare R2 |

---

## Distribution Channels

| Channel | Content | URL |
|------|------|-----|
| GitHub Releases | All artifacts | `github.com/markus-global/markus/releases` |
| npm | CLI package | `npmjs.com/package/@markus-global/cli` |
| Cloudflare R2 | Binaries + Desktop (CN acceleration) | `markus.global/releases/` |
| install.sh | Linux one-line install script | `curl -fsSL https://markus.global/install.sh \| bash` |

---

## Platform Support

| Platform | Desktop App | Server Binary | npm |
|------|-------------|--------------|-----|
| macOS arm64 | ✅ DMG | — | ✅ |
| macOS x64 | ✅ DMG | — | ✅ |
| Windows x64 | ✅ NSIS | — | ✅ |
| Linux x64 | ✅ AppImage | ✅ DEB | ✅ |

---

## Known Limitations

1. **Windows code signing** — implemented via Certum SimplySign (`build/sign.cjs`); builds without the `CERTUM_*` secrets are left unsigned and trigger a SmartScreen warning
2. **Linux arm64** — not supported yet
