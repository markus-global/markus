FROM node:22-slim AS base
RUN npm install -g pnpm@latest
WORKDIR /app

# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/comms/package.json packages/comms/
COPY packages/org-manager/package.json packages/org-manager/
COPY packages/storage/package.json packages/storage/
COPY packages/gui/package.json packages/gui/
COPY packages/a2a/package.json packages/a2a/
COPY packages/cli/package.json packages/cli/
COPY packages/web-ui/package.json packages/web-ui/
RUN pnpm install --frozen-lockfile || pnpm install

# ── Stage 2: Build all packages ─────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY templates/ templates/
RUN pnpm build && pnpm --filter @markus/web-ui build

# ── Stage 3: Production runtime ─────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json /app/packages/shared/dist ./packages/shared/
COPY --from=build /app/packages/core/package.json /app/packages/core/dist ./packages/core/
COPY --from=build /app/packages/comms/package.json /app/packages/comms/dist ./packages/comms/
COPY --from=build /app/packages/org-manager/package.json /app/packages/org-manager/dist ./packages/org-manager/
COPY --from=build /app/packages/storage/package.json /app/packages/storage/dist ./packages/storage/
COPY --from=build /app/packages/gui/package.json /app/packages/gui/dist ./packages/gui/
COPY --from=build /app/packages/a2a/package.json /app/packages/a2a/dist ./packages/a2a/
COPY --from=build /app/packages/cli/package.json /app/packages/cli/dist ./packages/cli/
COPY --from=build /app/packages/web-ui ./packages/web-ui
COPY --from=build /app/templates ./templates

ENV NODE_ENV=production
EXPOSE 8056 8058 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8056/api/health').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"

CMD ["node", "packages/cli/markus.mjs", "start"]
