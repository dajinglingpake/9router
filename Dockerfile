# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
  if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/tmp/9router-build-data
RUN --mount=type=cache,target=/app/.next/cache,sharing=locked \
  npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

# Install runtime packages before copying application files so this layer stays cached.
RUN apt-get update && apt-get install -y --no-install-recommends gosu ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec gosu node "$@"\n' > /entrypoint.sh \
  && chmod +x /entrypoint.sh

COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/custom-server.js ./custom-server.js
COPY --chown=node:node --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --chown=node:node --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --chown=node:node --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --chown=node:node --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --chown=node:node --from=builder /app/node_modules/sql.js ./node_modules/sql.js

RUN install -d -o node -g node /app/data /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
