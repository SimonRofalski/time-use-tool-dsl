import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { course, courseAccessCode, orm, userCourse, withService } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { rejectCrossSite } from "@/lib/auth/request";

// POST /api/courses/enroll - course enrollment with access code.
// The access codes live in course_access_code, which only admins can read, and
// users have no INSERT policy on user_course. So the code check and the insert
// both happen here with the service connection, never in the browser.
//
// Returns { error: "<code>" } on failure; EnrollmentModal maps the code to a
// translated message.

type EnrollBody = {
  courseId?: number;
  accessCode?: string;
};

function fail(code: string, status: number) {
  return NextResponse.json({ error: code }, { status });
}

export async function POST(request: NextRequest) {
  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;

  const user = await getSessionUser();
  if (!user) return fail("not_authenticated", 401);

  const body = (await request.json().catch(() => ({}))) as EnrollBody;
  const courseId = Number(body.courseId);
  const accessCode = body.accessCode?.trim() ?? "";
  if (!Number.isInteger(courseId) || !accessCode) {
    return fail("invalid_request", 400);
  }

  let result: "ok" | "invalid_code" | "enroll_failed";
  try {
    result = await withService(async (db) => {
      const q = orm(db);
      const [c] = await q.select({ isLocked: course.isLocked }).from(course).where(eq(course.courseId, courseId));
      // Locked courses aren't offered in the enrollment list either
      if (!c || c.isLocked) return "invalid_code" as const;

      const [codeRow] = await q
        .select({ accessCode: courseAccessCode.accessCode })
        .from(courseAccessCode)
        .where(eq(courseAccessCode.courseId, courseId));
      if (!codeRow || codeRow.accessCode.trim() !== accessCode) return "invalid_code" as const;

      // Already enrolled in this course (e.g. double click / second tab) → success.
      // Enrolled in another course → refused: the app expects exactly one enrollment per person
      // (the layout shows the enrollment gate again otherwise).
      const enrollments = await q
        .select({ courseId: userCourse.courseId })
        .from(userCourse)
        .where(eq(userCourse.profilesId, user.id));
      if (enrollments.some((e) => e.courseId !== courseId)) return "enroll_failed" as const;
      const existing = enrollments.length > 0;
      if (!existing) {
        // Savepoint: a failed insert must not abort the surrounding transaction
        try {
          await db.query("SAVEPOINT enroll_insert");
          await q.insert(userCourse).values({ profilesId: user.id, courseId });
        } catch (insertError) {
          console.error("enroll insert failed", insertError);
          await db.query("ROLLBACK TO SAVEPOINT enroll_insert");
          return "enroll_failed" as const;
        }
      }
      return "ok" as const;
    });
  } catch (error) {
    console.error("enroll failed", error);
    return fail("course_load_failed", 500);
  }

  if (result === "invalid_code") return fail("invalid_code", 400);
  if (result === "enroll_failed") return fail("enroll_failed", 500);
  return NextResponse.json({ success: true });
}
