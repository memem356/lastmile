// Vergleicht die Engine (src/engine.js, Zahlenfelder und Raster) mit der Referenz vor dem Umbau (tests/fixtures/engine_ref.js):
// gleiche Knoten, Kanten, Netze, Routen, Fahrzeiten, Verkehr und "nächste Straße" auf der Demo-Karte.
// Start: node tests/engine_equiv.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const load = f => new Function(fs.readFileSync(f, 'utf8') + ';return createEngine')();
const D = JSON.parse(fs.readFileSync(path.join(root, 'data/essen.json'), 'utf8'));
D.elev = JSON.parse(fs.readFileSync(path.join(root, 'data/essen_elev.json'), 'utf8'));
Object.assign(D, { v: 1, name: 'Essen', tz: 'Europe/Berlin', radius: 750, ref: { lat: 51.4510, lon: 7.0140 }, hub: { lat: 51.4513, lon: 7.0147 } });
const A = load(path.join(__dirname, 'fixtures/engine_ref.js'))(D), B = load(path.join(root, 'src/engine.js'))(D);
let ok = 0, bad = 0; const fail = [];
const check = (name, cond, info) => { if (cond) ok++; else { bad++; fail.push(name + ' ' + (info || '')); console.log('FAIL', name, info || ''); } };
const same = (x, y) => { if (x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

check('N und Koordinaten', A.N === B.N && same(A.nx, B.nx) && same(A.ny, B.ny), A.N + ' ' + B.N);
check('Wege', A.ways.length === B.ways.length);
check('Kantenzahl', A.EN === B.EN, A.EN + ' ' + B.EN);
check('Kanten A, B, Klasse', same(A.eA, B.eA) && same(A.eB, B.eB) && same(A.eC, B.eC));
check('Verkehrsgrundwerte', same(A.eBase, B.eBase) && same(A.eDir, B.eDir) && same(A.eMidX, B.eMidX));
for (const k of ['bike', 'car']) {
  check('Netz ' + k + ': Gruppe, Größe, Depot', A.nets[k].size === B.nets[k].size && A.nets[k].depot === B.nets[k].depot && same(A.nets[k].ok, B.nets[k].ok), A.nets[k].size + ' ' + B.nets[k].size);
  // Nachbarn in gleicher Reihenfolge mit gleichen Werten
  let eq = true; const adj = A.nets[k].adj, n = B.nets[k];
  for (let v = 0; v < A.N && eq; v++) {
    if (adj[v].length !== n.start[v + 1] - n.start[v]) { eq = false; break; }
    adj[v].forEach((e, j) => { const p = n.start[v] + j; if (e.to !== n.to[p] || e.len !== n.len[p] || e.c !== n.cls[p] || e.g !== n.grd[p] || e.id !== n.eid[p]) eq = false; });
  }
  check('Netz ' + k + ': alle Kanten gleich (Ziel, Länge, Klasse, Steigung, Nummer)', eq);
}
// nächster Knoten: zufällige Punkte, auch weit außerhalb, mit und ohne Maske
let ne = 0, nn = 0; const bds = A.bounds;
for (let i = 0; i < 4000; i++) {
  const m = i % 4, ex = m === 3 ? 6000 : m === 2 ? 800 : 0;
  const x = bds.minX - ex + rnd() * (bds.maxX - bds.minX + 2 * ex), y = bds.minY - ex + rnd() * (bds.maxY - bds.minY + 2 * ex);
  const mask = i % 2 ? A.nets.car.ok : (i % 3 ? A.nets.bike.ok : null);
  nn++; if (A.nearest(x, y, mask) !== B.nearest(x, y, mask)) ne++;
}
check('nächster Knoten (' + nn + ' Punkte, innen und außen, mit Maske)', ne === 0, ne + ' Abweichungen');
// Verkehr setzen und Routen vergleichen
const extra = new Float32Array(A.EN); for (let i = 0; i < A.EN; i += 97) extra[i] = 0.3;
const ta = A.updateTraffic(0.8, 0.5, extra), tb = B.updateTraffic(0.8, 0.5, extra);
check('Verkehr: Mittelwert, Stärke und Bremsen gleich', ta === tb && same(A.cong, B.cong) && same(A.trafficMul === undefined ? [] : [A.trafficMul('van', 5)], [B.trafficMul('van', 5)]), ta + ' ' + tb);
const okList = {}; for (const k of ['bike', 'car']) { okList[k] = []; for (let v = 0; v < A.N; v++) if (A.nets[k].ok[v]) okList[k].push(v); }
let re = 0, rn = 0;
const legEq = (a, b) => (a === null && b === null) || (a && b && same(a.nodes, b.nodes) && same(a.eid, b.eid) && same(a.t, b.t) && same(a.d, b.d) && same(a.mp, b.mp) && same(a.xs, b.xs));
for (let i = 0; i < 400; i++) {
  const veh = ['bike', 'scooter', 'van'][i % 3], q = [0, 0.5, 1][Math.floor(i / 3) % 3], net = veh === 'bike' ? 'bike' : 'car', okN = okList[net];
  const s = okN[Math.floor(rnd() * okN.length)], t = okN[Math.floor(rnd() * okN.length)];
  rn++; const la = A.returnLeg(veh, s, t, q), lb = B.returnLeg(veh, s, t, q);
  if (!legEq(la, lb)) re++;
}
check('Routen und Fahrzeiten (' + rn + ' Fahrten, drei Fahrzeuge, drei Stau-Kenntnisse)', re === 0 && rn > 300, re + ' Abweichungen von ' + rn);
// Fahrten mit Abholung, Unterwegs-Zustand, Ausweichen
let pe = 0, pn = 0, rr = 0, rrn = 0;
for (let i = 0; i < 120; i++) {
  const veh = ['bike', 'scooter', 'van'][i % 3], p = Math.floor(rnd() * A.pois.length), h = Math.floor(rnd() * A.homes.length), q = (i % 4) / 3;
  const ta2 = A.planTrip(veh, null, p, h, q), tb2 = B.planTrip(veh, null, p, h, q);
  pn++; if (!(ta2 === null && tb2 === null) && !(ta2 && tb2 && legEq(ta2.legs[0], tb2.legs[0]) && legEq(ta2.legs[1], tb2.legs[1]) && ta2.total === tb2.total && ta2.len === tb2.len && ta2.endNode === tb2.endNode)) pe++;
  if (ta2 && tb2) {
    for (const f of [0.1, 0.4, 0.8]) {
      const tt = ta2.total * f, sa = A.tripState(ta2, tt), sb = B.tripState(tb2, tt);
      if (sa.phase !== sb.phase || sa.s.x !== sb.s.x || sa.s.y !== sb.s.y || sa.left !== sb.left) pe++;
    }
    const leg = ta2.legs[0]; if (leg.nodes.length > 4) {
      rrn++; const veh2 = veh, ra = A.reroute(veh2, ta2.legs[0], ta2.T1 * 0.2, q, 1), rb = B.reroute(veh2, tb2.legs[0], tb2.T1 * 0.2, q, 1);
      if (!((ra === null && rb === null) || (ra && rb && ra.gain === rb.gain && ra.cur === rb.cur && legEq(ra.leg, rb.leg)))) rr++;
    }
  }
}
check('planTrip, tripState (' + pn + ' Fahrten)', pe === 0, pe + ' Abweichungen');
check('Ausweichen unterwegs (' + rrn + ' Fahrten)', rr === 0, rr + ' Abweichungen');
// Firmen
const fl = []; for (let i = 0; i < 300; i++) fl.push([i % 5, Math.round((51.4510 + (rnd() - 0.5) * 0.02) * 1e5), Math.round((7.0140 + (rnd() - 0.5) * 0.03) * 1e5), 'Firma ' + i]);
const fa = A.addFirms(fl), fb = B.addFirms(fl);
check('Firmen (' + fa.length + ' im Netz)', fa.length === fb.length && fa.every((f, i) => f.node === fb[i].node && f.street === fb[i].street && f.x === fb[i].x));
// Karte im neuen Zahlenfeld-Format (wie bei geladenen Städten) statt im kompakten Altformat: gleiches Ergebnis
{
  const T = new Function(fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8') + ';return {createEngine, roadsToTyped}')();
  const typed = T.roadsToTyped(D.roads);
  check('Altformat wird in Zahlenfelder umgewandelt', typed.lat instanceof Int32Array && typed.wc instanceof Uint8Array && typed.wo.length === typed.wc.length + 1);
  const D2 = Object.assign({}, D, { roads: typed }), C = T.createEngine(D2);
  check('Zahlenfeld-Karte: Knoten, Wege, Kanten, Netze gleich', C.N === B.N && same(C.nx, B.nx) && C.ways.length === B.ways.length && C.EN === B.EN && same(C.eA, B.eA) && C.nets.car.size === B.nets.car.size && C.nets.bike.size === B.nets.bike.size);
  let re = 0; for (let i = 0; i < 60; i++) { const a = B.hubNode('van', B.nx[(i * 97) % B.N], B.ny[(i * 97) % B.N]), b = B.hubNode('van', B.nx[(i * 53 + 7) % B.N], B.ny[(i * 53 + 7) % B.N]); const l1 = B.returnLeg('van', a, b, 0), l2 = C.returnLeg('van', a, b, 0); if ((l1 && l1.len) !== (l2 && l2.len)) re++; }
  check('Zahlenfeld-Karte: Routen gleich lang', re === 0, re);
}
console.log('\n' + ok + ' Prüfungen ok, ' + bad + ' Fehler'); process.exit(bad ? 1 : 0);
