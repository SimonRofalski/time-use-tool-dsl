-- T02 ethics rule (inherited RLS): admins see all profiles, enrollments and day flags,
-- but only their OWN time entries, social contexts, media types and day questionnaires.
SELECT set_config('role', 'tut_authenticated', true),
       set_config('app.user_id', '5eed0000-0000-4000-8000-000000000101', true);   -- a1, admin
DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles) <> 13 THEN RAISE EXCEPTION 'T02a: admin should see all 13 profiles'; END IF;
  IF (SELECT count(*) FROM public.day) <> 17 THEN RAISE EXCEPTION 'T02b: admin should see all 17 days'; END IF;
  IF (SELECT count(*) FROM public.user_course) <> 9 THEN RAISE EXCEPTION 'T02c: admin should see all 9 enrollments'; END IF;
  IF (SELECT count(*) FROM public.time_entry te
      WHERE NOT EXISTS (SELECT 1 FROM public.day d WHERE d.day_id = te.day_id AND d.profiles_id = auth.uid())) <> 0 THEN
    RAISE EXCEPTION 'T02d: admin sees time entries of others';
  END IF;
  IF (SELECT count(*) FROM public.time_entry) <> 144 THEN RAISE EXCEPTION 'T02e: admin should see own 144 entries'; END IF;
  IF (SELECT count(*) FROM public.time_entry_social_context) <> 144 THEN RAISE EXCEPTION 'T02f: social contexts'; END IF;
  IF (SELECT count(*) FROM public.time_entry_digital_media_type) <> 48 THEN RAISE EXCEPTION 'T02g: media types'; END IF;
  IF (SELECT count(*) FROM public.day_questionnaire) <> 1 THEN RAISE EXCEPTION 'T02h: day questionnaires'; END IF;
  IF (SELECT count(*) FROM public.course_access_code) <> 3 THEN RAISE EXCEPTION 'T02i: admin reads access codes'; END IF;
  IF (SELECT count(*) FROM public.user_data) <> 2 THEN RAISE EXCEPTION 'T02j: admin reads user_data (old behaviour)'; END IF;
END
$$;

-- inactive admin a2: is_admin() ignores is_active (inherited behaviour), so a2 still has admin reads
SELECT set_config('app.user_id', '5eed0000-0000-4000-8000-000000000102', true);
DO $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'T02k: is_admin() must stay true for an inactive admin (old behaviour)'; END IF;
  IF (SELECT count(*) FROM public.profiles) <> 13 THEN RAISE EXCEPTION 'T02l: inactive admin profile reads changed'; END IF;
END
$$;
