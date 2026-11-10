# Operations at the DSL

For the Digital Sustainability Lab (DSL): what running the Time Use Tool involves and how to start,
update, back up and fill it with data.

## Overview

Each environment runs one Compose stack with three services:

| Service | Purpose |
| --- | --- |
| `tut_app` | the web app (Next.js, port 3000), reachable through Traefik on the network `web` |
| `tut_migrate` | runs briefly before every start, brings the database schema up to date and exits |
| `tut_db` | the app's PostgreSQL 17, data in the volume `tut_pgdata`. Internal network of the stack only, no published port |

| | Test | Production |
| --- | --- | --- |
| Compose file | `deploy/dsl/test/compose.yml` | `deploy/dsl/prod/compose.yml` |
| Domain | `time-use-tool-test.digisus-lab.ch` | `time-use-tool.digisus-lab.ch` |
| Image tag | `:test` (latest build of `main`) | `:vX.Y.Z` (fixed version) |
| SWITCH edu-ID | `login.test.eduid.ch` | `login.eduid.ch` |
| Data | empty, test accounts only | real data (one-time import) |

## Values to check

The Compose files follow the format of the Infrastructure repository. A few values are assumptions
about your setup and may need adjusting:

| Value | Where (in both files) |
| --- | --- |
| Image path `registry.gitlab.ti.bfh.ch/digital-sustainability-lab/time-use-tool/{db,app}` | `image:` of `tut_db`, `tut_migrate`, `tut_app` |
| Traefik entrypoint `websecure` and certresolver `letsencrypt` | labels of `tut_app` |
| Vault paths `{{ secrets.<env>.tut.… }}` | environment of all three services |
| Domain | `tut_app`: Traefik `Host(...)` rule, `APP_ORIGIN`, `SWITCH_OIDC_REDIRECT_URI` (all three must be the same domain) |

## Images

1. Create the GitLab project as a pull mirror of the GitHub repository. Turn on **"Trigger pipelines
   for mirror updates"** and enable the **container registry**.
2. The pipeline (`.gitlab-ci.yml`) builds the images `app` and `db` with kaniko; it needs no
   privileged runner.
   - A new commit on `main` produces the tag `:test`.
   - A git tag `vX.Y.Z` produces the tag `:vX.Y.Z`.
3. **Release:** the project team sets the git tag. The new version then goes into the production
   Compose file, for all three services.

## SWITCH edu-ID

Login with SWITCH edu-ID needs one OIDC client per environment in the SWITCH Resource Registry:

| | Test | Production |
| --- | --- | --- |
| Federation / issuer | `https://login.test.eduid.ch/` | `https://login.eduid.ch/` |
| Redirect URI | `https://time-use-tool-test.digisus-lab.ch/api/auth/switch/callback` | `https://time-use-tool.digisus-lab.ch/api/auth/switch/callback` |

- Client authentication: `client_secret_basic`.
- Scopes: `openid email profile https://eduid.ch/scope/userinfo.read` (the app reads e-mail and name
  from the UserInfo endpoint).
- Client ID and secret go into the vault as `switch_oidc_client_id` / `switch_oidc_client_secret`.

Until the registration exists, leave both values empty: the app then runs with password login only.

## Secrets

Seven entries per environment:
- `db_superuser_password`
- `db_owner_password`, `db_app_password`, `db_service_password`
- `reset_decoy_secret`
- `switch_oidc_client_id`, `switch_oidc_client_secret`

Rules:
- **Letters and digits only, at least 16 characters**, e.g. `openssl rand -hex 32`. The passwords
  are part of database URLs.
- The database passwords only take effect on the **first** start. To change one later:
  1. `docker compose exec tut_db psql -U postgres -c "ALTER ROLE tut_prod_app PASSWORD '<new>'"`
  2. change the value in the vault;
  3. `docker compose up -d`.

## First start

```bash
docker compose pull
docker compose up -d
docker compose ps -a                  # tut_db and tut_app "healthy", tut_migrate "Exited (0)"
curl -s https://<domain>/api/health   # {"status":"ok"}
```

On the first start `tut_db` creates the database and its logins. If that fails, e.g. because a
password is too short, `docker compose logs tut_db` shows why. Then:
1. `docker compose down`;
2. delete the volume (`docker volume rm time-use-tool-<test|prod>_tut_pgdata`);
3. fix the value and start again.

This applies **only to a new, empty installation.**

**First admin in the test environment:** the person signs up on the page, then:

```bash
docker compose run --rm -e ALLOW_REMOTE_DB=1 tut_migrate node db/scripts/set-admin.mjs person@bfh.ch
```

Further admins can then be appointed in the app itself.

## Updates

- **Install an update:** `docker compose pull && docker compose up -d`. In production, enter the new
  version in the Compose file first. The app only starts after `tut_migrate` succeeded.
- **Before every production update** take a backup: migrations only run forward.
- **Back to the previous version:** enter the old version again. If the update changed the database,
  also restore the backup.

## Backups

Copying the volume of a running PostgreSQL does not give a usable backup. Take a regular dump
instead, e.g. daily via cron:

```bash
docker compose exec -T tut_db pg_dump -U postgres -d tut_prod -Fc > /backup/tut_prod_$(date +%F).dump
```

The dumps contain personal data: store them encrypted and delete them after the agreed retention
period.

**Restore** into an empty volume:

```bash
docker compose down
docker volume rm time-use-tool-prod_tut_pgdata
docker compose up -d --wait tut_db
docker compose exec -T tut_db pg_restore -U postgres -d tut_prod --single-transaction < /backup/<file>.dump
docker compose up -d
```

## Data import (one-time, production)

The project team hands over two files, encrypted: `data_export.sql` and `data_export.manifest.json`.

The import only runs into a freshly started, still empty production database. If test accounts were
created there before, delete the volume first, as described under "First start".

1. Put both files in the same directory on the host, e.g. `/srv/tut-import`, readable (`chmod 644`).
   Then import:
   ```bash
   docker compose run --rm -e ALLOW_REMOTE_DB=1 -v /srv/tut-import:/import:ro \
     tut_migrate node db/scripts/import-data.mjs /import/data_export.sql
   ```
   The import is a single transaction: all or nothing. It checks the checksum and the row counts
   against the manifest and reports `manifest ok` and `imported: {…}` on success.
2. Delete both files on the host.
3. An admin signs in and checks the numbers. Then take the first backup.

## Traefik notes

- `traefik.docker.network=web` is needed because `tut_app` is attached to two networks.
- The app's login rate limits work per client IP, so Traefik must see the real client addresses. If a
  load balancer or NAT sits in front, please tell the project team. Please do not turn on
  `forwardedHeaders.insecure`.
- HSTS comes from a middleware in the labels; otherwise Traefik's defaults are fine.
