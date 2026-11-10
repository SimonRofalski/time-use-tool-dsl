# Testplan

Manuelle Prüfung aller Funktionen vor einem Release, für alle Rollen. Abhaken mit `[x]`. Bei einem
Fehler notieren: Seite, Schritt, erwartetes und tatsächliches Verhalten, Screenshot.

## Vorbereitung

- **Testumgebung:** `https://time-use-tool-test.digisus-lab.ch`, oder lokal mit `npm run db:reset` und
  `npm run dev` (http://localhost:3000).
- **Teilnehmer-Tests:** ein eigenes Testkonto anlegen, entweder selbst registrieren oder als Admin
  über "Account anlegen". Dann in einen Testkurs einschreiben.
- **Varianten:** einmal hell und einmal dunkel, einmal Deutsch und einmal Englisch, einmal in schmaler
  Ansicht (Handy oder Entwicklertools des Browsers).

Automatisch bereits geprüft (musst du nicht wiederholen): Datenbank-Zugriffsregeln (`npm run db:test-all`),
Laden/Speichern der Seiten auf Datenebene, edu-ID-Login gegen den Mock (`npm run test:edu-id`),
Docker-Images und der DSL-Stack aus `deploy/dsl/` (`npm run test:dsl-stack`).

## 1. Anmeldung und Konto

- [ ] Registrieren mit neuer E-Mail: klappt, danach Pflicht-Schritte (Profil, Sicherheitsfragen)
- [ ] Registrieren mit bereits vorhandener E-Mail: verständliche Fehlermeldung
- [ ] Anmelden mit falschem Passwort: Meldung "ungültige Anmeldedaten", kein Login
- [ ] Anmelden mit richtigem Passwort: landet in der App
- [ ] Abmelden (Profil-Menü): zurück zur Login-Seite; geschützte Seite direkt aufrufen leitet auf Login um
- [ ] Passwort vergessen: Sicherheitsfragen erscheinen, richtige Antworten erlauben neues Passwort,
      falsche Antworten werden abgelehnt (nach 5 Fehlversuchen gesperrt)
- [ ] Unbekannte E-Mail bei "Passwort vergessen": es erscheinen trotzdem Fragen (kein Hinweis, ob es
      das Konto gibt)
- [ ] Neuer Login nach Passwort-Reset: altes Passwort geht nicht mehr, neues schon
- [ ] Erster Login: Profilformular ist Pflicht, Sicherheitsfragen sind Pflicht (bei Passwort-Konto)
- [ ] Kurs beitreten: falscher Zugangscode abgelehnt, richtiger Code funktioniert
- [ ] Nach dem Beitritt bleibt man eingeschrieben (auch nach Ab- und wieder Anmelden)
- [ ] Profil bearbeiten über das Profil-Menü: Änderungen bleiben gespeichert
- [ ] Sprache umstellen (Einstellungen): Oberfläche wechselt, bleibt nach erneutem Login erhalten
- [ ] Hell/Dunkel umstellen: bleibt nach Neuladen erhalten
- [ ] Tutorial startet beim ersten Mal automatisch; "Tutorial neu starten" in den Einstellungen geht;
      Überspringen und Fertigstellen merken sich, dass es gesehen wurde

## 2. Eingabe (Zeiterfassung)

- [ ] Tag wählen, 10-Minuten-Felder markieren (einzeln und als Bereich)
- [ ] Haupttätigkeit wählen, auch über die Suche (z. B. "duschen", "gamen" finden die richtige Tätigkeit)
- [ ] Nebentätigkeit, Gerät, Mit wem, Wo, Zufriedenheit setzen; je nach Kurs die Zusatzfragen
- [ ] Frage "fokussiert / nebenbei" beim Gerät erscheint nur, wenn der Kurs sie aktiviert hat, ein Gerät
      gewählt ist und es eine Nebentätigkeit gibt
- [ ] Speichern: Einträge sind nach Neuladen noch da
- [ ] Bereits erfasste Felder überschreiben und löschen
- [ ] Ganzer Tag (24 h) erfasst: Tag gilt als abgeschlossen/abgegeben
- [ ] Tagesfragebogen (wenn im Kurs aktiv): erscheint, Antworten bleiben gespeichert
- [ ] Tage-Navigation: die Pfeile enden am ersten bzw. letzten Kurstag (Tage ausserhalb der Kurszeit
      sind nicht wählbar)

## 3. Übersicht (Erfasste Zeit)

- [ ] Alle Kurstage erscheinen, Status pro Tag stimmt (leer / in Bearbeitung / abgeschlossen)
- [ ] Zusammenfassung oben stimmt mit den Tagen überein
- [ ] Klick auf einen Tag führt zur Eingabe dieses Tages; "Tagesfragen" öffnet den Tagesfragebogen

## 4. Statistiken

- [ ] Zeitverteilung: Balken pro Tag, Kategorien aufklappbar, Geräte/Mit wem/Wo-Auswertungen
- [ ] Filter Werktage/Wochenende und KW: Werte ändern sich passend
- [ ] Kursvergleich (Kurs mit Vergleich aktiv): Werte für "Du" und "Kurs", **keine Nullen** bei Kurswerten
      (Schlaf, Sport, Smartphone, Kategorien, Gerät, Mit anderen, Zuhause, Wohlbefinden)
- [ ] Kursvergleich ausgeschaltet bzw. zu wenige Teilnehmende: entsprechender Hinweis statt Werte
- [ ] PDF-Export der eigenen Statistik: Datei öffnet sich, Inhalte stimmen

## 5. Admin-Bereich

Kursübersicht:
- [ ] Liste der Kurse, Details eines Kurses, Tage einer Person ansehen
- [ ] Kurs anlegen (mit mehreren Zeiträumen und Zugangscode); fehlerhafte Eingabe legt nichts halb an
- [ ] Zugangscode ändern; Schalter (gesperrt, Kursvergleich, Zusatzfragen, Tagesfragebogen, Gerätefrage)
- [ ] Person aus Statistiken ausschliessen / wieder einschliessen
- [ ] Einschreibung entfernen
- [ ] Anonymisieren eines Kurses (nur an einem Testkurs!)
- [ ] Export "aggregiert" (XLSX), "roh" (CSV) und "Forschung" (XLSX): Dateien laden, Inhalte plausibel;
      bei zu wenigen Teilnehmenden kommt die Meldung statt der Datei

Nutzerübersicht:
- [ ] Suche nach Name, E-Mail, Kurs
- [ ] Account anlegen: temporäres Passwort wird angezeigt; beim ersten Login muss die Person es ändern
- [ ] Temp-Passwort setzen für eine bestehende Person: alte Sitzungen sind danach abgemeldet
- [ ] Löschen eines Test-Accounts (mit Bestätigung); eigenes Konto kann nicht gelöscht werden
- [ ] Admin-Abzeichen sichtbar; "Zum Admin machen" / "Admin-Rechte entfernen" mit Rückfrage;
      bei dir selbst kein Entfernen-Knopf; die Person sieht nach dem Neuladen die passende Ansicht

Admin-Statistiken:
- [ ] Kennzahlen und Diagramme laden, Zahlen plausibel

## 6. Auf der Produktionsumgebung (nach dem Release kurz wiederholen)

- [ ] Login mit Passwort (bestehender Admin), Kursübersicht zeigt die erwarteten Zahlen
- [ ] edu-ID-Login, sobald die SWITCH-Registrierung da ist (neuer Nutzer und Verknüpfung)
- [ ] Ein Teilnehmer-Account: Eingabe speichern, Statistik und Kursvergleich ansehen
- [ ] `https://<domain>/api/health` liefert `{"status":"ok"}`

## Ergebnis

| Bereich | Getestet von | Datum | Ergebnis / offene Punkte |
| --- | --- | --- | --- |
| 1. Anmeldung und Konto | | | |
| 2. Eingabe | | | |
| 3. Übersicht | | | |
| 4. Statistiken | | | |
| 5. Admin | | | |
