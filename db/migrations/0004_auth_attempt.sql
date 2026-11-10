-- Attempt log for rate limits that GoTrue (Supabase Auth) used to enforce: sign-in, sign-up,
-- password change. Keys are hashed (no e-mail or IP in clear text). Only the server (tut_backend)
-- can read or write it.
CREATE TABLE public.auth_attempt (
  attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,                 -- e.g. 'signin', 'signup', 'change_password'
  key_hash text NOT NULL,             -- sha256 of the normalized e-mail / ip / user id
  attempted_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX auth_attempt_kind_key_time_idx ON public.auth_attempt (kind, key_hash, attempted_at);

ALTER TABLE public.auth_attempt ENABLE ROW LEVEL SECURITY;
CREATE POLICY backend_all ON public.auth_attempt AS PERMISSIVE FOR ALL TO tut_backend USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_attempt TO tut_backend;
GRANT USAGE, SELECT ON SEQUENCE public.auth_attempt_attempt_id_seq TO tut_backend;
