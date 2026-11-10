-- T03 participant view: own data only. Other participants' days and entries stay hidden, even when
-- submitted (the course comparison is computed on the server, migration 0005).
SELECT set_config('role', 'tut_authenticated', true),
       set_config('app.user_id', '5eed0000-0000-4000-8000-000000000111', true);   -- p1, course 9001
DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles) <> 1 THEN RAISE EXCEPTION 'T03a: participant sees other profiles'; END IF;
  IF (SELECT count(*) FROM public.user_course) <> 1 THEN RAISE EXCEPTION 'T03b: participant sees other enrollments'; END IF;
  IF (SELECT count(*) FROM public.day WHERE profiles_id = auth.uid()) <> 4 THEN RAISE EXCEPTION 'T03c: own days'; END IF;
  -- the others in 9001 have submitted days (a1 1, p2 2, p3 2, p4 1, p5 2); none of them is visible
  IF (SELECT count(*) FROM public.day WHERE profiles_id <> auth.uid()) <> 0 THEN RAISE EXCEPTION 'T03d: days of others'; END IF;
  IF (SELECT count(*) FROM public.day WHERE course_id <> 9001) <> 0 THEN RAISE EXCEPTION 'T03e: days of other courses'; END IF;
  IF (SELECT count(*) FROM public.time_entry) <> 3 * 144 + 36 THEN RAISE EXCEPTION 'T03f: time entries of others'; END IF;
  -- details of the others stay hidden
  IF (SELECT count(*) FROM public.time_entry_social_context) <> 3 * 144 + 36 THEN RAISE EXCEPTION 'T03g: social contexts of others'; END IF;
  IF (SELECT count(*) FROM public.day_questionnaire) <> 3 THEN RAISE EXCEPTION 'T03h: questionnaires of others'; END IF;
  IF (SELECT count(*) FROM public.user_data) <> 1 THEN RAISE EXCEPTION 'T03i: user_data of others'; END IF;
  IF (SELECT count(*) FROM public.course_access_code) <> 0 THEN RAISE EXCEPTION 'T03j: participant reads access codes'; END IF;
  IF (SELECT count(*) FROM public.course) <> 3 THEN RAISE EXCEPTION 'T03k: course list'; END IF;
END
$$;

-- p9 has no course: sees only own profile, no days
SELECT set_config('app.user_id', '5eed0000-0000-4000-8000-000000000119', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles) <> 1 OR (SELECT count(*) FROM public.day) <> 0 THEN
    RAISE EXCEPTION 'T03n: user without course';
  END IF;
END
$$;
