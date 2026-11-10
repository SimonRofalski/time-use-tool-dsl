-- T01 default deny: the app login has no rights of its own; without a user id nothing is visible.
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.profiles LIMIT 1;
    RAISE EXCEPTION 'T01a: app login without SET ROLE could read profiles';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM set_config('role', 'tut_backend', true);
    RAISE EXCEPTION 'T01b: app login could switch to tut_backend';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF current_setting('TimeZone') <> 'UTC' THEN RAISE EXCEPTION 'T01c: TimeZone is %', current_setting('TimeZone'); END IF;
END
$$;

SELECT set_config('role', 'tut_authenticated', true);
DO $$
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'T01d: auth.uid() not NULL without app.user_id'; END IF;
  IF (SELECT count(*) FROM public.profiles) + (SELECT count(*) FROM public.day)
     + (SELECT count(*) FROM public.time_entry) + (SELECT count(*) FROM public.user_data) <> 0 THEN
    RAISE EXCEPTION 'T01e: rows visible without a logged-in user';
  END IF;
  IF (SELECT count(*) FROM public.activity) = 0 THEN RAISE EXCEPTION 'T01f: lookup tables not readable'; END IF;
END
$$;
