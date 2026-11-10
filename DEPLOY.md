# Betrieb beim DSL

Für das Digital Sustainability Lab (DSL): Was zum Betrieb des Time Use Tool gehört und wie man es
startet, aktualisiert, sichert und mit Daten befüllt.

## Überblick

Pro Umgebung läuft ein Compose-Stack mit drei Diensten:

| Dienst | Aufgabe |
| --- | --- |
| `tut_app` | die Web-App (Next.js, Port 3000), erreichbar über Traefik im Netz `web` |
| `tut_migrate` | läuft vor jedem Start kurz, bringt das Datenbankschema auf den neuesten Stand und beendet sich |
| `tut_db` | PostgreSQL 17 der App, Daten im Volume `tut_pgdata`. Nur im internen Netz des Stacks, kein Port nach aussen |

| | Test | Produktion |
| --- | --- | --- |
| Compose-Datei | `deploy/dsl/test/compose.yml` | `deploy/dsl/prod/compose.yml` |
| Domain | `time-use-tool-test.digisus-lab.ch` | `time-use-tool.digisus-lab.ch` |
| Image-Tag | `:test` (neuester Stand von `main`) | `:vX.Y.Z` (feste Version) |
| SWITCH edu-ID | `login.test.eduid.ch` | `login.eduid.ch` |
| Daten | leer, nur Testkonten | echte Daten (einmaliger Import) |

Die Compose-Dateien sind im Format des Infrastructure-Repos geschrieben. Anpassen müssen Sie nur:
- den Image-Pfad, also den Pfad des GitLab-Projekts;
- die Namen von Entrypoint und Certresolver in den Traefik-Labels;
- die Vault-Pfade.

## Images

1. GitLab-Projekt als Pull-Mirror des GitHub-Repos anlegen. Dabei **"Trigger pipelines for mirror
   updates"** einschalten und die **Container Registry** aktivieren.
2. Die Pipeline (`.gitlab-ci.yml`) baut mit kaniko die Images `app` und `db`. Dafür braucht sie
   keinen privilegierten Runner.
   - Ein neuer Commit auf `main` ergibt das Tag `:test`.
   - Ein Git-Tag `vX.Y.Z` ergibt das Tag `:vX.Y.Z`.
3. **Release:** Das Projektteam setzt den Tag. Danach tragen Sie die Version in der
   Produktions-Compose-Datei ein, bei allen drei Diensten.

## Geheimnisse

Sieben Einträge pro Umgebung:
- `db_superuser_password`
- `db_owner_password`, `db_app_password`, `db_service_password`
- `reset_decoy_secret`
- `switch_oidc_client_id`, `switch_oidc_client_secret`

Regeln:
- **Nur Buchstaben und Ziffern, mindestens 16 Zeichen**, z. B. `openssl rand -hex 32`. Die
  Passwörter stehen in Datenbank-URLs.
- Die beiden SWITCH-Werte bleiben leer, bis die Registrierung vorliegt. Bis dahin funktioniert nur
  der Passwort-Login.
- Die Datenbank-Passwörter wirken nur beim **ersten** Start. Ein Passwort später ändern:
  1. `docker compose exec tut_db psql -U postgres -c "ALTER ROLE tut_prod_app PASSWORD '<neu>'"`
  2. den Wert im Vault ändern;
  3. `docker compose up -d`.

## Erster Start

```bash
docker compose pull
docker compose up -d
docker compose ps -a                  # tut_db und tut_app "healthy", tut_migrate "Exited (0)"
curl -s https://<domain>/api/health   # {"status":"ok"}
```

Beim ersten Start legt `tut_db` die Datenbank und ihre Logins an. Bricht das ab, z. B. wegen eines zu
kurzen Passworts, steht der Grund in `docker compose logs tut_db`. Dann so vorgehen:
1. `docker compose down`;
2. das Volume löschen (`docker volume rm time-use-tool-<test|prod>_tut_pgdata`);
3. den Fehler beheben und neu starten.

Das gilt **nur für eine neue, leere Installation.**

**Erster Admin in der Testumgebung:** Die Person registriert sich auf der Seite, dann:

```bash
docker compose run --rm -e ALLOW_REMOTE_DB=1 tut_migrate node db/scripts/set-admin.mjs person@bfh.ch
```

Weitere Admins ernennt sie danach selbst in der App.

## Updates

- **Update einspielen:** `docker compose pull && docker compose up -d`. In der Produktion vorher die
  neue Version in der Compose-Datei eintragen. Die App startet erst, wenn `tut_migrate` erfolgreich war.
- **Vor jedem Produktions-Update** ein Backup machen, weil Migrationen nur vorwärts laufen.
- **Zurück zur alten Version:** die alte Version eintragen. Hat das Update die Datenbank verändert,
  zusätzlich das Backup zurückspielen.

## Backups

Das Volume eines laufenden PostgreSQL zu kopieren ergibt kein brauchbares Backup. Erstellen Sie
deshalb regelmässig einen Dump, z. B. täglich per Cron:

```bash
docker compose exec -T tut_db pg_dump -U postgres -d tut_prod -Fc > /backup/tut_prod_$(date +%F).dump
```

Die Dumps enthalten Personendaten. Legen Sie sie verschlüsselt ab und löschen Sie sie nach der
vereinbarten Frist.

**Wiederherstellen** in ein leeres Volume:

```bash
docker compose down
docker volume rm time-use-tool-prod_tut_pgdata
docker compose up -d --wait tut_db
docker compose exec -T tut_db pg_restore -U postgres -d tut_prod --single-transaction < /backup/<datei>.dump
docker compose up -d
```

## Datenimport (einmalig, Produktion)

Das Projektteam übergibt zwei Dateien, verschlüsselt: `data_export.sql` und
`data_export.manifest.json`.

Der Import läuft nur in eine frisch gestartete, noch leere Produktionsdatenbank. Wurden dort vorher
Testkonten angelegt, zuerst das Volume löschen, wie unter "Erster Start" beschrieben.

1. Beide Dateien in dasselbe Verzeichnis auf dem Host legen, z. B. `/srv/tut-import`, lesbar mit
   `chmod 644`. Dann importieren:
   ```bash
   docker compose run --rm -e ALLOW_REMOTE_DB=1 -v /srv/tut-import:/import:ro \
     tut_migrate node db/scripts/import-data.mjs /import/data_export.sql
   ```
   Der Import ist eine einzige Transaktion: Er übernimmt alles oder nichts. Er prüft die Prüfsumme und
   die Zeilenzahlen gegen das Manifest. Bei Erfolg meldet er `manifest ok` und `imported: {…}`.
2. Die beiden Dateien auf dem Host löschen.
3. Ein Admin meldet sich an und prüft die Zahlen. Danach das erste Backup erstellen.

## Hinweise zu Traefik

- `traefik.docker.network=web` ist nötig, weil `tut_app` in zwei Netzen hängt.
- Die Login-Sperren der App gelten pro Client-IP. Traefik muss deshalb die echten Client-Adressen
  sehen. Steht ein Load Balancer oder NAT davor, melden Sie das bitte dem Projektteam.
  `forwardedHeaders.insecure` bitte nicht einschalten.
- HSTS kommt über eine Middleware in den Labels. Sonst reichen die Standardeinstellungen von Traefik.
