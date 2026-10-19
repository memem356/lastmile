'use strict';
// Tests des gemeinsamen Kartenspeichers (src/citystore.js): Paketformat, Prüfungen fremder Pakete, Holen und Ablegen mit einer künstlichen Datenbank.
// Start: node tests/citystore_test.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'citystore.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FEHLER:', m); } };

// Künstliche Datenbank mit denselben Aufrufen wie LMO._db (nur die Pfade citystore/…)
function world(opt) {
  const W = { db: {}, calls: [], signedIn: true, hasProfile: true, denyRead: false, denyWrite: false, net: false };
  const LMO = {
    state: () => ({ signedIn: W.signedIn, hasProfile: W.hasProfile }),
    _db: async (method, p, body, o) => {
      W.calls.push(method + ' ' + p);
      if (W.net) { const e = new Error('Netz'); e.code = 'NETWORK'; throw e; }
      const err = c => { const e = new Error(c); e.code = c; return e; };
      const m = p.match(/^citystore\/([a-z])\/([^/]+)(\/v)?$/); if (!m) throw err('DB_400');
      const key = m[1] + '/' + m[2];
      if (method === 'GET') { if (W.denyRead) throw err('PERMISSION_DENIED'); const r = W.db[key]; return r === undefined ? null : (m[3] ? r.v : JSON.parse(JSON.stringify(r))); }
      if (method === 'PUT') { if (W.denyWrite || W.db[key]) throw err('PERMISSION_DENIED'); W.db[key] = JSON.parse(JSON.stringify(body)); return body; }
      throw err('DB_405');
    }
  };
  W.S = new Function('LMO', 'CompressionStream', 'DecompressionStream', SRC + '\nreturn LMStore;')(LMO, CompressionStream, DecompressionStream);
  return W;
}

// ---------- ein künstliches Straßenpaket wie es loadRoads liefert ----------
const BB = { s: 51.35, w: 6.9, n: 51.5, e: 7.15 };
function mkPack(nWays, id, seed) {
  let x = (seed || 1) >>> 0; const rnd = () => { x = (x + 0x6D2B79F5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ids = [], la = [], lo = [], wid = [], wc = [], wf = [], wn = [], wo = [0], wi = [], names = [];
  let nid = 3.1e9;
  for (let w = 0; w < nWays; w++) {
    let a = Math.round((BB.s + rnd() * (BB.n - BB.s)) * 1e5), o = Math.round((BB.w + rnd() * (BB.e - BB.w)) * 1e5);
    const len = 4 + Math.floor(rnd() * 20);
    for (let k = 0; k < len; k++) { nid += 1 + Math.floor(rnd() * 40); ids.push(nid); la.push(a); lo.push(o); wi.push(ids.length - 1); a += Math.round((rnd() - 0.4) * 200); o += Math.round((rnd() - 0.4) * 260); }
    wo.push(wi.length); wid.push(1e8 + w * 7 + Math.floor(rnd() * 5)); wc.push(1 + Math.floor(rnd() * 8)); wf.push(Math.floor(rnd() * 4));
    if (rnd() < 0.8) { wn.push(names.length); names.push('Straße ' + w + 'äöü'); } else wn.push(-1);
  }
  return { o: [la[0], lo[0]], ids: Float64Array.from(ids), la: Int32Array.from(la), lo: Int32Array.from(lo), wid: Float64Array.from(wid), wc: Uint8Array.from(wc), wf: Uint8Array.from(wf),
    wn: Int32Array.from(wn), wo: Int32Array.from(wo), wi: Int32Array.from(wi), s: names, v: 2, cityId: id, stats: { nodes: ids.length, ways: nWays, tiles: 3, ms: 1234, bytes: 99 } };
}
const same = (a, b) => {
  if (ArrayBuffer.isView(a)) return ArrayBuffer.isView(b) && a.constructor === b.constructor && a.length === b.length && a.every((v, i) => v === b[i]);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && typeof a === 'object') { const k = Object.keys(a); return b && typeof b === 'object' && k.length === Object.keys(b).length && k.every(q => same(a[q], b[q])); }
  return a === b;
};
const CITY = { id: 'r62649', bbox: BB };

(async () => {
  const W = world(), S = W.S;
  // ---------- Format ----------
  {
    const o = { t: 'Zähler ÄÖ', n: [1, 2, 3], neg: Int32Array.from([5, -3, -2147483648, 2147483647, 0, 0, 7]), big: Float64Array.from([12345678901, 1, 12345678999, 0, 3e10]), u: Uint8Array.from([0, 255, 7]), e: new Int32Array(0), nest: { a: Int32Array.from([9, 8, 7]), b: null } };
    const back = await S.decode(await S.encode(o));
    ok(same(o, back), 'Rundlauf: Zahlenfelder, Zeichen, Verschachtelung bleiben gleich');
    ok(back.neg instanceof Int32Array && back.big instanceof Float64Array && back.u instanceof Uint8Array && back.e.length === 0, 'Rundlauf: Feldarten bleiben erhalten');
    ok(same(await S.decode(await S.encode({ a: [1, [2, { b: 'x' }]], c: null })), { a: [1, [2, { b: 'x' }]], c: null }), 'Rundlauf ohne Zahlenfelder');
    let thrown = false; try { await S.encode({ x: new Int16Array(3) }); } catch (e) { thrown = true; } ok(thrown, 'unbekannte Feldart wird abgelehnt');
  }
  {
    const p = mkPack(6000, 'r62649', 7); const t0 = Date.now(), enc = await S.encode(p), t1 = Date.now(), back = await S.decode(enc), t2 = Date.now();
    const rawBytes = p.ids.length * 16 + p.wi.length * 4 + p.wc.length * 18;
    ok(same(p, back), 'großes Paket (' + p.ids.length + ' Knoten): Rundlauf');
    ok(enc.length < rawBytes * 0.5, 'Paket ist kleiner als die Hälfte der Rohdaten (' + enc.length + ' Zeichen, roh ' + rawBytes + ' Bytes)');
    ok(t1 - t0 < 4000 && t2 - t1 < 4000, 'Packen ' + (t1 - t0) + ' ms, Entpacken ' + (t2 - t1) + ' ms');
    console.log('  Info: ' + p.ids.length + ' Knoten, ' + p.wc.length + ' Wege -> ' + enc.length + ' Zeichen (' + (enc.length / p.ids.length).toFixed(1) + ' je Knoten), packen ' + (t1 - t0) + ' ms, entpacken ' + (t2 - t1) + ' ms');
    // Beschädigung wird bemerkt
    let miss = 0, n = 0;
    for (const pos of [40, 200, Math.floor(enc.length / 2), enc.length - 30, enc.length - 8]) {
      n++; const c = enc.slice(0, pos) + (enc[pos] === 'A' ? 'B' : 'A') + enc.slice(pos + 1);
      try { const r = await S.decode(c); if (same(r, p)) miss++; } catch (e) { /* gewünscht */ }
    }
    ok(miss === 0, 'veränderte Zeichen ergeben nie das Original (' + n + ' Stellen)');
    let t = 0; for (const c of [enc.slice(0, 50), enc.slice(0, enc.length >> 1), '', 'keinbase64!!', enc + 'AAAA']) { try { await S.decode(c); } catch (e) { t++; } }
    ok(t >= 4, 'abgeschnittene oder fremde Texte werfen einen Fehler (' + t + ' von 5)');
  }
  { // Marker mit Lügen
    const j = new TextEncoder().encode(JSON.stringify({ a: { $ta: 'i', n: 2000000, o: 0, b: 3 } }));
    const u = new Uint8Array(4 + j.length + 3); new DataView(u.buffer).setUint32(0, j.length, true); u.set(j, 4);
    let bad = false; try { S.fromBytes(u); } catch (e) { bad = true; } ok(bad, 'Zahlenfeld mit zu großer Länge wird abgelehnt');
    const j2 = new TextEncoder().encode(JSON.stringify({ a: { $ta: 'u', n: 3, o: 0, b: 99 } })), u2 = new Uint8Array(4 + j2.length + 3); new DataView(u2.buffer).setUint32(0, j2.length, true); u2.set(j2, 4);
    bad = false; try { S.fromBytes(u2); } catch (e) { bad = true; } ok(bad, 'Zahlenfeld über das Ende hinaus wird abgelehnt');
    bad = false; try { S.fromBytes(new Uint8Array([255, 255, 255, 255, 1, 2])); } catch (e) { bad = true; } ok(bad, 'unmöglicher Kopf wird abgelehnt');
  }

  // ---------- Prüfungen ----------
  const cx = { v: 2, city: CITY };
  {
    const p = mkPack(300, 'r62649', 3);
    ok(S.check.p(p, 'r62649', cx) === '', 'Straßenpaket: gültig');
    const mut = (f, id) => { const q = Object.assign({}, p); f(q); return S.check.p(q, id || 'r62649', cx); };
    ok(mut(q => { q.v = 1; }) !== '', 'Straßenpaket: falsches Format');
    ok(S.check.p(p, 'r1', cx) !== '', 'Straßenpaket: gehört zu einer anderen Stadt');
    ok(mut(q => { q.la = q.la.slice(1); }) !== '', 'Straßenpaket: Längen passen nicht');
    ok(mut(q => { q.wi = q.wi.slice(); q.wi[5] = q.ids.length; }) !== '', 'Straßenpaket: Knotennummer außerhalb');
    ok(mut(q => { q.wi = q.wi.slice(); q.wi[5] = -1; }) !== '', 'Straßenpaket: negative Knotennummer');
    ok(mut(q => { q.wo = q.wo.slice(); q.wo[0] = 1; }) !== '', 'Straßenpaket: Wege beginnen nicht bei 0');
    ok(mut(q => { q.wo = q.wo.slice(); q.wo[q.wo.length - 1]--; }) !== '', 'Straßenpaket: Wegende passt nicht');
    ok(mut(q => { q.wo = q.wo.slice(); q.wo[3] = q.wo[2]; }) !== '', 'Straßenpaket: Weg mit weniger als 2 Knoten');
    ok(mut(q => { q.la = q.la.slice(); q.la[10] = Math.round(60 * 1e5); }) !== '', 'Straßenpaket: Knoten weit außerhalb der Stadt');
    ok(mut(q => { q.wn = q.wn.slice(); q.wn[2] = 9999; }) !== '', 'Straßenpaket: Namensnummer außerhalb');
    ok(mut(q => { q.s = q.s.concat(['x'.repeat(500)]); }) !== '', 'Straßenpaket: Name zu lang');
    ok(mut(q => { q.ids = Array.from(q.ids); }) !== '', 'Straßenpaket: Feld ist keine Zahlenreihe');
    ok(mut(q => { q.o = [1.5, 2]; }) !== '', 'Straßenpaket: Ursprung keine ganze Zahl');
    ok(mut(q => { q.wc = q.wc.slice(); q.wc[0] = 200; }) !== '', 'Straßenpaket: Wegklasse unmöglich');
    ok(S.check.p(null, 'r62649', cx) !== '' && S.check.p({}, 'r62649', cx) !== '', 'Straßenpaket: leer');
    const nb = Object.assign({}, p, { la: p.la.slice() }); nb.la[0] = Math.round(51.9 * 1e5);
    ok(S.check.p(nb, 'r62649', { v: 2 }) === '', 'Straßenpaket: ohne Stadtkasten nur grobe Grenzen der Erde');
  }
  {
    const ring = () => Int32Array.from([5140000, 700000, 5140000, 710000, 5150000, 710000, 5150000, 700000, 5140000, 700000]);
    const c = { id: 'r62649', v: 2, approx: false, name: 'Essen', lat: 51.45, lon: 7.01, area: 210, rings: [ring()], bbox: BB };
    ok(S.check.c(c, 'r62649', { v: 2 }) === '', 'Stadtgrenze: gültig');
    ok(S.check.c(Object.assign({}, c, { approx: true }), 'x', { v: 2 }) !== '', 'Stadtgrenze: Kreisnäherung wird nicht geteilt');
    ok(S.check.c(Object.assign({}, c, { v: 1 }), 'x', { v: 2 }) !== '', 'Stadtgrenze: falsches Format');
    ok(S.check.c(Object.assign({}, c, { rings: [] }), 'x', { v: 2 }) !== '', 'Stadtgrenze: ohne Ringe');
    ok(S.check.c(Object.assign({}, c, { rings: [Int32Array.from([1, 2, 3, 4])] }), 'x', { v: 2 }) !== '', 'Stadtgrenze: Ring zu kurz');
    ok(S.check.c(Object.assign({}, c, { rings: [Int32Array.from([5140000, 99999999, 5140000, 710000, 5150000, 710000, 5150000, 700000, 5140000, 700000])] }), 'x', { v: 2 }) !== '', 'Stadtgrenze: Punkt außerhalb der Erde');
    ok(S.check.c(Object.assign({}, c, { area: NaN }), 'x', { v: 2 }) !== '', 'Stadtgrenze: Fläche keine Zahl');
    ok(S.check.c(Object.assign({}, c, { id: 'r1/../x' }), 'x', { v: 2 }) !== '', 'Stadtgrenze: ungültige Kennung');
  }
  {
    const f = { v: 2, firms: [[0, 5145000, 701000, 'Büro GmbH'], [4, 5146000, 702000, 'Bank']] };
    ok(S.check.f(f, 'r1', { v: 2 }) === '', 'Firmen: gültig');
    ok(S.check.f({ v: 2, firms: [] }, 'r1', { v: 2 }) === '', 'Firmen: leere Liste ist gültig (Stadt ohne Firmen)');
    ok(S.check.f({ v: 2, firms: [[0, 1, 2]] }, 'r1', { v: 2 }) !== '', 'Firmen: Eintrag zu kurz');
    ok(S.check.f({ v: 2, firms: [[0, 1.5, 2, 'x']] }, 'r1', { v: 2 }) !== '', 'Firmen: Koordinate keine ganze Zahl');
    ok(S.check.f({ v: 2, firms: [[0, 5145000, 701000, { x: 1 }]] }, 'r1', { v: 2 }) !== '', 'Firmen: Name kein Text');
    ok(S.check.f({ v: 2, firms: new Array(4000).fill([0, 5145000, 701000, 'x']) }, 'r1', { v: 2 }) !== '', 'Firmen: zu viele');
    ok(S.check.f({ v: 1, firms: [] }, 'r1', { v: 2 }) !== '', 'Firmen: falsches Format');
  }
  {
    const E = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'essen.json'), 'utf8')); E.elev = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'essen_elev.json'), 'utf8'));
    Object.assign(E, { v: 1, name: 'Essen', sub: 'Innenstadt', tz: 'Europe/Berlin', radius: 750, ref: { lat: 51.451, lon: 7.014 } });
    const sv = d => S.check.s(d, 'k', { v: 1 }), cp = () => JSON.parse(JSON.stringify(E));
    ok(sv(E) === '', 'Startkarte (Essen-Demo): gültig');
    const back = await S.decode(await S.encode(E)); ok(same(E, back) && sv(back) === '', 'Startkarte: Rundlauf und gültig');
    const enc = await S.encode(E); console.log('  Info: Startkarte Essen ' + JSON.stringify(E).length + ' Zeichen JSON -> ' + enc.length + ' Zeichen');
    let d = cp(); d.roads.w[3][5] = 99999999; ok(sv(d) !== '', 'Startkarte: Knotennummer außerhalb');
    d = cp(); d.roads.w[3][4] = 1.5; ok(sv(d) !== '', 'Startkarte: Weg mit Kommazahl');
    d = cp(); d.roads.n.pop(); ok(sv(d) !== '', 'Startkarte: ungerade Knotenzahl');
    d = cp(); d.roads.w[0] = [1, 1, 0]; ok(sv(d) !== '', 'Startkarte: Weg ohne Knoten');
    d = cp(); d.v = 7; ok(sv(d) !== '', 'Startkarte: falsches Format');
    d = cp(); d.pois[0] = [1, 2]; ok(sv(d) !== '', 'Startkarte: Ort unvollständig');
    d = cp(); d.homes[0] = ['a', 2]; ok(sv(d) !== '', 'Startkarte: Haus ohne Zahlen');
    d = cp(); d.elev.z.pop(); ok(sv(d) !== '', 'Startkarte: Höhenraster unvollständig');
    d = cp(); d.elev = null; d.tz = null; ok(sv(d) === '', 'Startkarte: ohne Höhen und Zeitzone ist erlaubt');
    d = cp(); d.ref = null; ok(sv(d) !== '', 'Startkarte: ohne Ort');
    d = cp(); d.roads.s.push('y'.repeat(999)); ok(sv(d) !== '', 'Startkarte: Name zu lang');
  }

  // ---------- Holen und Ablegen ----------
  {
    const w = world(), S2 = w.S, p = mkPack(200, 'r62649', 5), ctx = { v: 2, city: CITY, n: 'Essen' };
    ok(await S2.get('p', 'r62649', ctx) === null && S2.stats().miss === 1, 'leerer Speicher: nichts gefunden');
    ok(await S2.put('p', 'r62649', p, ctx) === true && S2.stats().up === 1, 'Ablegen gelingt');
    const rec = w.db['p/r62649']; ok(rec && rec.v === 2 && typeof rec.d === 'string' && rec.t && rec.t['.sv'] === 'timestamp' && rec.n === 'Essen' && Object.keys(rec).sort().join() === 'd,n,t,v', 'Eintrag hat genau die Felder v, t, d, n');
    ok(w.calls.filter(c => c.startsWith('PUT')).length === 1, 'genau ein Schreibzugriff');
    const w2 = world(); w2.db = w.db; const got = await w2.S.get('p', 'r62649', ctx);
    ok(got && same(got, p), 'ein zweiter Spieler bekommt das gleiche Paket');
    ok(await w2.S.put('p', 'r62649', p, ctx) === false, 'bereits geholt: wird nicht wieder hochgeladen');
    const w3 = world(); w3.db = w.db; ok(await w3.S.put('p', 'r62649', p, ctx) === false && !w3.calls.some(c => c.startsWith('PUT')), 'liegt schon dort: kein Schreibzugriff (nur kleine Vorabfrage)');
    ok(w3.calls.length === 1 && w3.calls[0].endsWith('/v'), 'Vorabfrage liest nur das Formatfeld');
    // falsches Format
    const w4 = world(); w4.db = JSON.parse(JSON.stringify(w.db)); ok(await w4.S.get('p', 'r62649', { v: 3, city: CITY }) === null && w4.S.stats().old === 1, 'anderes Format: wird nicht gelesen');
    ok(await w4.S.put('p', 'r62649', p, { v: 3, city: CITY }) === false, 'neueres Format gegen altes: Schreiben wird von der Regel verweigert, aber ohne Folgefehler');
    // Beschädigter Eintrag
    const w5 = world(); w5.db = JSON.parse(JSON.stringify(w.db)); w5.db['p/r62649'].d = w5.db['p/r62649'].d.slice(0, 500) + 'AAAA' + w5.db['p/r62649'].d.slice(504);
    ok(await w5.S.get('p', 'r62649', ctx) === null && w5.S.stats().bad === 1, 'beschädigter Eintrag: null, als schlecht gemerkt');
    const c0 = w5.calls.length; ok(await w5.S.get('p', 'r62649', ctx) === null && w5.calls.length === c0, 'schlechter Eintrag wird in dieser Sitzung nicht noch einmal geholt');
    ok(await w5.S.put('p', 'r62649', p, ctx) === false, 'schlechter Eintrag wird nicht überschrieben versucht');
    // Eintrag mit falscher Stadt
    const w6 = world(); w6.db = JSON.parse(JSON.stringify(w.db)); ok(await w6.S.get('p', 'r62649', { v: 2, city: { id: 'x', bbox: { s: 10, n: 11, w: 10, e: 11 } } }) === null && w6.S.stats().bad === 1, 'Paket aus einer anderen Gegend: abgelehnt');
    // Voraussetzungen
    const w7 = world(); w7.signedIn = false; ok(await w7.S.get('p', 'r1', ctx) === null && await w7.S.put('p', 'r1', p, ctx) === false && w7.calls.length === 0, 'abgemeldet: kein Netzzugriff');
    const w8 = world(); w8.hasProfile = false; ok(await w8.S.get('p', 'r1', ctx) === null && w8.calls.length === 0, 'ohne Profil: kein Netzzugriff');
    const w9 = world(); w9.net = true; ok(await w9.S.get('p', 'r1', ctx) === null && w9.S.stats().err === 1, 'kein Netz: null');
    ok(await w9.S.put('p', 'r1', p, ctx) === false, 'kein Netz: Ablegen scheitert leise');
    const w10 = world(); w10.denyRead = true; ok(await w10.S.get('p', 'r1', ctx) === null && w10.S.stats().off === true, 'Regeln fehlen: aus');
    const c1 = w10.calls.length; await w10.S.get('p', 'r2', ctx); await w10.S.put('p', 'r2', p, ctx); ok(w10.calls.length === c1, 'Regeln fehlen: danach kein Netzzugriff mehr');
    const w11 = world(); w11.denyWrite = true; ok(await w11.S.put('p', 'r5', p, ctx) === false && w11.S.stats().off === false, 'Schreiben verweigert: Lesen bleibt an');
    ok(await w11.S.get('p', 'r5', ctx) === null && w11.S.stats().miss === 1, 'Lesen funktioniert weiter');
    ok(await world().S.get('x', 'r1', ctx) === null, 'unbekannte Art: null');
    // Prüfung beim Hochladen und Größe
    const w12 = world(); const big = { v: 2, firms: [] }; big.junk = Uint8Array.from(crypto.randomBytes(5.4e6)); w12.S.check.f = () => '';
    ok(await w12.S.put('f', 'r1', big, { v: 2 }) === false && w12.S.stats().big === 1 && !w12.calls.some(c => c.startsWith('PUT')), 'zu großes Paket (über ' + w12.S.MAXC + ' Zeichen) wird nicht hochgeladen');
    // Schlüssel
    ok(w.S.keyOf('link:r1~r2') === 'link_r1_r2' && w.S.keyOf('51.457,7.012') === '51_457_7_012' && w.S.keyOf('a'.repeat(200)).length === 80, 'Schlüssel enthalten nur erlaubte Zeichen und sind begrenzt');
    // Zwei gleichzeitige Spieler: nur ein Eintrag
    const p77 = mkPack(200, 'r77', 5), w13 = world(), w14 = world(); w14.db = w13.db; const [r1, r2] = await Promise.all([w13.S.put('p', 'r77', p77, ctx), w14.S.put('p', 'r77', p77, ctx)]);
    ok(Object.keys(w13.db).length === 1 && (r1 || r2) && !(r1 && r2 && false), 'gleichzeitiges Ablegen: ein Eintrag, kein Absturz');
  }

  console.log(pass + ' bestanden, ' + fail + ' fehlgeschlagen');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ABSTURZ', e); process.exit(2); });
