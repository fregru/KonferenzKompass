# Roadmap

Ideen und offene Punkte für spätere Versionen. Nichts davon ist umgesetzt; die Reihenfolge innerhalb der Abschnitte ist ein Vorschlag.

## Aus der ursprünglichen TODO-Liste

- **Neuigkeiten / Ankündigungen:** kurzer Hinweis-Banner über der „Jetzt“-Karte (z. B. „AG 2 jetzt in Raum X“), optional mit Ablaufzeit. Erfüllt die ursprüngliche Anforderung „aktuelle Neuigkeiten“ auf der Startseite (derzeit durch Einführungstext und FAQ ersetzt). Läuft über den vorhandenen `version`-Zähler und das Polling mit.
- **Eigene Seiten als Module:** Admins legen selbst Seiten an (bisher nur die sieben festen). Neue Seitenart „Liste/Dateien“ mit hochgeladenen PDFs und Links. Damit lassen sich abdecken:
  - Abkürzungsverzeichnis
  - Liste der GOs (ohne Link auf die GO selbst)
  - Links zur Reflexion

## Für schwaches WLAN vor Ort

- **Offline / PWA:** kleiner Service Worker, der den letzten Stand des Zeitplans, CSS und Grundrisse zwischenspeichert und „Stand hh:mm (offline)“ anzeigt.
- **Caching und Kompression:** `/static/*` mit Versions-Parameter (`?v=`) und langem `Cache-Control`; gzip/brotli über Hono `compress` oder den Reverse-Proxy.

## Live-Steuerung

- **Übersicht im Admin aktualisiert sich selbst** (gleiches ETag-Polling wie die Startseite), damit zwei Personen an zwei Handys nicht mit veraltetem Stand arbeiten.
- **Kalender-Export (ICS)** des Zeitplans, pro Tag oder pro Raum.
- **Raumanzeige für ein Tablet an der Tür:** `/p/lageplan?raum=X&kiosk=1` mit „jetzt / als Nächstes“ für einen Raum.
- **Beamer-Ansicht:** große „Jetzt“-Karte mit Timer für die Leinwand im Saal.

## Betrieb und Weitergabe

- **Komplettes Backup/Restore im Admin:** Zip aus Datenbank-Schnappschuss (`VACUUM INTO`) und Uploads.
- **Änderungsprotokoll:** wer hat welchen Eintrag oder Live-Stand geändert – hilfreich, wenn mehrere Personen den Zeitplan pflegen.
- **Health-Endpoint** und Docker-`HEALTHCHECK`; Container als Nicht-Root-Benutzer.
- **Veranstaltung als JSON exportieren/importieren** (wie beim Lageplan), damit Vorlagen zwischen Installationen oder Organisationen wandern können.
