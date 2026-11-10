"use client";

import { useState, useEffect, useMemo } from "react";
import {
  KeyRound,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  loadUserOverviewData,
  setUserAdmin,
  setUserCourseExcluded,
} from "@/app/components/admin/admin-actions";
import { courseDurationDays, totalPeriodDays } from "@/lib/course-periods";
import ConfirmModal from "./ConfirmModal";
import CreateUserModal from "./CreateUserModal";
import SetPasswordModal from "./SetPasswordModal";

// Admin tab "Nutzeruebersicht": all active users with course, progress (submitted / course days),
// login method and actions (exclude from statistics, set password, make/remove admin, delete,
// create account). Data comes from admin-actions.ts; the KPIs are computed here in the browser.

// --- Types ---

type UserRow = {
  userId: string;
  // all enrollments of the user (normally at most one); exclusion applies to all of them
  userCourseIds: string[];
  email: string;
  firstName: string | null;
  lastName: string | null;
  courseName: string | null;
  courseTotalDays: number;
  submittedDays: number;
  isExcluded: boolean;
  authProvider: "password" | "switch_edu_id";
  mustChangePassword: boolean;
  isAdmin: boolean;
  lastSignInAt: string | null;
};

type Kpis = {
  totalUsers: number;
  totalSubmittedDays: number;
  avgCompletionRate: number; // 0–100, average across users who started at least one day
};

type ConfirmModalState = {
  title: string;
  message: string;
  variant: "danger" | "warning" | "default";
  confirmLabel: string;
  onConfirm: () => void;
};

// --- Helpers ---

function displayName(u: UserRow): string {
  if (u.firstName || u.lastName) {
    return [u.firstName, u.lastName].filter(Boolean).join(" ");
  }
  return u.email;
}

function AdminBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
      <ShieldCheck size={12} />
      {label}
    </span>
  );
}

function AuthProviderBadge({
  authProvider,
  mustChangePassword,
  labels,
}: {
  authProvider: UserRow["authProvider"];
  mustChangePassword: boolean;
  labels: { switchEduId: string; password: string; mustChangePassword: string };
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
          authProvider === "switch_edu_id"
            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        }`}
      >
        {authProvider === "switch_edu_id"
          ? labels.switchEduId
          : labels.password}
      </span>
      {mustChangePassword && (
        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
          {labels.mustChangePassword}
        </span>
      )}
    </div>
  );
}

// --- Main component ---

export default function NutzeruebersichtTab() {
  const t = useTranslations("nutzeruebersicht");
  const locale = useLocale();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(
    null,
  );
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [setPasswordUser, setSetPasswordUser] = useState<UserRow | null>(null);
  // the logged-in admin: can't take away their own admin rights
  const [viewerId, setViewerId] = useState<string | null>(null);

  useEffect(() => {
    void loadData();
  }, []);

  // "10.11.2026" (de) / "11/10/2026" (en); "never" when the person never signed in
  function formatLastLogin(value: string | null): string {
    if (!value) return t("neverLoggedIn");
    return new Date(value).toLocaleDateString(
      locale === "en" ? "en-US" : "de-CH",
      {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      },
    );
  }

  // --- Data loading ---

  // silent: refresh without the loading screen, so open dialogs (e.g. the "account created"
  // confirmation with the temporary password) stay on screen
  async function loadData({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setIsLoading(true);
    setError("");

    // All active profiles (admin RLS policy), enrollments with course name +
    // dates + periods for the total-days calculation, and all day records,
    // in one server call
    const overview = await loadUserOverviewData();

    if (!overview) {
      setError(t("loadError"));
      setIsLoading(false);
      return;
    }
    const profiles = overview.profiles;
    const userCourses = overview.userCourses;
    setViewerId(overview.viewerId);

    const courseInfoByUser: Record<
      string,
      {
        name: string;
        totalDays: number;
        userCourseIds: string[];
        isExcluded: boolean;
      }
    > = {};
    for (const uc of userCourses ?? []) {
      // The server embeds the course as an object (or null when it no longer exists)
      const c = uc.course;
      const courseName = c?.name ?? null;
      const totalDays = !c
        ? 0
        : c.course_period.length > 0
          ? totalPeriodDays(c.course_period)
          : courseDurationDays(c.start_date, c.end_date);

      if (uc.profiles_id && courseName) {
        // Several enrollments are merged into one row (names joined, days added up) instead of
        // the last one silently replacing the others
        const prev = courseInfoByUser[uc.profiles_id];
        courseInfoByUser[uc.profiles_id] = prev
          ? {
              name: `${prev.name}, ${courseName}`,
              totalDays: prev.totalDays + totalDays,
              userCourseIds: [...prev.userCourseIds, uc.user_course_id],
              isExcluded: prev.isExcluded && (uc.is_excluded ?? false),
            }
          : {
              name: courseName,
              totalDays,
              userCourseIds: [uc.user_course_id],
              isExcluded: uc.is_excluded ?? false,
            };
      }
    }

    // All day records to compute per-user submitted counts and the KPI
    const allDays = overview.allDays;

    const submittedByUser: Record<string, number> = {};
    const totalDaysByUser: Record<string, number> = {};
    let totalSubmittedDays = 0;

    for (const d of allDays) {
      totalDaysByUser[d.profiles_id] =
        (totalDaysByUser[d.profiles_id] ?? 0) + 1;
      if (d.is_submitted) {
        submittedByUser[d.profiles_id] =
          (submittedByUser[d.profiles_id] ?? 0) + 1;
        totalSubmittedDays++;
      }
    }

    // Average completion rate: average per-user completion among users who started at least one day
    const usersWhoStarted = Object.keys(totalDaysByUser);
    const avgCompletionRate =
      usersWhoStarted.length > 0
        ? Math.round(
            usersWhoStarted.reduce((sum, uid) => {
              const submitted = submittedByUser[uid] ?? 0;
              return sum + (submitted / totalDaysByUser[uid]) * 100;
            }, 0) / usersWhoStarted.length,
          )
        : 0;

    setKpis({
      totalUsers: profiles.length,
      totalSubmittedDays,
      avgCompletionRate,
    });

    setUsers(
      profiles.map((p) => {
        const info = courseInfoByUser[p.id];
        return {
          userId: p.id,
          userCourseIds: info?.userCourseIds ?? [],
          email: p.email ?? p.id.slice(0, 8) + "…",
          firstName: p.first_name ?? null,
          lastName: p.last_name ?? null,
          courseName: info?.name ?? null,
          courseTotalDays: info?.totalDays ?? 0,
          submittedDays: submittedByUser[p.id] ?? 0,
          isExcluded: info?.isExcluded ?? false,
          authProvider:
            p.auth_provider === "switch_edu_id" ? "switch_edu_id" : "password",
          mustChangePassword: p.must_change_password ?? false,
          isAdmin: p.role === "admin",
          lastSignInAt: overview.lastSignInById[p.id] ?? null,
        };
      }),
    );

    setIsLoading(false);
  }

  // --- Actions (each opens a ConfirmModal first) ---

  /** Excluded enrollments stay visible here but are left out of the course comparison and the exports. */
  async function handleToggleExclude(user: UserRow) {
    if (user.userCourseIds.length === 0) return;

    const nowExcluded = !user.isExcluded;
    let error = false;
    for (const id of user.userCourseIds) {
      if ((await setUserCourseExcluded(id, nowExcluded)).error) error = true;
    }

    if (!error) {
      setUsers((prev) =>
        prev.map((u) =>
          u.userId === user.userId ? { ...u, isExcluded: nowExcluded } : u,
        ),
      );
    }
    setConfirmModal(null);
  }

  function openExcludeModal(user: UserRow) {
    if (user.isExcluded) {
      setConfirmModal({
        title: t("includeConfirm.title"),
        message: t("includeConfirm.message", { name: displayName(user) }),
        variant: "default",
        confirmLabel: t("includeConfirm.confirmLabel"),
        onConfirm: () => void handleToggleExclude(user),
      });
    } else {
      setConfirmModal({
        title: t("excludeConfirm.title"),
        message: t("excludeConfirm.message", { name: displayName(user) }),
        variant: "warning",
        confirmLabel: t("excludeConfirm.confirmLabel"),
        onConfirm: () => void handleToggleExclude(user),
      });
    }
  }

  async function handleDeleteUser(user: UserRow) {
    setConfirmModal(null);

    // the session cookie authenticates the request
    const response = await fetch("/api/admin/users/delete", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: user.userId }),
    });

    if (response.ok) {
      setUsers((prev) => prev.filter((u) => u.userId !== user.userId));
    } else {
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(result.error ?? t("deleteError"));
    }
  }

  function openDeleteModal(user: UserRow) {
    setConfirmModal({
      title: t("deleteConfirm.title"),
      message: t("deleteConfirm.message", { name: displayName(user) }),
      variant: "danger",
      confirmLabel: t("deleteConfirm.confirmLabel"),
      onConfirm: () => void handleDeleteUser(user),
    });
  }

  async function handleSetAdmin(user: UserRow, makeAdmin: boolean) {
    setConfirmModal(null);
    const { error } = await setUserAdmin(user.userId, makeAdmin);
    if (!error) {
      setUsers((prev) =>
        prev.map((u) =>
          u.userId === user.userId ? { ...u, isAdmin: makeAdmin } : u,
        ),
      );
    } else {
      setError(error === "self" ? t("cannotRemoveOwnAdmin") : t("roleError"));
    }
  }

  function openAdminModal(user: UserRow) {
    const makeAdmin = !user.isAdmin;
    const key = makeAdmin ? "makeAdminConfirm" : "removeAdminConfirm";
    setConfirmModal({
      title: t(`${key}.title`),
      message: t(`${key}.message`, { name: displayName(user) }),
      variant: makeAdmin ? "warning" : "danger",
      confirmLabel: t(`${key}.confirmLabel`),
      onConfirm: () => void handleSetAdmin(user, makeAdmin),
    });
  }

  // own admin rights can't be removed (keeps at least one admin)
  const canToggleAdmin = (u: UserRow) => !(u.isAdmin && u.userId === viewerId);

  // Filter applied client-side: searches name, email and course name
  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const name = [u.firstName, u.lastName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        name.includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.courseName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [users, searchQuery]);

  // --- Render ---

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-slate-500">{t("loading")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  return (
    <>
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          variant={confirmModal.variant}
          confirmLabel={confirmModal.confirmLabel}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      {showCreateModal && (
        <CreateUserModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => void loadData({ silent: true })}
        />
      )}

      {setPasswordUser && (
        <SetPasswordModal
          userId={setPasswordUser.userId}
          userLabel={displayName(setPasswordUser)}
          isSwitchEduIdAccount={
            setPasswordUser.authProvider === "switch_edu_id"
          }
          onClose={() => setSetPasswordUser(null)}
          onSaved={() => {
            setSetPasswordUser(null);
            void loadData();
          }}
        />
      )}

      <div className="space-y-6">
        {/* KPI cards */}
        {kpis && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {t("kpis.activeUsers")}
              </p>
              <p className="mt-2 text-3xl font-bold text-slate-800 dark:text-slate-100">
                {kpis.totalUsers}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {t("kpis.completedDays")}
              </p>
              <p className="mt-2 text-3xl font-bold text-slate-800 dark:text-slate-100">
                {kpis.totalSubmittedDays}
              </p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                {t("kpis.completedDaysSubtitle")}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {t("kpis.avgCompletionRate")}
              </p>
              <p className="mt-2 text-3xl font-bold text-slate-800 dark:text-slate-100">
                {kpis.avgCompletionRate}%
              </p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                {t("kpis.avgCompletionRateSubtitle")}
              </p>
            </div>
          </div>
        )}

        {/* Search bar + create account */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-4 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            <UserPlus size={15} />
            {t("createUserButton")}
          </button>
        </div>

        {/* Mobile user cards */}
        <div className="space-y-3 md:hidden">
          {filteredUsers.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500">
              {searchQuery.trim() ? t("noUserFound") : t("noActiveUsers")}
            </div>
          ) : (
            filteredUsers.map((u) => (
              <div
                key={u.userId}
                className={`rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900 ${
                  u.isExcluded ? "opacity-50" : ""
                }`}
              >
                <div className="space-y-1">
                  {u.firstName || u.lastName ? (
                    <>
                      <p className="break-words font-medium text-slate-800 dark:text-slate-100">
                        {displayName(u)}
                      </p>
                      <p className="break-all text-xs text-slate-400 dark:text-slate-500">
                        {u.email}
                      </p>
                    </>
                  ) : (
                    <p className="break-all font-medium text-slate-800 dark:text-slate-100">
                      {u.email}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {u.isAdmin && <AdminBadge label={t("adminBadge")} />}
                    <AuthProviderBadge
                      authProvider={u.authProvider}
                      mustChangePassword={u.mustChangePassword}
                      labels={{
                        switchEduId: t("authMethodBadge.switchEduId"),
                        password: t("authMethodBadge.password"),
                        mustChangePassword: t("mustChangePasswordBadge"),
                      }}
                    />
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      {t("courseLabel")}
                    </p>
                    <p className="mt-1 break-words text-slate-600 dark:text-slate-300">
                      {u.courseName ?? t("noCoursePlaceholder")}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      {t("progressLabel")}
                    </p>
                    <p className="mt-1 break-words text-slate-600 dark:text-slate-300">
                      {u.courseTotalDays > 0
                        ? t("progressDaysLabel", {
                            submitted: u.submittedDays,
                            total: u.courseTotalDays,
                          })
                        : u.submittedDays}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      {t("lastLoginLabel")}
                    </p>
                    <p className="mt-1 break-words text-slate-600 dark:text-slate-300">
                      {formatLastLogin(u.lastSignInAt)}
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  {u.userCourseIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => openExcludeModal(u)}
                      className={`w-full rounded-lg border px-3 py-2 text-xs font-medium transition ${
                        u.isExcluded
                          ? "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400"
                          : "border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-900/20"
                      }`}
                    >
                      {u.isExcluded ? t("includeButton") : t("excludeButton")}
                    </button>
                  )}
                  {canToggleAdmin(u) && (
                    <button
                      type="button"
                      onClick={() => openAdminModal(u)}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600"
                    >
                      {u.isAdmin ? (
                        <ShieldOff size={13} />
                      ) : (
                        <ShieldCheck size={13} />
                      )}
                      {u.isAdmin
                        ? t("removeAdminButton")
                        : t("makeAdminButton")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSetPasswordUser(u)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600"
                  >
                    <KeyRound size={13} />
                    {t("setPasswordButton")}
                  </button>
                  {u.userId !== viewerId && (
                    <button
                      type="button"
                      onClick={() => openDeleteModal(u)}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      <Trash2 size={13} />
                      {t("deleteButton")}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Desktop user table */}
        <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900 md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-left dark:border-slate-800 dark:bg-slate-800/50">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t("table.user")}
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t("table.course")}
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t("table.progress")}
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t("table.authMethod")}
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t("table.actions")}
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t("table.lastLogin")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500"
                  >
                    {searchQuery.trim() ? t("noUserFound") : t("noActiveUsers")}
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => (
                  <tr
                    key={u.userId}
                    className={`transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40 ${
                      u.isExcluded ? "opacity-50" : ""
                    }`}
                  >
                    {/* Name + email (+ admin badge) */}
                    <td className="px-4 py-3">
                      {u.firstName || u.lastName ? (
                        <>
                          <p className="font-medium text-slate-800 dark:text-slate-100">
                            {displayName(u)}
                          </p>
                          <p className="text-xs text-slate-400 dark:text-slate-500">
                            {u.email}
                          </p>
                        </>
                      ) : (
                        <p className="font-medium text-slate-800 dark:text-slate-100">
                          {u.email}
                        </p>
                      )}
                      {u.isAdmin && (
                        <div className="mt-1">
                          <AdminBadge label={t("adminBadge")} />
                        </div>
                      )}
                    </td>

                    {/* Course */}
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {u.courseName ?? (
                        <span className="text-slate-300 dark:text-slate-600">
                          {t("noCoursePlaceholder")}
                        </span>
                      )}
                    </td>

                    {/* X / Y progress */}
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {u.courseTotalDays > 0 ? (
                        <span>
                          {u.submittedDays}{" "}
                          <span className="text-slate-400 dark:text-slate-500">
                            / {u.courseTotalDays} {t("daysUnit")}
                          </span>
                        </span>
                      ) : (
                        u.submittedDays
                      )}
                    </td>

                    {/* Auth method */}
                    <td className="px-4 py-3">
                      <AuthProviderBadge
                        authProvider={u.authProvider}
                        mustChangePassword={u.mustChangePassword}
                        labels={{
                          switchEduId: t("authMethodBadge.switchEduId"),
                          password: t("authMethodBadge.password"),
                          mustChangePassword: t("mustChangePasswordBadge"),
                        }}
                      />
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {u.userCourseIds.length > 0 && (
                          <button
                            type="button"
                            onClick={() => openExcludeModal(u)}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                              u.isExcluded
                                ? "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400"
                                : "border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-900/20"
                            }`}
                          >
                            {u.isExcluded
                              ? t("includeButton")
                              : t("excludeButton")}
                          </button>
                        )}
                        {canToggleAdmin(u) && (
                          <button
                            type="button"
                            onClick={() => openAdminModal(u)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600"
                          >
                            {u.isAdmin ? (
                              <ShieldOff size={13} />
                            ) : (
                              <ShieldCheck size={13} />
                            )}
                            {u.isAdmin
                              ? t("removeAdminButton")
                              : t("makeAdminButton")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setSetPasswordUser(u)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600"
                        >
                          <KeyRound size={13} />
                          {t("setPasswordButton")}
                        </button>
                        {u.userId !== viewerId && (
                          <button
                            type="button"
                            onClick={() => openDeleteModal(u)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
                          >
                            <Trash2 size={13} />
                            {t("deleteButton")}
                          </button>
                        )}
                      </div>
                    </td>

                    {/* Last sign-in */}
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600 dark:text-slate-300">
                      {formatLastLogin(u.lastSignInAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
