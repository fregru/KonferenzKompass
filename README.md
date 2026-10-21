# Diko Manager

Diko Manager ist eine simple Webseite, wo alle nötigen Unterlagen und Tools zu einer Diözesankonferenz bzw. Mitgliederversammlung von einem Jugendverband verlinkt bzw. integriert sind. Das Design soll sich im Groben (Farben etc.) an kjg-koeln.de orientieren. Die Versammmlung findet in der Jugendbildungsstätte Haus Altenberg statt. Die Seite soll sich selbst aktualisieren, sodass alle die neusten Updates haben (nicht zu kompliziert aber trotzdem zeitnah). Die Sprache der Seite ist zunächst nur deutsch und die Seite sollte leicht bleiben, da das Internet schwach sein kann.

Seiten gibt es folgende:
- Startseite: Oben Kurzer Abschnitt mit aktuellen Neuigkeiten, darunter der aktuelle Zeitplan, angepasst auf die aktuelle Uhrzeit bzw. welcher Tagesordnungspunkt tatsächlich gerade dran ist (es kann sein, dass ein TO-Punkt überzogen wird). Der Zeitplan zeigt somit sowohl den aktuellen TO Punkt an, als auch was gerade nach geplanter Zeit dran sein soll. Ebenfalls soll hier ein Kontakt sichbar sein (Bild und Kontaktmöglichkeiten), für die Person an die man sich bei Fragen melden kann.
- Lageplan: Eine Karte vom Jugendhaus Altenberg, wo die Räume bzw. Grundrisse sichtbar sind. Hier soll später die Möglichkeit bestehen räume zu mit Namen suchen usw. Ebenfalls soll es später möglich sein vom Zeitplan aus sich den Raum anzeigen zu lassen, damit es einen Überblick gibt.
- Unterlagen: Ein Link zur Nextcloud, wo die Unterlagen gespeichert sind.
- Anträge: Ein Link zu Antragsgrün
- Wahlen: Ein Link zum derzeitigen Wahlen, z.B. Openslides oder VotesUp.
- Hilfe & Service: Eine anpassbare Seite, wo z.B. Hinweise benannt werden können. Weitere Infos, wo man HIlfe bekommt, bzw. wen man ansprechen muss, etc.

Alle Seiten sollen an und ausstellbar sein und deren Namen ebenfalls anpassbar. Demenstprechend auf der Startseite einfach nur den Zeitplan ausstellen.

Ebenfalls soll es natürlich ein Impressum und Datenschutz Link im Footer der Seite geben (anpassbar), sowie auch Copyright.

Um das ganze System zu verwalten, soll es ein Admin-Bereich geben, denn man mit Sicherung (z.B. ein langes Passwort) einsehen kann. Es soll verschiedene Zugangsbeschränkungen geben, die Modular einstellbar sind, sodass z.B. ein Account nur den Zeitplan managen kann.
Hier soll es einfach und verständlich möglich sein die Inhalte anzupassen. Hierrunter zählt vorallem eine einfache Anpassung vom Zeitplan und derzeitgem TO-Punkt, sowie aktuelle Neuigkeiten. Die anderen Inhalte sollen ebenfalls anpassbar sein. Darunter Zählt auch Titel der Seite, Logo, Favicon, etc. sodass später mehrere Organisationen die gleiche Seite nutzen könnten (in einer neuen Installation).

Der Zeitplan soll mind. den Ort, Start und Endzeit (geplant) inkl. Datum bzw. Wochentag, Title, ggf. Beschreibung, ggf. Zuständigkeit (intern, ggf. anzeigbar) anzeigen. Der aktuelle TO PUnkt soll vom Admin-Panel aus anpassbar sein mit fokus von mobil aus. Die Zeit läuft nach aktueller Ortszeit ganz normal weiter. Die Veranstaltung geht meist über mehrere Tage (z.B. drei). Andere TO-Punkte, bekommen bei Verspätung neue vorraussichltiche Zeiten, die alte ist aber noch Sichtbar.

Alte Events sollen archiviert werden bzw. lösch und kopierbar sein. Hier soll eine einfache konfiguration als Speicherung dienen, alle einstellbaren möglichkeiten speichert (z.B. ein json file o.ä.) Alte events sind nicht mehr öffentlich zugänglich.

Stand der Umsetzung: Statt eigener „Neuigkeiten“ gibt es derzeit einen Einführungstext mit FAQ; ein Ankündigungs-Banner steht auf der Roadmap.

# Roadmap

Offene Ideen (Speiseplan-Übersicht, Thekenschichten, Abkürzungsverzeichnis, Liste der GOs, Links zur Reflexion, Neuigkeiten u. a.) stehen in [ROADMAP.md](ROADMAP.md).


## Installation & Betrieb

Alles (Datenbank und hochgeladene Bilder) liegt im Ordner `data/`. **Backup = diesen Ordner kopieren.**

### Variante A: Docker

```sh
ADMIN_USER=admin ADMIN_PASSWORD='ein-langes-passwort' docker compose up -d --build
```

### Variante B: direkt mit Bun

Voraussetzung: [Bun](https://bun.sh) ≥ 1.2.

```sh
bun install --production
ADMIN_USER=admin ADMIN_PASSWORD='ein-langes-passwort' bun run start
```

Die Seite läuft dann auf Port 3000 (änderbar über `PORT`).

### Erster Admin

Beim ersten Start ohne Benutzer wird aus `ADMIN_USER` und `ADMIN_PASSWORD` (mind. 12 Zeichen) ein Admin mit allen Rechten angelegt. Danach werden die Variablen ignoriert; weitere Konten legt man unter *Admin → Benutzer* an.

### Beispielveranstaltung

Beim allerersten Start (leere Datenbank) wird eine aktive Beispiel-Diko über drei Tage ab dem aktuellen Datum angelegt: mit Zeitplan, Einführungstext, FAQ, Ansprechperson und Beispiel-Links. Dazu kommt der Lageplan von Haus Altenberg mit allen Etagen und eingezeichneten Räumen (aus `src/example-venue.json`, einem Lageplan-Export); die Einträge im Zeitplan sind diesen Räumen zugeordnet. Gibt es schon einen Ort, wird kein Lageplan angelegt. Die Beispiel-Diko dient zum Ausprobieren und lässt sich unter *Admin → Veranstaltungen* löschen oder als Vorlage kopieren. Sie wird nur ein einziges Mal angelegt. Die Texte für Impressum und Datenschutz sind Platzhalter und müssen ausgefüllt werden.

### Titelbild

Unter *Admin → Einstellungen* lässt sich ein Titelbild für die Startseite hochladen (Querformat, ca. 1600 px breit, JPG/WebP, möglichst unter 300 KB). Ohne Bild erscheint eine Fläche in der Primärfarbe.

### Zeitplan

Einträge mit **fester Uhrzeit** (z. B. Mittagessen) behalten ihren Beginn, alle anderen beginnen direkt nach dem vorherigen Eintrag. Wird ein Eintrag verschoben (Griff ziehen oder Pfeile), verlängert oder gelöscht, rechnet der Tag sich neu durch. Läuft ein Eintrag in einen festen hinein, zeigt der Zeitplan die Überschneidung rot an.

Ein Veranstaltungstag dauert bis 04:00 Uhr nachts: Was abends beginnt und über Mitternacht läuft (z. B. die Party), bleibt bis dahin „läuft“, und die Live-Steuerung setzt sich erst danach für den neuen Tag zurück. Name und ersten Tag einer Veranstaltung ändert man unter *Admin → Veranstaltungen*; ein neuer erster Tag verschiebt den ganzen Zeitplan mit.

Ein Eintrag kann **Unterpunkte** haben (z. B. parallele Arbeitskreise in verschiedenen Räumen oder Abschnitte nacheinander). Sie liegen innerhalb seiner Zeit und verschieben sich mit ihm.

Bei Einträgen der Art *Pause / Essen* lässt sich unter **Essen** eintragen, was es gibt (ein Gericht pro Zeile, z. B. `vegetarisch: Gemüselasagne`). Es steht im Zeitplan unter der Pause; ohne Eintrag wird nichts angezeigt. In der CSV-Datei ist das die Spalte `Essen`.

Unter *Admin → Zeitplan* lässt sich der Zeitplan als CSV exportieren und importieren (Spalten `Datum;Beginn;Dauer;Titel;Art;TOP;Raum;Ort;Zuständig;Beschreibung;Unterpunkt;Essen`, Excel-Export mit `;` funktioniert). Ein ausgefüllter *Beginn* macht den Eintrag fest; der erste Eintrag eines Tages braucht einen. *Raum* ist der Name oder Kurzname eines Raums aus dem Lageplan (unbekannte Räume landen als Text in *Ort*); ein `x` in *Unterpunkt* hängt die Zeile an den Haupteintrag darüber. Vor dem Import erscheint eine Vorschau mit allen Fehlern. Der Import ersetzt den ganzen Zeitplan und ist nicht mehr möglich, sobald Einträge erledigt sind. Tipp: erst exportieren und die Datei als Vorlage nutzen.

### Lageplan

Unter *Admin → Lageplan* werden Orte (z. B. Haus Altenberg) mit ihren Etagen und Räumen gepflegt – unabhängig von den Veranstaltungen:

1. Ort anlegen, je Etage einen Grundriss hochladen (SVG, PNG oder JPG, höchstens 10 MB).
2. Räume anlegen. *Bereiche* (Foyer, Wiese) lassen sich zuordnen, gelten aber nie als belegt.
3. *Räume einzeichnen*: Raum wählen und Eckpunkte in den Grundriss klicken (oder als Rechteck ziehen), Punkte lassen sich verschieben.
4. In der Veranstaltung den Ort wählen. Danach hat jeder Eintrag ein Feld *Raum*, das zeigt, welche Räume zur Zeit des Eintrags frei sind; eine Doppelbelegung muss bestätigt werden. *Raumbelegung* zeigt alle Räume eines Tages auf einer Zeitleiste.

Ein Ort lässt sich als JSON-Datei (mit Grundrissen) exportieren und in einer anderen Installation wieder importieren – als neuer Ort oder als Ersatz eines vorhandenen (Räume mit gleichem Namen bleiben dabei im Zeitplan verknüpft). Die öffentliche Seite *Lageplan* zeigt den Ort der aktiven Veranstaltung mit Raumsuche; Räume im Zeitplan verlinken direkt dorthin. Wie jede Seite lässt sie sich unter *Seiten* umbenennen oder ausblenden.

### HTTPS

Die App selbst spricht nur HTTP. Davor gehört ein Reverse-Proxy, der HTTPS übernimmt und `X-Forwarded-For` sowie `X-Forwarded-Proto` setzt. Hinter einem Proxy `TRUST_PROXY=1` setzen (in `compose.yaml` schon gesetzt), damit die Sperre nach zu vielen Fehlversuchen pro Besucher-IP greift. Ohne Proxy die Variable weglassen, sonst lässt sich die Sperre mit gefälschten Headern umgehen. Die Docker-Variante ist nur über `127.0.0.1:3000` erreichbar, also nur über den Proxy. Beispiel mit [Caddy](https://caddyserver.com) (`Caddyfile`):

```
diko.example.org {
  encode gzip
  reverse_proxy localhost:3000
}
```

### Update

```sh
git pull
docker compose up -d --build   # bzw. bun install --production && Neustart
```

### Entwicklung

```sh
bun install
bun run dev    # Neustart bei Änderungen
bun test
```
