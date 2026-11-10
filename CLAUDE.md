# CLAUDE.md

Guidance for Claude Code in this repository. Human-oriented docs: README.md, docs/ENTWICKLUNG.md
(architecture, conventions), db/README.md (database), DEPLOY.md (operations at the DSL), TESTPLAN.md.

## Commands

```bash
npm run dev            # dev server, localhost:3000 (needs npm run db:up)
npm run lint
npm run build
npm run db:test-all    # ALL tests (RLS + data access) in the throwaway database tut_test
npm run test:edu-id    # edu-ID end to end (production image + mock provider)
npm run test:dsl-stack # starts deploy/dsl/<test|prod>/compose.yml as written
npm run mock-oidc      # local SWITCH edu-ID mock, port 9999
```

## Architecture in one paragraph

Next.js 16 App Router + React 19 + TypeScript + Tailwind 4 on PostgreSQL 17. All pages live under
`app/[locale]/...` (next-intl, `localePrefix: "never"`, so the locale never shows in the URL). Pages are
client components that call Server Actions (`app/.../actions.ts`, thin, user taken from the session),
which call `lib/data/<page>.ts`. `lib/db` gives `withUser(userId, fn)` (transaction as
`tut_authenticated` with `app.user_id`, so RLS applies) and `withService(fn)` (server-side jobs). Auth,
account admin, exports and enrollment are API routes in `app/api/` (CSRF check `rejectCrossSite`).
`proxy.ts` (project root, Next.js 16 convention) only does locale sync and redirects; every page, action
and route checks the session itself.

## Rules

- Never change behaviour of existing features without an explicit request; this app is used for research.
- Never edit an applied file in `db/migrations/` (checksums are recorded in every database); add a new
  `NNNN_name.sql`. `0001`/`0002` were generated once from the predecessor database.
- Tests only via `npm run db:test-all`. Never run `db:reset` just to test: it wipes the working database
  `tut_local`.
- `db/.work/` holds exports with personal data and password hashes: never print or commit its content.
- Personal names appear only in the README credits; none in code, comments, docs or commit messages.
- Profile columns `role`, `email`, `is_active`, `auth_provider`, `must_change_password`,
  `switch_edu_id_sub` are writable only via `withService` (trigger `protect_profiles_auth_fields`).
- Lookup names via `getLocalizedName(row, locale)`; logic keys off the language-neutral `code` column.
- "Today" via `getLocalIsoDate()`, never `toISOString()`; any `ILIKE` on user input via `escapeLikePattern`.
- UI copy in `messages/{de,en}.json`, informal "du"; every light Tailwind class gets a `dark:` variant.
- Code comments in English, concise, explaining why.
- Local database port 15432 (54329 is in a Hyper-V reserved range on Windows).
