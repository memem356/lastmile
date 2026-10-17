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
