# Roadmap

Ideen für spätere Versionen, nach Thema sortiert. Noch nichts davon ist umgesetzt.

## Inhalte

- **Ankündigungen:** kurzer Hinweis-Banner auf der Startseite (z. B. „AG 2 jetzt in Raum X“), optional mit Ablaufzeit.
- **Eigene Seiten:** Admins legen selbst Seiten an, auch als Liste mit hochgeladenen PDFs und Links – z. B. für Abkürzungsverzeichnis, GO-Liste oder Reflexion.
- **Kalender-Export (ICS)** des Zeitplans, pro Tag oder pro Raum.

## Vor Ort und bei schwachem WLAN

- **Offline-Modus:** der letzte Stand von Zeitplan und Lageplan bleibt ohne Netz verfügbar, mit Hinweis „Stand hh:mm (offline)“.
- **Schnelleres Laden:** statische Dateien lange zwischenspeichern und in der App selbst komprimieren (bisher nur über den Reverse-Proxy).
- **Raumanzeige** für ein Tablet an der Tür: „jetzt / als Nächstes“ für einen Raum.
- **Beamer-Ansicht:** große „Jetzt“-Karte mit Timer für die Leinwand im Saal.

## Live-Steuerung

- **Admin-Übersicht aktualisiert sich selbst**, damit mehrere Personen nicht mit veraltetem Stand arbeiten.
- **Änderungsprotokoll:** wer hat welchen Eintrag oder Live-Stand geändert.

## Betrieb

- **Backup und Wiederherstellung** direkt im Admin-Bereich.
- **Veranstaltung exportieren und importieren** (wie beim Lageplan), damit Vorlagen zwischen Installationen wandern können.
- **Health-Check** für Docker; Container ohne Root-Rechte.

## Mitmachen

Ideen, Fehlermeldungen und Pull Requests sind willkommen – am besten als [Issue](https://github.com/fregru/KonferenzKompass/issues).
