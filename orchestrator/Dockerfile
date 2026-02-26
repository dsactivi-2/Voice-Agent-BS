# syntax=docker/dockerfile:1

# ============================================================
# Stage 1: base — shared foundation for all stages
# ============================================================
FROM node:22-alpine AS base

WORKDIR /app

# Install OS-level dependencies needed at runtime (e.g. for native modules)
RUN apk add --no-cache \
    dumb-init \
    curl

# Copy package manifests first to leverage layer caching
COPY package.json package-lock.json* ./

# ============================================================
# Stage 2: deps — install ALL dependencies (dev + prod)
# ============================================================
FROM base AS deps

RUN npm ci --frozen-lockfile

# ============================================================
# Stage 3: dev — development image with hot-reload
# ============================================================
FROM deps AS dev

ENV NODE_ENV=development

# Install nodemon globally for watch mode fallback
RUN npm install -g nodemon tsx

# Copy source (will be overridden by volume mount in dev compose)
COPY . .

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npx", "tsx", "watch", "src/index.ts"]

# ============================================================
# Stage 4: builder — compile TypeScript to JavaScript
# ============================================================
FROM deps AS builder

ENV NODE_ENV=production

COPY . .

RUN npm run build

# ============================================================
# Stage 5: production — lean runtime image
# ============================================================
FROM base AS production

ENV NODE_ENV=production
ENV PORT=3000

# Install only production dependencies
RUN npm ci --frozen-lockfile --omit=dev && \
    npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Adjust ownership
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
