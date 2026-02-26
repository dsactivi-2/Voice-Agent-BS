# syntax=docker/dockerfile:1

# ============================================================
# Stage 1: base — shared foundation for all stages
# ============================================================
FROM node:22-alpine AS base

WORKDIR /app

RUN apk add --no-cache dumb-init curl && \
    corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./

# ============================================================
# Stage 2: deps — install ALL dependencies (dev + prod)
# ============================================================
FROM base AS deps

RUN pnpm install --frozen-lockfile

# ============================================================
# Stage 3: dev — development image with hot-reload
# ============================================================
FROM deps AS dev

ENV NODE_ENV=development

COPY . .

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD node -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npx", "tsx", "watch", "src/index.ts"]

# ============================================================
# Stage 4: builder — compile TypeScript to JavaScript
# ============================================================
FROM deps AS builder

ENV NODE_ENV=production

COPY . .

RUN npx tsc

# ============================================================
# Stage 5: production — lean runtime image
# ============================================================
FROM base AS production

ENV NODE_ENV=production
ENV PORT=3001

RUN pnpm install --frozen-lockfile --prod && \
    pnpm store prune

COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD node -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
