"use server";
// Server Actions of the admin tabs (Kursuebersicht, Nutzeruebersicht). Each one takes the user from the
// session and refuses non-admins; the logic lives in lib/data/admin.ts and runs as that admin (withUser),
// so RLS still applies. Role changes go through the service connection there.
import { eq } from "drizzle-orm";
import { orm, profiles, withUser } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import * as admin from "@/lib/data/admin";

/** Id of the logged-in user if they are an admin, otherwise null (role read from profiles, not the session). */
async function adminId(): Promise<string | null> {
  const user = await getSessionUser();
  if (!user) return null;
  const rows = await withUser(user.id, (db) =>
    orm(db).select({ role: profiles.role }).from(profiles).where(eq(profiles.id, user.id)),
  );
  return rows[0]?.role === "admin" ? user.id : null;
}

/** Data of the Nutzeruebersicht tab; null when not allowed or on error. */
export async function loadUserOverviewData() {
  const id = await adminId();
  if (!id) return null;
  try {
    return await admin.loadUserOverview(id);
  } catch {
    return null;
  }
}

/** Excludes an enrollment from (or re-includes it in) the course statistics. */
export async function setUserCourseExcluded(userCourseId: string, excluded: boolean) {
  const id = await adminId();
  if (!id) return { error: "forbidden" };
  return admin.setUserCourseExcluded(id, userCourseId, excluded);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Make a user admin (true) or take the admin rights away (false). Inputs are validated because
 *  Server Actions can be called with arbitrary arguments. */
export async function setUserAdmin(userId: string, makeAdmin: boolean) {
  const id = await adminId();
  if (!id) return { error: "forbidden" as const };
  if (typeof userId !== "string" || !UUID_RE.test(userId) || typeof makeAdmin !== "boolean") {
    return { error: "invalid" as const };
  }
  return admin.setUserRole(id, userId, makeAdmin ? "admin" : "user");
}

const FORBIDDEN = { data: null, error: "forbidden" } as const;

// --- Kursuebersicht ---

export async function loadCoursesList() {
  const id = await adminId();
  return id ? admin.loadCoursesList(id) : FORBIDDEN;
}

export async function loadCourseUsers(courseId: number) {
  const id = await adminId();
  return id ? admin.loadCourseUsers(id, courseId) : FORBIDDEN;
}

export async function loadUserDays(userId: string, courseId: number) {
  const id = await adminId();
  return id ? admin.loadUserDays(id, userId, courseId) : FORBIDDEN;
}

export async function setCourseFlag(courseId: number, flag: admin.CourseFlag, value: boolean) {
  const id = await adminId();
  return id ? admin.setCourseFlag(id, courseId, flag, value) : FORBIDDEN;
}

export async function setAccessCode(courseId: number, code: string) {
  const id = await adminId();
  return id ? admin.setAccessCode(id, courseId, code) : FORBIDDEN;
}

export async function deleteUserCourse(userCourseId: string) {
  const id = await adminId();
  return id ? admin.deleteUserCourse(id, userCourseId) : FORBIDDEN;
}

export async function anonymizeCourse(courseId: number) {
  const id = await adminId();
  return id ? admin.anonymizeCourse(id, courseId) : FORBIDDEN;
}

/** Creates a course with its periods; the error names the failed step. */
export async function createCourse(input: admin.NewCourseInput) {
  const id = await adminId();
  return id ? admin.createCourse(id, input) : { error: { step: "course" as const, message: "forbidden" } };
}
