FROM node:20-slim AS base
RUN npm install -g pnpm@latest

WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/compute/package.json packages/compute/
COPY packages/comms/package.json packages/comms/
COPY packages/org-manager/package.json packages/org-manager/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY templates/ templates/
RUN pnpm build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json /app/packages/shared/dist ./packages/shared/
COPY --from=build /app/packages/core/package.json /app/packages/core/dist ./packages/core/
COPY --from=build /app/packages/compute/package.json /app/packages/compute/dist ./packages/compute/
COPY --from=build /app/packages/comms/package.json /app/packages/comms/dist ./packages/comms/
COPY --from=build /app/packages/org-manager/package.json /app/packages/org-manager/dist ./packages/org-manager/
COPY --from=build /app/packages/cli/package.json /app/packages/cli/dist ./packages/cli/
COPY --from=build /app/packages/web-ui ./packages/web-ui
COPY --from=build /app/templates ./templates

ENV NODE_ENV=production
EXPOSE 3001 3002 9000

CMD ["node", "packages/cli/dist/index.js", "start"]
