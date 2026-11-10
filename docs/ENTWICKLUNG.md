# Entwicklung

Einstieg für das Team, das die App weiterentwickelt. Den Schnellstart findest du im
[README](../README.md), die Details zur Datenbank in [db/README.md](../db/README.md).

## Wie eine Anfrage läuft

```
Browser
  │
  ▼
proxy.ts               Sprache wählen, nicht angemeldete Personen von geschützten Seiten auf "/" umleiten
  │
  ▼
Seite (app/[locale]/…)  Client-Komponente; ruft Server Actions auf
  │
  ▼
actions.ts             dünne Server Actions: holen die angemeldete Person aus der Sitzung
  │
  ▼
lib/data/<seite>.ts    Logik und SQL der Seite; testbar ohne Browser
  │
  ▼
lib/db                 withUser(...) = Zugriff als diese Person, die RLS-Regeln gelten
                       withService(...) = serverseitige Aufgaben (Login, Exporte, Kontoverwaltung)
```

- **Anmeldung, Kontoverwaltung, Exporte und Kursbeitritt** laufen über API-Routen in `app/api/`.
  - Jede schreibende Route prüft mit `rejectCrossSite` die Herkunft der Anfrage (CSRF).
  - Logins und Registrierungen sind pro IP begrenzt (`lib/auth/request.ts`).
- **Jede Seite, Server Action und Route prüft die Sitzung selbst.** Der Proxy entscheidet nur über
  Umleitung und Sprache.

## Rechte

Die Datenbank setzt die Rechte durch, nicht nur die App:

| Rolle | Wer | Wofür |
| --- | --- | --- |
| `tut_authenticated` | jede angemeldete Person (`withUser`) | Row Level Security: Teilnehmende sehen ihre eigenen Daten, Admins zusätzlich die Kursverwaltung |
| `tut_backend` | der Server (`withService`) | Login, Exporte, Kontoverwaltung, Kursvergleich |
| Owner | nur Migrationen, Import, `set-admin` | nie im App-Container |

- **Geschützte Spalten.** Einige Spalten von `profiles` kann nur der Server ändern; ein Trigger
  verhindert das für Personen. Betroffen sind:
  - `role`, `email`, `is_active`;
  - `auth_provider`, `must_change_password`, `switch_edu_id_sub`.

  Code, der diese Spalten ändert, läuft deshalb über `withService`.
- **Kursvergleich.** Er wird auf dem Server berechnet (`lib/data/statistiken.ts`,
  `lib/statistiken/comparison.ts`). Im Browser kommen nur Kennzahlen an, nie Einträge anderer Personen.
  - In der Datenbank gibt es noch zwei Leseregeln aus der Vorgängerversion: Teilnehmende dürfen die
    abgegebenen Tage und Einträge ihres Kurses lesen. Früher brauchte der Kursvergleich das im
    Browser. Heute liest der Kursvergleich über `withService`. Bevor man die Regeln mit einer
    Migration entfernt, prüfen, dass kein anderer Code sie braucht, und den Test `db/tests/03_*`
    anpassen.
- **Forschungsdaten.** Admins sehen keine einzelnen Zeiteinträge der Teilnehmenden. Exporte sind
  aggregiert oder anonymisiert (`lib/admin/`).

## Anmeldung

- **Passwort**
  - Sitzungen liegen in der Tabelle `user_session`, im Browser nur als HttpOnly-Cookie
    (`lib/auth/session.ts`).
  - Passwörter werden mit bcrypt gespeichert.
  - "Passwort vergessen" läuft über Sicherheitsfragen (`lib/password-reset-server.ts`). Die Antwort
    verrät nicht, ob ein Konto existiert. Nach fünf Fehlversuchen ist die Funktion gesperrt.
- **SWITCH edu-ID** (`lib/oidc/`, `app/api/auth/switch/`)
  - Beim ersten Login wird ein Konto angelegt.
  - Gibt es schon ein Passwort-Konto mit derselben bestätigten E-Mail, wird es verknüpft.
  - Lokal ersetzt `npm run mock-oidc` den echten Dienst. Dafür sind Testkonten vorbereitet.
- **Pflicht-Schritte nach dem Login** (`app/[locale]/(protected)/layout.tsx`), in dieser Reihenfolge:
  1. vom Admin gesetztes Passwort ändern;
  2. Sicherheitsfragen (nur bei Passwort-Konten);
  3. Profil;
  4. Kursbeitritt;
  5. danach einmalig die geführte Tour.

## Fachliche Logik: wo was liegt

| Thema | Datei |
| --- | --- |
| Kurse mit mehreren Zeiträumen, Kurstage | `lib/course-periods.ts` |
| Tätigkeitssuche mit Alltagsbegriffen (`activity.keywords_de/_en`) | `lib/activity-search.ts` |
| Frage "fokussiert / nebenbei" bei Geräten | `app/[locale]/(protected)/zeiterfassung/ict-attention.ts` |
| Speichern eines Tages (eine Transaktion) | `lib/data/zeiterfassung.ts` |
| Admin-Statistik und Exporte | `lib/admin/` |
| Geführte Tour (Ziele mit `data-tour="…"` markiert) | `app/components/tutorial/TutorialTour.tsx` |

## Konventionen

- **Texte:**
  - Alle Oberflächentexte stehen in `messages/de.json` und `messages/en.json`.
  - Angesprochen wird mit "du", auch im Englischen informell.
- **Namen aus Nachschlagetabellen:**
  - Immer über `getLocalizedName(row, locale)` lesen, nie `.name` direkt.
  - Logik (Icons, Gruppen, Sortierung) hängt am sprachneutralen `code`, nie am Namen.
- **Design:** Zu jeder hellen Tailwind-Klasse gehört eine `dark:`-Variante.
- **Datum "heute":** immer `getLocalIsoDate()` (`lib/local-date.ts`), nie `toISOString()`, weil
  sonst die Zeitzone den Tag verschiebt.
- **E-Mails** werden mit `lower(email) = $1` verglichen. Braucht es einmal `ILIKE` mit einer
  Benutzereingabe, dann mit `escapeLikePattern` (`lib/escape-like.ts`).
- **Kommentare** auf Englisch, kurz, mit dem Warum. Personennamen nur im README.

## Datenbank ändern

1. Neue Datei `db/migrations/NNNN_beschreibung.sql` anlegen. Bereits eingespielte Dateien nie ändern:
   Ihre Prüfsumme ist in jeder Datenbank gespeichert.
2. `npm run db:migrate` spielt sie lokal ein.
3. Mit `npm run db:pull` das Drizzle-Schema (`lib/db/schema.ts`) neu erzeugen.
4. Wenn sich Rechte ändern: einen Test in `db/tests/` ergänzen.

## Tests

| Befehl | Prüft |
| --- | --- |
| `npm run db:test-all` | Rechte (SQL-Tests) und Datenzugriff der Seiten, in der Wegwerf-Datenbank `tut_test` |
| `npm run test:edu-id` | edu-ID-Anmeldung durchgehend, mit dem Produktions-Image und dem Mock |
| `npm run test:dsl-stack [-- prod]` | die Compose-Dateien für das DSL, so wie sie übergeben werden |

- `db:test-all` lässt deine Arbeitsdatenbank `tut_local` unberührt.
- `npm run db:reset` dagegen setzt sie komplett neu auf.

Bei jedem Push führen die GitHub-Actions Lint, Build, `db:test-all` und `test:dsl-stack` aus.
`test:edu-id` läuft nur lokal, weil es Docker Desktop braucht. Vor einem Release kommt die manuelle
Prüfung nach [TESTPLAN.md](../TESTPLAN.md) dazu.

## Release

1. Auf `main` ist alles grün, und die Testumgebung (`:test`) ist geprüft.
2. Einen Tag setzen: `git tag v1.2.0 && git push origin v1.2.0`.
3. Dem DSL die neue Version melden. Es trägt sie in der Produktions-Compose-Datei ein (siehe
   [DEPLOY.md](../DEPLOY.md)).
