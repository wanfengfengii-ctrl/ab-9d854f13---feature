# syntax=docker/dockerfile:1

# ------------------------------------------------------------------ base
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=development

# Full dependency set (typescript + vitest are devDependencies; the runtime
# itself has zero third-party dependencies).
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ------------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------- verify
# One-shot verification image: full toolchain, sources and scripts.
FROM deps AS verify
ENV NODE_ENV=development
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
RUN chmod +x scripts/verify.sh scripts/wait-for-health.mjs scripts/smoke.mjs scripts/healthcheck.mjs
CMD ["sh", "scripts/verify.sh"]

# ----------------------------------------------------------------- runtime
# Slim production image: compiled output only (no external runtime deps).
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3000
ENV API_HOST=0.0.0.0
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY scripts/healthcheck.mjs ./scripts/healthcheck.mjs
RUN chmod +x scripts/healthcheck.mjs
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "dist/api/server.js"]
