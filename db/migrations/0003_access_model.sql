-- Access model for the new roles. Keeps the effective rights of the old Supabase setup 1:1:
--   * tut_authenticated gets the same table rights "authenticated" had in Supabase (all DML on the
--     public tables); the 95 policies from 0001 decide row by row, exactly as before.
--   * tut_backend replaces "service_role" (which bypassed RLS): an explicit backend_all policy per table.
--   * the login tables app_user / user_session are reachable for tut_backend only (password hashes!).
--   * the triggers that hung on auth.users now hang on app_user (same functions).

-- schemas and the auth.uid() shim
GRANT USAGE ON SCHEMA public, auth TO tut_authenticated, tut_backend;
GRANT EXECUTE ON FUNCTION auth.uid() TO tut_authenticated, tut_backend;

-- table rights (Supabase granted ALL on public tables to authenticated; RLS restricts the rows)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tut_authenticated, tut_backend;
REVOKE ALL ON public.app_user, public.user_session FROM tut_authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tut_authenticated, tut_backend;

-- future tables: backend automatically, the app group only by an explicit GRANT in the migration
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tut_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tut_backend;

-- backend_all on every table of the public schema (replaces the implicit BYPASSRLS of service_role)
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('CREATE POLICY backend_all ON public.%I AS PERMISSIVE FOR ALL TO tut_backend USING (true) WITH CHECK (true)', t.relname);
  END LOOP;
END
$$;

-- Privileged profile columns: same columns and same effect as before (silently kept unchanged for app
-- users). Old rule: frozen when current_user IN ('authenticated','anon'). New rule (allow-list):
-- frozen for everybody except superusers (manual fixes), members of tut_backend and the table owner
-- (SECURITY DEFINER functions such as sync_profile_email run as the owner).
CREATE OR REPLACE FUNCTION public.protect_profiles_auth_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $$
BEGIN
  IF NOT (
       (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user)
    OR pg_catalog.pg_has_role(current_user, 'tut_backend', 'MEMBER')
    OR current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = TG_RELID)
  ) THEN
    NEW.auth_provider        := OLD.auth_provider;
    NEW.must_change_password := OLD.must_change_password;
    NEW.switch_edu_id_sub    := OLD.switch_edu_id_sub;
    NEW.role                 := OLD.role;
    NEW.email                := OLD.email;
    NEW.is_active            := OLD.is_active;
  END IF;
  RETURN NEW;
END;
$$;

-- Triggers that were defined on auth.users in Supabase (same functions, same order: alphabetical)
CREATE TRIGGER on_auth_user_created AFTER INSERT ON public.app_user
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER on_auth_user_email_sync AFTER INSERT OR UPDATE OF email ON public.app_user
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_email();
CREATE TRIGGER trg_app_user_updated_at BEFORE UPDATE ON public.app_user
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
