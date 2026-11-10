-- Removes read rules inherited from the predecessor version that the app no longer needs.
--
-- 1. Participants could read the submitted days and time entries of everybody in their course. The
--    old browser-side course comparison needed that; the comparison is now computed on the server
--    (lib/data/statistiken.ts, withService), and every page reads only the viewer's own days.
--    Without these rules a participant can no longer load another person's entries by day id.
-- 2. Admins could read and update every person's security-answer hashes. No admin feature uses them;
--    the password reset reads them on the server (tut_backend).
-- 3. course_excluded_profile_ids(): only the old browser-side comparison called it.
DROP POLICY "Users can view submitted days in their own course" ON public.day;
DROP POLICY "Users can view time entries for submitted days in their course" ON public.time_entry;
DROP POLICY "Admins can read all user security questions" ON public.user_security_question;
DROP POLICY "Admins can update all user security questions" ON public.user_security_question;
DROP FUNCTION public.course_excluded_profile_ids(integer);
