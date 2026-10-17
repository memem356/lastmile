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
