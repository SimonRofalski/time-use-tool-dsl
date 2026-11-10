# Datenbank

PostgreSQL 17. Hier liegt alles, was die Datenbank aufbaut, prüft und lokal nachbildet. In der
Produktion läuft sie als Dienst `tut_db` im Stack der App (siehe [DEPLOY.md](../DEPLOY.md)).

## Lokale Befehle

Voraussetzung ist Docker Desktop. Die lokale Datenbank läuft auf `127.0.0.1:15432` (`compose.dev.yml`).

| Befehl | Wirkung |
| --- | --- |
| `npm run db:up` / `db:down` | lokale Datenbank starten / stoppen |
| `npm run db:reset` | **löscht** die Arbeitsdatenbank `tut_local` und baut sie neu auf (Bootstrap, Migrationen, synthetische Testdaten) |
| `npm run db:reset-real` | wie `db:reset`, aber mit dem Datenexport aus `db/.work/data_export.sql` |
| `npm run db:export` | Export aller Nutzerdaten (Import-Datei und Manifest in `db/.work/`, nicht im Git) |
| `npm run db:migrate` | neue Migrationen einspielen |
| `npm run db:test-all` | alle Tests in der Wegwerf-Datenbank `tut_test`; `tut_local` bleibt unberührt |
| `npm run db:pull` | Drizzle-Schema `lib/db/schema.ts` aus der Datenbank neu erzeugen |

- **Testdaten:** Konten `seed-<alias>@example.invalid`, Passwort `Seed-Passwort-1`. Die Übersicht
  steht oben in `seed/seed.sql`.
- **Nur lokal:** Die Skripte und `lib/db` verbinden sich in der Entwicklung nur mit dem lokalen
  Container. Für einen anderen Host braucht es ausdrücklich `ALLOW_REMOTE_DB=1`.

## Aufbau

| Pfad | Zweck |
| --- | --- |
| `bootstrap/bootstrap.sql` | einmal pro Umgebung als Superuser: legt Datenbank, Logins und Gruppen an (lokal über `local-init.sh`, beim DSL über das Image `bootstrap/Dockerfile`) |
| `migrations/` | Schema und Nachschlagedaten, nummeriert; werden nur vorwärts und nur als Owner eingespielt |
| `scripts/` | Migrieren, Zurücksetzen, Export und Import, Admin setzen, Test-Runner |
| `seed/` | synthetische Testdaten |
| `tests/` | SQL-Tests der Rechte (`NN_*.sql`) und Tests des Datenzugriffs der Seiten (`app/`), dazu ein durchgehender edu-ID-Test (`e2e/`) |

`0001_base_schema.sql` und `0002_lookup_data.sql` wurden einmalig aus der Vorgänger-Datenbank erzeugt.
Spätere Änderungen kommen immer in eine neue Migration.

## Rollen

| Rolle | Login | Wofür |
| --- | --- | --- |
| `tut_authenticated` | `tut_<env>_app` | Zugriff als angemeldete Person: `withUser(userId, fn)` setzt `app.user_id`, `auth.uid()` liest es, die RLS-Regeln gelten |
| `tut_backend` | `tut_<env>_service` | serverseitige Aufgaben: `withService(fn)` |
| Owner | `tut_<env>_owner` | besitzt das Schema; nur Migrationen, Import und `set-admin`, nie in der App |

Keiner der Logins ist Superuser oder hat `BYPASSRLS`.

`<env>` ist je nach Umgebung:
- `local` (Entwicklung),
- `test` (automatische Tests),
- `stage` (Testumgebung beim DSL),
- `prod` (Produktion).
