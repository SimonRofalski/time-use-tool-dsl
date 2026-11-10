#!/bin/sh
# Local only: runs bootstrap.sql once when the dev container starts with an empty data volume,
# like the DSL's database image does with stack-init.sh (as superuser, env=local).
set -eu
export TUT_OWNER_PASSWORD="${TUT_LOCAL_OWNER_PASSWORD:-tut_local_owner_pw}"
export TUT_APP_PASSWORD="${TUT_LOCAL_APP_PASSWORD:-tut_local_app_pw}"
export TUT_SERVICE_PASSWORD="${TUT_LOCAL_SERVICE_PASSWORD:-tut_local_service_pw}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v env=local -f /bootstrap/bootstrap.sql
