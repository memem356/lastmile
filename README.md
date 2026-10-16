# Lastmile

Browsergame: Du baust einen Lieferdienst auf einer echten Karte auf (OpenStreetMap-Daten).

Aktueller Stand: Phase 2 (Essen-Innenstadt, Bestellungen, Fahrer, Kasse).

## Aufbau
- `index.html` – das fertige Spiel (wird aus `src/` gebaut)
- `src/template.html` – Oberfläche und Spiellogik
- `src/engine.js` – Straßennetz, Routenberechnung (A*), Fahrtsimulation
- `src/build.py` – baut `index.html` aus Vorlage, Engine und Daten
- `data/essen.json` – Straßen und Orte der Essener Innenstadt

Kartendaten: © OpenStreetMap-Mitwirkende (ODbL), https://www.openstreetmap.org/copyright
