-- T00 catalog: RLS everywhere, explicit backend policy, only our roles in policies, login tables closed.
DO $$
DECLARE n int; x text;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND (NOT c.relrowsecurity OR c.relforcerowsecurity);
  IF n <> 0 THEN RAISE EXCEPTION 'T00a: % public tables without RLS (or with FORCE)', n; END IF;

  SELECT string_agg(c.relname, ', ') INTO x FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r'
    AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
                    AND p.policyname = 'backend_all' AND p.roles = '{tut_backend}' AND p.cmd = 'ALL');
  IF x IS NOT NULL THEN RAISE EXCEPTION 'T00b: tables without backend_all: %', x; END IF;

  SELECT string_agg(DISTINCT r, ', ') INTO x FROM pg_policies p, unnest(p.roles) r
  WHERE p.schemaname = 'public' AND r NOT IN ('tut_authenticated', 'tut_backend');
  IF x IS NOT NULL THEN RAISE EXCEPTION 'T00c: unexpected roles in policies: %', x; END IF;

  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND policyname <> 'backend_all';
  IF n <> 95 THEN RAISE EXCEPTION 'T00d: expected the 95 policies of the old database, found %', n; END IF;

  IF has_table_privilege('tut_authenticated', 'public.app_user', 'SELECT')
     OR has_table_privilege('tut_authenticated', 'public.user_session', 'SELECT') THEN
    RAISE EXCEPTION 'T00e: tut_authenticated must not read app_user / user_session';
  END IF;

  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace s ON s.oid = f.pronamespace
  WHERE s.nspname IN ('public', 'auth') AND f.prosecdef
    AND (f.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(f.proconfig) c WHERE c LIKE 'search_path=%'));
  IF n <> 0 THEN RAISE EXCEPTION 'T00f: % SECURITY DEFINER functions without fixed search_path', n; END IF;

  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace s ON s.oid = f.pronamespace
  WHERE s.nspname IN ('public', 'auth') AND pg_get_userbyid(f.proowner) <> current_user;
  IF n <> 0 THEN RAISE EXCEPTION 'T00g: % functions not owned by the database owner', n; END IF;
END
$$;
