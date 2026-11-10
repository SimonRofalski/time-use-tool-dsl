-- Synthetic development data (no real person, no research data). Runs as the owner on tut_local or tut_test only.
--   node db/scripts/seed.mjs        (or npm run db:seed / db:reset)
-- Every seed account has the password "Seed-Passwort-1" and the security answer "seed".
--
-- accounts (uuid 5eed0000-0000-4000-8000-000000000NNN, e-mail seed-<alias>@example.invalid)
--   a1  admin, active, enrolled in 9001 with one own day     a2  admin, INACTIVE
--   p1  9001, 3 submitted days + 1 partial day               p2, p3  9001, 2 submitted days
--   p4  9001, only 1 submitted day (below the comparison threshold of 2 days)
--   p5  9001, excluded from the comparison (is_excluded)     p6  9002 (locked course), 1 day
--   p7, p8  9003 (comparison course with only 2 people)      p9  no course
--   e1  edu-ID account (no password, sub "returning-user-1" like the local mock)
--   m1  must change password (admin-set password)
-- courses: 9001 "SEED Offen" (open, comparison + all questions on), 9002 "SEED Gesperrt" (locked),
--          9003 "SEED Klein" (comparison on, too few participants)

DO $seed$
DECLARE
  pw  constant text := '$2a$10$UE49I1Rx5KLy4MHiLMpV1Ozu8qRdrt/52H6u6MrJ0htBQKwybttXC';
  ans constant text := '5eed5eed5eed5eed5eed5eed5eed5eed:a8aada2d0e294cc4e58739abf0f8964beae7a308ea1dcd97f8ed4180734f7b3606e02dbef8877db39dc2ca385742ba839f1dfb47d78bbc9ca2ef1947c822e24a';
  acts int[]; sats int[]; locs int[]; socs int[]; meds int[]; means int[]; stresses int[]; icts int[];
  r record; d int; s int; blk int; e int; act int; sec int; media boolean;
BEGIN
  IF current_database() NOT IN ('tut_local', 'tut_test') THEN
    RAISE EXCEPTION 'seed only runs on the local dev database (this is %)', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id::text NOT LIKE '5eed0000-%') THEN
    RAISE EXCEPTION 'database contains non-seed profiles: refusing to seed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_user) THEN
    RAISE EXCEPTION 'database is already seeded (run npm run db:reset)';
  END IF;

  SELECT array_agg(activity_id ORDER BY activity_id) INTO acts FROM public.activity;
  SELECT array_agg(satisfaction_id ORDER BY satisfaction_id) INTO sats FROM public.satisfaction;
  SELECT array_agg(location_transport_id ORDER BY location_transport_id) INTO locs FROM public.location_transport;
  SELECT array_agg(social_context_id ORDER BY social_context_id) INTO socs FROM public.social_context;
  SELECT array_agg(digital_media_type_id ORDER BY digital_media_type_id) INTO meds FROM public.digital_media_type;
  SELECT array_agg(meaningfulness_id ORDER BY meaningfulness_id) INTO means FROM public.meaningfulness;
  SELECT array_agg(stressfulness_id ORDER BY stressfulness_id) INTO stresses FROM public.stressfulness;
  SELECT array_agg(ict_attention_id ORDER BY ict_attention_id) INTO icts FROM public.ict_attention;

  -- accounts (the AFTER INSERT triggers create the profiles, as in production)
  CREATE TEMP TABLE seed_acc (alias text PRIMARY KEY, id uuid, role text, active boolean, first text, last text,
                              provider text, sub text, must_change boolean, has_pw boolean) ON COMMIT DROP;
  INSERT INTO seed_acc VALUES
    ('a1', '5eed0000-0000-4000-8000-000000000101', 'admin', true,  'Ada',   'Admin',    'password', NULL, false, true),
    ('a2', '5eed0000-0000-4000-8000-000000000102', 'admin', false, 'Inez',  'Inaktiv',  'password', NULL, false, true),
    ('p1', '5eed0000-0000-4000-8000-000000000111', 'user',  true,  'Paula', 'Eins',     'password', NULL, false, true),
    ('p2', '5eed0000-0000-4000-8000-000000000112', 'user',  true,  'Peter', 'Zwei',     'password', NULL, false, true),
    ('p3', '5eed0000-0000-4000-8000-000000000113', 'user',  true,  'Pia',   'Drei',     'password', NULL, false, true),
    ('p4', '5eed0000-0000-4000-8000-000000000114', 'user',  true,  'Paul',  'Vier',     'password', NULL, false, true),
    ('p5', '5eed0000-0000-4000-8000-000000000115', 'user',  true,  'Petra', 'Fuenf',    'password', NULL, false, true),
    ('p6', '5eed0000-0000-4000-8000-000000000116', 'user',  true,  'Pascal','Sechs',    'password', NULL, false, true),
    ('p7', '5eed0000-0000-4000-8000-000000000117', 'user',  true,  'Priska','Sieben',   'password', NULL, false, true),
    ('p8', '5eed0000-0000-4000-8000-000000000118', 'user',  true,  'Patrick','Acht',    'password', NULL, false, true),
    ('p9', '5eed0000-0000-4000-8000-000000000119', 'user',  true,  'Pirmin','Neun',     'password', NULL, false, true),
    ('e1', '5eed0000-0000-4000-8000-000000000121', 'user',  true,  'Eva',   'Eduid',    'switch_edu_id', 'returning-user-1', false, false),
    ('m1', '5eed0000-0000-4000-8000-000000000122', 'user',  true,  'Moritz','Muss',     'password', NULL, true,  true);

  INSERT INTO public.app_user (id, email, password_hash, created_at, last_sign_in_at)
  SELECT id, CASE alias WHEN 'e1' THEN 'returning.user@example.org' ELSE 'seed-' || alias || '@example.invalid' END,
         CASE WHEN has_pw THEN pw END, timestamptz '2026-10-20 08:00+00', NULL
  FROM seed_acc ORDER BY alias;

  UPDATE public.profiles p
     SET role = a.role, is_active = a.active, first_name = a.first, last_name = a.last,
         auth_provider = a.provider, switch_edu_id_sub = a.sub, must_change_password = a.must_change,
         tutorial_completed_at = CASE WHEN a.alias IN ('m1', 'p9') THEN NULL ELSE timestamptz '2026-10-20 09:00+00' END
    FROM seed_acc a WHERE p.id = a.id;

  -- courses, periods, access codes
  INSERT INTO public.course (course_id, name, start_date, end_date, is_locked, comparison_enabled,
                             ask_extra_ratings, ask_day_questionnaire, ask_ict_attention)
  OVERRIDING SYSTEM VALUE VALUES
    (9001, 'SEED Offen',     '2026-11-02', '2026-11-08', false, true,  true,  true,  true),
    (9002, 'SEED Gesperrt',  '2026-10-01', '2026-10-07', true,  false, false, false, false),
    (9003, 'SEED Klein',     '2026-10-12', '2026-10-18', false, true,  false, false, false);
  INSERT INTO public.course_period (course_period_id, course_id, start_date, end_date, sort_order) VALUES
    (9001, 9001, '2026-11-02', '2026-11-08', 0),
    (9002, 9002, '2026-10-01', '2026-10-07', 0),
    (9003, 9003, '2026-10-12', '2026-10-18', 0);
  INSERT INTO public.course_access_code (course_id, access_code) VALUES
    (9001, 'SEED-OFFEN'), (9002, 'SEED-GESPERRT'), (9003, 'SEED-KLEIN');

  INSERT INTO public.user_course (user_course_id, profiles_id, course_id, is_excluded, alias)
  SELECT ('5eed0000-0000-4000-9000-000000000' || substr(a.id::text, 34, 3))::uuid, a.id, c.course_id,
         a.alias = 'p5', NULL
  FROM seed_acc a
  JOIN (VALUES ('a1', 9001), ('p1', 9001), ('p2', 9001), ('p3', 9001), ('p4', 9001), ('p5', 9001),
               ('p6', 9002), ('p7', 9003), ('p8', 9003)) AS c(alias, course_id) ON c.alias = a.alias;

  -- days: {alias, course, date, full?}
  CREATE TEMP TABLE seed_day (alias text, course_id int, date date, full_day boolean) ON COMMIT DROP;
  INSERT INTO seed_day VALUES
    ('a1', 9001, '2026-11-02', true),
    ('p1', 9001, '2026-11-02', true), ('p1', 9001, '2026-11-03', true), ('p1', 9001, '2026-11-04', true),
    ('p1', 9001, '2026-11-05', false),
    ('p2', 9001, '2026-11-02', true), ('p2', 9001, '2026-11-03', true),
    ('p3', 9001, '2026-11-02', true), ('p3', 9001, '2026-11-03', true),
    ('p4', 9001, '2026-11-02', true),
    ('p5', 9001, '2026-11-02', true), ('p5', 9001, '2026-11-03', true),
    ('p6', 9002, '2026-10-01', true),
    ('p7', 9003, '2026-10-12', true), ('p7', 9003, '2026-10-13', true),
    ('p8', 9003, '2026-10-12', true), ('p8', 9003, '2026-10-13', true);

  FOR r IN
    SELECT sd.*, a.id AS profiles_id FROM seed_day sd JOIN seed_acc a ON a.alias = sd.alias
    ORDER BY sd.alias, sd.date
  LOOP
    -- the app marks a day submitted exactly when it is complete (144 slots)
    INSERT INTO public.day (profiles_id, course_id, date, is_submitted, is_complete, is_valid, created_at)
    VALUES (r.profiles_id, r.course_id, r.date, r.full_day, r.full_day, true, r.date::timestamptz + interval '20 hours')
    RETURNING day_id INTO d;

    FOR s IN 0 .. (CASE WHEN r.full_day THEN 143 ELSE 35 END) LOOP
      blk := s / 6;                                                   -- one activity per hour
      act := acts[1 + ((d * 7 + blk * 13) % array_length(acts, 1))];
      sec := CASE WHEN blk % 4 = 1 THEN acts[1 + ((d * 5 + blk * 11 + 1) % array_length(acts, 1))] END;
      IF sec = act THEN sec := NULL; END IF;
      media := blk % 3 = 0;
      INSERT INTO public.time_entry (day_id, start_time, end_time, primary_activity_id, secondary_activity_id,
                                     satisfaction_id, location_transport_id, digital_media_used, is_valid,
                                     meaningfulness_id, stressfulness_id, ict_attention_id, created_at, updated_at)
      VALUES (d, time '00:00' + s * interval '10 minutes', time '00:00' + (s + 1) * interval '10 minutes',
              act, sec,
              sats[1 + ((blk + d) % array_length(sats, 1))],
              locs[1 + ((blk * 3 + d) % array_length(locs, 1))],
              media, true,
              CASE WHEN r.course_id = 9001 THEN means[1 + (blk % array_length(means, 1))] END,
              CASE WHEN r.course_id = 9001 THEN stresses[1 + ((blk + 1) % array_length(stresses, 1))] END,
              CASE WHEN r.course_id = 9001 AND media AND sec IS NOT NULL THEN icts[1 + (blk % array_length(icts, 1))] END,
              r.date::timestamptz + interval '21 hours', r.date::timestamptz + interval '21 hours')
      RETURNING entry_id INTO e;
      INSERT INTO public.time_entry_social_context (entry_id, social_context_id)
      VALUES (e, socs[1 + ((blk + d) % array_length(socs, 1))]);
      IF media THEN
        INSERT INTO public.time_entry_digital_media_type (entry_id, digital_media_type_id)
        VALUES (e, meds[1 + ((blk + d) % array_length(meds, 1))]);
      END IF;
    END LOOP;

    -- day questionnaire for submitted days of the course that asks it (trigger sets the day flag)
    IF r.full_day AND r.course_id = 9001 THEN
      INSERT INTO public.day_questionnaire (day_id, diary_fill_timing_id, most_pleasant_activity_id,
                                            most_unpleasant_activity_id, most_stressful_activity_id,
                                            day_appreciation_id, is_unusual_day, day_type_context_id, trip_type_id)
      VALUES (d, (SELECT min(diary_fill_timing_id) FROM public.diary_fill_timing), acts[1], acts[2], acts[3],
              (SELECT min(day_appreciation_id) FROM public.day_appreciation), false,
              (SELECT min(day_type_context_id) FROM public.day_type_context), (SELECT min(trip_type_id) FROM public.trip_type));
    END IF;
  END LOOP;

  -- socio-demographic data and security questions for two participants
  INSERT INTO public.user_data (profiles_id, gender_id, age, marital_status_id, partner_in_household,
                                children_in_household_id, education_level_id, occupational_status_id, weekly_work_hours,
                                main_workplace_id, health_status_id, nationality_id, region_id, urbanity_id)
  SELECT a.id, (SELECT min(gender_id) FROM public.gender), 24, (SELECT min(marital_status_id) FROM public.marital_status), false,
         (SELECT min(children_in_household_id) FROM public.children_in_household), (SELECT min(education_level_id) FROM public.education_level),
         (SELECT min(occupational_status_id) FROM public.occupational_status), 20.5, (SELECT min(main_workplace_id) FROM public.main_workplace),
         (SELECT min(health_status_id) FROM public.health_status), (SELECT min(nationality_id) FROM public.nationality),
         (SELECT min(region_id) FROM public.region), (SELECT min(urbanity_id) FROM public.urbanity)
  FROM seed_acc a WHERE a.alias IN ('p1', 'p2');
  INSERT INTO public.user_employment_status (user_data_id, employment_status_id)
  SELECT ud.user_data_id, (SELECT min(employment_status_id) FROM public.employment_status)
  FROM public.user_data ud;

  INSERT INTO public.user_security_question (profiles_id, security_question_id, answer_hash)
  SELECT a.id, q.security_question_id, ans
  FROM seed_acc a
  CROSS JOIN LATERAL (SELECT security_question_id FROM public.security_question
                      WHERE is_active ORDER BY sort_order, security_question_id LIMIT 2) q  -- the app uses exactly 2
  WHERE a.alias NOT IN ('e1', 'm1', 'p9');

  RAISE NOTICE 'seeded: % accounts, % days, % time entries',
    (SELECT count(*) FROM public.app_user), (SELECT count(*) FROM public.day), (SELECT count(*) FROM public.time_entry);
END
$seed$;
