---
sidebar_position: 2
description: Get started with Markus in minutes — clone the repo, install dependencies, and run the full stack locally.
---

# Quick Start

Follow this guide to set up Markus for local development.

## Prerequisites

- **Node.js** 22 or later
- **pnpm** 9 or later

Verify your environment:

```bash
node --version   # Must be v22+
pnpm --version   # Must be v9+
```

## Clone and Install

Clone the repository and install all dependencies:

```bash
git clone git@github.com:markus-global/markus.git
cd markus
pnpm install
```

This will install dependencies for all packages in the monorepo.

## Build

Build all packages, including the API server and UI application:

```bash
pnpm build
```

The first build may take a few minutes — subsequent builds are significantly faster thanks to caching.

## Run

Start both the API server and the UI in development mode:

```bash
pnpm dev
```

This starts:
- **API server** at `http://localhost:8056`
- **UI application** at `http://localhost:8057`

## Quick Verification

Once the dev servers are running, verify the API is healthy:

```bash
curl http://localhost:8056/api/health
```

Expected response:

```json
{ "status": "ok" }
```

You can then open `http://localhost:8057` in your browser to access the Markus UI.
