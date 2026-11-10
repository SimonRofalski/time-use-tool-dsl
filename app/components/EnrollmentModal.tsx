"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { auth } from "@/lib/auth/client";
import { listOpenCourses } from "@/app/components/onboarding-actions";
import { useRouter } from "next/navigation";

// Mandatory course enrollment on first login (rendered by the protected layout while the user has no
// course): pick an open course and enter its access code. The code is checked by /api/courses/enroll.

type AvailableCourse = {
  course_id: number;
  name: string;
  start_date: string;
  end_date: string;
};

function formatShortDate(dateString: string, locale: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString(locale === "en" ? "en-US" : "de-DE", {
    timeZone: "UTC", // "YYYY-MM-DD" parses as UTC midnight; formatting in UTC keeps the day
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default function EnrollmentModal({
  onEnrolled,
}: {
  onEnrolled: () => void;
}) {
  const t = useTranslations("enrollmentModal");
  const locale = useLocale();
  const router = useRouter();

  async function handleBackToLogin() {
    await auth.signOut();
    router.push("/");
  }

  const [availableCourses, setAvailableCourses] = useState<AvailableCourse[]>(
    [],
  );
  const [selectedCourseId, setSelectedCourseId] = useState<number | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [isLoadingCourses, setIsLoadingCourses] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    loadAvailableCourses();
  }, []);

  async function loadAvailableCourses() {
    setIsLoadingCourses(true);

    const { data, error } = await listOpenCourses();

    if (error) {
      setErrorMessage(t("loadCoursesError"));
    } else {
      const courses = (data ?? []) as AvailableCourse[];
      setAvailableCourses(courses);
      if (courses.length > 0) {
        setSelectedCourseId(courses[0].course_id);
      }
    }

    setIsLoadingCourses(false);
  }

  async function handleEnroll(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage("");

    if (!selectedCourseId) {
      setErrorMessage(t("selectCourseError"));
      setIsSubmitting(false);
      return;
    }

    if (!accessCode.trim()) {
      setErrorMessage(t("enterAccessCodeError"));
      setIsSubmitting(false);
      return;
    }

    // The access code is checked server-side; the codes are never readable
    // from the browser (see app/api/courses/enroll/route.ts)
    let errorCode: string | null = null;
    try {
      const response = await fetch("/api/courses/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: selectedCourseId,
          accessCode: accessCode.trim(),
        }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        errorCode = result.error ?? "enroll_failed";
      }
    } catch {
      errorCode = "enroll_failed";
    }

    // Map the route's error codes to translated messages
    if (errorCode) {
      setErrorMessage(
        errorCode === "invalid_code"
          ? t("invalidAccessCodeError")
          : errorCode === "course_load_failed"
            ? t("courseLoadRetryError")
            : t("enrollFailedError"),
      );
      setIsSubmitting(false);
      return;
    }

    onEnrolled();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-6 shadow-xl">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            {t("title")}
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("description")}</p>
        </div>

        {isLoadingCourses && (
          <p className="text-center text-sm text-slate-500 dark:text-slate-400">{t("loading")}</p>
        )}

        {!isLoadingCourses && availableCourses.length === 0 && (
          <p className="text-center text-sm text-slate-500 dark:text-slate-400">
            {t("noCoursesAvailable")}
          </p>
        )}

        {!isLoadingCourses && availableCourses.length > 0 && (
          <form onSubmit={handleEnroll} className="space-y-4">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              {t("selectCourseLabel")}
              <select
                value={selectedCourseId ?? ""}
                onChange={(e) => {
                  setSelectedCourseId(Number(e.target.value));
                  setErrorMessage("");
                }}
                className="mt-1.5 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {availableCourses.map((course) => (
                  <option key={course.course_id} value={course.course_id}>
                    {course.name} ({formatShortDate(course.start_date, locale)} -{" "}
                    {formatShortDate(course.end_date, locale)})
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              {t("accessCodeLabel")}
              <input
                type="text"
                value={accessCode}
                onChange={(e) => {
                  setAccessCode(e.target.value);
                  setErrorMessage("");
                }}
                placeholder={t("accessCodePlaceholder")}
                className="mt-1.5 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>

            {errorMessage && (
              <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {isSubmitting ? t("submittingButton") : t("submitButton")}
            </button>
          </form>
        )}

        <button
          type="button"
          onClick={handleBackToLogin}
          className="mt-4 w-full rounded-md border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 transition hover:border-slate-400 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-slate-800 dark:hover:text-slate-100"
        >
          {t("backToLoginButton")}
        </button>
      </div>
    </div>
  );
}
