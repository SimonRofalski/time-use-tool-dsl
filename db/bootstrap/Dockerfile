# Time Use Tool: database image for the DSL stack (one PostgreSQL instance per app).
# Official postgres image + db/bootstrap/bootstrap.sql, which runs once on the first start with an
# empty data volume (stack-init.sh). No data and no secrets in the image.
#
#   docker build -t time-use-tool-db db/bootstrap        (build context: this directory)
#
# Same PostgreSQL version as the local dev container (compose.dev.yml), Debian suite pinned (ICU
# version decides the sort order). A minor update (17.x) is a rebuild + restart; a major update
# (18) needs dump and restore (DEPLOY.md). Comments only on their own lines (Dockerfile syntax).
ARG POSTGRES_IMAGE=postgres:17.11-trixie
FROM ${POSTGRES_IMAGE}

# Plain COPY + RUN chmod (not COPY --chmod, which would also give the new /bootstrap directory mode
# 0644, so the server user could not enter it).
COPY bootstrap.sql /bootstrap/bootstrap.sql
COPY stack-init.sh /docker-entrypoint-initdb.d/10-bootstrap.sh
RUN chmod 0644 /bootstrap/bootstrap.sql && chmod 0755 /docker-entrypoint-initdb.d/10-bootstrap.sh

# Healthy only when the real server accepts TCP connections (during the first-start initialisation
# the entrypoint runs a temporary server on the socket only) AND the last bootstrap step ran (schema
# public owned by tut_<env>_owner). A failed bootstrap stays unhealthy, so the migration job and the
# app never start against a half-initialised database.
HEALTHCHECK --interval=5s --timeout=5s --start-period=120s --retries=12 \
  CMD pg_isready -q -h 127.0.0.1 -p 5432 -U postgres -d postgres \
   && [ "$(psql -qtAX -U postgres -d "tut_${TUT_ENV}" -c "SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'public' AND r.rolname = 'tut_${TUT_ENV}_owner'")" = "1" ]
