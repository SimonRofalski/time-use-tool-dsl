# Time Use Tool

Webanwendung der Berner Fachhochschule (BFH) für Zeitverwendungsstudien in der Lehre. Studierende
erfassen in einem Kurs während einiger Tage, womit sie ihre Zeit verbringen. Das geschieht in
10-Minuten-Feldern nach der HETUS-Klassifikation. Danach sehen sie ihre eigene Auswertung und den
Vergleich mit dem Kurs. Admins verwalten die Kurse und exportieren die Daten für die Forschung.

Die Oberfläche gibt es auf Deutsch und Englisch, jeweils hell und dunkel.

## Funktionen

- **Zeiterfassung:**
  - Tagesraster mit 144 Feldern.
  - Haupt- und Nebentätigkeit; die Suche findet Tätigkeiten auch über Alltagsbegriffe.
  - Gerätenutzung, Ort, mit wem, Zufriedenheit.
  - Je nach Kurs Zusatzfragen und ein Tagesfragebogen.
- **Erfasste Zeit:** Übersicht aller Kurstage mit Status (leer, in Bearbeitung, vollständig).
- **Statistiken:**
  - eigene Zeitverteilung;
  - Kursvergleich (nur Kennzahlen des Kurses, keine Daten anderer Personen);
  - PDF-Export.
- **Admin:**
  - Kurse mit mehreren Zeiträumen und Zugangscode.
  - Nutzerverwaltung: Konten anlegen, Passwörter zurücksetzen, Admin-Rechte vergeben.
  - Kennzahlen.
  - Exporte: aggregiert, Rohdaten, Forschung.
- **Anmeldung:** E-Mail und Passwort (Zurücksetzen über Sicherheitsfragen) oder SWITCH edu-ID.
- **Einstieg:** Pflicht-Profil beim ersten Login, Kursbeitritt per Code, geführte Tour.

## Technik

| Bereich | Umsetzung |
| --- | --- |
| Anwendung | Next.js 16 (App Router, Server Actions), React 19, TypeScript, Tailwind CSS 4 |
| Datenbank | PostgreSQL 17 mit Row Level Security; Zugriff über `pg` und Drizzle |
| Anmeldung | eigene Sitzungen in der Datenbank (HttpOnly-Cookie), bcrypt; SWITCH edu-ID über OpenID Connect |
| Sprachen | `next-intl` (`messages/de.json`, `messages/en.json`); Nachschlagetabellen mit `name` / `name_en` |
| Betrieb | zwei Docker-Images (App, Datenbank), gebaut im GitLab der BFH, betrieben vom Digital Sustainability Lab (DSL) |

## Schnellstart (lokal)

Voraussetzungen: Node.js 24 und Docker Desktop.

```bash
npm ci
npm run db:reset      # lokale Datenbank mit synthetischen Testdaten aufsetzen
npm run dev           # http://localhost:3000
```

**Testkonten:** `seed-<alias>@example.invalid` mit dem Passwort `Seed-Passwort-1`. Die Liste steht in
`db/seed/seed.sql`.

**edu-ID lokal:**
1. `npm run mock-oidc` starten.
2. Den SWITCH-Block in `.env.local` ausfüllen (Vorlage: `.env.example`).

Vor einem Commit:

```bash
npm run lint
npm run build
npm run db:test-all   # Datenbank- und Datenzugriffstests in einer eigenen Test-Datenbank
```

## Aufbau

```
app/          Seiten (app/[locale]/...), API-Routen (app/api/...), gemeinsame Komponenten
lib/          Logik ohne Oberfläche: Datenzugriff (lib/data), Anmeldung (lib/auth, lib/oidc),
              Datenbankverbindung (lib/db), Exporte und Statistik (lib/admin, lib/statistiken)
db/           Datenbank: Bootstrap, Migrationen, Skripte, Testdaten, Tests
messages/     Oberflächentexte Deutsch / Englisch
deploy/dsl/   Compose-Dateien der Test- und der Produktionsumgebung beim DSL
dev/          lokaler Ersatz für SWITCH edu-ID (Mock-Provider)
```

## Dokumentation

| Datei | Inhalt | Für |
| --- | --- | --- |
| [docs/ENTWICKLUNG.md](docs/ENTWICKLUNG.md) | Architektur, Datenzugriff, Rechte, Konventionen, Tests | Entwicklungsteam |
| [db/README.md](db/README.md) | Datenbank: Rollen, Migrationen, lokale Befehle | Entwicklungsteam |
| [DEPLOY.md](DEPLOY.md) | Images, Inbetriebnahme, Updates, Backups, Datenimport | Betrieb (DSL) |
| [TESTPLAN.md](TESTPLAN.md) | Manuelle Prüfung aller Funktionen vor einem Release | Projektteam |

## Projekt

Entwickelt von Alban Bunjaku, Simon Rofalski und Joel Thomas Bettler im Auftrag von Jan Bieser,
Berner Fachhochschule.
