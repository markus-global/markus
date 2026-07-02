---
sidebar_position: 1
---

# Docker Deployment

This guide covers deploying Markus using Docker and Docker Compose.

## Prerequisites

- Docker Engine 24+ and Docker Compose v2+
- A Linux x86_64 or arm64 host

## Pull the Image

Markus images are published to GitHub Container Registry:

```bash
docker pull ghcr.io/markus-global/markus:latest
```

You can also pull a specific version:

```bash
docker pull ghcr.io/markus-global/markus:0.8.4
```

## Docker Compose Setup

Create a `compose.yaml` file:

```yaml
services:
  markus:
    image: ghcr.io/markus-global/markus:latest
    container_name: markus
    restart: unless-stopped
    ports:
      - "8056:8056"
    volumes:
      - ./data:/app/data
      - ./config:/app/config
    environment:
      - MARKUS_AUTH_SECRET=${MARKUS_AUTH_SECRET}
      - MARKUS_LLM_API_KEY=${MARKUS_LLM_API_KEY}
      - MARKUS_LLM_BASE_URL=${MARKUS_LLM_BASE_URL}
      - TZ=UTC
```

## Volumes

| Volume mount | Purpose |
|---|---|
| `./data` | Persistent agent data, workspaces, and logs |
| `./config` | Configuration files overrides |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Optional | API key for Anthropic (Claude) |
| `OPENAI_API_KEY` | Optional | API key for OpenAI |
| `MARKUS_AUTH_SECRET` | Optional | Secret key for authentication (auto-generated if omitted) |

Start the service:

```bash
docker compose up -d
```

The API will be available at `http://localhost:8056`. The Web UI (if running separately) is at `http://localhost:8057`.
