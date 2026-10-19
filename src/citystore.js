// Gemeinsamer Kartenspeicher (Oktober 2026): Wer eine Stadt als Erster lädt, legt das fertige Paket in der Realtime Database ab (komprimiert, einmal beschreibbar).
// Wer dieselbe Stadt später braucht, holt zuerst dort nach und lädt nur dann live von OpenStreetMap, wenn es noch kein brauchbares Paket gibt.
// Arten (kind): s Startkarte (loader.js), c Stadtgrenze, p Straßenpaket, f Firmen (cities.js). Pfad: citystore/<kind>/<Schlüssel>, Felder v (Format), t (Serverzeit), d (Paket), n (Name).
// Alles hier ist Beiwerk: Jeder Fehler (kein Netz, keine Rechte, kaputtes Paket) heißt nur „nicht vorhanden“, dann wird wie bisher live geladen.
// Getestet in tests/citystore_test.js (Format, Prüfungen), tests/lmo_store_test.js (Regeln) und tests/ui_store.py (im Browser).
// Karten- und Firmendaten stammen von OpenStreetMap (© OpenStreetMap-Mitwirkende, ODbL).
const LMStore = (function () {
  const MAXC = 7000000;                               // höchstens so viele Zeichen je Eintrag (Firebase erlaubt 10 MB je Text; die Regeln begrenzen ebenfalls)
  const LIM = { nodes: 4e6, ways: 1e6, ring: 4e5, rings: 1e6, firms: 3500, homes: 30000, pois: 5000, str: 160 };

  // ---------- Format: JSON für alles Übrige, Zahlenfelder als Differenzen (7 Bit je Byte), dann gzip und Base64 ----------
  class Buf {
    constructor() { this.a = new Uint8Array(1 << 16); this.n = 0; }
    room(k) { if (this.n + k > this.a.length) { const b = new Uint8Array(Math.max(this.a.length * 2, this.n + k)); b.set(this.a.subarray(0, this.n)); this.a = b; } }
    put(v) { this.room(10); const a = this.a; let n = this.n; while (v >= 128) { a[n++] = (v % 128) | 128; v = Math.floor(v / 128); } a[n++] = v; this.n = n; }
    raw(u) { this.room(u.length); this.a.set(u, this.n); this.n += u.length; }
  }
  function toBytes(obj) {
    const bin = new Buf();
    const json = JSON.stringify(obj, (k, v) => {
      if (!ArrayBuffer.isView(v)) return v;
      const t = v instanceof Int32Array ? 'i' : v instanceof Float64Array ? 'f' : v instanceof Uint8Array ? 'u' : null;
      if (!t) throw new Error('Zahlenfeld dieser Art wird nicht unterstützt');
      const o = bin.n;
      if (t === 'u') bin.raw(v);
      else { let p = 0; for (let i = 0; i < v.length; i++) { const x = v[i], d = x - p; p = x; bin.put(d >= 0 ? d * 2 : -d * 2 - 1); } }
      return { $ta: t, n: v.length, o, b: bin.n - o };
    });
    const j = new TextEncoder().encode(json), out = new Uint8Array(4 + j.length + bin.n);
    new DataView(out.buffer).setUint32(0, j.length, true); out.set(j, 4); out.set(bin.a.subarray(0, bin.n), 4 + j.length);
    return out;
  }
  function fromBytes(u) {
    if (u.length < 6) throw new Error('Paket zu kurz');
    const jl = new DataView(u.buffer, u.byteOffset, u.byteLength).getUint32(0, true), base = 4 + jl;
    if (base > u.length) throw new Error('Paketkopf unlesbar');
    return JSON.parse(new TextDecoder().decode(u.subarray(4, base)), (k, v) => {
      if (!v || typeof v !== 'object' || typeof v.$ta !== 'string') return v;
      const o = base + v.o, e = o + v.b;
      if (!(v.o >= 0) || !(v.b >= 0) || !(e <= u.length) || !(v.n >= 0) || !(v.n <= LIM.nodes * 2)) throw new Error('Zahlenfeld unlesbar');
      if (v.$ta === 'u') { if (v.b !== v.n) throw new Error('Zahlenfeld: falsche Länge'); return u.slice(o, e); }
      if (v.$ta !== 'i' && v.$ta !== 'f') throw new Error('Zahlenfeld: unbekannte Art');
      if (v.n > v.b) throw new Error('Zahlenfeld: falsche Länge');
      const out = v.$ta === 'i' ? new Int32Array(v.n) : new Float64Array(v.n); let p = 0, q = o;
      for (let i = 0; i < v.n; i++) {
        let x = 0, m = 1, c, k = 0;
        do { if (q >= e || ++k > 8) throw new Error('Zahlenfeld: abgeschnitten'); c = u[q++]; x += (c & 127) * m; m *= 128; } while (c & 128);
        p += x % 2 ? -(x + 1) / 2 : x / 2; out[i] = p;
      }
      if (q !== e) throw new Error('Zahlenfeld: Rest übrig');
      return out;
    });
  }
  async function pipe(u, S) {
    const s = new S('gzip'), w = s.writable.getWriter(), r = s.readable.getReader(), parts = []; let n = 0;
    w.write(u).catch(() => {}); w.close().catch(() => {});
    for (;;) { const x = await r.read(); if (x.done) break; parts.push(x.value); n += x.value.length; if (n > 1.2e8) throw new Error('Paket zu groß'); }
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const b64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const encode = async obj => b64(await pipe(toBytes(obj), CompressionStream));
  const decode = async d => fromBytes(await pipe(unb64(d), DecompressionStream));

  // ---------- Prüfungen: ein fremdes Paket darf das Spiel nie zum Absturz oder Hängen bringen ----------
  const isInt = v => Number.isInteger(v);
  const str = (v, n) => typeof v === 'string' && v.length <= (n || LIM.str);
  const latOk = v => v >= -9e6 && v <= 9e6, lonOk = v => v >= -18e6 && v <= 18e6;
  function checkRings(rings) {
    if (!Array.isArray(rings) || !rings.length || rings.length > 5000) return 'Ringe fehlen';
    let tot = 0;
    for (const r of rings) {
      if (!(r instanceof Int32Array) || r.length < 8 || r.length % 2 || r.length > LIM.ring * 2) return 'Ring ungültig';
      tot += r.length / 2; if (tot > LIM.rings) return 'zu viele Punkte';
      for (let i = 0; i < r.length; i += 2) if (!latOk(r[i]) || !lonOk(r[i + 1])) return 'Punkt außerhalb der Erde';
    }
    return '';
  }
  const check = {
    // Straßenpaket einer Stadt (cities.js loadRoads). ctx: { v, city }
    p(p, id, ctx) {
      if (!p || p.v !== ctx.v || p.cityId !== id) return 'Kopf';
      if (!(p.ids instanceof Float64Array && p.la instanceof Int32Array && p.lo instanceof Int32Array && p.wid instanceof Float64Array && p.wc instanceof Uint8Array && p.wf instanceof Uint8Array &&
        p.wn instanceof Int32Array && p.wo instanceof Int32Array && p.wi instanceof Int32Array && Array.isArray(p.s))) return 'Felder';
      const N = p.ids.length, W = p.wc.length;
      if (!N || !W || N > LIM.nodes || W > LIM.ways || p.la.length !== N || p.lo.length !== N || p.wid.length !== W || p.wf.length !== W || p.wn.length !== W || p.wo.length !== W + 1) return 'Längen';
      if (p.wo[0] !== 0 || p.wo[W] !== p.wi.length) return 'Wegende';
      if (!Array.isArray(p.o) || p.o.length !== 2 || !isInt(p.o[0]) || !isInt(p.o[1])) return 'Ursprung';
      if (p.s.length > W + 1 || !p.s.every(x => str(x))) return 'Namen';
      const b = ctx.city && ctx.city.bbox, mg = 0.5 * 1e5, s0 = b ? b.s * 1e5 - mg : -9e6, n0 = b ? b.n * 1e5 + mg : 9e6, w0 = b ? b.w * 1e5 - mg : -18e6, e0 = b ? b.e * 1e5 + mg : 18e6;
      for (let i = 0; i < N; i++) { const a = p.la[i], o = p.lo[i]; if (a < s0 || a > n0 || o < w0 || o > e0) return 'Knoten außerhalb der Stadt'; }
      for (let k = 0; k < W; k++) {
        if (p.wo[k + 1] - p.wo[k] < 2 || p.wc[k] > 40 || p.wn[k] < -1 || p.wn[k] >= p.s.length) return 'Weg ' + k;
      }
      for (let j = 0; j < p.wi.length; j++) if (p.wi[j] < 0 || p.wi[j] >= N) return 'Knotennummer';
      return '';
    },
    // Firmen einer Stadt: { v, firms: [[Art, Breite·1e5, Länge·1e5, Name], …] }
    f(f, id, ctx) {
      if (!f || f.v !== ctx.v || !Array.isArray(f.firms) || f.firms.length > LIM.firms) return 'Kopf';
      for (const x of f.firms) if (!Array.isArray(x) || x.length !== 4 || !isInt(x[0]) || x[0] < 0 || x[0] > 9 || !isInt(x[1]) || !isInt(x[2]) || !latOk(x[1]) || !lonOk(x[2]) || !str(x[3], 100)) return 'Firma';
      return '';
    },
    // Stadtgrenze (cities.js resolve). ctx: { v }
    c(c, id, ctx) {
      if (!c || c.v !== ctx.v || c.approx || !/^[A-Za-z0-9:~,._-]{1,100}$/.test(c.id || '') || !str(c.name, 120)) return 'Kopf';
      if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !Number.isFinite(c.area) || c.area < 0) return 'Zahlen';
      return checkRings(c.rings);
    },
    // Startkarte (loader.js loadCity). ctx: { v }
    s(d, id, ctx) {
      if (!d || d.v !== ctx.v || !str(d.name, 120) || !(d.sub === undefined || d.sub === null || str(d.sub, 200))) return 'Kopf';
      const rf = d.ref;
      if (!rf || !Number.isFinite(rf.lat) || !Number.isFinite(rf.lon) || !Array.isArray(d.bbox) || d.bbox.length !== 4 || !d.bbox.every(Number.isFinite)) return 'Ort';
      const R = d.roads;
      if (!R || !Array.isArray(R.o) || R.o.length !== 2 || !isInt(R.o[0]) || !isInt(R.o[1]) || !Array.isArray(R.n) || R.n.length % 2 || !R.n.length || R.n.length > LIM.nodes * 2 || !Array.isArray(R.w) || !R.w.length || R.w.length > LIM.ways || !Array.isArray(R.s)) return 'Straßen';
      const N = R.n.length / 2; for (const x of R.n) if (!isInt(x)) return 'Knoten';
      if (!R.s.every(x => str(x))) return 'Namen';
      for (const w of R.w) {
        if (!Array.isArray(w) || w.length < 5 || !isInt(w[0]) || !isInt(w[1]) || !isInt(w[2]) || w[0] < 0 || w[0] > 40 || w[2] < -1 || w[2] >= R.s.length) return 'Weg';
        let p = 0; for (let j = 3; j < w.length; j++) { if (!isInt(w[j])) return 'Weg'; p += w[j]; if (p < 0 || p >= N) return 'Knotennummer'; }
      }
      if (!Array.isArray(d.pois) || d.pois.length > LIM.pois || !Array.isArray(d.homes) || d.homes.length > LIM.homes) return 'Orte';
      for (const x of d.pois) if (!Array.isArray(x) || x.length !== 4 || !isInt(x[0]) || !isInt(x[1]) || !isInt(x[2]) || !str(x[3], 120)) return 'Ort';
      for (const x of d.homes) if (!Array.isArray(x) || x.length !== 2 || !isInt(x[0]) || !isInt(x[1])) return 'Haus';
      if (d.tz !== undefined && d.tz !== null && !str(d.tz, 60)) return 'Zeitzone';
      const e = d.elev;
      if (e !== undefined && e !== null) { if (!isInt(e.n) || e.n < 2 || e.n > 40 || !Array.isArray(e.z) || e.z.length !== e.n * e.n || !e.z.every(Number.isFinite) || !Array.isArray(e.b) || e.b.length !== 4 || !e.b.every(Number.isFinite)) return 'Höhen'; }
      return '';
    }
  };

  // ---------- Zugriff ----------
  const keyOf = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  // Erlaubte Schlüssel je Art (dieselben Muster stehen in den Regeln, firebase-rules.json): Koordinaten der Startkarte, Beziehungsnummern, Verbindungen zweier Städte, Punktschlüssel einer Ortsmarke
  const KEYS = { s: /^-?[0-9]{1,3}_[0-9]{3}_-?[0-9]{1,3}_[0-9]{3}$/, c: /^(r[0-9]{1,12}|pt_-?[0-9]{1,3}_[0-9]{3}_-?[0-9]{1,3}_[0-9]{3})$/, p: /^(r[0-9]{1,12}|link_r[0-9]{1,12}_r[0-9]{1,12})$/, f: /^r[0-9]{1,12}$/ };
  const shareable = (kind, id) => !!KEYS[kind] && KEYS[kind].test(keyOf(id));
  const st = { hit: 0, miss: 0, bad: 0, old: 0, err: 0, up: 0, skip: 0, big: 0, deny: 0, last: '' };
  const bad = new Set(), done = new Set();
  // Auf dem Gerät gemerkt (14 Tage): Dieses Paket gibt es im Speicher schon (geholt, abgelegt oder dort gefunden), also nicht noch einmal nachfragen
  const FLAG = 'lm.cs.', FLAG_MS = 14 * 86400000;
  const flagGet = tag => { try { const x = String(localStorage.getItem(FLAG + tag) || '').split(':'); return Date.now() - (+x[1] || 0) < FLAG_MS ? (+x[0] || 0) : 0; } catch (e) { return 0; } };
  const flagSet = (tag, v) => { try { localStorage.setItem(FLAG + tag, v + ':' + Date.now()); } catch (e) { /* ohne Speicher gilt es nur bis zum Neuladen */ } };
  let off = false;                                                         // Regeln noch nicht eingetragen oder kein Zugriff: nicht weiter versuchen
  const usable = () => {
    if (off || typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') return false;
    try { const s = LMO.state(); return !!(s.signedIn && s.hasProfile); } catch (e) { return false; }
  };
  const denied = e => { if (e && e.code === 'PERMISSION_DENIED') { off = true; st.deny++; } };
  // Ein Paket holen. Ergebnis: das Paket oder null (nicht vorhanden, falsches Format, kaputt, kein Zugriff). ctx: { v: erwartetes Format, … } (siehe check)
  async function get(kind, id, ctx) {
    const key = keyOf(id), tag = kind + '/' + key;
    if (!check[kind] || !shareable(kind, id) || !usable() || bad.has(tag)) return null;
    let r;
    try { r = await LMO._db('GET', 'citystore/' + tag, undefined, { ms: 20000 }); }
    catch (e) { st.err++; denied(e); return null; }
    if (!r || typeof r !== 'object') { st.miss++; return null; }
    if (r.v !== ctx.v || typeof r.d !== 'string') { st.old++; return null; }
    try {
      const obj = await decode(r.d), why = check[kind](obj, id, ctx);
      if (why) throw new Error(why);
      st.hit++; done.add(tag); flagSet(tag, r.v); return obj;
    } catch (e) { bad.add(tag); st.bad++; st.last = tag + ': ' + ((e && e.message) || String(e)); console.warn('Kartenpaket ' + tag + ' unbrauchbar:', st.last); return null; }
  }
  // Ein frisch geladenes Paket ablegen (im Hintergrund, nur wenn dort noch keines mit diesem oder neuerem Format liegt). ctx: { v, n (Name für den Betreiber) }
  async function put(kind, id, obj, ctx) {
    const key = keyOf(id), tag = kind + '/' + key;
    if (!check[kind] || !shareable(kind, id) || !usable() || done.has(tag) || bad.has(tag)) { st.skip++; return false; }
    if (flagGet(tag) >= ctx.v) { done.add(tag); st.skip++; return false; }
    const why = check[kind](obj, id, ctx);
    if (why) { st.skip++; st.last = tag + ': eigenes Paket unbrauchbar (' + why + ')'; return false; }     // nichts Halbfertiges oder Fehlerhaftes teilen
    let bytes; try { bytes = toBytes(obj); } catch (e) { st.skip++; return false; }       // sofort festhalten: das Spiel darf das Objekt danach noch verändern
    done.add(tag);
    let cur;
    try { cur = await LMO._db('GET', 'citystore/' + tag + '/v', undefined, { ms: 8000 }); }
    catch (e) { st.err++; denied(e); done.delete(tag); return false; }
    if (typeof cur === 'number' && cur >= ctx.v) { st.skip++; flagSet(tag, cur); return false; }
    try {
      const d = b64(await pipe(bytes, CompressionStream));
      if (d.length > MAXC) { st.big++; return false; }
      const rec = { v: ctx.v, t: { '.sv': 'timestamp' }, d }; if (ctx.n) rec.n = String(ctx.n).slice(0, 80);
      await LMO._db('PUT', 'citystore/' + tag, rec, { ms: 90000 });          // verweigert die Regel (z. B. weil jemand schneller war), ist das kein Fehler
      st.up++; flagSet(tag, ctx.v); return true;
    } catch (e) { st.err++; if (!(e && e.code === 'PERMISSION_DENIED')) done.delete(tag); return false; }
  }
  const stats = () => Object.assign({ off }, st);
  return { encode, decode, toBytes, fromBytes, check, get, put, keyOf, shareable, stats, MAXC };
})();
