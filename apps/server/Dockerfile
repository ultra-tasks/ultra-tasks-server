FROM --platform=$BUILDPLATFORM node:24-alpine AS builder
WORKDIR /repo
RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json ./
COPY packages/account-crypto/package.json ./packages/account-crypto/
COPY packages/sync-contract/package.json ./packages/sync-contract/
COPY apps/server/package.json ./apps/server/
COPY apps/account/package.json ./apps/account/
RUN npm ci --ignore-scripts

COPY packages/ ./packages/
COPY apps/ ./apps/
COPY scripts/ ./scripts/
RUN npm exec -w @ultra-tasks/server -- prisma generate
RUN npm run build

FROM node:24-alpine AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
LABEL org.opencontainers.image.source=https://github.com/ultra-tasks/ultra-tasks-server
LABEL org.opencontainers.image.licenses=AGPL-3.0-only
RUN apk add --no-cache openssl libc6-compat wget && \
    addgroup -g 1001 -S nodejs && \
    adduser -S ultra -u 1001 -G nodejs && \
    mkdir -p /repo/apps/server/data && chown -R ultra:nodejs /repo
WORKDIR /repo

# Preserve workspace paths so runtime uses the same lock as development.
COPY --chown=ultra:nodejs package.json package-lock.json LICENSE LICENSING.md SOURCE.md ./
COPY --chown=ultra:nodejs LICENSES/ ./LICENSES/
COPY --from=builder --chown=ultra:nodejs /repo/packages/sync-contract/package.json ./packages/sync-contract/
COPY --from=builder --chown=ultra:nodejs /repo/packages/sync-contract/dist ./packages/sync-contract/dist
COPY --from=builder --chown=ultra:nodejs /repo/packages/account-crypto/package.json ./packages/account-crypto/
COPY --from=builder --chown=ultra:nodejs /repo/packages/account-crypto/dist ./packages/account-crypto/dist
COPY --from=builder --chown=ultra:nodejs /repo/apps/account/package.json ./apps/account/
COPY --from=builder --chown=ultra:nodejs /repo/apps/server/package.json ./apps/server/
COPY --from=builder --chown=ultra:nodejs /repo/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=ultra:nodejs /repo/apps/server/account-public ./apps/server/account-public
COPY --from=builder --chown=ultra:nodejs /repo/apps/server/prisma ./apps/server/prisma
COPY --from=builder --chown=ultra:nodejs /repo/apps/server/scripts ./apps/server/scripts
COPY --from=builder --chown=ultra:nodejs /repo/apps/server/LICENSE /repo/apps/server/LICENSE-MIT-UPSTREAM ./apps/server/
RUN npm ci --ignore-scripts --omit=dev && \
    npm exec -w @ultra-tasks/server -- prisma generate && \
    npm cache clean --force

WORKDIR /repo/apps/server
USER ultra
EXPOSE 1900
ENV NODE_ENV=production
ENV PORT=1900
ENV RUN_MIGRATIONS_ON_STARTUP=false
ENV NODE_OPTIONS=--max-old-space-size=576
ENV ULTRA_REVISION=$VCS_REF
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:${PORT}/health || exit 1
CMD ["sh", "-c", "if [ \"${RUN_MIGRATIONS_ON_STARTUP:-false}\" = \"true\" ]; then sh scripts/migrate-deploy.sh || exit 1; fi; exec node dist/src/index.js"]

# Explicit test target. The default final image remains private-only.
FROM runtime AS legacy-e2e
COPY --from=builder --chown=ultra:nodejs /repo/apps/server/public ./public
COPY --from=builder --chown=ultra:nodejs /repo/apps/server/templates ./templates
CMD ["sh", "-c", "sh scripts/migrate-deploy.sh && exec node dist/src/legacy-index.js"]

FROM runtime AS production
