-- T04 profile updates: own names editable; privileged columns are silently kept (trigger); others untouched.
SELECT set_config('role', 'tut_authenticated', true),
       set_config('app.user_id', '5eed0000-0000-4000-8000-000000000111', true);   -- p1
DO $$
DECLARE n int;
BEGIN
  UPDATE public.profiles SET first_name = 'Neu', role = 'admin', is_active = false, must_change_password = true,
                             email = 'x@example.invalid', auth_provider = 'switch_edu_id', switch_edu_id_sub = 'x'
  WHERE id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'T04a: own profile not updatable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND first_name = 'Neu' AND role = 'user'
                 AND is_active AND NOT must_change_password AND email = 'seed-p1@example.invalid'
                 AND auth_provider = 'password' AND switch_edu_id_sub IS NULL) THEN
    RAISE EXCEPTION 'T04b: privileged columns were changed by the user';
  END IF;
  UPDATE public.profiles SET first_name = 'Hack' WHERE id = '5eed0000-0000-4000-8000-000000000112';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'T04c: participant updated another profile'; END IF;
END
$$;

-- admin may edit other profiles (policy "Admins can update all profiles"), but not the privileged columns
SELECT set_config('app.user_id', '5eed0000-0000-4000-8000-000000000101', true);   -- a1
DO $$
DECLARE n int;
BEGIN
  UPDATE public.profiles SET last_name = 'Admin-Edit', role = 'admin' WHERE id = '5eed0000-0000-4000-8000-000000000112';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'T04d: admin cannot update another profile'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = '5eed0000-0000-4000-8000-000000000112'
                 AND last_name = 'Admin-Edit' AND role = 'user') THEN
    RAISE EXCEPTION 'T04e: role changed through the app role';
  END IF;
END
$$;
