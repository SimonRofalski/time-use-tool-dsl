-- T06 enrollment only via the server (service), course administration only for admins.
SELECT set_config('role', 'tut_authenticated', true),
       set_config('app.user_id', '5eed0000-0000-4000-8000-000000000119', true);   -- p9, no course
DO $$
DECLARE n int;
BEGIN
  BEGIN
    INSERT INTO public.user_course (profiles_id, course_id) VALUES (auth.uid(), 9001);
    RAISE EXCEPTION 'T06a: participant enrolled without the server';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.course SET name = 'x' WHERE course_id = 9001;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'T06b: participant updated a course'; END IF;
END
$$;

SELECT set_config('app.user_id', '5eed0000-0000-4000-8000-000000000101', true);   -- a1
DO $$
DECLARE n int;
BEGIN
  UPDATE public.user_course SET is_excluded = true, alias = 'A' WHERE course_id = 9001;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 6 THEN RAISE EXCEPTION 'T06c: admin updates enrollments (expected 6, got %)', n; END IF;
  INSERT INTO public.course (name, start_date, end_date) VALUES ('Admin-Kurs', '2026-12-01', '2026-12-07');
  INSERT INTO public.course_access_code (course_id, access_code)
  VALUES ((SELECT course_id FROM public.course WHERE name = 'Admin-Kurs'), 'CODE');
  UPDATE public.course SET is_locked = true WHERE course_id = 9001;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'T06d: admin locks a course'; END IF;
END
$$;
