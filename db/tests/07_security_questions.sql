-- T07 security question answers: own CRUD; reset tables only for the server.

-- INHERITED BEHAVIOUR (kept; a candidate for tightening): admins can read all answer hashes
SELECT set_config('role', 'tut_authenticated', true),
       set_config('app.user_id', '5eed0000-0000-4000-8000-000000000101', true);   -- a1
DO $$
BEGIN
  IF (SELECT count(*) FROM public.user_security_question) <> 20 THEN
    RAISE EXCEPTION 'T07a: old behaviour changed (admin reads all 20 answer hashes), got %', (SELECT count(*) FROM public.user_security_question);
  END IF;
END
$$;

SELECT set_config('app.user_id', '5eed0000-0000-4000-8000-000000000111', true);   -- p1
DO $$
DECLARE n int;
BEGIN
  IF (SELECT count(*) FROM public.user_security_question) <> 2 THEN RAISE EXCEPTION 'T07b: own answers'; END IF;
  UPDATE public.user_security_question SET answer_hash = 'x' WHERE profiles_id = '5eed0000-0000-4000-8000-000000000112';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'T07c: changed answers of another person'; END IF;
  DELETE FROM public.user_security_question WHERE profiles_id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN RAISE EXCEPTION 'T07d: own answers not deletable'; END IF;
  IF (SELECT count(*) FROM public.security_question_reset_challenge) + (SELECT count(*) FROM public.security_question_reset_attempt) <> 0 THEN
    RAISE EXCEPTION 'T07e: reset tables visible to a participant';
  END IF;
  IF (SELECT count(*) FROM public.security_question) = 0 THEN RAISE EXCEPTION 'T07f: active questions readable'; END IF;
END
$$;
