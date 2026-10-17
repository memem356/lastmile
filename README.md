# Lastmile

Browsergame: Du baust einen Lieferdienst auf einer echten Karte auf (OpenStreetMap-Daten).

Aktueller Stand: Phase 5 (Spielmodi Entspannt und Rush; Hauptquartier- und Fahrerfenster mit geplanten Schulungen) auf Basis von Phase 4 (Wirtschaft: Ruf, Löhne, Fahrerstufen, Ausbau-Shop, Auto-Disposition; Hubs, Liefergebiet, Partner-Restaurants) auf Basis von Phase 3. Beliebige Stadt weltweit suchen (Nominatim), Straßen, Läden und Häuser live laden (Overpass), im Browser speichern (IndexedDB). Spielschleife aus Phase 2: Bestellungen, Fahrer, Kasse.

Spiel: https://memem356.github.io/lastmile/

## Aufbau
- `index.html` – das fertige Spiel (wird aus `src/` gebaut)
- `src/template.html` – Oberfläche und Spiellogik
- `src/loader.js` – Stadtsuche, Kartendaten laden, Kompaktformat, Cache
- `src/boot.js` – Startbildschirm
- `src/engine.js` – Straßennetz, Routenberechnung (A*), Fahrtsimulation
- `src/build.py` – baut `index.html` aus Vorlage, Engine und Daten
- `data/essen.json` – Straßen und Orte der Essener Innenstadt (Offline-Demo)

Kartendaten: © OpenStreetMap-Mitwirkende (ODbL), https://www.openstreetmap.org/copyright

## Phase 6 (Realismus)
Tageszeit-Kurve und Wochentage, Rushhour-Verkehr, Wetter, Pannen, Ereignisse (Stau, Straßenfest, Großbestellung, Krankmeldung), Nachfrage-Karte (Taste H) und Höhenprofil: Steigungen bremsen vor allem Fahrräder. Höhendaten kommen von Open-Meteo (für neu geladene Städte live, für das Essen-Demo eingebettet). Bereits gespeicherte Städte sind flach, bis sie neu geladen werden.

## Phase 7 (Speichern, Erfolge, Ton, Handy)
- Automatisches Speichern im Browser (pro Stadt und Modus), Fortsetzen über den Startbildschirm, Neues Spiel im Menü.
- Offline-Fortschritt: Mit Dispositions-Software und eingeschalteter Auto-Disposition arbeitet der Betrieb bis zu 4 Stunden weiter, wenn die Seite geschlossen ist (vereinfachtes Modell).
- 18 Erfolge, synthetischer Ton (abschaltbar im Menü), Tutorial beim ersten Start.
- Handy-Layout mit Tabs (Aufträge, Karte, Fahrer), Pinch-Zoom und größeren Tippflächen.

## Phase 6b (Verkehr und Ereignisse)
- Das Spiel startet mit der echten Ortszeit und dem Wochentag der Stadt (Zeitzone über Open-Meteo, das Essen-Demo nutzt Europe/Berlin).
- Verkehr je Straßenabschnitt nach deutscher Rushhour (Spitzen morgens und nachmittags, freitags früher, samstags Einkaufsverkehr, sonntags ruhig), mit Richtungsbias (morgens Richtung Zentrum, abends heraus) und Engstellen an Kreuzungen großer Straßen. Farben (Grün bis Dunkelrot) lassen sich im Menü und mit der Taste T ausschalten.
- Ereignisse mit Ort und Symbol auf der Karte: Stau, Unfall, Baustelle, Straßenfest; dazu Großbestellung, Panne und Krankmeldung. Ihre Häufigkeit folgt der Tageszeit und dem Wetter.
- Hauptquartier: drei Ausbaustufen für das Ausweichen (Verkehrsfunk, Live-Navigation, Prognose-Navigation). Fahrer planen mit dem Verkehr, den sie kennen, und weichen unterwegs aus.
- Löhne und Fahrzeugkosten (Wartung und Fahrstrecke) werden gesammelt und einmal pro Stunde zur vollen Uhrzeit abgebucht. Die Anzeige "Abbuchung um HH:00" im Block Betrieb zeigt den aktuellen Betrag.

## Finanzen und Statistik
- Das linke Panel zeigt nur noch die offenen Bestellungen.
- Klick auf die **Kasse** (oder Taste **K**) öffnet das Fenster mit den Tabs **Finanzen** (Einnahmen, laufende Kosten, Investitionen, Kennzahlen, Balkendiagramm der letzten 12 Spielstunden) und **Statistik** (Lieferungen, Pünktlichkeit, Lage, Fahrer, beliebte Orte, erlebte Ereignisse, Erfolge).
- In der Kopfzeile zeigen drei Chips Wetter (Symbol und Temperatur, Tag/Nacht nach Sonnenstand), Verkehr (Farbpunkt, Rushhour) und Ereignisse; ein Klick öffnet die Statistik bzw. springt zum Ereignis.
- Alle Ausgaben laufen über `spend(art, betrag)`; das Geldbuch (`led`) wird mit gespeichert (ältere Spielstände starten mit leeren Werten).

## Rush-Modus entschärft, Ausweichen sichtbar
- Rush startet mit 30 % der Nachfrage und steigt über 5 Spielstunden auf das volle Niveau; Aufträge laufen erst nach dem 2-fachen der Zielzeit ab (Rufverlust je Storno 0,12).
- Weicht ein Fahrer aus (ab 30 s Zeitgewinn): Meldung im Protokoll und als Hinweis, grüner Ring mit „↪ −m:ss min“ an der Karte, „Umweg −m:ss“ in der Fahrerkarte, Zähler „Ausgewichen“ in der Statistik.

## Stoßzeitenverkehr ohne Ereignis
- Die Grundlast je Straße enthält jetzt Rückstau an Kreuzungen (Zufahrten auf Knoten, an denen Hauptstraßen aufeinandertreffen oder Nebenstraßen einmünden) und zusammenhängende Engstellen-Zonen (ca. 350 m). Dadurch werden zur Stoßzeit auch ohne Ereignis Kreuzungsbereiche gelb bis rot, mittags bleibt es überwiegend grün. Ereignisse kommen als Zuschlag obendrauf.

## Phase 8a: Spielstände absichern
- Format v2. Beim Laden werden fehlende Felder mit Standardwerten ergänzt und unmögliche Werte begrenzt (`normalizeSave`); Stände aus älteren Versionen laden weiter.
- Sicherung: beim Laden entsteht eine Kopie des Stands (`….bak`), außerdem etwa alle 10 Minuten im Spiel. Ist der Hauptstand defekt, wird die Sicherung geladen.
- Defekte Stände werden nie überschrieben, sondern unter `lm.bad.*` aufgehoben (die letzten 6). Ein Hinweisfenster erlaubt, sie als Datei zu sichern; auf der Startseite stehen sie ebenfalls.
- Stammt ein Stand aus einer neueren Spielversion, wird er nicht überschrieben (Sitzung ohne Speichern, mit Hinweis).
- Hat sich die Karte der Stadt geändert, werden Bestellungen, Partner-Lokale, Hubs und Fahrer über Koordinaten neu zugeordnet; nicht zuordenbare Partner werden erstattet.
- Menü: Spielstand exportieren/importieren (JSON-Datei); Import auch auf der Startseite.
- Die Seite bittet Suchmaschinen per Meta-Tag, sie nicht aufzunehmen.

## Phase 8b: Berechenbare Welt
- Wetter, Stau/Unfall/Baustelle/Straßenfest sowie Großbestellung und Krankmeldung folgen jetzt allein aus einem Startwert (`WORLD.seed`) und der Weltzeit (`worldT()`), ohne Zufall pro Spieler. Zwei Spiele mit gleichem Startwert erleben zur gleichen Zeit dasselbe (Test: `?debug&seed=123`, `__lm.world`).
- Wetter: feste 3-Stunden-Zeitfenster, Übergänge aus einer Kette ab Weltstart (`wxAtSlot`).
- Verkehrsereignisse: Zeitraster je Art, Wahrscheinlichkeit nach Tageslast, Wetter und Modus; Höchstzahl gleichzeitiger Ereignisse wie bisher. Die Straße wird aus dem Liefergebiet des Spielers gewählt (Zeit und Art sind gleich, der Ort kann sich unterscheiden).
- Beim Laden und nach Abwesenheit werden aktive Ereignisse und das Wetter aus der Weltzeit neu berechnet (`scanWorldEvents`, `syncWeather`). Der Startwert steht im Spielstand.
- Bestellungen, Pannen und persönliche Folgen bleiben individuell.
- Grundlage für Phase 8d: Dort wird die Weltzeit vom Server vorgegeben (`WORLD.t0`, 30-fach).

## Phase 8c: Konto und Cloud-Sicherung (Firebase)
- **Aufbau:** Das Spiel bleibt eine statische Seite auf GitHub Pages. Konten und Cloud-Daten liegen bei Firebase (Tarif Spark, ohne Zahlungsmittel): *Authentication* (E-Mail und Passwort) und *Realtime Database*. Es werden keine Firebase-Bibliotheken geladen, `src/online.js` spricht die offenen REST-Schnittstellen direkt an (`LMO`). Die Zugangswerte in `src/online.js` (Projekt, Webschlüssel) sind öffentlich gedacht; geschützt werden die Daten durch `firebase-rules.json`.
- **Datenbank-Adresse:** Beim ersten Start wird automatisch gefunden, in welcher Region die Datenbank liegt (Europa/USA/Asien) und gemerkt.
- **Datenmodell** (alles unter dem Konto-Kennzeichen `uid`, der Name ist nur Anzeige und kann später geändert werden):
  - `redeemed/<uid>`: benutzter Einladungscode (steht in den Regeln, dort änderbar). Ohne ihn darf niemand etwas schreiben.
  - `users/<uid>`: `{name, key, created}`, nur für den Besitzer lesbar. `key` ist der Name klein geschrieben mit `_` statt Leerzeichen.
  - `names/<key>`: gehört `<uid>`; garantiert eindeutige Namen. Einzelne Namen sind ohne Anmeldung prüfbar, die Liste nicht. Pro Konto nur ein Anspruch (er muss zum Profil passen).
  - `saves/<uid>/<platz>` und `savemeta/<uid>/<platz>`: Cloud-Spielstände (JSON als Text, höchstens 400 000 Zeichen) und eine kurze Beschreibung. Platz = `s_<Koordinaten>_<Modus>`.
  - `clock/<uid>`: ein Schreibzugriff mit Server-Zeitstempel liefert die Serverzeit (Vorbereitung für Phase 8d, `LMO.syncClock()`).
- **Registrierung:** Name (3–16 Zeichen, Buchstaben/Zahlen/Leerzeichen/_/-, kurze Sperrliste und reservierte Namen, Namensvorschlag), E-Mail, Passwort (mind. 8), Einladungscode, Häkchen für die Datenschutz-Hinweise. Reihenfolge: Konto anlegen → Einladung einlösen → Profil → Namensanspruch → Bestätigungsmail. Scheitert ein Schritt, wird alles zurückgenommen. Unterbrochene Registrierungen lassen sich beim nächsten Login abschließen; fehlt nur der Namensanspruch, wird er automatisch nachgeholt.
- **Weiteres:** Anmelden, Abmelden, „Passwort vergessen“ (E-Mail von Firebase), E-Mail-Bestätigung erneut senden/prüfen, Konto löschen (fragt das Passwort, löscht Stände, Profil, Namen und Konto).
- **Cloud-Sicherung:** Im Konto-Fenster lassen sich Solo-Spielstände hochladen und auf einem anderen Gerät laden. Beim Laden bleibt der bisherige lokale Stand als `.bak` erhalten; ist der Gegenstand neuer, wird nachgefragt.
- **Sicherheitsregeln** (`firebase-rules.json`, in der Firebase-Konsole unter *Realtime Database → Regeln* einfügen und veröffentlichen). Weil das Projekt öffentlich ist, steht in der Datei nur der Platzhalter `LM-BEISPIEL`; der echte Einladungscode steht ausschließlich in den Regeln in der Firebase-Konsole und kann dort jederzeit geändert werden (Zeile `redeemed`, `.validate`). Die Regeln: Fremde Daten sind weder lesbar noch schreibbar, Felder werden geprüft (Format, Größe, Zusatzfelder verboten), `created`/Zeitstempel kommen vom Server, der Anzeigename lässt sich nur zusammen mit dem Schlüssel ändern.
- **Tests** (ohne Internet, mit einem Nachbau von Firebase samt Regelprüfung in `tests/fbmock.js`): `node tests/lmo_test.js` (Bausteine und Regeln, 129 Prüfungen) und `python3 tests/ui_account.py` (Oberfläche im Browser, 35 Prüfungen). Der Nachbau prüft die Regeln mit eigener Auswertung und ersetzt keinen Test gegen das echte Firebase.
- Nebenbei behoben: Sicherungskopien (`….bak`) tauchten auf der Startseite doppelt unter „Weiter spielen“ auf.

## Phase 8d: Online-Modus und Ranglisten
- **Spielart:** Auf der Startseite steht „Solo“ neben „Online“. Solo bleibt unverändert (ohne Konto, mit Pause und Tempo). Online braucht ein Konto mit abgeschlossener Registrierung; Stadt wählt man wie im Solo-Spiel, je Stadt gibt es ein eigenes Unternehmen. Die Adresse merkt sich `&m=o`.
- **Feste Weltzeit:** Die Spielzeit ist eine Funktion der Serverzeit: `LMO.world.gameNow() = (Serverzeit − 1.10.2026 00:00 UTC) · 30`. Alle Spieler sehen dieselbe Uhrzeit, dasselbe Wetter und dieselben Verkehrsereignisse (`WORLD.seed` folgt aus der Stadt, `WORLD.t0` hängt die Weltzeit an die Serveruhr, `START = WORLD.t0`). Es gibt keine Pause und keine Tempowahl; Dialoge halten das Spiel nicht an. Die Serverzeit wird beim Start aus drei Messungen mit Firebase-Zeitstempel geschätzt (kürzeste Laufzeit gewinnt) und alle 10 Minuten aufgefrischt. Die Schleife holt kleine Lücken in 6-Sekunden-Schritten nach.
- **Abwesenheit:** Wird eine Lücke größer als 8 echte Sekunden (Tab im Hintergrund, Neuladen, Ruhezustand, Wiedereinstieg), greift das bekannte Abwesenheitsmodell: Ohne Dispositions-Software ruht der Betrieb (kein Lohn, nichts geliefert), mit Software und Auto-Disposition arbeitet er mit. Angerechnet wird höchstens **1 echte Stunde (= 30 Spielstunden)**; danach läuft die Welt weiter, das Unternehmen nicht. Offene Bestellungen bleiben bei Pausen unter 2 Minuten erhalten. Nach jeder Abwesenheit werden Wetter und Ereignisse aus der Weltzeit neu bestimmt.
- **Spielregeln online:** Eigener Modus `MODES.online` (ein Regelwerk für alle, damit Ranglisten vergleichbar sind). Bestellungen entstehen weiter individuell pro Spieler.
- **Cloud-Stand und Gerätesperre:** Der maßgebliche Stand liegt in `saves/<uid>/o_<Stadt>` (alle 60 s, bei Verstecken/Schließen und über „Jetzt speichern“); auf dem Gerät bleibt nur eine Kopie `lm.osave.<uid>.<Stadt>` (alle 15 s), die nie unter „Weiter spielen“ erscheint. Beim Öffnen übernimmt die Sitzung (`sessions/<uid>/o_<Stadt>`, Zufallskennung); die Regeln lassen einen Stand nur mit der aktuellen Kennung zu. Wird das Unternehmen auf einem zweiten Gerät/Tab geöffnet, wird die alte Sitzung beim nächsten Speichern beendet (Dialog „Sitzung beendet“), damit nichts doppelt zählt. Die Gerätekopie wird nur genutzt, wenn sie neuer ist und zur zuletzt gültigen Sitzung gehört (Cloud war nicht erreichbar).
- **Unternehmenswert und Wachstum:** Wert = Kasse + Kaufpreise von Fahrzeugen, Upgrades, Hub-Ausbau, Zusatz-Hubs, Liefergebiet und Partnern (Schulungen und Einstellgebühren zählen nicht). Wachstum = Wert − Startwert (210 €). Tag und Woche zählen ab dem Wert, den das Unternehmen beim letzten Speichern vor dem Zeitraum hatte.
- **Rangliste:** `board/<Stadt|_global>/<all|day|week>/<uid>` = `{n Name, c Stadt, g Wachstum, l Lieferungen, r Ruf, p Zeitraum, t Serverzeit}`. Gesamt: Wachstum, Lieferungen, Ruf (nur je Stadt); Heute und Woche: Wachstum; weltweit: bestes Wachstum eines Unternehmens. Tag/Woche beginnen um 02:00 UTC (Woche: Montag). Gewertet wird der Höchstwert des Zeitraums (Werte sinken nie). Im Spiel: Chip „Rang n von m“ in der Kopfzeile und Menü → Rangliste. Abfragen laufen über `orderBy` mit `.indexOn` (`p`, `g`, `l`, `r`).
- **Regeln der Rangliste** (`firebase-rules.json`): nur der Besitzer schreibt seinen Eintrag; Name muss dem Profil entsprechen; Zeitstempel und Zeitraum (`p`) müssen zur Serverzeit passen; `g` und `l` dürfen nicht sinken und nur plausibel wachsen (höchstens 10 € bzw. 1,5 Lieferungen je echter Sekunde seit dem letzten Eintrag, neue Zeiträume höchstens bezogen auf Zeitraum- bzw. Kontoalter, plus kleiner Puffer); keine Zusatzfelder. **Grenze:** Das Spiel läuft komplett im Browser, ein entschlossener Spieler kann Werte fälschen. Die Regeln begrenzen nur grobe Ausreißer (siehe 8f).
- **Aufgeben/Löschen:** Menü → „Unternehmen aufgeben“ löscht Stand, Sitzung und Stadt-Einträge (der weltweite Bestwert bleibt). Konto löschen entfernt zusätzlich alle Rangeinträge und Sitzungen.
- **Nebenbei:** Abgelaufene Anmeldemarken werden einmal automatisch erneuert (REST-Aufruf wird wiederholt), das Profil wird auch geladen, wenn die E-Mail-Prüfung scheitert.
- **Tests:** `node tests/lmo_online_test.js` (Weltzeit, Sitzungssperre, Rangliste samt Angriffsfällen gegen die Regeln, 103 Prüfungen), `python3 tests/ui_online.py` (Browser: Startseite, Uhr 30-fach, Cloud-Speichern, zweites Gerät, Abwesenheit 10 min/30 min/3 h, Zwischenzeit, Gerätekopie, Aufgeben, Handy-Breite, 63 Prüfungen); die älteren Tests (`lmo_test.js` 129, `ui_account.py` 35) laufen unverändert weiter.
