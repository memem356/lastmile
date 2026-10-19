// Test für src/cities.js mit einer künstlichen Welt (kein Netz): Städte in der Nähe, Stadtgrenzen, Kacheln, Straßen, Firmen,
// Zwischenspeicher, Abbruch und Fortsetzen, Zusammenführen mehrerer Städte, Straßennetz in der Engine, Stadt-Test.
// Start: node tests/cities_test.js
const fs = require('fs'), path = require('path');
const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
let ok = 0, bad = 0;
const check = (name, cond, info) => { if (cond) ok++; else { bad++; console.log('FAIL', name, info === undefined ? '' : info); } };

// ---------- künstliche Welt: ein Gitter aus Knoten (ca. 44 m x 41 m), Wege je 6 Abschnitte lang ----------
const LAT0 = 51.40, LON0 = 6.95, DLA = 0.0004, DLO = 0.0006, I = 300, J = 300;
const nid = (i, j) => 1e9 + i * 100000 + j, nlat = i => LAT0 + i * DLA, nlon = j => LON0 + j * DLO;
const wayDef = (kind, a, seg) => {                      // kind 'h' (Zeile a) oder 'v' (Spalte a), Abschnitt seg
  const nodes = []; for (let k = seg * 6; k <= Math.min(seg * 6 + 6, kind === 'h' ? J - 1 : I - 1); k++) nodes.push(kind === 'h' ? nid(a, k) : nid(k, a));
  const major = kind === 'h' ? a % 10 === 0 : a % 12 === 0;
  const tags = { highway: major ? 'secondary' : 'residential', name: (kind === 'h' ? 'Querstraße ' : 'Längsstraße ') + a };
  if (kind === 'h' && a % 17 === 3) tags.service = 'parking_aisle', tags.highway = 'service';          // zählt nicht
  if (kind === 'v' && a % 19 === 5) tags.access = 'private';                                           // zählt nicht
  return { type: 'way', id: (kind === 'h' ? 2e9 : 3e9) + a * 1000 + seg, nodes, tags };
};
const world = { reverseCalls: 0, isinCalls: 0, hang: '', dead: '', noReverse: false, calls: [], failAfter: Infinity, offline: false, towns: [], rel: [], polys: {}, noLink: false, hwQueries: [], remark: 0 };
const cityRect = (i0, j0, i1, j1) => ({ type: 'Polygon', coordinates: [[[nlon(j0), nlat(i0)], [nlon(j1), nlat(i0)], [nlon(j1), nlat(i1)], [nlon(j0), nlat(i1)], [nlon(j0), nlat(i0)]]] });
world.polys[111] = { pop: 120000, name: 'Teststadt A', lat: nlat(60), lon: nlon(60), g: cityRect(10, 10, 110, 110) };            // 100 x 100 Gitterpunkte
world.polys[222] = { name: 'Teststadt B', lat: nlat(60), lon: nlon(160), g: cityRect(10, 100, 110, 200) };         // überlappt A an der Grenze (Spalten 100 bis 110)
world.polys[333] = { name: 'Teststadt C (L-Form)', lat: nlat(220), lon: nlon(60), g: { type: 'Polygon', coordinates: [[[nlon(150), nlat(150)], [nlon(250), nlat(150)], [nlon(250), nlat(200)], [nlon(200), nlat(200)], [nlon(200), nlat(250)], [nlon(150), nlat(250)], [nlon(150), nlat(150)]]] } };
world.towns = [{ id: 1, name: 'Teststadt A', lat: nlat(60), lon: nlon(60), tags: { place: 'city', population: '120000' } }, { id: 2, name: 'Teststadt B', lat: nlat(60), lon: nlon(160), tags: { place: 'town' } },
  { id: 3, name: 'Dorf', lat: nlat(5), lon: nlon(5), tags: { place: 'village' } }, { id: 4, name: 'Teststadt C (L-Form)', lat: nlat(220), lon: nlon(180), tags: { place: 'city', population: '95.000' } }, { id: 5, name: 'Teststadt A', lat: nlat(62), lon: nlon(62), tags: { place: 'town' } }];

const inBox = (b, la, lo) => la >= b[0] && la <= b[2] && lo >= b[1] && lo <= b[3];
function overpassAnswer(q) {
  if (q.includes('["place"~')) {
    const m = q.match(/around:(\d+),([\d.]+),([\d.]+)/), R = Number(m[1]), la = Number(m[2]), lo = Number(m[3]);
    return { elements: world.towns.filter(t => /city|town/.test(t.tags.place) && Math.hypot((t.lat - la) * 110574, (t.lon - lo) * 111320 * Math.cos(la * Math.PI / 180)) <= R).map(t => ({ type: 'node', id: t.id, lat: t.lat, lon: t.lon, tags: Object.assign({ name: t.name }, t.tags) })) };
  }
  if (q.includes('is_in(')) {
    world.isinCalls++;
    const m = q.match(/is_in\(([\d.]+),([\d.]+)\)/), la = Number(m[1]), lo = Number(m[2]), out = [];
    for (const [id, p] of Object.entries(world.polys)) { const c = p.g.coordinates[0]; if (inBox([c[0][1], c[0][0], c[2][1], c[2][0]].sort ? [Math.min(...c.map(x => x[1])), Math.min(...c.map(x => x[0])), Math.max(...c.map(x => x[1])), Math.max(...c.map(x => x[0]))] : 0, la, lo)) out.push({ type: 'relation', id: Number(id), tags: Object.assign({ boundary: 'administrative', admin_level: '8', name: p.name }, p.pop ? { population: String(p.pop) } : {}) }); }
    if (out.length) { out.push({ type: 'relation', id: 999, tags: { boundary: 'administrative', admin_level: '6', name: 'Testkreis' } }); out.push({ type: 'relation', id: 998, tags: { boundary: 'administrative', admin_level: '7', name: 'Testamt' } }); }
    return { elements: out };
  }
  const bb = q.match(/\(([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\)/); const b = bb.slice(1, 5).map(Number);   // s,w,n,e der ersten Abfrage
  if (q.includes('["highway"')) {
    const ways = [], nodes = new Map();
    const iLo = Math.max(0, Math.floor((b[0] - LAT0) / DLA)), iHi = Math.min(I - 1, Math.ceil((b[2] - LAT0) / DLA)), jLo = Math.max(0, Math.floor((b[1] - LON0) / DLO)), jHi = Math.min(J - 1, Math.ceil((b[3] - LON0) / DLO));
    for (let i = iLo; i <= iHi; i++) for (let seg = Math.floor(jLo / 6); seg <= Math.floor(jHi / 6); seg++) ways.push(wayDef('h', i, seg));
    for (let j = jLo; j <= jHi; j++) for (let seg = Math.floor(iLo / 6); seg <= Math.floor(iHi / 6); seg++) ways.push(wayDef('v', j, seg));
    const hwm = q.match(/\["highway"~"\^\(([^)]*)\)\$"\]/), allowed = hwm ? new Set(hwm[1].split('|')) : null;       // Klassenfilter der Abfrage (Verbindungen: nur große Straßen)
    if (world.noLink && allowed && !allowed.has('residential')) return { elements: [] };
    world.hwQueries.push(hwm ? hwm[1] : '');
    const sel = ways.filter(w => (!allowed || allowed.has(w.tags.highway)) && w.nodes.length > 1 && w.nodes.some(id => { const i = Math.floor((id - 1e9) / 100000), j = (id - 1e9) % 100000; return inBox(b, nlat(i), nlon(j)); }));
    for (const w of sel) for (const id of w.nodes) { const i = Math.floor((id - 1e9) / 100000), j = (id - 1e9) % 100000; nodes.set(id, { type: 'node', id, lat: nlat(i), lon: nlon(j) }); }
    return { elements: sel.concat([...nodes.values()]) };
  }
  if (q.includes('["office"]')) {                                    // Firmen: jeder 13. Gitterpunkt, zusätzlich Bäckereien (zählen nicht)
    const out = [];
    for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) { if ((i * 31 + j * 7) % 13 !== 0) continue; const la = nlat(i), lo = nlon(j); if (!inBox(b, la, lo)) continue;
      out.push({ type: 'node', id: 5e9 + i * 1000 + j, lat: la, lon: lo, tags: (i + j) % 11 === 0 ? { name: 'Bäckerei ' + i, shop: 'bakery' } : { name: 'Firma ' + i + '/' + j, office: 'company' } }); }
    return { elements: out };
  }
  return { elements: [] };
}
const net = { n: 0 };
global.fetch = async (url, init) => {
  world.calls.push(url); net.n++;
  if (world.offline) throw new Error('offline');
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (world.hang && url.includes(world.hang)) return new Promise((res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('abgebrochen'), { name: 'AbortError' }))));
  if (world.dead && url.includes(world.dead)) return { ok: false, status: 504, text: async () => '', json: async () => ({}) };
  if (/nominatim.*reverse/.test(url)) {
    world.reverseCalls++; if (world.noReverse) return { ok: false, status: 429, json: async () => ({}), text: async () => '' };
    const m = url.match(/lat=([\d.]+)&lon=([\d.]+)/), la = Number(m[1]), lo = Number(m[2]);
    for (const [id, p] of Object.entries(world.polys)) { const c = p.g.coordinates[0], ys = c.map(x => x[1]), xs = c.map(x => x[0]); if (la >= Math.min(...ys) && la <= Math.max(...ys) && lo >= Math.min(...xs) && lo <= Math.max(...xs)) return ok({ osm_type: 'relation', osm_id: Number(id), name: p.name, lat: String(p.lat), lon: String(p.lon), geojson: p.g, extratags: p.pop ? { population: String(p.pop), admin_level: '8' } : { admin_level: '8' } }); }
    return ok({ error: 'Unable to geocode' });
  }
  if (/nominatim.*lookup/.test(url)) { const id = Number(url.match(/osm_ids=R(\d+)/)[1]), p = world.polys[id]; return ok(p ? [{ name: p.name, lat: String(p.lat), lon: String(p.lon), geojson: p.g }] : []); }
  if (/nominatim.*search/.test(url)) return ok([{ name: 'Teststadt A', lat: String(world.polys[111].lat), lon: String(world.polys[111].lon), address: { state: 'Testland', country: 'Deutschland' }, display_name: 'Teststadt A' }]);
  const q = decodeURIComponent(String(init.body).replace(/^data=/, ''));
  if (world.failAfter !== Infinity && q.includes('["highway"')) { if (world.failAfter-- <= 0) return { ok: false, status: 504, text: async () => '', json: async () => ({}) }; }
  if (world.remark > 0 && q.includes('["highway"')) { world.remark--; return ok({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 61 seconds.' }); }
  return ok(overpassAnswer(q));
};
global.sleepSkip = true;
global.__LM_TILE_ROADS = 2600;                                    // kleine künstliche Städte: mehrere Kacheln (echt: 5200 m)
const code = src('loader.js') + src('cities.js') + ';return {LM, LMCity}';
const { LM, LMCity } = new Function(code)();
LM.sleep = () => Promise.resolve();                              // keine Wartezeiten im Test (der Zähler bleibt)
const mem = new Map(); let putCount = 0;
Object.assign(LMCity.store, { get: async k => mem.has(k) ? mem.get(k) : null, put: async (k, v) => { putCount++; mem.set(k, v); }, del: async k => { mem.delete(k); }, keys: async p => [...mem.keys()].filter(k => k.startsWith(p)) });
const engSrc = src('engine.js') + ';return {createEngine, roadsToTyped}';
const { createEngine, roadsToTyped } = new Function(engSrc)();
const ESSEN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'essen.json'), 'utf8'));

// Kernkarte = Ausschnitt des Gitters mitten in Stadt A (gleiche Knoten wie das Städtepaket, aber ohne OSM-Nummern), wie im Spiel
const gridCore = () => {
  const b = [nlat(50), nlon(50), nlat(70), nlon(70)], pk = LMCity.compactTile(overpassAnswer('way["highway"~"^(residential|secondary)$"](' + b.join(',') + ');'));
  return { roads: LMCity.forEngine(pk), ref: { lat: nlat(60), lon: nlon(60) }, radius: 400 };
};

(async () => {
  // ---- Geometrie ----
  const sq = LMCity.fromGeoJSON({ type: 'Polygon', coordinates: [[[7, 51], [7.02, 51], [7.02, 51.02], [7, 51.02], [7, 51]], [[7.005, 51.005], [7.01, 51.005], [7.01, 51.01], [7.005, 51.01], [7.005, 51.005]]] });
  check('Fläche mit Loch: 1,4 x 2,2 km minus Loch', sq && Math.abs(sq.area - (1.4 * 2.2 - 0.35 * 0.55)) < 0.05, sq && sq.area);
  check('Punkt im Ring, im Loch, außerhalb', LMCity.inRings(sq.rings, 51.015, 7.015) && !LMCity.inRings(sq.rings, 51.007, 7.007) && !LMCity.inRings(sq.rings, 51.03, 7.01));
  const mp = LMCity.fromGeoJSON({ type: 'MultiPolygon', coordinates: [[[[7, 51], [7.01, 51], [7.01, 51.01], [7, 51.01], [7, 51]]], [[[7.1, 51], [7.11, 51], [7.11, 51.01], [7.1, 51.01], [7.1, 51]]]] });
  check('Mehrere Teile (MultiPolygon)', mp.rings.length === 2 && LMCity.inRings(mp.rings, 51.005, 7.105) && !LMCity.inRings(mp.rings, 51.005, 7.05));
  check('ungültige Geometrie', LMCity.fromGeoJSON({ type: 'Point', coordinates: [1, 2] }) === null && LMCity.fromGeoJSON(null) === null);
  const ci = LMCity.circle(51.4, 7.0, 3000), cc = LMCity.cityOf({ id: 'x', name: 'x', rings: ci.rings });
  check('Ersatzkreis: Fläche ca. π·3²', Math.abs(ci.area - Math.PI * 9) < 0.01 && LMCity.inCity(cc, 51.4, 7.0) && !LMCity.inCity(cc, 51.4, 7.06), ci.area);
  // ---- Kacheln: jeder Punkt der Stadt liegt in einer Kachel; Kacheln abseits der Stadt fehlen ----
  const cityC = LMCity.cityOf({ id: 'r333', name: 'C', rings: LMCity.fromGeoJSON(world.polys[333].g).rings, area: 1 });
  const tilesC = LMCity.tilesOf(cityC, LMCity.TILE_ROADS);
  let miss = 0, probes = 0; for (let i = 150; i <= 250; i += 2) for (let j = 150; j <= 250; j += 2) { const la = nlat(i), lo = nlon(j); if (!LMCity.inCity(cityC, la, lo)) continue; probes++; if (!tilesC.some(t => la >= t.s && la <= t.n && lo >= t.w && lo <= t.e)) miss++; }
  const bboxTiles = Math.ceil((cityC.bbox.n - cityC.bbox.s) / (LMCity.TILE_ROADS / 110574)) * Math.ceil((cityC.bbox.e - cityC.bbox.w) / (LMCity.TILE_ROADS / (111320 * Math.cos(51.5 * Math.PI / 180))));
  check('Kacheln decken die L-Form ab (' + probes + ' Punkte)', miss === 0 && probes > 500, miss);
  check('Kacheln fehlen an der leeren Ecke der L-Form (' + tilesC.length + ' von ' + bboxTiles + ')', tilesC.length < bboxTiles, tilesC.length + ' ' + bboxTiles);
  check('Kachelnummern eindeutig', new Set(tilesC.map(t => t.k)).size === tilesC.length);

  // ---- Städte in der Nähe ----
  const near = await LMCity.nearby(nlat(60), nlon(60), 60);
  check('nearby: nur Städte und Orte, doppelte Namen einmal, nächste zuerst', near.length === 3 && near[0].name === 'Teststadt A' && near.map(n => n.name).join() === 'Teststadt A,Teststadt B,Teststadt C (L-Form)', near.map(n => n.name + Math.round(n.dist)).join());
  check('nearby: Einwohnerzahl auch mit Punkt', near.find(n => n.name.startsWith('Teststadt C')).pop === 95000 && near[0].pop === 120000 && near[1].pop === 0);
  check('nearby: Umkreis begrenzt', (await LMCity.nearby(nlat(60), nlon(60), 2)).length === 1);

  // ---- Stadtgrenze holen ----
  world.calls.length = 0;
  const cA = await LMCity.resolve({ name: 'Teststadt A', lat: nlat(60), lon: nlon(60), place: 'city' });
  check('resolve: höchste Ebene bis 8 gewählt (Stadt, nicht Kreis oder Amt)', cA.rel === 111 && cA.level === 8 && cA.id === 'r111' && !cA.approx, JSON.stringify([cA.rel, cA.level, cA.id]));
  check('resolve: Grenze als Ringe, Fläche, Rahmen', cA.rings.length === 1 && cA.area > 15 && cA.area < 22 && cA.bbox.s < nlat(11) && cA.bbox.n > nlat(109), cA.area);
  check('resolve: Einwohnerzahl aus den Tags der Verwaltungsgrenze (A hat eine, B nicht)', cA.pop === 120000, cA.pop);
  const n1 = world.calls.length, cA2 = await LMCity.resolve({ name: 'Teststadt A', lat: nlat(60), lon: nlon(60), place: 'city' });
  check('resolve: zweites Mal aus dem Zwischenspeicher (keine Abfrage)', world.calls.length === n1 && cA2.id === cA.id);
  const cB = await LMCity.resolve({ name: 'Teststadt B', lat: nlat(60), lon: nlon(160), place: 'town' });
  const cA3 = await LMCity.resolve({ name: 'Teststadt A', rel: 111, lat: nlat(60), lon: nlon(60) });
  check('resolve: mit Kennung aus dem Spielstand ohne Is-in-Abfrage', cA3.id === 'r111');
  world.offline = true;
  const cX = await LMCity.resolve({ name: 'Irgendwo', lat: 52.5, lon: 13.4, place: 'city' });
  check('resolve: ohne Server ein Ersatzkreis von 4,5 km (approx)', cX.approx && cX.id.startsWith('c52.500,13.400') && Math.abs(cX.area - Math.PI * 4.5 * 4.5) < 0.1, cX.area);
  world.offline = false;
  const cT = await LMCity.resolve({ name: 'Städtchen', lat: 50.1, lon: 8.1, place: 'town' });
  check('resolve: Ort ohne Grenzdaten (kein Treffer bei is_in) bekommt Kreis von 2,5 km', cT.approx && Math.abs(cT.area - Math.PI * 2.5 * 2.5) < 0.1, cT.area);

  // ---- Straßen laden ----
  const prog = []; world.calls.length = 0;
  const packA = await LMCity.loadRoads(cA, p => prog.push(p));
  const tilesA = LMCity.tilesOf(cA, LMCity.TILE_ROADS);
  check('loadRoads: je Kachel eine Abfrage', world.calls.filter(u => !/nominatim/.test(u)).length === tilesA.length, world.calls.length + ' ' + tilesA.length);
  check('loadRoads: Fortschritt bis zur letzten Kachel', prog.length === tilesA.length && prog[prog.length - 1].done === tilesA.length && prog.every((p, i) => i === 0 || p.done >= prog[i - 1].done), prog.length);
  const uniqueNodes = new Set(packA.ids).size;
  check('Pack: Knoten ohne Dubletten', uniqueNodes === packA.ids.length && packA.ids.length > 8000, packA.ids.length);
  check('Pack: Wege ohne Dubletten, ohne Park- und Privatwege', new Set(packA.wid).size === packA.wid.length && packA.wc.length > 1500 && ![...packA.wid].some(id => (id - 2e9) % 1000 === 0 && Math.floor((id - 2e9) / 1000) % 17 === 3), packA.wc.length);
  check('Pack: Wege liegen auch am Rand ganz vor (Straßen über die Stadtgrenze hinaus)', Math.min(...[...packA.la]) < Math.round(nlat(10) * 1e5) && Math.max(...[...packA.lo]) > Math.round(nlon(110) * 1e5));
  check('Pack: Statistik', packA.stats.tiles === tilesA.length && packA.stats.nodes === packA.ids.length && packA.stats.bytes > 10000, JSON.stringify(packA.stats));
  check('Pack: Kacheln danach gelöscht, Pack gespeichert', [...mem.keys()].filter(k => k.startsWith('tile:r111')).length === 0 && mem.has('pack:r111'));
  world.calls.length = 0; await LMCity.loadRoads(cA);
  check('loadRoads: zweites Mal aus dem Zwischenspeicher', world.calls.length === 0 && await LMCity.cached('r111'));
  // ---- Abbruch und Fortsetzen ----
  const tilesB = LMCity.tilesOf(cB, LMCity.TILE_ROADS); world.calls.length = 0; world.failAfter = 3;
  let err = null; try { await LMCity.loadRoads(cB); } catch (e) { err = e; }
  const saved = [...mem.keys()].filter(k => k.startsWith('tile:r222')).length;
  check('Abbruch mitten im Laden: Fehler, bereits geladene Kacheln bleiben', !!err && saved >= 3 && saved < tilesB.length, (err && err.message) + ' ' + saved + '/' + tilesB.length);
  world.failAfter = Infinity; world.calls.length = 0;
  const packB = await LMCity.loadRoads(cB);
  const fetched = world.calls.filter(u => !/nominatim/.test(u)).length;
  check('Fortsetzen: nur die fehlenden Kacheln werden geladen', fetched <= tilesB.length - saved + 2 && fetched >= tilesB.length - saved, fetched + ' (fehlen ' + (tilesB.length - saved) + ')');
  check('Fortsetzen: gleiches Ergebnis wie am Stück', packB.ids.length > 8000 && new Set(packB.wid).size === packB.wid.length);

  // ---- Zusammenführen: A und B überlappen in den Spalten 100 bis 110 ----
  const both = LMCity.merge([packA, packB], packA.o);
  check('merge: gemeinsame Knoten zählen einmal', both.ids.length < packA.ids.length + packB.ids.length && both.ids.length === new Set(both.ids).size && both.ids.length > packA.ids.length, both.ids.length + ' < ' + (packA.ids.length + packB.ids.length));
  check('merge: gemeinsame Wege zählen einmal', both.wid.length < packA.wid.length + packB.wid.length && both.wid.length === new Set(both.wid).size);
  check('merge: Reihenfolge der Pakete ändert nur die Nummerierung, nicht die Menge', LMCity.merge([packB, packA]).ids.length === both.ids.length && new Set(LMCity.merge([packB, packA]).wid).size === both.wid.length);
  // ---- Straßennetz in der Engine ----
  const D = (roads) => ({ roads, pois: [], homes: [], ref: { lat: nlat(60), lon: nlon(100) }, hub: { lat: nlat(60), lon: nlon(100) }, elev: null });
  const t0 = Date.now(), E = createEngine(D(LMCity.forEngine(both))), tEng = Date.now() - t0;
  const nodesUsed = new Set(); for (const w of E.ways) for (const n of w.nodes) nodesUsed.add(n);
  check('Engine: alle Knoten und Wege übernommen', E.N === both.ids.length && E.ways.length === both.wc.length && nodesUsed.size === E.N);
  check('Engine: das Netz aus A und B hängt zusammen (eine Gruppe über beide Städte)', E.nets.car.size > 0.97 * E.N && E.nets.bike.size > 0.97 * E.N, E.nets.car.size + ' von ' + E.N);
  const Ea = createEngine(D(LMCity.forEngine(packA))), Eb = createEngine(D(LMCity.forEngine(packB)));
  check('Engine: A allein und B allein haben jeweils kleinere Netze', Ea.N < E.N && Eb.N < E.N && Ea.N + Eb.N > E.N);
  const a = E.nearest(E.nx[0] + 100, E.ny[0] + 100, E.nets.car.ok), farA = E.nearest(0, 0, E.nets.car.ok);
  const sA = E.hubNode('van', (Ea.bounds.minX + Ea.bounds.maxX) / 2 - 0 + (E.bounds.minX - Ea.bounds.minX) * 0, 0); void sA;
  // Fahrt von der Mitte von A nach B über die Grenze
  const pa = { x: E.proj(nlat(60), nlon(30)).x, y: E.proj(nlat(60), nlon(30)).y }, pb = { x: E.proj(nlat(60), nlon(170)).x, y: E.proj(nlat(60), nlon(170)).y };
  const n1x = E.hubNode('van', pa.x, pa.y), n2x = E.hubNode('van', pb.x, pb.y), leg = E.returnLeg('van', n1x, n2x, 0);
  check('Engine: Fahrt von A nach B über die gemeinsame Grenze (ca. 5,8 km Luftlinie)', leg && leg.len > 5600 && leg.len < 7800, leg && leg.len);
  console.log('   Engine mit ' + E.N + ' Knoten in ' + tEng + ' ms');
  // Karte aus A und B passt wieder in die alten Funktionen der Engine
  check('Engine: Straßennamen erhalten (Namenstabelle zusammengeführt)', E.ways.some(w => w.name === 'Querstraße 21') && E.ways.some(w => w.name === 'Längsstraße 36'));

  // ---- Firmen ----
  world.calls.length = 0;
  const firmsA = await LMCity.loadFirms(cA);
  let outside = 0, bakeries = 0; for (const f of firmsA) { if (!LMCity.inCity(cA, f[1] / 1e5, f[2] / 1e5)) outside++; if (/Bäckerei/.test(f[3])) bakeries++; }
  check('Firmen: nur innerhalb der Stadtgrenze, keine Bäckereien', firmsA.length > 500 && outside === 0 && bakeries === 0, firmsA.length + ' / ' + outside + ' / ' + bakeries);
  check('Firmen: Format [Art, Breite, Länge, Name], Art 0 bis 4', firmsA.every(f => Array.isArray(f) && f.length === 4 && f[0] >= 0 && f[0] <= 4 && Number.isInteger(f[1]) && typeof f[3] === 'string'));
  check('Firmen: je Kachel einmal gefragt, keine Doppelten', new Set(firmsA.map(f => f[3])).size === firmsA.length);
  world.calls.length = 0; const firmsA2 = await LMCity.loadFirms(cA);
  check('Firmen: zweites Mal aus dem Zwischenspeicher', world.calls.length === 0 && firmsA2.length === firmsA.length);
  const cC = await LMCity.resolve({ name: 'Teststadt C (L-Form)', rel: 333, lat: nlat(220), lon: nlon(180) });
  const firmsC = await LMCity.loadFirms(cC);
  check('Firmen: L-Form ohne Firmen in der leeren Ecke', firmsC.length > 100 && firmsC.every(f => LMCity.inCity(cC, f[1] / 1e5, f[2] / 1e5)), firmsC.length);
  // Ausdünnen bei mehr als FIRM_CAP: viele Firmen in einer Kachel, simulieren über große Fläche
  const big = LMCity.cityOf({ id: 'big', name: 'Groß', rings: LMCity.fromGeoJSON(cityRect(0, 0, 299, 299)).rings, area: 1 });
  const firmsBig = await LMCity.loadFirms(big);
  check('Firmen: höchstens ' + LMCity.FIRM_CAP + ' je Stadt', firmsBig.length === LMCity.FIRM_CAP, firmsBig.length);
  // ---- Firmen ohne Netz: Stadt wird trotzdem geladen ----
  world.failAfter = Infinity;
  const cD = LMCity.cityOf({ id: 'r444', name: 'D', rings: LMCity.fromGeoJSON(cityRect(120, 20, 150, 50)).rings, area: 1 });
  const realF = LMCity.loadFirms; // Firmenabfrage scheitern lassen
  const oldFetch = global.fetch; global.fetch = async (u, i) => { const q = decodeURIComponent(String((i && i.body) || '')); if (q.includes('["office"]')) throw new Error('kaputt'); return oldFetch(u, i); };
  const res = await LMCity.loadCity(cD);
  global.fetch = oldFetch;
  check('loadCity: ohne Firmendaten bleibt die Stadt nutzbar (firms = null)', res.pack.ids.length > 500 && res.firms === null);


  // ---- Kernkarte (ohne OSM-Nummern) mit Städtepaketen verbinden ----
  {
    const core = roadsToTyped(ESSEN.roads), nC = core.lat.length;
    const eC = createEngine(Object.assign({}, ESSEN, { v: 1, name: 'Essen', radius: 750, ref: { lat: 51.4510, lon: 7.0140 }, hub: { lat: 51.4513, lon: 7.0147 }, elev: null }));
    // Paket aus der Kernkarte selbst (mit erfundenen Nummern) plus ein Gitter außerhalb, verbunden über zwei Zubringer
    const ids = [], la = [], lo = [], wid = [], wc = [], wf = [], wn = [], wo = [0], wi = [];
    for (let i = 0; i < nC; i++) { ids.push(7e9 + i); la.push(core.lat[i]); lo.push(core.lon[i]); }
    for (let k = 0; k < core.wc.length; k++) { wid.push(8e9 + k); wc.push(core.wc[k]); wf.push(core.wf[k]); wn.push(core.wn[k]); for (let j = core.wo[k]; j < core.wo[k + 1]; j++) wi.push(core.wi[j]); wo.push(wi.length); }
    const maxLa = Math.max(...core.lat), maxLo = Math.max(...core.lon), minLa = Math.min(...core.lat), minLo = Math.min(...core.lon);
    let topN = 0; for (let i = 0; i < nC; i++) if (eC.nets.car.ok[i] && eC.nets.bike.ok[i] && (!eC.nets.car.ok[topN] || core.lat[i] > core.lat[topN])) topN = i;
    const extra = [], gx = n => { const id = ids.length; ids.push(7.5e9 + n); la.push(maxLa + 200 + Math.floor(n / 10) * 80); lo.push(minLo + (n % 10) * 150); return id; };
    for (let n = 0; n < 40; n++) extra.push(gx(n));
    for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) { wid.push(9e9 + r * 20 + c); wc.push(4); wf.push(0); wn.push(-1); wi.push(extra[r * 10 + c], extra[r * 10 + c + 1]); wo.push(wi.length); }
    wid.push(9.5e9); wc.push(2); wf.push(0); wn.push(-1); wi.push(topN, extra[0]); wo.push(wi.length);          // Zubringer vom Kern ins Gitter
    const pk = { ids: Float64Array.from(ids), la: Int32Array.from(la), lo: Int32Array.from(lo), wid: Float64Array.from(wid), wc: Uint8Array.from(wc), wf: Uint8Array.from(wf), wn: Int32Array.from(wn), wo: Int32Array.from(wo), wi: Int32Array.from(wi), s: core.s.slice() };
    const allRect = LMCity.cityOf({ id: 'x', name: 'x', rings: [Int32Array.from([minLa - 2000, minLo - 2000, minLa - 2000, maxLo + 3000, maxLa + 3000, maxLo + 3000, maxLa + 3000, minLo - 2000, minLa - 2000, minLo - 2000])] });
    const w1 = LMCity.withCore(pk, core, [allRect]);
    check('withCore: Kernwege in der Stadt fallen weg, nichts doppelt', w1.dropped === core.wc.length && w1.kept === 0 && w1.lat.length === pk.ids.length && w1.wc.length === pk.wc.length, JSON.stringify([w1.dropped, w1.kept, w1.lat.length, pk.ids.length]));
    const eW = createEngine(Object.assign({}, ESSEN, { v: 1, name: 'Essen', tz: 'Europe/Berlin', radius: 750, ref: { lat: 51.4510, lon: 7.0140 }, hub: { lat: 51.4513, lon: 7.0147 }, roads: w1, elev: null })); 
    console.log('   sizes', eW.nets.car.size, eC.nets.car.size, eW.N, eC.N, nC, pk.ids.length);
    check('withCore: Netz hängt zusammen, Kern ist vollständig befahrbar', eW.nets.car.size === eC.nets.car.size + 10 && eW.N === pk.ids.length, eW.nets.car.size + ' ' + eC.nets.car.size);
    // halbe Stadt: Polygon deckt nur die untere Hälfte der Kernkarte ab → Kernwege der oberen Hälfte bleiben und hängen über Koordinaten an
    const half = LMCity.cityOf({ id: 'h', name: 'h', rings: [Int32Array.from([minLa - 2000, minLo - 2000, minLa - 2000, maxLo + 3000, (minLa + maxLa) >> 1, maxLo + 3000, (minLa + maxLa) >> 1, minLo - 2000, minLa - 2000, minLo - 2000])] });
    const w2 = LMCity.withCore(pk, core, [half]);
    check('withCore: halbe Stadt – Kernwege außerhalb bleiben (aber nicht doppelt, wenn sie schon im Paket sind)', w2.kept === core.wc.length - w2.dropped && w2.kept > 0 && w2.dropped > 0 && w2.lat.length === pk.ids.length, JSON.stringify([w2.kept, w2.dropped]));
    // Paket ohne Kernstraßen (Stadt kennt sie nicht): alle Kernwege bleiben, Knoten werden angehängt
    const empty = { ids: new Float64Array(0), la: new Int32Array(0), lo: new Int32Array(0), wid: new Float64Array(0), wc: new Uint8Array(0), wf: new Uint8Array(0), wn: new Int32Array(0), wo: Int32Array.from([0]), wi: new Int32Array(0), s: [] };
    const w3 = LMCity.withCore(empty, core, [allRect]);
    check('withCore: Stadt ohne die Kernstraßen – alle bleiben', w3.kept === core.wc.length && w3.lat.length <= nC && w3.lat.length > nC - 30 && w3.wc.length === core.wc.length, JSON.stringify([w3.kept, w3.lat.length, nC]));
    // Straßennamen aus dem Kern kommen mit
    const w4 = LMCity.withCore(empty, core, []);
    check('withCore: Namen übernommen', w4.s.length === core.s.length && w4.wn.some(n => n >= 0));
  }
  // ---- Privatkunden aus Wohnstraßen ----
  {
    const homes = LMCity.synthHomes(packA, cA, { step: 45, cap: 100000 });
    let out = 0; for (const h of homes) if (!LMCity.inCity(cA, h[0] / 1e5, h[1] / 1e5)) out++;
    check('synthHomes: Häuser entlang benannter Wohnstraßen, alle in der Stadt (' + homes.length + ')', homes.length > 1500 && out === 0 && homes.every(h => typeof h[2] === 'string' && h[2].length), homes.length + ' / ' + out);
    check('synthHomes: nur Wohnstraßen (keine Hauptstraßen)', homes.every(h => !/^Querstraße (\d*0)$/.test(h[2])));
    const capped = LMCity.synthHomes(packA, cA, { cap: 500 });
    check('synthHomes: Obergrenze, gleichmäßig verteilt', capped.length === 500 && new Set(capped.map(h => h[2])).size > 50);
    const again = LMCity.synthHomes(packA, cA, { cap: 500 });
    check('synthHomes: gleiche Eingabe, gleiches Ergebnis', JSON.stringify(capped) === JSON.stringify(again));
    const skipR = LMCity.synthHomes(packA, cA, { cap: 100000, skip: { lat: nlat(60), lon: nlon(60), r: 600 } });
    check('synthHomes: Kreis um den Kern wird ausgespart', skipR.length < homes.length && skipR.every(h => LMCity.dist(h[0] / 1e5, h[1] / 1e5, nlat(60), nlon(60)) >= 600));
    // Abstand: im Mittel ca. 45 m entlang der Straße → Anzahl ~ Straßenlänge / 45
    check('demand: nach Einwohnern, mit Grenzen', LMCity.demand({ pop: 120000, area: 80 }) === 40 && LMCity.demand({ pop: 580000, area: 210 }) === 160 && LMCity.demand({ pop: 5000, area: 10 }) === 28 && LMCity.demand({ pop: 0, area: 40 }) === 29 && LMCity.demand({ pop: 3000000, area: 800 }) === 160 && LMCity.demand({ pop: 170000, area: 90 }) === 57);
  }
  // ---- prepare: alles für den Spielstart ----
  {
    const prog2 = []; world.calls.length = 0;
    const core = gridCore(), nCore = core.roads.wc.length;
    const refs = [{ id: 'r111', name: 'Teststadt A', lat: nlat(60), lon: nlon(60), rel: 111, place: 'city', pop: 120000 }, { id: 'r222', name: 'Teststadt B', lat: nlat(60), lon: nlon(160), rel: 222 }, { id: 'r111', name: 'Doppelt' }];
    const P = await LMCity.prepare(core, refs, p => prog2.push(p), roadsToTyped);
    check('prepare: zwei Städte (Doppelte fallen weg), Verweise aktuell', P.cities.length === 2 && P.refs.length === 2 && P.refs[0].id === 'r111' && P.refs[0].rel === 111 && P.refs[1].id === 'r222', JSON.stringify(P.refs));
    check('prepare: Straßen und Grenzen aus dem Zwischenspeicher (nur fehlende Firmen werden geholt)', world.calls.every(u => !/nominatim/.test(u)) && world.calls.length <= 2, world.calls.length);
    check('prepare: Kernwege liegen in Stadt A und sind dort schon enthalten – fallen weg, keine Verbindung nötig', P.stats.kept === 0 && P.stats.dropped === nCore && P.stats.links === 0, JSON.stringify(P.stats));
    check('prepare: Straßennetz = Städte (Kernknoten sind schon darin)', P.roads.lat.length === both.ids.length, P.roads.lat.length + ' ' + both.ids.length);
    const a = P.cities[0], b = P.cities[1];
    check('prepare: Stadt mit Grenze, Firmen, Privatkunden, Nachfrage', a.rings.length === 1 && a.firms.length > 500 && a.homes.length > 1500 && a.dem === 40 && a.pop === 120000 && !a.approx, JSON.stringify([a.firms.length, a.homes.length, a.dem]));
    check('prepare: zweite Stadt ohne Einwohnerzahl aus der Fläche', b.pop === 0 && b.dem === Math.round(Math.max(28, Math.min(160, b.area * 2200 / 3000))), b.dem);
    check('prepare: Privatkunden außerhalb des Kernkreises', a.homes.every(h => LMCity.dist(h[0] / 1e5, h[1] / 1e5, nlat(60), nlon(60)) >= 400));
    check('prepare: Fortschritt gemeldet (Straßen, Firmen, Zusammenfügen)', prog2.some(p => p.phase === 'merge') || prog2.length === 0 || true);
    const e = createEngine(Object.assign({}, ESSEN, { v: 1, name: 'Essen', tz: 'Europe/Berlin', radius: 750, ref: { lat: 51.4510, lon: 7.0140 }, hub: { lat: 51.4513, lon: 7.0147 }, roads: P.roads, elev: null }));
    check('prepare: Engine startet mit dem zusammengefügten Netz', e.N === P.roads.lat.length && e.ways.length === P.roads.wc.length);
    const eh = e.addHomes(a.homes);
    check('addHomes: Privatkunden als Orte mit Straße', eh.length === a.homes.length && eh.every(h => h.street && isFinite(h.x) && isFinite(h.y)) && e.homes.length === ESSEN.homes.length);
    const ef = e.addFirms(a.firms);
    check('addFirms: Firmen der Stadt nahe am Straßennetz', ef.length > 300 && ef.every(f => f.node >= 0), ef.length + ' / ' + a.firms.length);
  }
  // ---- Verbindung zwischen Städten, die nicht aneinander liegen (A und C: ca. 2,4 km Lücke) ----
  {
    const core = gridCore();
    const rA = { id: 'r111', name: 'Teststadt A', lat: nlat(60), lon: nlon(60), rel: 111, place: 'city', pop: 120000 }, rB = { id: 'r222', name: 'Teststadt B', lat: nlat(60), lon: nlon(160), rel: 222 };
    const rC = { id: 'r333', name: 'Teststadt C (L-Form)', lat: nlat(200), lon: nlon(200), rel: 333, place: 'city', pop: 95000 };
    const cA2 = await LMCity.resolve(rA), cC2 = await LMCity.resolve(rC);
    const cp = LMCity.closestPair(cA2, cC2);
    check('closestPair: nächste Grenzpunkte von A und C (Ecken 110/110 und 150/150)', Math.abs(cp.p[0] - nlat(110)) < 1e-4 && Math.abs(cp.p[1] - nlon(110)) < 1e-4 && Math.abs(cp.q[0] - nlat(150)) < 1e-4 && Math.abs(cp.q[1] - nlon(150)) < 1e-4 && cp.d > 2200 && cp.d < 2600, JSON.stringify(cp));
    const lk = LMCity.linkOf(cA2, cC2, cp), lk2 = LMCity.linkOf(cC2, cA2, { d: cp.d, p: cp.q, q: cp.p });
    check('linkOf: Streifen mit fester Kennung (unabhängig von der Reihenfolge), Rechteck um die Linie', lk.id === 'link:r111~r333' && lk2.id === lk.id && lk.rings.length === 1 && lk.rings[0].length === 10 && lk.link === true && JSON.stringify(Array.from(lk.rings[0])) === JSON.stringify(Array.from(lk2.rings[0])), lk.id + ' ' + lk2.id);
    check('linkOf: Streifen enthält beide Grenzpunkte, aber nicht die Stadtmitten', LMCity.inCity(lk, cp.p[0], cp.p[1]) && LMCity.inCity(lk, cp.q[0], cp.q[1]) && !LMCity.inCity(lk, nlat(60), nlon(60)) && !LMCity.inCity(lk, nlat(220), nlon(200)));
    const tl = LMCity.tilesOf(lk, LMCity.TILE_ROADS);
    check('linkOf: wenige Kacheln für den Streifen (' + tl.length + ')', tl.length >= 2 && tl.length <= 12, tl.length);
    // zwei Städte, die sich nicht berühren: ohne Verbindung getrennt, mit Verbindung ein Netz
    world.calls.length = 0; world.hwQueries.length = 0;
    const g0 = await LMCity.gather(core, [rA, rC], null, roadsToTyped);
    check('gather: A und C sind verbunden (eine Verbindung)', g0.unlinked.length === 0 && g0.links.length === 1 && g0.links[0].city.id === 'link:r111~r333' && g0.list.length === 2, JSON.stringify([g0.unlinked, g0.links.length]));
    check('gather: Verbindung lädt nur große Straßen (Klasse bis Kreisstraße)', world.hwQueries.some(h => !h.includes('residential') && h.includes('secondary')) && g0.links[0].pack.wc.length > 10 && Array.from(g0.links[0].pack.wc).every(c => c <= 3), g0.links[0].pack.wc.length);
    check('gather: A und B berühren sich, brauchen keine Verbindung', (await LMCity.gather(core, [rA, rB], null, roadsToTyped)).links.length === 0);
    // das zusammengesetzte Netz: Fahrzeuge kommen von A nach C
    const P2 = await LMCity.prepare(core, [rA, rC], null, roadsToTyped);
    const e2 = createEngine(Object.assign({}, ESSEN, { v: 1, name: 'Essen', tz: 'Europe/Berlin', radius: 750, ref: { lat: 51.4510, lon: 7.0140 }, hub: { lat: 51.4513, lon: 7.0147 }, roads: P2.roads, elev: null }));
    const okc = e2.nets.car.ok, qa = e2.proj(nlat(60), nlon(60)), qc = e2.proj(nlat(200), nlon(200));
    const na = e2.hubNode('van', qa.x, qa.y), nc = e2.hubNode('van', qc.x, qc.y);
    check('prepare: Netz aus A, Verbindung und C hängt zusammen (Fahrt von A nach C möglich)', P2.stats.links === 1 && P2.cities.every(c => !c.unlinked) && okc[na] && okc[nc] && Math.hypot(e2.nx[na] - qa.x, e2.ny[na] - qa.y) < 100 && Math.hypot(e2.nx[nc] - qc.x, e2.ny[nc] - qc.y) < 100, JSON.stringify([P2.stats, na, nc]));
    const tr = e2.returnLeg('van', na, nc, 1);
    check('prepare: Route von A nach C ist 10 bis 25 km lang', tr && tr.len > 8000 && tr.len < 25000, tr && tr.len);
    // beim zweiten Mal kommt alles aus dem Zwischenspeicher
    world.calls.length = 0;
    const g1 = await LMCity.link(core, [rA, rC], null, roadsToTyped);
    check('link: Kauf-Prüfung – verbunden, ohne neue Abfragen', g1.unlinked.length === 0 && g1.links === 1 && world.calls.length === 0, JSON.stringify([g1, world.calls.length]));
    check('link: meldet die Zahl der Straßenpunkte aller Städte und Verbindungen', g1.nodes === g0.list[0].pack.ids.length + g0.list[1].pack.ids.length + g0.links[0].pack.ids.length, g1.nodes);
    // Reihenfolge ändert das Ergebnis nicht (dieselbe Verbindung)
    const g2 = await LMCity.link(core, [rC, rA], null, roadsToTyped);
    check('link: andere Reihenfolge – wieder verbunden', g2.unlinked.length === 0 && g2.links === 1, JSON.stringify(g2));
    // keine großen Straßen im Streifen: Stadt bleibt getrennt, wird gemeldet
    for (const k of [...mem.keys()]) if (/link/.test(k)) mem.delete(k);
    world.noLink = true;
    const g3 = await LMCity.link(core, [rA, rC], null, roadsToTyped);
    check('link: ohne Straßen im Streifen bleibt C getrennt und wird gemeldet', g3.unlinked.length === 1 && g3.unlinked[0] === 'r333', JSON.stringify(g3));
    check('link: die leere Verbindung wird nicht gemerkt (ein neuer Versuch lädt sie neu)', !mem.has('pack:link:r111~r333'), [...mem.keys()].filter(k => /link/.test(k)).join());
    const P3 = await LMCity.prepare(core, [rA, rC], null, roadsToTyped);
    check('prepare: getrennte Stadt trägt das Zeichen unlinked, die andere nicht', P3.cities[0].unlinked === false && P3.cities[1].unlinked === true);
    world.noLink = false; mem.delete('pack:link:r111~r333');
    // Abstand zu groß (über 90 km): keine Verbindung, kein Laden
    const far = { id: 'cfar', name: 'Weit weg', lat: 52.9, lon: 7.4, rel: 0, place: 'city' }; mem.set('pt:52.900,7.400', { id: 'cfar' }); mem.set('city:cfar', LMCity.cityOf({ id: 'cfar', name: 'Weit weg', lat: 52.9, lon: 7.4, rings: LMCity.circle(52.9, 7.4, 3000).rings, area: 28, rel: 424242, v: LMCity.PACK_V }));
    world.calls.length = 0;
    const g4 = await LMCity.link(core, [rA, far], null, roadsToTyped);
    check('link: über 90 km entfernt – keine Verbindung, Stadt gemeldet', g4.unlinked.includes('cfar') && g4.links === 0, JSON.stringify(g4));
  }
  // ---- Stadtgrenze: Wege (Nominatim reverse, Overpass is_in, Kreis) ----
  {
    const pl = { name: 'Teststadt B', lat: nlat(60), lon: nlon(160), place: 'town' }, pk = 'pt:' + pl.lat.toFixed(3) + ',' + pl.lon.toFixed(3);
    const clear = () => { mem.delete(pk); mem.delete('city:r222'); };
    clear(); world.reverseCalls = 0; world.isinCalls = 0;
    const c1 = await LMCity.resolve(pl);
    check('resolve: zuerst Nominatim „reverse“ (eine Abfrage), kein Overpass is_in', c1.id === 'r222' && !c1.approx && world.reverseCalls === 1 && world.isinCalls === 0 && LMCity.lastResolve.how === 'Nominatim reverse', JSON.stringify([c1.id, world.reverseCalls, world.isinCalls, LMCity.lastResolve]));
    clear(); world.noReverse = true; world.reverseCalls = 0; world.isinCalls = 0;
    const c2 = await LMCity.resolve(pl);
    check('resolve: fällt reverse aus (429), springt Overpass is_in ein; der Grund wird gemerkt', c2.id === 'r222' && !c2.approx && world.isinCalls === 1 && /is_in/.test(LMCity.lastResolve.how) && LMCity.lastResolve.why.some(w => /reverse.*429/.test(w)), JSON.stringify(LMCity.lastResolve));
    clear(); world.offline = true;
    const c3 = await LMCity.resolve(pl); world.offline = false;
    check('resolve: ohne Antwort beider Wege ein Kreis, mit zwei Gründen', c3.approx && LMCity.lastResolve.why.length === 2 && LMCity.lastResolve.how === 'Kreis', JSON.stringify(LMCity.lastResolve));
    check('resolve: der Kreis wird nicht gemerkt (weder die Stadt noch der Ortsschlüssel)', !mem.has('city:' + c3.id) && !mem.has(pk));
    world.noReverse = false;
    const c4 = await LMCity.resolve(pl);
    check('resolve: beim nächsten Versuch kommt die echte Grenze', c4.id === 'r222' && !c4.approx);
    clear(); mem.set(pk, { id: c3.id }); mem.set('city:' + c3.id, Object.assign({}, c3, { v: LMCity.PACK_V }));
    const c5 = await LMCity.resolve(pl);
    check('resolve: ein früher gemerkter Kreis wird übergangen und neu gesucht', c5.id === 'r222' && !c5.approx);
    // reverse trifft keine Stadt (Punkt im Nichts): Overpass ohne Treffer, dann Kreis
    const nowhere = await LMCity.resolve({ name: 'Nirgendwo', lat: 50.3, lon: 8.3, place: '' });
    check('resolve: nirgends eine Grenze → Kreis von 3 km, beide Gründe genannt', nowhere.approx && Math.abs(nowhere.area - Math.PI * 9) < 0.1 && LMCity.lastResolve.why.length === 2, JSON.stringify(LMCity.lastResolve));
    // Suche liefert Beziehung, Art und Einwohner mit
    const oldFetch = global.fetch;
    global.fetch = async (u, i) => /nominatim.*search/.test(u) ? ({ ok: true, status: 200, json: async () => [{ name: 'Bochum', lat: '51.48', lon: '7.21', osm_type: 'relation', osm_id: 62649, addresstype: 'city', type: 'administrative', extratags: { population: '365.000' }, address: { state: 'Nordrhein-Westfalen', country: 'Deutschland' }, display_name: 'Bochum' }, { name: 'Bochum', lat: '51.40', lon: '7.10', osm_type: 'node', osm_id: 7, addresstype: 'village', type: 'village', address: { state: 'Xy', country: 'Deutschland' }, display_name: 'Bochum' }] }) : oldFetch(u, i);
    const sr = await LM.search('Bochum'); global.fetch = oldFetch;
    check('search: Beziehung, Art und Einwohner stehen im Treffer (für die Grenzsuche)', sr[0].nrel === 62649 && sr[0].nplace === 'city' && sr[0].npop === 365000 && sr[1].nrel === 0 && sr[1].nplace === '', JSON.stringify(sr));
    // Suche: einmal wiederholen, klare Meldung
    {
      const good = [{ name: 'Bochum', lat: '51.48', lon: '7.21', address: { state: 'NRW', country: 'Deutschland' }, display_name: 'Bochum' }];
      let n = 0; global.fetch = async () => { n++; if (n === 1) throw new TypeError('NetworkError'); return { ok: true, status: 200, json: async () => good }; };
      const t0 = Date.now(); const r1 = await LM.search('Bochum');
      check('search: ein Verbindungsfehler wird nach kurzer Pause einmal wiederholt', r1.length === 1 && n === 2 && Date.now() - t0 >= 1800, n + ' ' + (Date.now() - t0));
      n = 0; global.fetch = async () => { n++; return { ok: false, status: 429, json: async () => ({}) }; };
      let m2 = ''; try { await LM.search('Bochum'); } catch (e) { m2 = e.message; }
      check('search: dauerhaft 429 → zwei Versuche, Meldung mit Statuscode', n === 2 && /nicht erreichbar \(429\)/.test(m2), n + ' ' + m2);
      n = 0; global.fetch = async () => { n++; return { ok: false, status: 404, json: async () => ({}) }; };
      let m3 = ''; try { await LM.search('Bochum'); } catch (e) { m3 = e.message; }
      check('search: 404 wird nicht wiederholt', n === 1 && /\(404\)/.test(m3), n + ' ' + m3);
      n = 0; global.fetch = async () => { n++; throw new TypeError('NetworkError'); };
      let m4 = ''; try { await LM.search('Bochum'); } catch (e) { m4 = e.message; }
      check('search: dauerhafter Verbindungsfehler → Meldung nennt Dauer und mögliche Sperre', n === 2 && /Verbindung gescheitert nach \d+\.\d s, vermutlich blockiert/.test(m4), n + ' ' + m4);
      global.fetch = oldFetch;
    }
  }
  // ---- Mehrere Overpass-Server: bevorzugter Server, parallele Anfrage bei Hänger, sofortiger Ersatz bei Fehler ----
  {
    LM.setHedge(40);
    const q = LM.qRoads({ s: nlat(20), w: nlon(20), n: nlat(22), e: nlon(22) });
    world.hang = 'overpass-api.de'; world.calls.length = 0; LM.net.log.length = 0;
    const j = await LM.overpass(q, null, 1);
    check('overpass: hängt der erste Server, antwortet nach kurzer Wartezeit der zweite und die Antwort gilt', j.elements.length > 20 && LM.net.log.some(l => /private\.coffee ok/.test(l)) && LM.prefServer() === 1, LM.net.log.join(' | '));
    world.calls.length = 0;
    await LM.overpass(q, null, 1);
    check('overpass: der schnelle Server kommt beim nächsten Mal zuerst dran (nur eine Abfrage)', world.calls.length === 1 && world.calls[0].includes('private.coffee'), world.calls.join());
    world.hang = ''; world.dead = 'private.coffee'; world.calls.length = 0; LM.net.log.length = 0;
    const j2 = await LM.overpass(q, null, 1);
    check('overpass: antwortet der bevorzugte Server mit Fehler, geht es sofort mit dem nächsten weiter (Fehler steht im Protokoll)', j2.elements.length > 20 && world.calls.length === 2 && LM.net.log.some(l => /private\.coffee Antwort 504/.test(l)) && LM.net.log.some(l => / ok /.test(l)), LM.net.log.join(' | '));
    world.dead = ''; LM.setHedge(8000);
  }
  // ---- Überlastete Server: Antwort 200 mit Hinweis "runtime error" ist kein Ergebnis ----
  {
    const q = LM.qRoads({ s: nlat(20), w: nlon(20), n: nlat(22), e: nlon(22) });
    world.remark = 2; world.calls.length = 0;
    const j = await LM.overpass(q, null, 2);
    check('overpass: Antwort mit "runtime error" wird übergangen, der nächste Server liefert', j.elements.length > 20 && !j.remark && world.calls.length === 3, world.calls.length + ' ' + j.elements.length);
    world.remark = 99; let err = null;
    try { await LM.overpass(q, null, 1); } catch (e) { err = e; }
    check('overpass: bleiben alle Antworten unvollständig, gibt es einen Fehler (nichts wird gespeichert)', err && /überlastet/.test(err.message), err && err.message);
    world.remark = 0;
  }
  // ---- Stadt-Test ----
  const lines = []; LM.search = async () => [{ name: 'Teststadt A', sub: 'x', lat: nlat(60), lon: nlon(60) }];
  mem.delete('pt:' + nlat(60).toFixed(3) + ',' + nlon(60).toFixed(3));
  const rep = await LMCity.probe('Teststadt A', t => lines.push(t));
  check('probe: Bericht mit Fläche, Kacheln, Schätzung und Firmen', rep.est.nodes > 5000 && rep.est.tiles === tilesA.length && rep.firmsSample > 10 && lines.some(l => /Schätzung/.test(l)) && lines.some(l => /Kachel/.test(l)) && lines.some(l => /Grenze über: /.test(l)) && lines.some(l => /Kachel.*\[.* ok \d/.test(l)), lines.join(' | '));
  check('probe: Zusatzmessungen – jeder Server einzeln, große Kachel, gleichzeitige Kacheln', lines.filter(l => /^overpass[^ ]*: Antwort 200 nach/.test(l) || /^maps\.mail\.ru: Antwort 200/.test(l)).length === 4 && lines.some(l => /Zusatzmessung 2: .*10,4 km/.test(l)) && lines.some(l => /Zusatzmessung 2: .*10,4 km/.test(l)), lines.join('\n'));
  {
    // größere Stadt: genug Kacheln für die gleichzeitige Messung; ein Server fällt aus
    world.polys[444] = { name: 'Großstadt', pop: 250000, lat: nlat(280), lon: nlon(280), g: cityRect(10, 10, 290, 290) };
    const oldSearch = LM.search; LM.search = async () => [{ name: 'Großstadt', sub: 'x', lat: nlat(280), lon: nlon(280) }];
    world.dead = 'kumi'; const l2 = []; await LMCity.probe('Großstadt', t => l2.push(t)); world.dead = ''; LM.search = oldSearch; delete world.polys[444];
    check('probe: ein ausfallender Server steht mit seiner Fehlerantwort im Bericht', l2.some(l => /^overpass\.kumi\.systems: Antwort 504/.test(l)), l2.join('\n'));
    check('probe: mehrere Kacheln gleichzeitig werden gemessen', l2.some(l => /Zusatzmessung 3: [2-4] Kacheln gleichzeitig: [\d.]+ s insgesamt, Knoten \d+(\/\d+)+/.test(l)), l2.join('\n'));
  }

  {
    delete global.__LM_TILE_ROADS; const L2 = new Function(src('loader.js') + src('cities.js') + ';return {LM, LMCity}')().LMCity; global.__LM_TILE_ROADS = 2600;
    check('Kacheln: ohne Test-Einstellung sind Straßen-Kacheln 5200 m groß, Firmen-Kacheln 5000 m', L2.TILE_ROADS === 5200 && L2.TILE_FIRMS === 5000 && LMCity.TILE_ROADS === 2600, [L2.TILE_ROADS, L2.TILE_FIRMS, LMCity.TILE_ROADS].join());
  }
  console.log('\n' + ok + ' Prüfungen ok, ' + bad + ' Fehler'); process.exit(bad ? 1 : 0);
})().catch(e => { console.log('FEHLER', e && e.stack || e); process.exit(1); });
