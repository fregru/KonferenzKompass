<div align="center">

# KonferenzKompass

**Der Live-Zeitplan für Konferenzen und Mitgliederversammlungen.**<br>
Alle sehen auf dem Handy, was gerade läuft, wo es stattfindet und was als Nächstes kommt.

[![Lizenz: AGPL-3.0](https://img.shields.io/badge/Lizenz-AGPL--3.0-00b6be)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.2-black?logo=bun)](https://bun.sh)
[![Docker](https://img.shields.io/badge/Docker-bereit-2496ED?logo=docker&logoColor=white)](compose.yaml)

<img src="docs/screenshots/startseite.png" alt="Startseite: TOP 1 läuft mit 12 Minuten Verspätung, die folgenden Zeiten sind neu berechnet" width="800">

</div>

KonferenzKompass ist eine leichte, selbst gehostete Webseite – entstanden für die Diözesankonferenzen von Jugendverbänden. Verschiebt sich etwas im Ablauf, sehen es alle sofort. Die Seite ist bewusst schlank, damit sie auch bei schwachem WLAN funktioniert.

## Funktionen

- **Live-Zeitplan:** zeigt den aktuellen TOP, Verspätungen und die voraussichtlichen neuen Zeiten (die geplanten bleiben sichtbar). Gesteuert wird er vom Handy aus über die Live-Steuerung im Admin-Bereich; die Startseite aktualisiert sich selbst.
- **Zeitplanung:** feste und fließende Einträge, Unterpunkte (z. B. parallele Arbeitskreise), Essen bei Pausen, CSV-Import und -Export.
- **Lageplan:** Grundrisse je Etage, eingezeichnete Räume, Raumsuche und Raumbelegung. Räume im Zeitplan verlinken direkt auf den Plan. Der Plan der Jugendbildungsstätte **Haus Altenberg** ist schon enthalten – wer dort tagt, muss nichts selbst einzeichnen.
- **Seiten:** Unterlagen, Anträge, Wahlen (Links z. B. zu Nextcloud, Antragsgrün, OpenSlides), Hilfe & Service, Impressum und Datenschutz – alle umbenenn- und ausblendbar.
- **Startseite:** Einführungstext, FAQ und Ansprechperson mit Foto.
- **Eigenes Erscheinungsbild:** Titel, Logo, Favicon, Farben und Titelbild.
- **Admin-Bereich:** mehrere Konten mit einzeln vergebbaren Rechten (z. B. nur Zeitplan).
- **Veranstaltungen** archivieren, kopieren und löschen. Archivierte sind nicht mehr öffentlich.

Die Oberfläche ist auf Deutsch.

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/handy-startseite.png" alt="Startseite auf dem Handy" width="240"><br><sub>Für Teilnehmende: was gerade läuft</sub></td>
    <td align="center"><img src="docs/screenshots/handy-live.png" alt="Live-Steuerung auf dem Handy" width="240"><br><sub>Live-Steuerung: ein Tipp auf „Weiter“</sub></td>
    <td align="center"><img src="docs/screenshots/handy-lageplan.png" alt="Lageplan von Haus Altenberg mit hervorgehobenem Kapitelsaal" width="240"><br><sub>Lageplan: der Raum zum TOP</sub></td>
  </tr>
</table>

## Installation

Voraussetzung: Docker oder [Bun](https://bun.sh) ≥ 1.2.

```sh
# mit Docker
ADMIN_USER=admin ADMIN_PASSWORD='ein-langes-passwort' docker compose up -d --build

# oder direkt mit Bun
bun install --production
ADMIN_USER=admin ADMIN_PASSWORD='ein-langes-passwort' bun run start
```

Die Seite läuft auf Port 3000, der Admin-Bereich unter `/admin`.

Beim ersten Start wird aus `ADMIN_USER` und `ADMIN_PASSWORD` (mind. 12 Zeichen) ein Admin mit allen Rechten angelegt; danach werden die Variablen ignoriert. Außerdem entsteht eine Beispielveranstaltung mit Zeitplan und dem Lageplan von Haus Altenberg zum Ausprobieren. Sie lässt sich unter *Admin → Veranstaltungen* löschen oder als Vorlage kopieren. Impressum und Datenschutz enthalten nur Platzhalter und müssen ausgefüllt werden.

| Variable | Bedeutung |
|---|---|
| `ADMIN_USER`, `ADMIN_PASSWORD` | erster Admin (nur beim ersten Start) |
| `PORT` | Port, Standard `3000` |
| `TRUST_PROXY` | `1` hinter einem Reverse-Proxy, damit die Sperre nach Fehlversuchen pro Besucher-IP greift. Ohne Proxy weglassen. |

Die App spricht nur HTTP; für HTTPS gehört ein Reverse-Proxy davor (z. B. Caddy oder nginx). Die Docker-Variante ist deshalb nur über `127.0.0.1:3000` erreichbar.

**Daten und Backup:** Datenbank und hochgeladene Dateien liegen im Ordner `data/`. Backup = diesen Ordner kopieren.

**Update:** `git pull`, dann `docker compose up -d --build` bzw. `bun install --production` und Neustart.

## Gut zu wissen

- **Feste und fließende Einträge:** Einträge mit fester Uhrzeit (z. B. Mittagessen) behalten ihren Beginn, alle anderen schließen direkt an den vorherigen an. Überschneidungen zeigt der Zeitplan rot an.
- **Tageswechsel:** Ein Veranstaltungstag dauert bis 04:00 Uhr, damit z. B. die Party über Mitternacht weiterläuft.
- **CSV-Import:** Am einfachsten erst exportieren und die Datei als Vorlage nutzen (Excel mit `;` funktioniert). Vor dem Import zeigt eine Vorschau alle Fehler. Der Import ersetzt den ganzen Zeitplan.
- **Lageplan weitergeben:** Ein Ort lässt sich samt Grundrissen als JSON exportieren und in einer anderen Installation importieren.

## Entwicklung

```sh
bun install
bun run dev    # Neustart bei Änderungen
bun test
```

Technik: [Bun](https://bun.sh), [Hono](https://hono.dev) mit serverseitigem JSX, SQLite, wenig JavaScript im Browser.

Ideen für spätere Versionen stehen in der [ROADMAP](ROADMAP.md).

## Lizenz

[GNU AGPL-3.0](LICENSE). Wer eine veränderte Version öffentlich betreibt, muss den geänderten Quellcode ebenfalls zugänglich machen.
