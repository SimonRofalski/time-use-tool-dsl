-- Time Use Tool: one-time database setup per environment.
-- Run ONCE per environment as a superuser (DSL: by the database image on its first start, stack-init.sh;
-- locally: by local-init.sh). By hand:
--
--   TUT_OWNER_PASSWORD=... TUT_APP_PASSWORD=... TUT_SERVICE_PASSWORD=... \
--   psql -v ON_ERROR_STOP=1 -v env=prod -d postgres -f bootstrap.sql
--
-- Needs psql >= 15 (\getenv). The passwords may be plain text or, preferably, SCRAM verifiers
-- ('SCRAM-SHA-256$4096:...'), so no plain-text password ends up in server logs.
--
-- What it creates (role names are cluster-wide, hence the tut_ prefix):
--   tut_authenticated   NOLOGIN group  - the app switches to it per request (SET LOCAL ROLE); RLS applies
--   tut_backend         NOLOGIN group  - server-side jobs (login, exports, admin account handling)
--   tut_<env>_owner     LOGIN          - owns the database and every object; used ONLY by the migration job
--   tut_<env>_app       LOGIN NOINHERIT- the web app; has no rights of its own, only SET ROLE tut_authenticated
--   tut_<env>_service   LOGIN          - the web app's server-side service connection, member of tut_backend
--   database tut_<env>  owned by the owner login; nobody else may connect except app and service
-- No role gets SUPERUSER, CREATEROLE, CREATEDB or BYPASSRLS.

\set ON_ERROR_STOP on
\if :{?env}
\else
  \echo 'missing -v env=<name> (e.g. prod, stage, local)'
  \quit
\endif

\getenv owner_pw   TUT_OWNER_PASSWORD
\getenv app_pw     TUT_APP_PASSWORD
\getenv service_pw TUT_SERVICE_PASSWORD
\if :{?owner_pw}
\else
  \echo 'TUT_OWNER_PASSWORD is not set'
  \quit
\endif
\if :{?app_pw}
\else
  \echo 'TUT_APP_PASSWORD is not set'
  \quit
\endif
\if :{?service_pw}
\else
  \echo 'TUT_SERVICE_PASSWORD is not set'
  \quit
\endif

-- role and database names: tut_<env>_owner / _app / _service, database tut_<env>
SELECT 'tut_' || :'env' || '_owner'   AS owner,
       'tut_' || :'env' || '_app'     AS app,
       'tut_' || :'env' || '_service' AS service,
       'tut_' || :'env'               AS dbname \gset

-- shared groups (idempotent, they may already exist from another environment on the same server)
SELECT 'CREATE ROLE tut_authenticated NOLOGIN NOINHERIT'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tut_authenticated') \gexec
SELECT 'CREATE ROLE tut_backend NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tut_backend') \gexec

-- logins without special attributes
CREATE ROLE :"owner"   LOGIN INHERIT   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE :"app"     LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40 PASSWORD :'app_pw';
CREATE ROLE :"service" LOGIN INHERIT   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 15 PASSWORD :'service_pw';
GRANT tut_authenticated TO :"app";      -- NOINHERIT: no rights until SET ROLE tut_authenticated
GRANT tut_backend       TO :"service";  -- INHERIT: always acts with the backend rights

-- ICU en-US collation, the same as the original database, so the sort order of existing data stays identical
CREATE DATABASE :"dbname" OWNER :"owner" TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'en_US.UTF-8';
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;            -- no CONNECT/TEMP for other roles on the server
GRANT CONNECT ON DATABASE :"dbname" TO :"app", :"service";
ALTER DATABASE :"dbname" SET timezone TO 'UTC';
ALTER ROLE :"app"     IN DATABASE :"dbname" SET statement_timeout = '30s';
ALTER ROLE :"app"     IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE :"service" IN DATABASE :"dbname" SET statement_timeout = '180s';   -- research exports

\connect :"dbname"
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"owner";

\echo 'bootstrap done for' :dbname
