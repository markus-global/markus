---
sidebar_position: 2
---

# Configuration

Markus is configured through environment variables and the `markus.json` configuration file. Below is a reference for all available options.

## Configuration File (`markus.json`)

Markus looks for `markus.json` in the current directory, the directory specified by `MARKUS_HOME`, or `~/.markus/config/markus.json`.

```json
{
  "port": 8056,
  "host": "0.0.0.0",
  "dataDir": "~/.markus/data",
  "dbPath": "~/.markus/data/markus.db",
  "logLevel": "info",
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-...",
      "model": "claude-sonnet-4-20250514"
    },
    "openai": {
      "apiKey": "sk-...",
      "model": "gpt-4o"
    }
  }
}
```

## Environment Variables

All configuration values can be overridden by environment variables with the `MARKUS_` prefix.

| Variable | Description | Default |
|----------|-------------|---------|
| `MARKUS_PORT` | HTTP server port | `8056` |
| `MARKUS_HOST` | HTTP server host | `0.0.0.0` |
| `MARKUS_HOME` | Data and config directory | `~/.markus` |
| `MARKUS_LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`) | `info` |
| `MARKUS_DB_PATH` | SQLite database file path | `{dataDir}/markus.db` |
| `MARKUS_AUTH_SECRET` | JWT signing secret | Auto-generated |

### Provider API Keys

Provider API keys can be set as environment variables or in `markus.json`:

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI (GPT-4o, etc.) |
| `GOOGLE_API_KEY` | Google (Gemini) |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `SILICONFLOW_API_KEY` | SiliconFlow |
| `OPENROUTER_API_KEY` | OpenRouter |
| `MINIMAX_API_KEY` | MiniMax |
| `ZAI_API_KEY` | Zhipu AI (GLM) |

## Ports Reference

| Service | Port | Description |
|---------|------|-------------|
| API Server | `8056` | HTTP API and WebSocket |
| Web UI | `8057` | React frontend (Vite dev server) |
| Desktop App | Bundles both | Electron app with API + UI |

## LLM Provider Configuration

Providers are configured under the `providers` key in `markus.json`. Each provider requires:

- **`apiKey`** — Authentication key for the provider API
- **`model`** — Default model ID to use
- **`baseUrl`** (optional) — Custom API endpoint (for OpenAI-compatible providers)

Example with multiple providers:

```json
{
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-...",
      "model": "claude-sonnet-4-20250514"
    },
    "openai": {
      "apiKey": "sk-...",
      "model": "gpt-4o"
    },
    "deepseek": {
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "model": "llama3.2"
    }
  }
}
```
