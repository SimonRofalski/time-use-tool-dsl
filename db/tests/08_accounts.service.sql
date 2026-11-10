-- T08 server-side account handling (service login): the account triggers work on app_user,
-- the service may set the privileged profile columns, deleting an account cascades.
DO $$
DECLARE uid uuid := '5eed0000-0000-4000-8000-000000000199';
BEGIN
  INSERT INTO public.app_user (id, email, password_hash) VALUES (uid, 'neu@example.invalid', NULL);
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = uid AND role = 'user' AND is_active
                 AND email = 'neu@example.invalid' AND locale = 'de' AND auth_provider = 'password') THEN
    RAISE EXCEPTION 'T08a: profile not created like handle_new_user + sync_profile_email did';
  END IF;
  UPDATE public.app_user SET email = 'neu2@example.invalid' WHERE id = uid;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = uid AND email = 'neu2@example.invalid') THEN
    RAISE EXCEPTION 'T08b: e-mail change not synced to profiles';
  END IF;
  UPDATE public.profiles SET must_change_password = true, role = 'admin' WHERE id = uid;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = uid AND must_change_password AND role = 'admin') THEN
    RAISE EXCEPTION 'T08c: service cannot set privileged columns';
  END IF;
  BEGIN
    INSERT INTO public.app_user (email) VALUES ('NEU2@example.invalid');
    RAISE EXCEPTION 'T08d: e-mail uniqueness is case-sensitive';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- cascade: deleting p3 removes the profile and all research data of p3
  DELETE FROM public.app_user WHERE id = '5eed0000-0000-4000-8000-000000000113';
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = '5eed0000-0000-4000-8000-000000000113')
     OR EXISTS (SELECT 1 FROM public.day WHERE profiles_id = '5eed0000-0000-4000-8000-000000000113')
     OR EXISTS (SELECT 1 FROM public.user_course WHERE profiles_id = '5eed0000-0000-4000-8000-000000000113') THEN
    RAISE EXCEPTION 'T08e: account deletion did not cascade';
  END IF;

  -- day questionnaire trigger keeps the day flag in sync
  DELETE FROM public.day_questionnaire WHERE day_id = (SELECT min(day_id) FROM public.day WHERE day_questionnaire_completed);
  IF (SELECT count(*) FROM public.day WHERE day_questionnaire_completed) <> (SELECT count(*) FROM public.day_questionnaire) THEN
    RAISE EXCEPTION 'T08f: day_questionnaire_completed out of sync';
  END IF;
END
$$;
