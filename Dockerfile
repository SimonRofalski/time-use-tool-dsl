# Time Use Tool: production image (Next.js standalone server + migration/import scripts).
# The database is NOT part of this image: it is its own container (db/bootstrap/Dockerfile).
# Based on the official Next.js with-docker example; see DEPLOY.md for running it.
#
#   docker build -t time-use-tool .
# Runs in the DSL as two services of one image (deploy/dsl/<test|prod>/compose.yml): tut_migrate
# (node db/scripts/migrate.mjs, then exits) and tut_app (this CMD). Built there by .gitlab-ci.yml.

ARG NODE_IMAGE=node:24.13.1-slim

# --- 1. dependencies (cached as long as package*.json don't change) ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- 2. build ---
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- 3. runtime: only the standalone server, static files and the db scripts ---
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    KEEP_ALIVE_TIMEOUT=100000
# KEEP_ALIVE_TIMEOUT (100 s): longer than reverse-proxy upstream idle timeouts (nginx 60 s, Traefik
# 90 s). The Node default of 5 s lets the proxy reuse connections the server has already closed,
# which causes sporadic 502 errors.

# server.js + the traced node_modules (incl. pg), static assets, public files
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# migrations and the scripts the DSL runs with this image (migrate, data import, first admin); they use the pg
# package from the standalone node_modules. No data files: import files are mounted at run time.
COPY --from=builder /app/db/migrations ./db/migrations
COPY --from=builder /app/db/scripts/env.mjs /app/db/scripts/migrate.mjs /app/db/scripts/import-data.mjs /app/db/scripts/data-tables.mjs /app/db/scripts/set-admin.mjs ./db/scripts/

# the image files belong to root and are read-only for the app user; only the Next.js cache is writable
RUN mkdir -p /app/.next/cache && chown node:node /app/.next/cache
USER node

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
