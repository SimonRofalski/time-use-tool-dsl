"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { auth } from "@/lib/auth/client";
import {
  listSecurityQuestionOptions,
  loadOwnSecurityQuestions,
} from "@/app/components/onboarding-actions";

// Two security questions + answers, the recovery path for password accounts (see /api/password-reset/*).
// Used as a mandatory onboarding step (requireCompletion) and in the settings panel (allowEditToggle).
// Saved answers are never sent back to the browser, so editing always means entering both answers again.

type SecurityQuestionOptionRow = {
  security_question_id: number;
  question_text: string;
};

type ExistingUserSecurityQuestionRow = {
  user_security_question_id: string;
  security_question_id: number;
};

type SecurityQuestionsFormProps = {
  /** Onboarding mode: the form is always editable and must be completed. */
  requireCompletion?: boolean;
  /** Settings mode: read-only until the user clicks "edit". */
  allowEditToggle?: boolean;
  onSaved?: () => Promise<void> | void;
};

type FormRow = {
  questionId: string;
  answer: string;
};

const INITIAL_ROWS: FormRow[] = [
  { questionId: "", answer: "" },
  { questionId: "", answer: "" },
];

export default function SecurityQuestionsForm({
  requireCompletion = false,
  allowEditToggle = false,
  onSaved,
}: SecurityQuestionsFormProps) {
  const t = useTranslations("securityQuestionsForm");
  const tCommon = useTranslations("common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(requireCompletion);
  const [options, setOptions] = useState<SecurityQuestionOptionRow[]>([]);
  const [existingRows, setExistingRows] = useState<
    ExistingUserSecurityQuestionRow[]
  >([]);
  const [rows, setRows] = useState<FormRow[]>(INITIAL_ROWS);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadData();
  }, []);

  // --- Data loading ---

  async function loadData() {
    setLoading(true);
    setSaveError(null);

    const [{ data: userData }, { data: optionRows, error: optionError }] =
      await Promise.all([
        auth.getUser(),
        listSecurityQuestionOptions(),
      ]);

    if (optionError || !optionRows) {
      setSaveError(t("loadQuestionsError"));
      setLoading(false);
      return;
    }

    const currentUser = userData.user;

    setOptions(optionRows);

    if (!currentUser) {
      setSaveError(t("userLoadError"));
      setLoading(false);
      return;
    }

    const { data: existing, error: existingError } = await loadOwnSecurityQuestions();

    if (existingError) {
      setSaveError(t("loadQuestionsError"));
      setLoading(false);
      return;
    }

    const normalizedExisting = existing ?? [];
    setExistingRows(normalizedExisting);
    // Pre-select the saved questions; answers stay empty
    setRows(
      normalizedExisting.length === 2
        ? normalizedExisting.map((entry) => ({
            questionId: String(entry.security_question_id),
            answer: "",
          }))
        : INITIAL_ROWS,
    );
    setLoading(false);
  }

  const isComplete = useMemo(
    () => rows.every((row) => row.questionId.trim() && row.answer.trim()),
    [rows],
  );

  const hasDuplicateQuestion = useMemo(() => {
    const selected = rows
      .map((row) => row.questionId)
      .filter((questionId) => questionId.length > 0);
    return new Set(selected).size !== selected.length;
  }, [rows]);

  // --- Submit: the API hashes and stores the answers ---

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) {
      return;
    }

    setSaveError(null);

    if (!isComplete) {
      setSaveError(t("incompleteError"));
      return;
    }

    if (hasDuplicateQuestion) {
      setSaveError(t("duplicateQuestionError"));
      return;
    }

    setSaving(true);

    try {
      const { data: userData } = await auth.getUser();
      const currentUser = userData.user;

      if (!currentUser) {
        setSaveError(t("userLoadError"));
        return;
      }

      const payload = rows.map((row) => ({
        questionId: Number(row.questionId),
        answer: row.answer,
      }));

      // the session cookie authenticates the requests
      const response = await fetch("/api/security-questions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: payload }),
      });

      let result: { error?: string } = {};
      try {
        result = (await response.json()) as { error?: string };
      } catch {
        result = { error: t("unexpectedServerResponse") };
      }

      if (!response.ok) {
        setSaveError(
          result.error ??
            t("saveFailedWithStatus", { status: response.status }),
        );
        return;
      }

      // Verify persistence so UI cannot show false positive success.
      const verifyResponse = await fetch("/api/security-questions", {
        method: "GET",
        credentials: "include",
      });

      // A non-JSON answer (e.g. a proxy error page) counts as "not verified"
      let verifyResult: { hasCompleted?: boolean; error?: string } = {};
      try {
        verifyResult = (await verifyResponse.json()) as typeof verifyResult;
      } catch {
        verifyResult = {};
      }

      if (!verifyResponse.ok || verifyResult.hasCompleted !== true) {
        setSaveError(verifyResult.error ?? t("verifyFailedError"));
        return;
      }

      setExistingRows(
        payload.map((entry, index) => ({
          user_security_question_id: `${index}`,
          security_question_id: entry.questionId,
        })),
      );
      setRows(rows.map((row) => ({ ...row, answer: "" })));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      if (allowEditToggle && !requireCompletion) {
        setIsEditing(false);
      }
      await onSaved?.();
    } catch {
      // only fetch itself can throw here (no connection)
      setSaveError(t("networkError"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-slate-500">
        {t("loading")}
      </div>
    );
  }

  const canEdit = requireCompletion || isEditing;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {t("title")}
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {t("description")}
            </p>
            {existingRows.length === 2 && (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {t("alreadySetHint")}
              </p>
            )}
          </div>
          {allowEditToggle && !requireCompletion && (
            <button
              type="button"
              onClick={() => {
                setIsEditing((current) => !current);
                setSaveError(null);
              }}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800"
            >
              {isEditing ? tCommon("cancelButton") : t("editButton")}
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {rows.map((row, index) => (
            <div
              key={`security-row-${index}`}
              className="grid gap-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]"
            >
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                {t("questionLabel", { index: index + 1 })}
                <select
                  value={row.questionId}
                  onChange={(event) => {
                    const value = event.target.value;
                    setRows((previous) =>
                      previous.map((entry, entryIndex) =>
                        entryIndex === index
                          ? { ...entry, questionId: value }
                          : entry,
                      ),
                    );
                    setSaveError(null);
                  }}
                  disabled={!canEdit}
                  className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:disabled:bg-slate-800"
                >
                  <option value="">{t("selectPlaceholder")}</option>
                  {options.map((option) => (
                    <option
                      key={option.security_question_id}
                      value={option.security_question_id}
                      disabled={rows.some(
                        (entry, entryIndex) =>
                          entryIndex !== index &&
                          entry.questionId ===
                            String(option.security_question_id),
                      )}
                    >
                      {option.question_text}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                {t("answerLabel")}
                <input
                  type="text"
                  value={row.answer}
                  onChange={(event) => {
                    const value = event.target.value;
                    setRows((previous) =>
                      previous.map((entry, entryIndex) =>
                        entryIndex === index
                          ? { ...entry, answer: value }
                          : entry,
                      ),
                    );
                    setSaveError(null);
                  }}
                  disabled={!canEdit}
                  autoComplete="off"
                  className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:disabled:bg-slate-800"
                  placeholder={
                    canEdit
                      ? t("answerPlaceholderEditable")
                      : t("answerPlaceholderHidden")
                  }
                />
              </label>
            </div>
          ))}

          {saveError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {saveError}
            </p>
          )}

          {saved && (
            <p className="text-sm text-green-600 dark:text-green-400">
              {t("savedMessage")}
            </p>
          )}

          {canEdit && (
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-slate-800 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {saving ? t("savingButton") : t("saveButton")}
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
