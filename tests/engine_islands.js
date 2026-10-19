// Inseln im Straßennetz: Städte weit entfernter Center (Kennung isl) bekommen ihre eigene befahrbare Gruppe; das Suchraster wächst mit der Ausdehnung.
// Start: node tests/engine_islands.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const createEngine = new Function(fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8') + ';return createEngine')();
let ok = 0, bad = 0;
const check = (name, cond, info) => { if (cond) ok++; else { bad++; console.log('FAIL', name, info || ''); } };

// Gitter aus n x n Knoten (Abstand step Grad, Einheiten 1e-5) um (lat0, lon0)
function grid(lat0, lon0, n, step, nodes, ways) {
  const base = nodes.length / 2;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) nodes.push(Math.round(lat0 * 1e5) + i * step, Math.round(lon0 * 1e5) + j * step);
  for (let i = 0; i < n; i++) { const w = []; for (let j = 0; j < n; j++) w.push(base + i * n + j); ways.push(w); }
  for (let j = 0; j < n; j++) { const w = []; for (let i = 0; i < n; i++) w.push(base + i * n + j); ways.push(w); }
  return { s: lat0, w: lon0, n: lat0 + (n - 1) * step / 1e5, e: lon0 + (n - 1) * step / 1e5, base, cnt: n };
}
function build(islands, extra) {
  const nodes = [], ways = [];
  const core = grid(51.45, 7.01, 30, 40, nodes, ways);              // Kernkarte (ca. 3 km)
  const far = grid(53.55, 10.0, (extra && extra.farN) || 20, 40, nodes, ways);               // ca. 290 km entfernt
  const far2 = grid(48.14, 11.58, 20, 40, nodes, ways);             // ca. 420 km entfernt, in der anderen Richtung
  const N = nodes.length / 2, lat = new Int32Array(N), lon = new Int32Array(N);
  for (let i = 0; i < N; i++) { lat[i] = nodes[2 * i]; lon[i] = nodes[2 * i + 1]; }
  const W = ways.length, wc = new Uint8Array(W).fill(4), wf = new Uint8Array(W), wn = new Int32Array(W).fill(-1), wo = new Int32Array(W + 1); let m = 0; for (const w of ways) m += w.length;
  const wi = new Int32Array(m); let q = 0; ways.forEach((w, k) => { wo[k] = q; for (const v of w) wi[q++] = v; }); wo[W] = q;
  const D = { v: 1, name: 'T', roads: { o: [lat[0], lon[0]], lat, lon, wc, wf, wn, wo, wi, s: [] }, pois: [], homes: [], ref: { lat: 51.4515, lon: 7.0115 }, hub: { lat: 51.4515, lon: 7.0115 } };
  if (islands) D.cities = [{ id: 'a', isl: 'a', bbox: { s: far.s, w: far.w, n: far.n, e: far.e } }, { id: 'b', isl: 'b', bbox: { s: far2.s, w: far2.w, n: far2.n, e: far2.e } }, { id: 'c', isl: '', bbox: { s: core.s, w: core.w, n: core.n, e: core.e } }];
  return { D, core, far, far2, N };
}

{ // ohne Inseln: nur die Kernkarte ist befahrbar
  const { D, core, far } = build(false), E = createEngine(D);
  const nc = E.nets.car, c0 = core.base + 5, f0 = far.base + 5;
  check('ohne Inseln: Kernkarte befahrbar, ferne Gruppe nicht', nc.ok[c0] === 1 && nc.ok[f0] === 0);
  const x = E.proj(53.5503, 10.0004), h = E.hubNode('van', x.x, x.y);
  check('ohne Inseln landet ein Klick in der Ferne an der Kernkarte', h >= 0 && h < core.base + core.cnt * core.cnt, h);
}
{ // mit Inseln: jede Insel ist befahrbar, auch beim Fahrrad
  const { D, core, far, far2 } = build(true), E = createEngine(D);
  const ok = E.nets.car.ok, okb = E.nets.bike.ok;
  let allCore = true, allFar = true, allFar2 = true; for (let i = 0; i < core.cnt * core.cnt; i++) if (!ok[core.base + i]) allCore = false; for (let i = 0; i < far.cnt * far.cnt; i++) if (!ok[far.base + i] || !okb[far.base + i]) allFar = false; for (let i = 0; i < far2.cnt * far2.cnt; i++) if (!ok[far2.base + i]) allFar2 = false;
  check('mit Inseln: Kernkarte und beide Inseln befahrbar', allCore && allFar && allFar2);
  const p = E.proj(53.5503 + 0.0003, 10.0004), h = E.hubNode('van', p.x, p.y);
  check('Klick in der fernen Stadt trifft einen Knoten der Insel', h >= far.base && h < far.base + far.cnt * far.cnt && Math.hypot(E.nx[h] - p.x, E.ny[h] - p.y) < 100, h + ' ' + Math.hypot(E.nx[h] - p.x, E.ny[h] - p.y));
  const a = far.base + 3, b = far.base + 19 * 20 + 17, leg = E.returnLeg('van', a, b);
  check('Fahrt innerhalb der Insel möglich (Länge und Zeit)', leg && leg.len > 500 && leg.time > 30, leg && leg.len);
  const none = E.returnLeg('van', a, core.base + 10);
  check('zwischen Insel und Kernkarte gibt es keine Fahrt (null, kein Absturz)', none === null);
  check('Depot bleibt bei der Kernkarte', E.nets.car.depot >= 0 && E.nets.car.depot < core.base + core.cnt * core.cnt);
  // Suchraster: Ergebnisse gleich der Suche über alle Knoten, auch über ca. 700 km Ausdehnung
  let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; let bad2 = 0;
  const bds = E.bounds;
  for (let i = 0; i < 600; i++) {
    const x = bds.minX + rnd() * (bds.maxX - bds.minX), y = bds.minY + rnd() * (bds.maxY - bds.minY), m = i % 2 ? ok : null;
    let bi = -1, bd = Infinity; for (let v = 0; v < E.N; v++) { if (m && !m[v]) continue; const d = (E.nx[v] - x) ** 2 + (E.ny[v] - y) ** 2; if (d < bd) { bd = d; bi = v; } }
    if (E.nearest(x, y, m) !== bi) bad2++;
  }
  check('nächster Knoten bei großer Ausdehnung gleich der Suche über alle Knoten (600 Punkte)', bad2 === 0, bad2);
  check('Ausdehnung über 500 km', bds.maxX - bds.minX > 300000 || bds.maxY - bds.minY > 300000, [bds.maxX - bds.minX, bds.maxY - bds.minY].join());
}
{ // eine Insel, deren Stadtrechteck die Kernkarte schneidet, ändert nichts
  const { D, core, far } = build(true); D.cities = [{ id: 'x', isl: 'x', bbox: { s: core.s - 0.01, w: core.w - 0.01, n: core.n + 0.01, e: core.e + 0.01 } }];
  const E = createEngine(D);
  check('Insel-Rechteck über der Kernkarte: ferne Gruppe bleibt unbefahrbar', E.nets.car.ok[far.base + 5] === 0 && E.nets.car.ok[core.base + 5] === 1);
}
{ // eine Insel, die größer ist als die Kernkarte, verdrängt die Startregion nicht aus dem befahrbaren Netz
  const { D, core, far } = build(true, { farN: 60 }), E = createEngine(D), ok = E.nets.car.ok;
  let allCore = true, allFar = true; for (let i = 0; i < core.cnt * core.cnt; i++) if (!ok[core.base + i]) allCore = false; for (let i = 0; i < far.cnt * far.cnt; i++) if (!ok[far.base + i]) allFar = false;
  check('große Insel (3600 Knoten) und kleinere Kernkarte (900 Knoten): beide befahrbar', allCore && allFar);
  const h = E.hubNode('van', E.HUB.x, E.HUB.y), d = E.nets.car.depot;
  check('Hub und Depot bleiben in der Startregion', h >= core.base && h < core.base + core.cnt * core.cnt && d >= core.base && d < core.base + core.cnt * core.cnt, h + ' ' + d);
  check('Fahrt zwischen Startregion und großer Insel: null', E.returnLeg('van', h, far.base + 5) === null && E.returnLeg('van', far.base + 5, h) === null);
}
console.log('\n' + ok + ' Prüfungen ok, ' + bad + ' Fehler'); process.exit(bad ? 1 : 0);
