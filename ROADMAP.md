# Roadmap

Ideen für spätere Versionen, nach Thema sortiert. Noch nichts davon ist umgesetzt.

## Inhalte

- **Ankündigungen:** kurzer Hinweis-Banner auf der Startseite (z. B. „AG 2 jetzt in Raum X“), optional mit Ablaufzeit. Dazu ein Knopf „In WhatsApp teilen“, der den Text fertig in WhatsApp öffnet (Teilen-Menü bzw. `wa.me`-Link), damit er schnell im Kanal oder in der Gruppe der Veranstaltung landet – automatisch posten geht bei WhatsApp nicht. Ein Link zum WhatsApp-Kanal der Veranstaltung auf der Startseite.
- **Eigene Seiten:** Admins legen selbst Seiten an, auch als Liste mit hochgeladenen PDFs und Links – z. B. für Abkürzungsverzeichnis, GO-Liste oder Reflexion.
- **Kalender-Export (ICS)** des Zeitplans, pro Tag oder pro Raum.

## Vor Ort und bei schwachem WLAN

- **App zum Installieren (PWA)**, in Stufen:
  - *Stufe 1:* Manifest aus den Einstellungen (Titel, Logo, Farben) für ein Icon auf dem Startbildschirm, dazu ein kleiner Service Worker. Zeitplan, Seiten und Live-Daten kommen immer zuerst aus dem Netz; ohne Netz zeigt die App den letzten Stand mit Hinweis „Stand hh:mm (offline)“. CSS, JS und Grundrisse werden mit Versions-Parameter lange zwischengespeichert, Antworten in der App selbst komprimiert.
  - *Admin-Bereich:* mit installierbar (auf Android als Verknüpfung direkt zur Live-Steuerung), aber nur online: nichts aus dem Cache, keine zwischengespeicherten Klicks – ohne Netz erscheint „Offline – Änderungen erst wieder mit Netz möglich“. Auf dem iPhone meldet man sich in der installierten App einmal neu an.
  - *Stufe 2 (optional):* Push-Mitteilungen für Ankündigungen. Zuverlässig auf Android und am Rechner, auf dem iPhone nur bei installierter App (ab iOS 16.4) – erreicht dort also nur wenige.
  - Zu beachten: ein veralteter „Jetzt“-Stand darf nie wie ein aktueller aussehen; Updates müssen den alten Cache sicher ablösen; Safari löscht den Cache nach etwa 7 Tagen ohne Nutzung.
- **Raumanzeige** für ein Tablet an der Tür: „jetzt / als Nächstes“ für einen Raum.
- **Beamer-Ansicht:** große „Jetzt“-Karte mit Timer für die Leinwand im Saal.

## Technik

- **Automatische Sicherung:** einmal pro Nacht eine Sicherung (wie unter *Admin → Sicherung*) nach `data/backups/`, die letzten 7 bleiben. Schützt auch vor versehentlich gelöschten Veranstaltungen.
- **Sicherheits-Header für alle Seiten:** strenge `Content-Security-Policy` (alle Skripte sind eigene Dateien), Schutz vor Einbetten in fremde Seiten (`frame-ancestors`) und `Referrer-Policy`. Bisher haben nur hochgeladene Dateien eine CSP.
- **Kontrast-Prüfung** in den Einstellungen: Hinweis, wenn weiße Schrift auf der gewählten Primärfarbe schlecht lesbar ist.
- **Tests unabhängig von der Uhrzeit:** die Admin-Routen nutzen `Date.now()` statt der austauschbaren Uhr der öffentlichen Seiten; Live-Tests können deshalb zwischen 00:00 und 04:00 fehlschlagen (der Veranstaltungstag dauert bis 04:00).
- **CI auf GitHub:** bei jedem Push und Pull Request Typprüfung, Tests und Docker-Build.

## Mitmachen

Ideen, Fehlermeldungen und Pull Requests sind willkommen – am besten als [Issue](https://github.com/fregru/KonferenzKompass/issues).
