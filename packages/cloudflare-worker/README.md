# Markus Proxy — Cloudflare Worker

Production-grade LLM proxy with token billing support, running on Cloudflare Workers.

## Architecture

```
Client → [Cloudflare Worker] → Upstream LLM Provider (OpenAI-compatible)
```

Requests are authenticated via:
- **Proxy JWT mode** — Bearer token with embedded CU quota (platform billing)
- **Direct API-key mode** — Caller provides their own API key (passthrough)

## Prerequisites

- Node.js >= 22
- pnpm >= 9
- [Cloudflare account](https://dash.cloudflare.com) with Workers enabled
- `wrangler` CLI (installed via `pnpm install`)

## Setup

### 1. Install dependencies

```bash
cd packages/cloudflare-worker
pnpm install
```

### 2. Configure wrangler.toml

Edit `wrangler.toml` and set your `account_id`:

```toml
account_id = "your-account-id-here"
```

Find your Account ID at [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages.

### 3. Authenticate with Cloudflare

```bash
npx wrangler login
```

This opens a browser window to authorize wrangler CLI with your Cloudflare account.

### 4. Set production secrets

```bash
npx wrangler secret put PROXY_JWT_SECRET --env production
npx wrangler secret put LLM_PROXY_BASE_URL --env production
npx wrangler secret put LLM_PROXY_API_KEY --env production
```

| Secret | Description | Example |
|--------|-------------|---------|
| `PROXY_JWT_SECRET` | JWT signing secret (generate via `openssl rand -hex 32`) | `a1b2c3...` |
| `LLM_PROXY_BASE_URL` | Upstream LLM provider base URL | `https://api.openai.com/v1` |
| `LLM_PROXY_API_KEY` | API key for upstream LLM provider | `sk-...` |

### 5. (Optional) Configure domain / routes

In Cloudflare Dashboard:
1. Add your domain to Cloudflare
2. Workers & Pages → markus-proxy → Triggers → Custom Domains
3. Add `proxy.markus.ai` (or your preferred subdomain)

If using routes instead of custom domains, update `routes` in `wrangler.toml`.

## Deployment

### Production

```bash
cd packages/cloudflare-worker
npx wrangler deploy --env production
```

### Staging (if configured)

```bash
npx wrangler deploy --env staging
```

### Local development

```bash
npx wrangler dev
```

This starts a local dev server at `http://localhost:8787`.

## Verification

After deployment, verify the health endpoint:

```bash
curl https://proxy.markus.ai/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "markus-proxy",
  "version": "0.1.0",
  "timestamp": "2025-04-01T00:00:00.000Z",
  "uptime": 12345
}
```

## Environment Variables

| Variable | Scope | Where to set | Required |
|----------|-------|-------------|----------|
| `ENVIRONMENT` | per-environment | `wrangler.toml` `[env.*.vars]` | Yes |
| `PROXY_JWT_SECRET` | secret | `wrangler secret put` | Yes (proxy mode) |
| `LLM_PROXY_BASE_URL` | secret | `wrangler secret put` | Yes (proxy mode) |
| `LLM_PROXY_API_KEY` | secret | `wrangler secret put` | Yes (proxy mode) |

## Testing

```bash
pnpm test          # Run unit tests
pnpm test:watch    # Watch mode
pnpm typecheck     # TypeScript type checking
pnpm build         # Dry-run deploy (validate config)
```

## CI/CD

The Worker deployment can be added to GitHub Actions:

```yaml
- name: Deploy Worker
  run: npx wrangler deploy --env production
  working-directory: packages/cloudflare-worker
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

> Note: For CI/CD, use a Cloudflare API Token with `Workers: Edit` permissions
> set via GitHub Secrets, rather than `wrangler login`.

## Project Structure

```
packages/cloudflare-worker/
├── wrangler.toml          # Worker configuration
├── src/
│   ├── index.ts           # Entry point / request handler
│   ├── auth-context.ts    # Auth context (request-scoped)
│   ├── jwt-verify.ts      # JWT verification
│   ├── routes/
│   │   ├── health.ts      # GET /health
│   │   └── chat.ts        # POST /v1/chat/completions
│   ├── middleware/
│   │   ├── auth.ts        # JWT / API-key auth
│   │   ├── cors.ts        # CORS headers
│   │   ├── logging.ts     # Request logging
│   │   ├── rate-limit.ts  # In-memory rate limiting
│   │   └── timeout.ts     # Request timeout
│   └── utils/
│       ├── errors.ts      # Error types
│       └── response.ts    # Response helpers
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```
