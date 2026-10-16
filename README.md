# Lastmile

Browsergame: Du baust einen Lieferdienst auf einer echten Karte auf (OpenStreetMap-Daten).

Aktueller Stand: Phase 4a (Wirtschaft: Ruf, Löhne, Fahrerstufen, Ausbau-Shop, Auto-Disposition) auf Basis von Phase 3. Beliebige Stadt weltweit suchen (Nominatim), Straßen, Läden und Häuser live laden (Overpass), im Browser speichern (IndexedDB). Spielschleife aus Phase 2: Bestellungen, Fahrer, Kasse.

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
