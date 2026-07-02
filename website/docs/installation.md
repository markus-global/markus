---
sidebar_position: 3
---

# Installation

Markus can be installed and run in several ways. Choose the option that best fits your workflow.

## Option 1: Source Code (Recommended)

For developers who want to run, customize, or contribute to Markus:

```bash
git clone git@github.com:markus-global/markus.git
cd markus
pnpm install
pnpm build
pnpm dev
```

This starts both the API server and Web UI in development mode.

**Prerequisites:**
- **Node.js** 22 or later
- **pnpm** 9 or later (install via `corepack enable && corepack prepare pnpm@latest --activate`)

## Option 2: Desktop App (Electron)

Download the latest release for your platform from the [Releases](https://github.com/markus-global/markus/releases) page:

- **macOS**: `Markus-x.y.z.dmg` (Apple Silicon) or `Markus-x.y.z-x64.dmg` (Intel)
- **Linux**: `markus_x.y.z_amd64.AppImage`, `.deb`, or `.rpm` packages
- **Windows**: `Markus-Setup-x.y.z.exe`

Launch Markus from your applications menu. The desktop app includes a terminal, file browser, and settings panel.

## Option 3: Docker

Run Markus in an isolated container — ideal for CI/CD, servers, or sandbox environments:

```bash
docker run -d \
  --name markus \
  -p 8056:8056 \
  -v markus-data:/home/markus/data \
  -e MARKUS_API_KEY=your-api-key \
  ghcr.io/markus-global/markus:latest
```

See the [Docker Compose example](https://github.com/markus-global/markus/blob/main/docker-compose.yml) for a full setup with persistent volumes and environment configuration.

## Option 4: CLI Global Install

Use Markus as a CLI tool anywhere on your system:

```bash
pnpm add -g @markus-global/cli
```

After installation, run `markus --help` to see available commands. This variant is lightweight and does not include the desktop UI.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MARKUS_API_KEY` | API authentication key | — |
| `MARKUS_HOME` | Data and config directory | `~/.markus` |
| `MARKUS_PORT` | HTTP server port | `8056` |
| `MARKUS_LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`) | `info` |
