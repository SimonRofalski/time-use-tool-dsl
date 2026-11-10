-- T05 writing days and time entries, exactly as the inherited policies allow it.
SELECT set_config('role', 'tut_authenticated', true),
       set_config('app.user_id', '5eed0000-0000-4000-8000-000000000111', true);   -- p1, open course 9001
DO $$
DECLARE own_day int; other_day int; n int;
BEGIN
  SELECT day_id INTO own_day FROM public.day WHERE profiles_id = auth.uid() AND NOT is_complete;
  SELECT day_id INTO other_day FROM public.day WHERE profiles_id = '5eed0000-0000-4000-8000-000000000112' LIMIT 1;

  INSERT INTO public.time_entry (day_id, start_time, end_time, primary_activity_id)
  VALUES (own_day, '06:00', '06:10', (SELECT min(activity_id) FROM public.activity));

  BEGIN
    INSERT INTO public.time_entry (day_id, start_time, end_time, primary_activity_id)
    VALUES (other_day, '06:00', '06:10', (SELECT min(activity_id) FROM public.activity));
    RAISE EXCEPTION 'T05a: entry inserted into another person''s day';
  EXCEPTION WHEN insufficient_privilege THEN NULL;   -- "new row violates row-level security policy"
  END;

  DELETE FROM public.time_entry WHERE day_id = other_day;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'T05b: deleted entries of another person'; END IF;

  -- a full (= submitted) own day stays editable: the app deletes slots and resets the flags
  DELETE FROM public.time_entry WHERE day_id = (SELECT day_id FROM public.day WHERE profiles_id = auth.uid() AND is_complete LIMIT 1)
    AND start_time = '00:00';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'T05c: entry of a submitted own day not deletable'; END IF;
  UPDATE public.day SET is_complete = false, is_submitted = false
  WHERE profiles_id = auth.uid() AND is_complete AND date = '2026-11-02';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'T05d: own submitted day flags not updatable'; END IF;

  BEGIN
    INSERT INTO public.day (profiles_id, course_id, date) VALUES ('5eed0000-0000-4000-8000-000000000112', 9001, '2026-11-06');
    RAISE EXCEPTION 'T05e: day created for another person';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- INHERITED BEHAVIOUR, kept on purpose: a participant of a LOCKED course can still
-- write own days and entries, because the loose own-row policies are ORed with the strict ones.
SELECT set_config('app.user_id', '5eed0000-0000-4000-8000-000000000116', true);   -- p6, locked course 9002
DO $$
DECLARE n int;
BEGIN
  DELETE FROM public.time_entry WHERE day_id IN (SELECT day_id FROM public.day WHERE profiles_id = auth.uid()) AND start_time = '00:00';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'T05f: old behaviour changed (locked course, delete own entry)'; END IF;
  INSERT INTO public.day (profiles_id, course_id, date) VALUES (auth.uid(), 9002, '2026-10-02');
END
$$;
