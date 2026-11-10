"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

// Forced password change after an admin set the password (profiles.must_change_password).
// The protected layout shows only this form until it succeeds; /api/auth/change-password clears the flag.
// Right after signing in the temporary password is not asked again; the field only appears when
// the server asks for it (session older than 30 minutes).

type MustChangePasswordFormProps = {
  onSaved?: () => Promise<void> | void;
};

export default function MustChangePasswordForm({
  onSaved,
}: MustChangePasswordFormProps) {
  const t = useTranslations("mustChangePassword");
  const [currentPassword, setCurrentPassword] = useState("");
  const [askCurrentPassword, setAskCurrentPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) {
      return;
    }

    setSaveError(null);

    if (askCurrentPassword && !currentPassword) {
      setSaveError(t("currentPasswordRequired"));
      return;
    }

    if (newPassword.length < 6) {
      setSaveError(t("passwordTooShort"));
      return;
    }

    if (newPassword !== confirmPassword) {
      setSaveError(t("passwordMismatch"));
      return;
    }

    setSaving(true);

    try {
      // the session cookie authenticates the request
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: askCurrentPassword ? currentPassword : undefined,
          newPassword,
        }),
      });

      let result: { error?: string; currentPasswordRequired?: boolean } = {};
      try {
        result = (await response.json()) as typeof result;
      } catch {
        result = { error: t("unexpectedServerResponse") };
      }

      if (!response.ok) {
        if (result.currentPasswordRequired && !askCurrentPassword) {
          // session too old: show the field and ask for the temporary password
          setAskCurrentPassword(true);
          setSaveError(t("currentPasswordRequired"));
          return;
        }
        setSaveError(result.error ?? t("saveFailedError"));
        return;
      }

      await onSaved?.();
    } catch {
      // only fetch itself can throw here (no connection)
      setSaveError(t("networkError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {t("title")}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t("description")}
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {askCurrentPassword && (
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              {t("currentPasswordLabel")}
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                  setSaveError(null);
                }}
                autoComplete="current-password"
                className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
          )}

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t("newPasswordLabel")}
            <input
              type="password"
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
                setSaveError(null);
              }}
              autoComplete="new-password"
              className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t("confirmPasswordLabel")}
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setSaveError(null);
              }}
              autoComplete="new-password"
              className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>

          {saveError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {saveError}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-slate-800 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {saving ? t("savingButton") : t("saveButton")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
