-- Preflight + replacement for the Supabase "auth" schema.
-- Runs as the database owner (tut_<env>_owner) after db/bootstrap/bootstrap.sql.

DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'migrations must run as the owner login, not as superuser %', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tut_authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tut_backend') THEN
    RAISE EXCEPTION 'groups tut_authenticated / tut_backend missing: run db/bootstrap/bootstrap.sql first';
  END IF;
  IF pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())) <> current_user THEN
    RAISE EXCEPTION 'current user % does not own database %', current_user, current_database();
  END IF;
END
$$;

-- auth.uid(): the id of the logged-in user of the current transaction.
-- The app sets it per transaction with set_config('app.user_id', <uuid>, true) (lib/db withUser).
-- nullif: after a transaction-local set_config, the setting reads as '' (not NULL) in later transactions.
CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;

CREATE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Login accounts (replaces auth.users). id = the old auth.users.id, so every foreign key stays valid.
CREATE TABLE public.app_user (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  email text NOT NULL,
  password_hash text,                       -- bcrypt ($2a$/$2b$); NULL for edu-ID-only accounts
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  last_sign_in_at timestamptz
);
CREATE UNIQUE INDEX app_user_email_lower_key ON public.app_user (lower(email));

-- Sessions: only the sha256 of the session token is stored (a DB leak does not leak usable tokens).
CREATE TABLE public.user_session (
  id text NOT NULL PRIMARY KEY,             -- hex sha256 of the token in the cookie
  user_id uuid NOT NULL REFERENCES public.app_user (id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX user_session_user_id_idx ON public.user_session (user_id);
CREATE INDEX user_session_expires_at_idx ON public.user_session (expires_at);

ALTER TABLE public.app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_session ENABLE ROW LEVEL SECURITY;
