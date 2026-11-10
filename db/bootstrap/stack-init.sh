#!/bin/sh
# Database image for the DSL stack (db/bootstrap/Dockerfile): runs bootstrap.sql ONCE, when the
# container starts with an empty data volume (official postgres entrypoint, /docker-entrypoint-initdb.d),
# as the superuser over the local socket. Environment name and the three login passwords come from the
# container environment (compose: TUT_ENV, TUT_OWNER_PASSWORD, TUT_APP_PASSWORD, TUT_SERVICE_PASSWORD).
#
# If this fails, the data directory is already initialised and the entrypoint will NOT run it again:
# remove the (still empty) volume, fix the values and start again (DEPLOY.md).
set -eu

case "${TUT_ENV:-}" in
  prod|stage) ;;
  *) echo "stack-init: TUT_ENV must be prod or stage (test and local are reserved for development)" >&2; exit 1 ;;
esac
for var in TUT_OWNER_PASSWORD TUT_APP_PASSWORD TUT_SERVICE_PASSWORD; do
  eval "value=\${$var:-}"
  # letters and digits only: the passwords also end up in the apps' database URLs
  if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9]{16,}$'; then
    echo "stack-init: $var must be at least 16 letters/digits (e.g. openssl rand -hex 32)" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v env="$TUT_ENV" -f /bootstrap/bootstrap.sql
