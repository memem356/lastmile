// Städte für das Fulfillment Center: Nachbarstädte finden, Stadtgrenze holen, Straßen und Firmen ganzer Städte kachelweise laden,
// im Browser zwischenspeichern und mehrere Städte zu einem Straßennetz zusammenführen. Alles läuft über Overpass und Nominatim (wie loader.js).
// Im Spiel heißt das Modul LMCity, getestet wird es in tests/cities_test.js (mit einer künstlichen Welt statt echter Server).
const LMCity = (function () {
  const PACK_V = 2;
  // Kantenlänge der Abfragekacheln in Metern. Straßen: 5200 m (Messung Bochum: 2,6 km und 5,2 km brauchten beim Server gleich lang, die Wartezeit liegt am Server, nicht an der Datenmenge);
  // die Tests setzen globalThis.__LM_TILE_ROADS kleiner, damit ihre kleinen künstlichen Städte aus mehreren Kacheln bestehen.
  const TILE_OVERRIDE = (typeof globalThis !== 'undefined' && globalThis.__LM_TILE_ROADS) || 0;
  const TILE_ROADS = TILE_OVERRIDE || 5200, TILE_FIRMS = 5000;
  // Große Städte (ab 60 km²) bekommen doppelt so große Kacheln: Die Wartezeit liegt am Server, nicht an der Größe (Bochum: 5,2 km und 10,4 km je ca. 32 s), also sind weniger Anfragen schneller.
  const BIG_KM2 = 60;
  const bigCity = city => !TILE_OVERRIDE && !!city && city.area >= BIG_KM2;
  const roadTile = city => TILE_ROADS * (bigCity(city) ? 2 : 1), firmTile = city => TILE_FIRMS * (bigCity(city) ? 2 : 1);
  const FIRM_CAP = 3000;                            // höchstens so viele Firmen je Stadt
  const LATM = 110574, lonM = lat => 111320 * Math.cos(lat * Math.PI / 180);
  const store = { get: id => LM.dbGet(id), put: (id, d) => LM.dbPut(id, d), del: id => LM.dbDel(id), keys: p => LM.dbKeys(p) };   // in Tests austauschbar
  // Gemeinsamer Kartenspeicher (src/citystore.js, wird beim Start eingehängt): get(Art, Schlüssel, ctx) liefert ein fertiges Paket oder null, put(…) legt ein frisch geladenes im Hintergrund ab.
  // Ohne ihn (und bei jedem Fehler) wird wie bisher live geladen. Genutzt für Stadtgrenze (c), Straßenpaket (p) und Firmen (f).
  let remote = null;
  const setRemote = r => { remote = r; };
  const rget = async (kind, id, ctx) => { if (!remote) return null; try { return await remote.get(kind, id, ctx); } catch (e) { return null; } };
  const rput = (kind, id, obj, ctx) => { if (!remote) return; try { Promise.resolve(remote.put(kind, id, obj, ctx)).catch(() => {}); } catch (e) { /* nur Beiwerk */ } };
  const dist = (la1, lo1, la2, lo2) => Math.hypot((la2 - la1) * LATM, (lo2 - lo1) * lonM((la1 + la2) / 2));

  // ---------- Stadtgrenzen: Ringe aus Int32Array [Breite, Länge, …] in 1e-5 Grad; innen = ungerade Zahl von Überquerungen (Löcher zählen von selbst) ----------
  function ringArea(r) {                             // Quadratkilometer
    let a = 0; const n = r.length, k = lonM(r[0] / 1e5) * 1e-5, h = LATM * 1e-5;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) a += (r[j + 1] * k) * (r[i] * h) - (r[i + 1] * k) * (r[j] * h);
    return Math.abs(a) / 2 / 1e6;
  }
  function fromGeoJSON(g) {
    const polys = g && g.type === 'Polygon' ? [g.coordinates] : g && g.type === 'MultiPolygon' ? g.coordinates : null; if (!polys) return null;
    const rings = []; let area = 0;
    for (const poly of polys) poly.forEach((ring, k) => {
      if (!Array.isArray(ring) || ring.length < 4) return;
      const arr = new Int32Array(ring.length * 2);
      ring.forEach((p, i) => { arr[2 * i] = Math.round(p[1] * 1e5); arr[2 * i + 1] = Math.round(p[0] * 1e5); });
      rings.push(arr); const a = ringArea(arr); area += k === 0 ? a : -a;
    });
    return rings.length ? { rings, area: Math.max(0, area) } : null;
  }
  function circle(lat, lon, rM, n) {
    const arr = new Int32Array((n || 48) * 2 + 2), N = n || 48;
    for (let i = 0; i <= N; i++) { const a = (i % N) / N * 2 * Math.PI; arr[2 * i] = Math.round((lat + Math.sin(a) * rM / LATM) * 1e5); arr[2 * i + 1] = Math.round((lon + Math.cos(a) * rM / lonM(lat)) * 1e5); }
    return { rings: [arr], area: Math.PI * rM * rM / 1e6 };
  }
  function boxOf(rings) {
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const r of rings) for (let i = 0; i < r.length; i += 2) { if (r[i] < s) s = r[i]; if (r[i] > n) n = r[i]; if (r[i + 1] < w) w = r[i + 1]; if (r[i + 1] > e) e = r[i + 1]; }
    return { s: s / 1e5, w: w / 1e5, n: n / 1e5, e: e / 1e5 };
  }
  function inRings(rings, lat, lon) {
    const y = lat * 1e5, x = lon * 1e5; let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const yi = r[i], xi = r[i + 1], yj = r[j], xj = r[j + 1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }
  // Stadt-Objekt aus Ringen
  function cityOf(o) { const b = boxOf(o.rings); return Object.assign({ v: PACK_V, approx: false, pop: 0, level: 0, rel: 0 }, o, { bbox: b }); }
  const inCity = (c, lat, lon) => lat >= c.bbox.s && lat <= c.bbox.n && lon >= c.bbox.w && lon <= c.bbox.e && inRings(c.rings, lat, lon);

  // Berührt die Kante (a→b) das Rechteck t? (Cohen-Sutherland)
  function segHitsRect(ay, ax, by, bx, t) {
    const code = (y, x) => (x < t.w ? 1 : x > t.e ? 2 : 0) | (y < t.s ? 4 : y > t.n ? 8 : 0);
    let ca = code(ay, ax), cb = code(by, bx);
    for (let k = 0; k < 12; k++) {
      if (!(ca | cb)) return true; if (ca & cb) return false;
      const c = ca || cb; let x, y;
      if (c & 8) { x = ax + (bx - ax) * (t.n - ay) / (by - ay); y = t.n; } else if (c & 4) { x = ax + (bx - ax) * (t.s - ay) / (by - ay); y = t.s; }
      else if (c & 2) { y = ay + (by - ay) * (t.e - ax) / (bx - ax); x = t.e; } else { y = ay + (by - ay) * (t.w - ax) / (bx - ax); x = t.w; }
      if (c === ca) { ax = x; ay = y; ca = code(ay, ax); } else { bx = x; by = y; cb = code(by, bx); }
    }
    return false;
  }
  function tileTouches(rings, t) {
    const T = { s: t.s * 1e5, n: t.n * 1e5, w: t.w * 1e5, e: t.e * 1e5 };
    for (const r of rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        if (r[i] >= T.s && r[i] <= T.n && r[i + 1] >= T.w && r[i + 1] <= T.e) return true;
        if (segHitsRect(r[j], r[j + 1], r[i], r[i + 1], T)) return true;
      }
    }
    return inRings(rings, (t.s + t.n) / 2, (t.w + t.e) / 2);        // Kachel liegt ganz in der Stadt
  }
  // Kacheln über der Stadt, die die Grenze berühren (Nummer k stabil, damit zwischengespeicherte Kacheln wieder passen)
  function tilesOf(city, size) {
    const b = city.bbox, dlat = size / LATM, dlon = size / lonM((b.s + b.n) / 2), out = [];
    const ny = Math.max(1, Math.ceil((b.n - b.s) / dlat - 1e-9)), nx = Math.max(1, Math.ceil((b.e - b.w) / dlon - 1e-9));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const t = { s: b.s + j * dlat, n: Math.min(b.n, b.s + (j + 1) * dlat), w: b.w + i * dlon, e: Math.min(b.e, b.w + (i + 1) * dlon), k: j * nx + i };
      if (tileTouches(city.rings, t)) out.push(t);
    }
    return out;
  }

  // ---------- Städte in der Nähe und ihre Grenzen ----------
  // Städte und größere Orte im Umkreis (km), nächste zuerst: [{ key, name, lat, lon, pop, place, dist (m) }]
  async function nearby(lat, lon, km) {
    const q = `[out:json][timeout:40];node["place"~"^(city|town)$"]["name"](around:${Math.round(km * 1000)},${lat.toFixed(5)},${lon.toFixed(5)});out body;`;
    const j = await LM.overpass(q, null, 1), seen = new Set(), out = [];
    for (const el of j.elements || []) {
      const t = el.tags || {};
      if (el.type !== 'node' || !t.name || !isFinite(el.lat) || !isFinite(el.lon)) continue;
      const k = t.name.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      out.push({ key: 'n' + el.id, name: t.name, lat: el.lat, lon: el.lon, pop: parseInt(String(t.population || '').replace(/[^0-9]/g, ''), 10) || 0, place: t.place, dist: dist(lat, lon, el.lat, el.lon) });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  async function nominatimJson(url, what) { return (await LM.nomGet(url, what, 45000)).json(); }
  const popOf = v => parseInt(String(v || '').replace(/[^0-9]/g, ''), 10) || 0;
  // Grenze einer Beziehung (Relation) bei Nominatim
  async function nominatimPolygon(rel) {
    const j = await nominatimJson('https://nominatim.openstreetmap.org/lookup?osm_ids=R' + rel + '&format=jsonv2&polygon_geojson=1&polygon_threshold=0.0003&extratags=1&accept-language=de', 'Stadtgrenze');
    const x = j && j[0], g = x && fromGeoJSON(x.geojson);
    if (!g) throw new Error('Keine Stadtgrenze gefunden');
    return { g, rel, name: x.name || '', lat: Number(x.lat), lon: Number(x.lon), pop: popOf(x.extratags && x.extratags.population), level: parseInt(x.extratags && x.extratags.admin_level, 10) || 0 };
  }
  // Ersatz für Nominatim: die Grenze einer Beziehung vom Overpass-Server holen. Die Wegstücke werden zu geschlossenen Ringen zusammengesetzt (Außenränder zählen plus, Innenränder minus).
  function joinWays(ways) {
    const key = p => p[0] + ',' + p[1], rings = [], todo = ways.map(w => w.slice());
    while (todo.length) {
      let cur = todo.pop();
      for (let guard = 0; guard < 100000; guard++) {
        if (key(cur[0]) === key(cur[cur.length - 1])) break;
        const end = key(cur[cur.length - 1]), start = key(cur[0]);
        let k = todo.findIndex(w => key(w[0]) === end || key(w[w.length - 1]) === end);
        if (k >= 0) { const w = todo.splice(k, 1)[0]; cur = cur.concat(key(w[0]) === end ? w.slice(1) : w.slice(0, -1).reverse()); continue; }
        k = todo.findIndex(w => key(w[0]) === start || key(w[w.length - 1]) === start);
        if (k < 0) break;
        const w = todo.splice(k, 1)[0]; cur = (key(w[w.length - 1]) === start ? w.slice(0, -1) : w.slice(1).reverse()).concat(cur);
      }
      if (cur.length >= 4 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
    }
    return rings;
  }
  async function overpassPolygon(rel) {
    const j = await LM.overpass(`[out:json][timeout:60];rel(${Number(rel)});out geom;`, null, 1);
    const el = (j.elements || []).find(e => e.type === 'relation' && e.id === Number(rel));
    if (!el || !el.members) throw new Error('Keine Stadtgrenze gefunden');
    const outer = [], inner = [];
    for (const m of el.members) if (m.type === 'way' && m.geometry && m.geometry.length > 1) (m.role === 'inner' ? inner : outer).push(m.geometry.map(p => [Math.round(p.lat * 1e5), Math.round(p.lon * 1e5)]));
    const rings = [], thin = r => { const o = [r[0]]; for (let i = 1; i < r.length - 1; i++) { const l = o[o.length - 1]; if (Math.abs(r[i][0] - l[0]) + Math.abs(r[i][1] - l[1]) >= 15) o.push(r[i]); } o.push(r[r.length - 1]); return o; };
    let area = 0;
    for (const [list, sign] of [[outer, 1], [inner, -1]]) for (const r0 of joinWays(list)) {
      const r = thin(r0); if (r.length < 4) continue;
      const arr = new Int32Array(r.length * 2); r.forEach((p, i) => { arr[2 * i] = p[0]; arr[2 * i + 1] = p[1]; });
      rings.push(arr); area += sign * ringArea(arr);
    }
    if (!rings.length || !outer.length) throw new Error('Grenze unvollständig');
    const t = el.tags || {}, b = el.bounds || {};
    return { g: { rings, area: Math.max(0, area) }, rel: Number(rel), name: t.name || '', lat: (b.minlat + b.maxlat) / 2, lon: (b.minlon + b.maxlon) / 2, pop: popOf(t.population), level: parseInt(t.admin_level, 10) || 0 };
  }
  // Grenze einer Beziehung: erst Nominatim (eine kleine Abfrage), sonst Overpass
  async function polygonOf(rel, why) {
    try { return await nominatimPolygon(rel); }
    catch (e) { why.push('lookup R' + rel + ': ' + e.message); }
    const p = await overpassPolygon(rel); p.viaOverpass = true; return p;
  }
  // Die Stadt (Verwaltungsgrenze) um einen Punkt direkt bei Nominatim erfragen: eine einzige Abfrage, ohne den oft überlasteten Overpass-Server
  async function nominatimAround(lat, lon) {
    const x = await nominatimJson('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=' + lat.toFixed(6) + '&lon=' + lon.toFixed(6) + '&polygon_geojson=1&polygon_threshold=0.0003&extratags=1&accept-language=de', 'Stadtgrenze');
    if (!x || x.error) throw new Error('keine Verwaltungsgrenze an diesem Ort');
    if (x.osm_type !== 'relation') throw new Error('Treffer ist keine Grenze (' + x.osm_type + ')');
    const g = fromGeoJSON(x.geojson);
    if (!g) throw new Error('Treffer ohne Grenzlinie');
    return { g, rel: Number(x.osm_id), name: x.name || '', lat: Number(x.lat), lon: Number(x.lon), pop: popOf(x.extratags && x.extratags.population), level: parseInt(x.extratags && x.extratags.admin_level, 10) || 0 };
  }
  // Gründe, warum die letzte Grenzsuche ohne Grenze blieb (für den Stadt-Test)
  const lastResolve = { how: '', why: [] };
  const plausible = (p, lat, lon) => p && p.g && p.g.area >= 0.5 && p.g.area <= 3000 && inRings(p.g.rings, lat, lon);
  // Die Verwaltungsgrenze (Stadt oder Gemeinde) um einen Ort. pl: { name, lat, lon, place?, rel?, pop? }. Ohne Grenzdaten: Kreis (approx).
  // Wege, in dieser Reihenfolge: Beziehung bekannt → Grenze dazu; sonst Nominatim „reverse“; sonst Overpass is_in. Ein Kreis wird NICHT gemerkt (der nächste Versuch fragt neu).
  async function resolve(pl) {
    const pk = 'pt:' + pl.lat.toFixed(3) + ',' + pl.lon.toFixed(3), why = [], rk = pl.rel ? 'r' + pl.rel : pk;
    let p = null, how = '';
    // Auch ein schon auf diesem Gerät gespeicherter Treffer wird (einmalig, im Hintergrund) dem gemeinsamen Speicher angeboten: Das Spiel startet nach dem Laden einer Stadt neu, dabei kann die Ablage verloren gehen.
    const share = c => { rput('c', rk, c, { v: PACK_V, n: c.name }); if (c.id !== rk) rput('c', c.id, c, { v: PACK_V, n: c.name }); };
    const cached = c => { lastResolve.how = 'Zwischenspeicher'; lastResolve.why = []; share(c); return c; };
    if (pl.rel) { const c = await store.get('city:r' + pl.rel); if (c && c.v === PACK_V && !c.approx) return cached(c); }
    else { const hit = await store.get(pk); if (hit && hit.id) { const c = await store.get('city:' + hit.id); if (c && c.v === PACK_V && !c.approx) return cached(c); } }
    const rc = await rget('c', rk, { v: PACK_V });                    // schon einmal bestimmt und geteilt?
    if (rc) {
      const c2 = cityOf(Object.assign({}, rc, { lat: pl.lat || rc.lat, lon: pl.lon || rc.lon, pop: pl.pop || rc.pop, place: pl.place || rc.place || '' }));
      if (plausible({ g: { area: c2.area, rings: c2.rings } }, pl.lat, pl.lon)) {
        await store.put('city:' + c2.id, c2); if (!pl.rel) await store.put(pk, { id: c2.id });
        lastResolve.how = 'gemeinsamer Speicher'; lastResolve.why = []; return c2;
      }
    }
    if (pl.rel) {
      try { p = await polygonOf(pl.rel, why); how = 'Beziehung R' + pl.rel + (p.viaOverpass ? ' (über Overpass)' : ''); if (!plausible(p, pl.lat, pl.lon)) { why.push('Grenze R' + pl.rel + ' unplausibel (' + (p.g.area || 0).toFixed(1) + ' km²)'); p = null; } }
      catch (e) { why.push('Overpass R' + pl.rel + ': ' + e.message); p = null; }
    }
    if (!p) {
      try { p = await nominatimAround(pl.lat, pl.lon); how = 'Nominatim reverse'; if (!plausible(p, pl.lat, pl.lon)) { why.push('reverse: Grenze unplausibel (' + (p.g.area || 0).toFixed(1) + ' km², Ort liegt ' + (inRings(p.g.rings, pl.lat, pl.lon) ? 'in' : 'nicht in') + ' der Grenze)'); p = null; } }
      catch (e) { why.push('reverse: ' + e.message); p = null; }
    }
    if (!p && !pl.rel) {
      try {
        const q = `[out:json][timeout:40];is_in(${pl.lat.toFixed(5)},${pl.lon.toFixed(5)})->.a;rel(pivot.a)["boundary"="administrative"]["admin_level"~"^[678]$"];out tags;`;
        const j = await LM.overpass(q, null, 1); let best = null;
        for (const el of j.elements || []) {
          const lv = parseInt(el.tags && el.tags.admin_level, 10);
          if (el.type === 'relation' && lv >= 6 && lv <= 8 && (!best || lv > best.lv)) best = { id: el.id, lv, name: el.tags.name, pop: popOf(el.tags.population) };
        }
        if (!best) why.push('is_in: keine Gemeindegrenze in der Antwort (' + (j.elements || []).length + ' Treffer)');
        else {
          p = await polygonOf(best.id, why); how = 'Overpass is_in R' + best.id + (p.viaOverpass ? ' (Grenze über Overpass)' : ''); p.pop = p.pop || best.pop; p.level = best.lv; p.name = best.name || p.name;
          if (!plausible(p, pl.lat, pl.lon)) { why.push('is_in: Grenze unplausibel (' + (p.g.area || 0).toFixed(1) + ' km²)'); p = null; }
        }
      } catch (e) { why.push('is_in: ' + e.message); p = null; }
    }
    let city;
    if (p) city = cityOf({ id: 'r' + p.rel, rel: p.rel, level: p.level, name: p.name || pl.name, lat: pl.lat || p.lat, lon: pl.lon || p.lon, pop: pl.pop || p.pop, place: pl.place || '', rings: p.g.rings, area: p.g.area });
    else {
      const c = circle(pl.lat, pl.lon, pl.place === 'city' ? 4500 : pl.place === 'town' ? 2500 : 3000);
      city = cityOf({ id: 'c' + pl.lat.toFixed(3) + ',' + pl.lon.toFixed(3), name: pl.name, lat: pl.lat, lon: pl.lon, pop: pl.pop || 0, place: pl.place || '', rings: c.rings, area: c.area, approx: true });
      how = 'Kreis';
    }
    lastResolve.how = how; lastResolve.why = why;
    if (!city.approx) {
      await store.put('city:' + city.id, city); if (!pl.rel) await store.put(pk, { id: city.id });
      share(city);
    }
    return city;
  }

  // ---------- Straßen: eine Kachel in Zahlenfelder verwandeln ----------
  // Ergebnis: ids (OSM-Knotennummern), la/lo (1e-5 Grad), wid (OSM-Wegnummern), wc/wf/wn (Klasse, Merkmale, Name), wo/wi (Knoten je Weg), s (Namen)
  function compactTile(osm) {
    const nodes = new Map(), ways = [];
    for (const el of (osm && osm.elements) || []) { if (el.type === 'node') nodes.set(el.id, el); else if (el.type === 'way' && el.tags && el.nodes) ways.push(el); }
    const idx = new Map(), ids = [], la = [], lo = [], names = [], nameIdx = new Map(), wid = [], wc = [], wf = [], wn = [], wo = [0], wi = [];
    for (const w of ways) {
      const info = LM.wayInfo(w.tags); if (!info || w.nodes.length < 2) continue;
      let ok = true; for (const id of w.nodes) if (!nodes.has(id)) { ok = false; break; }
      if (!ok) continue;                                            // unvollständiger Weg: lieber ganz weglassen als zerstückeln
      const nd = info.rev ? w.nodes.slice().reverse() : w.nodes; let nm = -1;
      if (w.tags.name) { nm = nameIdx.get(w.tags.name); if (nm === undefined) { nm = names.length; names.push(w.tags.name); nameIdx.set(w.tags.name, nm); } }
      for (const id of nd) {
        let i = idx.get(id);
        if (i === undefined) { const n = nodes.get(id); i = ids.length; ids.push(id); la.push(Math.round(n.lat * 1e5)); lo.push(Math.round(n.lon * 1e5)); idx.set(id, i); }
        wi.push(i);
      }
      wo.push(wi.length); wid.push(w.id); wc.push(info.c); wf.push(info.f); wn.push(nm);
    }
    return { ids: Float64Array.from(ids), la: Int32Array.from(la), lo: Int32Array.from(lo), wid: Float64Array.from(wid), wc: Uint8Array.from(wc), wf: Uint8Array.from(wf),
      wn: Int32Array.from(wn), wo: Int32Array.from(wo), wi: Int32Array.from(wi), s: names };
  }
  // Mehrere Stücke (Kacheln, Städte) zu einem Straßennetz: gleiche Knoten und Wege (nach OSM-Nummer) zählen nur einmal.
  // Das Ergebnis behält ids und wid für weiteres Zusammenführen; für createEngine (lat, lon, wc, wf, wn, wo, wi, s, o) siehe forEngine.
  function merge(list, o) {
    let nN = 0, nW = 0, nM = 0; for (const p of list) { nN += p.ids.length; nW += p.wc.length; nM += p.wi.length; }
    const ids = new Float64Array(nN), la = new Int32Array(nN), lo = new Int32Array(nN), wid = new Float64Array(nW), wc = new Uint8Array(nW), wf = new Uint8Array(nW),
      wn = new Int32Array(nW), wo = new Int32Array(nW + 1), wi = new Int32Array(nM);
    const idx = new Map(), seenW = new Set(), names = [], nameIdx = new Map(); let N = 0, W = 0, M = 0;
    for (const p of list) {
      const map = new Int32Array(p.ids.length);
      for (let i = 0; i < p.ids.length; i++) {
        let g = idx.get(p.ids[i]);
        if (g === undefined) { g = N++; ids[g] = p.ids[i]; la[g] = p.la[i]; lo[g] = p.lo[i]; idx.set(p.ids[i], g); }
        map[i] = g;
      }
      const nmap = p.s.map(nm => { let k = nameIdx.get(nm); if (k === undefined) { k = names.length; names.push(nm); nameIdx.set(nm, k); } return k; });
      for (let k = 0; k < p.wc.length; k++) {
        const id = p.wid[k]; if (seenW.has(id)) continue; seenW.add(id);
        wid[W] = id; wc[W] = p.wc[k]; wf[W] = p.wf[k]; wn[W] = p.wn[k] >= 0 ? nmap[p.wn[k]] : -1; wo[W] = M;
        for (let j = p.wo[k]; j < p.wo[k + 1]; j++) wi[M++] = map[p.wi[j]];
        W++;
      }
    }
    wo[W] = M;
    return { o: o || [la[0], lo[0]], ids: ids.slice(0, N), la: la.slice(0, N), lo: lo.slice(0, N), wid: wid.slice(0, W), wc: wc.slice(0, W), wf: wf.slice(0, W),
      wn: wn.slice(0, W), wo: wo.slice(0, W + 1), wi: wi.slice(0, M), s: names };
  }
  // roads für createEngine und den Spielstart: ohne Dubletten-Nummern (spart Speicher)
  const forEngine = r => ({ o: r.o || [r.la[0], r.lo[0]], lat: r.la, lon: r.lo, wc: r.wc, wf: r.wf, wn: r.wn, wo: r.wo, wi: r.wi, s: r.s });

  // ---------- Laden (kachelweise, mit Zwischenspeicher je Kachel, damit ein Abbruch nicht alles kostet) ----------
  // Arbeitet die Aufgaben mit höchstens n gleichzeitigen Abfragen ab (Overpass erlaubt zwei) und meldet den Fortschritt
  async function pool(tasks, n, step) {
    let next = 0, done = 0, err = null;
    const worker = async () => {
      while (!err && next < tasks.length) {
        const my = next++;
        try { await tasks[my](); done++; step && step(done, tasks.length); } catch (e) { err = err || e; }
        if (!err) await LM.sleep(250);
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
    if (err) throw err;
  }
  const tileKey = (city, kind, size, k) => 'tile:' + city.id + ':' + kind + size + ':' + k;
  const bstr = t => LM.bbStr(t);

  async function loadRoads(city, progress, qf) {
    const t0 = Date.now(), pk = 'pack:' + city.id;
    const have = await store.get(pk), shared = !city.approx && (!qf || city.link);     // eigene Abfragen (Tests) und Kreisnäherungen werden nicht geteilt
    if (have && have.v === PACK_V && have.cityId === city.id) { if (shared) rput('p', city.id, have, { v: PACK_V, city, n: city.name }); return have; }
    if (shared && remote) {
      progress && progress({ phase: city.link ? 'link' : 'roads', done: 0, total: 1, text: city.name + ': gemeinsamer Kartenspeicher wird gefragt' });
      const rp = await rget('p', city.id, { v: PACK_V, city });
      if (rp) { await store.put(pk, rp); return rp; }
    }
    const TS = roadTile(city), tiles = tilesOf(city, TS), parts = new Array(tiles.length), net0 = LM.net.bytes;
    const tasks = tiles.map((t, i) => async () => {
      const key = tileKey(city, 'r', TS, t.k);
      let c = await store.get(key);
      if (!c) { c = compactTile(await LM.overpass((qf || LM.qRoads)(t), null, 2)); await store.put(key, c); }
      parts[i] = c;
    });
    await pool(tasks, 2, (d, n) => progress && progress({ phase: city.link ? 'link' : 'roads', done: d, total: n, text: city.name + ': Straßen ' + d + ' von ' + n + ' Kacheln' }));
    const m = merge(parts), pack = Object.assign(m, { v: PACK_V, cityId: city.id, stats: { nodes: m.ids.length, ways: m.wc.length, tiles: tiles.length, ms: Date.now() - t0, bytes: LM.net.bytes - net0 } });
    await store.put(pk, pack);
    if (shared) rput('p', city.id, pack, { v: PACK_V, city, n: city.name });
    for (const t of tiles) store.del(tileKey(city, 'r', TS, t.k));      // Kacheln werden nicht mehr gebraucht
    return pack;
  }

  // Firmen: [Art, Breite·1e5, Länge·1e5, Name], nur innerhalb der Stadtgrenze, höchstens FIRM_CAP (gleichmäßig ausgedünnt)
  function firmsOf(osm, city, seen) {
    const out = [];
    for (const el of (osm && osm.elements) || []) {
      const t = el.tags; if (!t || !t.name) continue;
      const uid = el.type + el.id; if (seen.has(uid)) continue;
      const lat = el.lat !== undefined ? el.lat : el.center && el.center.lat, lon = el.lon !== undefined ? el.lon : el.center && el.center.lon;
      if (lat === undefined || !inCity(city, lat, lon)) continue;
      if (t.shop === 'bakery' || t.shop === 'supermarket' || /^(restaurant|fast_food|cafe)$/.test(t.amenity || '')) continue;
      seen.add(uid); out.push([LM.firmKind(t), Math.round(lat * 1e5), Math.round(lon * 1e5), String(t.name).slice(0, 60)]);
    }
    return out;
  }
  async function loadFirms(city, progress) {
    const fk = 'firms:' + city.id, have = await store.get(fk);
    if (have && have.v === PACK_V && Array.isArray(have.firms)) { if (!city.approx) rput('f', city.id, have, { v: PACK_V, city, n: city.name }); return have.firms; }
    if (!city.approx) { const rf = await rget('f', city.id, { v: PACK_V, city }); if (rf) { await store.put(fk, { v: PACK_V, firms: rf.firms }); return rf.firms; } }
    const FS = firmTile(city), tiles = tilesOf(city, FS), parts = new Array(tiles.length), seen = new Set();
    const tasks = tiles.map((t, i) => async () => {
      const key = tileKey(city, 'f', FS, t.k); let c = await store.get(key);
      if (!c) { c = { raw: (await LM.overpass(LM.qFirms(t), null, 2)).elements || [] }; await store.put(key, c); }
      parts[i] = c.raw;
    });
    await pool(tasks, 2, (d, n) => progress && progress({ phase: 'firms', done: d, total: n, text: city.name + ': Firmen ' + d + ' von ' + n + ' Kacheln' }));
    let all = []; for (const raw of parts) all = all.concat(firmsOf({ elements: raw }, city, seen));
    if (all.length > FIRM_CAP) { const step = all.length / FIRM_CAP, pick = []; for (let i = 0; i < FIRM_CAP; i++) pick.push(all[Math.floor(i * step)]); all = pick; }
    await store.put(fk, { v: PACK_V, firms: all });
    if (!city.approx) rput('f', city.id, { v: PACK_V, firms: all }, { v: PACK_V, city, n: city.name });
    for (const t of tiles) store.del(tileKey(city, 'f', FS, t.k));
    return all;
  }

  // Alles zu einer Stadt: Grenze (schon bekannt), Straßen und Firmen. Ergebnis { city, pack, firms }
  async function loadCity(city, progress) {
    const pack = await loadRoads(city, progress);
    let firms = []; try { firms = await loadFirms(city, progress); } catch (e) { firms = null; }   // ohne Firmen gibt es nur Privatkunden
    return { city, pack, firms };
  }
  const cached = async id => { const p = await store.get('pack:' + id); return !!(p && p.v === PACK_V); };

  // ---------- Kernkarte und Städte zu einer Karte ----------
  const ckey = (la, lo) => (la + 9e6) * 4e7 + (lo + 2e7);
  // Die Kernkarte (ohne OSM-Nummern, an den Rändern abgeschnitten) wird mit den Städtepaketen verbunden: Knoten mit gleichen Koordinaten sind derselbe Knoten.
  // Kernwege, die ganz in einer geladenen Stadt liegen und dort schon vorkommen, fallen weg; alle anderen bleiben und hängen über gleiche Koordinaten an.
  function withCore(pk, core, cities) {
    const nP = pk.ids.length, idx = new Map(); for (let i = 0; i < nP; i++) idx.set(ckey(pk.la[i], pk.lo[i]), i);
    const nC = core.lat.length, inside = new Uint8Array(nC), known = new Uint8Array(nC);
    for (let i = 0; i < nC; i++) {
      const la = core.lat[i], lo = core.lon[i]; known[i] = idx.has(ckey(la, lo)) ? 1 : 0;
      for (const c of cities) if (inCity(c, la / 1e5, lo / 1e5)) { inside[i] = 1; break; }
    }
    const keep = []; let addM = 0;
    for (let k = 0; k < core.wc.length; k++) {
      let k2 = false; for (let j = core.wo[k]; j < core.wo[k + 1]; j++) { const v = core.wi[j]; if (!inside[v] || !known[v]) { k2 = true; break; } }
      if (k2) { keep.push(k); addM += core.wo[k + 1] - core.wo[k]; }
    }
    const la = new Int32Array(nP + nC), lo = new Int32Array(nP + nC), map = new Int32Array(nC).fill(-1); la.set(pk.la); lo.set(pk.lo); let N = nP;
    const mapNode = v => { let m = map[v]; if (m >= 0) return m; const g = idx.get(ckey(core.lat[v], core.lon[v])); if (g !== undefined) m = g; else { m = N++; la[m] = core.lat[v]; lo[m] = core.lon[v]; idx.set(ckey(core.lat[v], core.lon[v]), m); } return map[v] = m; };
    const W = pk.wc.length + keep.length, wc = new Uint8Array(W), wf = new Uint8Array(W), wn = new Int32Array(W), wo = new Int32Array(W + 1), wi = new Int32Array(pk.wi.length + addM);
    wc.set(pk.wc); wf.set(pk.wf); wn.set(pk.wn); wo.set(pk.wo.subarray(0, pk.wc.length + 1)); wi.set(pk.wi);
    const names = pk.s.slice(), nameIdx = new Map(names.map((n, i) => [n, i])); let w = pk.wc.length, m = pk.wi.length;
    for (const k of keep) {
      wc[w] = core.wc[k]; wf[w] = core.wf[k]; const nm = core.wn[k];
      if (nm >= 0) { const t = core.s[nm]; let q = nameIdx.get(t); if (q === undefined) { q = names.length; names.push(t); nameIdx.set(t, q); } wn[w] = q; } else wn[w] = -1;
      wo[w] = m; for (let j = core.wo[k]; j < core.wo[k + 1]; j++) wi[m++] = mapNode(core.wi[j]); w++;
    }
    wo[w] = m;
    return { o: core.o, lat: la.slice(0, N), lon: lo.slice(0, N), wc, wf, wn, wo, wi: wi.slice(0, m), s: names, kept: keep.length, dropped: core.wc.length - keep.length };
  }

  // ---------- Privatkunden aus Wohnstraßen ----------
  // Geladen werden nur Straßen, keine Häuser (das wären Millionen Gebäude). Darum entstehen Privatkunden entlang benannter Wohnstraßen:
  // alle ca. 'step' Meter ein Haus, abwechselnd links und rechts, nur innerhalb der Stadtgrenze und außerhalb von 'skip' (dort gibt es echte Häuser).
  // Ergebnis [[Breite·1e5, Länge·1e5, Straße], …], höchstens cap Stück, gleichmäßig ausgewählt. Gleiche Eingabe: gleiches Ergebnis.
  function synthHomes(pack, city, opt) {
    opt = opt || {}; const step = opt.step || 45, cap = opt.cap || 6000, skip = opt.skip, all = [];
    const classes = opt.classes || [3, 4, 5];                         // Nebenstraße, Wohnstraße, verkehrsberuhigt (Hauptstraßen und Serviceweg haben kaum Wohnhäuser)
    for (let k = 0; k < pack.wc.length; k++) {
      if (!classes.includes(pack.wc[k]) || pack.wn[k] < 0) continue;
      const nm = pack.s[pack.wn[k]]; let carry = step / 2, side = 1;
      for (let j = pack.wo[k] + 1; j < pack.wo[k + 1]; j++) {
        const a = pack.wi[j - 1], b = pack.wi[j], la0 = pack.la[a] / 1e5, lo0 = pack.lo[a] / 1e5, la1 = pack.la[b] / 1e5, lo1 = pack.lo[b] / 1e5;
        const dy = (la1 - la0) * LATM, dx = (lo1 - lo0) * lonM(la0), L = Math.hypot(dx, dy); if (L < 1) continue;
        const ex = -dy / L, ey = dx / L;                                // linke Normale (Ost-, Nordanteil)
        let d = carry;
        for (; d < L; d += step) {
          const f = d / L, off = 12 * side; side = -side;
          const la = la0 + (la1 - la0) * f + ey * off / LATM, lo = lo0 + (lo1 - lo0) * f + ex * off / lonM(la0);
          if (skip && dist(la, lo, skip.lat, skip.lon) < skip.r) continue;
          if (!inCity(city, la, lo)) continue;
          all.push([Math.round(la * 1e5), Math.round(lo * 1e5), nm]);
        }
        carry = d - L;                                                   // Rest in den nächsten Abschnitt mitnehmen
      }
    }
    if (all.length <= cap) return all;
    const out = [], f = all.length / cap; for (let i = 0; i < cap; i++) out.push(all[Math.floor(i * f)]); return out;
  }

  // ---------- Nachfrage ----------
  // Bestellungen pro Tag, die eine Stadt hergibt: nach Einwohnern (wenn bekannt), sonst nach Fläche (28 bis 160). Ein Transporter braucht ca. 14 davon.
  function demand(city) {
    const pop = city.pop || city.area * 2200;                          // ohne Angabe: ca. 2200 Einwohner je km²
    return Math.round(Math.max(28, Math.min(160, pop / 3000)));
  }

  // ---------- Verbindungen zwischen Städten ----------
  // Liegen zwei Städte nicht aneinander, fehlen die Straßen dazwischen: ein Transporter käme nicht hinüber. Dann werden die großen Straßen (Autobahn bis Kreisstraße)
  // in einem breiten Streifen zwischen den beiden Grenzen geladen und als weiteres Straßenstück angehängt.
  const LINK_HALF = 2500, LINK_EXT = 1500, LINK_MAX = 90000;   // halbe Breite des Streifens, Verlängerung über die Grenzpunkte hinaus, größter Abstand (m)
  function ringPts(c, max) {
    let n = 0; for (const r of c.rings) n += r.length / 2;
    const step = Math.max(1, Math.ceil(n / max)), out = []; let k = 0;
    for (const r of c.rings) for (let i = 0; i < r.length; i += 2, k++) if (k % step === 0) out.push([r[i] / 1e5, r[i + 1] / 1e5]);
    return out;
  }
  // Die beiden nächsten Punkte der Grenzen: { d (m), p: [Breite, Länge] auf a, q auf b }
  function closestPair(a, b) {
    const pa = ringPts(a, 300), pb = ringPts(b, 300); let best = null;
    for (const p of pa) for (const q of pb) { const d = dist(p[0], p[1], q[0], q[1]); if (!best || d < best.d) best = { d, p, q }; }
    return best;
  }
  // Streifen (Rechteck) von Stadt a zu Stadt b als Stadt-Objekt, damit er wie eine Stadt kachelweise geladen werden kann
  function linkOf(a, b, c) {
    if (a.id > b.id) { const t = a; a = b; b = t; c = { d: c.d, p: c.q, q: c.p }; }
    const P = c.p, Q = c.q, ky = LATM, kx = lonM((P[0] + Q[0]) / 2), dx = (Q[1] - P[1]) * kx, dy = (Q[0] - P[0]) * ky, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nxv = -uy, nyv = ux;
    const s0 = -LINK_EXT, s1 = L + LINK_EXT, ring = new Int32Array(10);
    [[s0, LINK_HALF], [s1, LINK_HALF], [s1, -LINK_HALF], [s0, -LINK_HALF], [s0, LINK_HALF]].forEach((v, i) => {
      const x = v[0] * ux + v[1] * nxv, y = v[0] * uy + v[1] * nyv;
      ring[2 * i] = Math.round((P[0] + y / ky) * 1e5); ring[2 * i + 1] = Math.round((P[1] + x / kx) * 1e5);
    });
    return cityOf({ id: 'link:' + a.id + '~' + b.id, name: 'Verbindung ' + a.name + ' – ' + b.name, lat: (P[0] + Q[0]) / 2, lon: (P[1] + Q[1]) / 2, rings: [ring], area: 0, link: true });
  }
  // Stück Straßennetz mit Koordinaten (1e-5 Grad) und Umrandung, für die Prüfung, ob zwei Stücke sich berühren
  function partOf(city, la, lo, link) {
    let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    for (let i = 0; i < la.length; i++) { const y = la[i], x = lo[i]; if (y < s) s = y; if (y > n) n = y; if (x < w) w = x; if (x > e) e = x; }
    return { city, la, lo, box: { s, n, w, e }, link: !!link };
  }
  // Zwei Stücke berühren sich, wenn sie einen Knoten an gleicher Stelle haben (gleicher OSM-Knoten)
  function touches(a, b) {
    const s = Math.max(a.box.s, b.box.s), n = Math.min(a.box.n, b.box.n), w = Math.max(a.box.w, b.box.w), e = Math.min(a.box.e, b.box.e);
    if (s > n || w > e) return false;
    const set = new Set(), small = a.la.length <= b.la.length ? a : b, big = small === a ? b : a;
    for (let i = 0; i < small.la.length; i++) { const y = small.la[i], x = small.lo[i]; if (y >= s && y <= n && x >= w && x <= e) set.add(ckey(y, x)); }
    if (!set.size) return false;
    for (let i = 0; i < big.la.length; i++) { const y = big.la[i], x = big.lo[i]; if (y >= s && y <= n && x >= w && x <= e && set.has(ckey(y, x))) return true; }
    return false;
  }
  // Lädt alle Städte (Straßen und Firmen) in der Reihenfolge der Liste und sorgt dafür, dass jede mit der Kernkarte verbunden ist.
  // Die Reihenfolge entscheidet, woran eine Stadt hängt; sie ist im Spielstand fest. Ergebnis { list: [{city, pack, firms}], links: [{city, pack}], unlinked: [Kennungen], typed }
  async function gather(core, refs, progress, toTyped) {
    const typed = core.roads && core.roads.lat ? core.roads : toTyped(core.roads);
    const cc = cityOf(Object.assign({ id: 'core', name: 'Kernkarte', lat: core.ref.lat, lon: core.ref.lon }, circle(core.ref.lat, core.ref.lon, core.radius || 750)));
    const parts = [partOf(cc, typed.lat, typed.lon)], uf = [0], list = [], links = [], unlinked = [], seen = new Set(), anchors = new Map();
    const find = i => { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; } return i; };
    const add = part => { const k = parts.length; parts.push(part); uf.push(k); for (let j = 0; j < k; j++) if (find(j) !== find(k) && touches(parts[j], part)) uf[find(j)] = find(k); return k; };
    for (const r of refs) {
      if (!r || seen.has(r.id)) continue; seen.add(r.id);
      const city = await resolve(r); if (r.pop && !city.pop) city.pop = r.pop;
      city.isl = r.isl || '';
      const res = await loadCity(city, progress); list.push(res);
      const k = add(partOf(city, res.pack.la, res.pack.lo));
      // Woran die Stadt hängen muss: an der Kernkarte; eine Insel (Center in einer fernen Stadt, ohne Verbindung zur Kernkarte) nur an ihrer ersten Stadt
      let root = 0;
      if (r.isl) { if (!anchors.has(r.isl)) { anchors.set(r.isl, k); continue; } root = anchors.get(r.isl); }
      if (find(k) === find(root)) continue;
      let best = null;                                                  // die nächste Stadt (oder die Kernkarte) der verbundenen Gruppe
      for (let j = 0; j < parts.length; j++) if (parts[j].city && !parts[j].link && find(j) === find(root)) { const c = closestPair(parts[j].city, city); if (!best || c.d < best.c.d) best = { j, c }; }
      if (best && best.c.d <= LINK_MAX) {
        const link = linkOf(parts[best.j].city, city, best.c), pk = await loadRoads(link, progress, LM.qLink);
        links.push({ city: link, pack: pk, root }); add(partOf(link, pk.la, pk.lo, true));
      }
      if (find(k) !== find(root)) {
        unlinked.push(city.id);
        for (const l of links.splice(0)) { if (find(parts.findIndex(q => q.city === l.city)) !== find(l.root)) await store.del('pack:' + l.city.id); else links.push(l); }   // eine Verbindung, die nicht trägt, wird nicht gemerkt (ein neuer Versuch lädt sie neu)
      }
    }
    return { list, links, unlinked, typed };
  }
  // Für den Kauf einer Stadt: alles laden und verbinden, ohne das Spiel zusammenzusetzen. Ergebnis { unlinked: [Kennungen], links: Anzahl, nodes: Straßenknoten aller Städte }
  // want: Punkt { lat, lon } (z. B. ein Klick auf die Karte); near ist der nächste Straßenpunkt der geladenen Städte { lat, lon, d (m) } oder null
  async function link(core, refs, progress, toTyped, want) {
    const g = await gather(core, refs, progress, toTyped); let nodes = 0, near = null;
    for (const x of g.list) nodes += x.pack.ids.length; for (const x of g.links) nodes += x.pack.ids.length;
    if (want) {
      let bd = Infinity, bi = -1, bp = null;
      const kx = Math.cos(want.lat * Math.PI / 180); for (const x of g.list) { const la = x.pack.la, lo = x.pack.lo, y0 = want.lat * 1e5, x0 = want.lon * 1e5; for (let i = 0; i < la.length; i++) { const dy = la[i] - y0, dx = (lo[i] - x0) * kx, d = dy * dy + dx * dx; if (d < bd) { bd = d; bi = i; bp = x.pack; } } }
      if (bp) near = { lat: bp.la[bi] / 1e5, lon: bp.lo[bi] / 1e5, d: dist(want.lat, want.lon, bp.la[bi] / 1e5, bp.lo[bi] / 1e5) };
    }
    return { unlinked: g.unlinked, links: g.links.length, nodes, near };
  }

  // ---------- Alles für den Spielstart ----------
  // refs: [{ id, name, lat, lon, rel?, place?, pop? }] (Städte der Center im Spielstand). Lädt jede Stadt (aus dem Zwischenspeicher oder von den Servern),
  // verbindet Kernkarte und Städte zu einem Straßennetz und erzeugt Privatkunden. toTyped: Umwandlung des Altformats der Kernkarte (roadsToTyped der Engine).
  // Ergebnis: { roads (für createEngine), cities: [Stadt mit firms, homes, dem], refs: [aktualisierte Verweise] }
  async function prepare(core, refs, progress, toTyped) {
    const say = p => progress && progress(p);
    const g = await gather(core, refs, progress, toTyped), list = g.list, bad = new Set(g.unlinked);
    const skip = { lat: core.ref.lat, lon: core.ref.lon, r: (core.radius || 750) };
    say({ phase: 'merge', text: 'Karten werden zusammengefügt …' });
    const merged = merge(list.map(x => x.pack).concat(g.links.map(x => x.pack)));
    const roads = withCore(merged, g.typed, list.map(x => x.city));
    const cities = list.map(x => {
      const c = x.city;
      return { id: c.id, name: c.name, lat: c.lat, lon: c.lon, rel: c.rel, place: c.place, pop: c.pop, approx: c.approx, area: c.area, level: c.level, rings: c.rings, bbox: c.bbox,
        firms: x.firms || [], firmsFailed: x.firms === null, homes: synthHomes(x.pack, c, { skip }), dem: demand(c), nodes: x.pack.ids.length, unlinked: bad.has(c.id), isl: c.isl || '' };
    });
    const nr = list.map(x => ({ id: x.city.id, name: x.city.name, lat: x.city.lat, lon: x.city.lon, rel: x.city.rel || 0, place: x.city.place || '', pop: x.city.pop || 0, ap: x.city.approx ? 1 : 0, isl: x.city.isl || '' }));
    return { roads, cities, refs: nr, stats: { nodes: roads.lat.length, ways: roads.wc.length, kept: roads.kept, dropped: roads.dropped, links: g.links.length } };
  }

  // Eine Abfrage an genau einen Server (ohne Ersatz): Antwort, Zeit, Größe oder Fehler. Bei einem Netzfehler wird geprüft, ob der Server überhaupt antwortet (dann fehlt nur die CORS-Freigabe im Browser).
  async function askServer(url, query, ms) {
    const body = 'data=' + encodeURIComponent(query), headers = { 'Content-Type': 'application/x-www-form-urlencoded' }, t0 = Date.now(), ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms || 40000);
    const sec = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s';
    try {
      const r = await fetch(url, { method: 'POST', body, headers, signal: ctl.signal }), txt = await r.text();
      let n = ''; try { const j = JSON.parse(txt); n = ', ' + (j.elements || []).length + ' Elemente' + (j.remark ? ', Hinweis: ' + String(j.remark).slice(0, 60) : ''); } catch (e) { n = ', keine JSON-Antwort'; }
      return 'Antwort ' + r.status + ' nach ' + sec() + ', ' + (txt.length / 1048576).toFixed(2) + ' MB' + n;
    } catch (e) {
      const why = e && e.name === 'AbortError' ? 'keine Antwort nach ' + sec() : ((e && e.message) || 'Fehler') + ' nach ' + sec();
      if (e && e.name === 'AbortError') return why;
      try { await fetch(url, { method: 'POST', body, headers, mode: 'no-cors', signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined }); return why + ' (der Server antwortet, aber der Browser darf die Antwort nicht lesen: Fehlerantwort ohne CORS-Freigabe)'; }
      catch (e2) { return why + ' (Server gar nicht erreichbar oder vom Browser blockiert)'; }
    } finally { clearTimeout(to); }
  }
  async function probeMore(city, sorted, pick, say, tries) {
    const servers = LM.servers ? LM.servers() : [], t = pick[0];
    say('— Zusatzmessung 1: dieselbe Straßen-Kachel (Kachel ' + t.k + ') bei jedem Server einzeln —');
    for (const u of servers) say(LM.host(u) + ': ' + await askServer(u, LM.qRoads(t), 45000));
    if (roadTile(city) < 10400) {
    const big = LM.bboxOf(city.lat, city.lon, 5200), bq = LM.qRoads(big);
    const b0 = LM.net.bytes, l0 = (LM.net.log || []).length, s0 = Date.now(), c = compactTile(await LM.overpass(bq, null, 1)), d = (Date.now() - s0) / 1000;
    say('— Zusatzmessung 2: eine sehr große Kachel (10,4 km, Stadtmitte; üblich sind ' + (roadTile(city) / 1000).toString().replace('.', ',') + ' km): ' + c.ids.length + ' Knoten, ' + c.wc.length + ' Wege, ' + d.toFixed(1) + ' s, ' + ((LM.net.bytes - b0) / 1048576).toFixed(1) + ' MB' + tries(l0));
    }
    const rest = sorted.filter(x => !pick.includes(x)), par = [rest[0], rest[Math.floor(rest.length / 3)], rest[Math.floor(rest.length * 2 / 3)], rest[rest.length - 1]].filter((v, i, a) => v && a.indexOf(v) === i);
    if (par.length > 1) {
      const lp = (LM.net.log || []).length, sp = Date.now();
      const res = await Promise.all(par.map(x => LM.overpass(LM.qRoads(x), null, 1).then(o => compactTile(o).ids.length, () => -1)));
      say('— Zusatzmessung 3: ' + par.length + ' Kacheln gleichzeitig: ' + ((Date.now() - sp) / 1000).toFixed(1) + ' s insgesamt, Knoten ' + res.join('/') + tries(lp));
    }
  }

  // ---------- Stadt-Test: lädt Stichproben einer echten Stadt und schätzt Dauer und Datenmenge für die ganze Stadt ----------
  async function probe(name, log) {
    const say = t => log && log(t), t0 = Date.now(), tries = i => { const l = ((LM.net && LM.net.log) || []).slice(i); return l.length ? ' [' + l.join('; ') + ']' : ''; }; say('Suche „' + name + '“ …');
    const hits = await LM.search(name); if (!hits.length) throw new Error('Ort nicht gefunden');
    const pl = hits[0]; say('Gefunden: ' + pl.name + (pl.sub ? ', ' + pl.sub : '') + (pl.nrel ? ' (Grenze R' + pl.nrel + ')' : ' (Punkt)') + '. Suche die Stadtgrenze …');
    const city = await resolve(Object.assign({}, pl, { rel: pl.nrel || 0, place: pl.nplace || pl.place || '', pop: pl.npop || pl.pop || 0 }));
    say('Grenze über: ' + lastResolve.how + (lastResolve.why.length ? ' (zuvor gescheitert: ' + lastResolve.why.join('; ') + ')' : '') + (city.pop ? ', Einwohner ' + city.pop : ''));
    if (LM.dbBlocked && LM.dbBlocked()) say('Hinweis: Der Kartenspeicher antwortet nicht, vermutlich ist Lastmile noch in einem anderen Tab oder Fenster geöffnet (ältere Version). Alles wird neu geladen (langsamer). Bitte die anderen Tabs schließen und diese Seite neu laden.');
    let pts = 0; for (const r of city.rings) pts += r.length / 2;
    say(city.name + ': ' + (city.approx ? 'keine Grenzdaten, Näherungskreis' : 'Stadtgrenze mit ' + city.rings.length + ' Ringen und ' + pts + ' Punkten') + ', Fläche ' + city.area.toFixed(1) + ' km²');
    const tiles = tilesOf(city, roadTile(city)), sorted = tiles.slice().sort((a, b) => dist(city.lat, city.lon, (a.s + a.n) / 2, (a.w + a.e) / 2) - dist(city.lat, city.lon, (b.s + b.n) / 2, (b.w + b.e) / 2));
    say(tiles.length + ' Kacheln à ' + (roadTile(city) / 1000) + ' km' + (bigCity(city) ? ' (große Stadt: doppelte Kachelgröße)' : ''));
    const pick = [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]].filter((v, i, a) => v && a.indexOf(v) === i);
    let nodes = 0, ways = 0, ms = 0, bytes = 0;
    for (const t of pick) {
      const b0 = LM.net.bytes, s0 = Date.now(), l0 = (LM.net.log || []).length, c = compactTile(await LM.overpass(LM.qRoads(t), null, 2));
      const d = Date.now() - s0; nodes += c.ids.length; ways += c.wc.length; ms += d; bytes += LM.net.bytes - b0;
      say('Kachel ' + t.k + ': ' + c.ids.length + ' Knoten, ' + c.wc.length + ' Wege, ' + (d / 1000).toFixed(1) + ' s, ' + ((LM.net.bytes - b0) / 1048576).toFixed(1) + ' MB' + tries(l0));
    }
    const f = tiles.length / pick.length, est = { tiles: tiles.length, nodes: Math.round(nodes * f), ways: Math.round(ways * f), seconds: Math.round(ms * f / 1000 / 2), mb: Math.round(bytes * f / 1048576) };
    say('Schätzung für die ganze Stadt (Straßen): ' + est.nodes + ' Knoten, ' + est.ways + ' Wege, ca. ' + est.mb + ' MB Download, ca. ' + est.seconds + ' s bei zwei Abfragen gleichzeitig');
    const fts = tilesOf(city, firmTile(city)).sort((a, b) => dist(city.lat, city.lon, (a.s + a.n) / 2, (a.w + a.e) / 2) - dist(city.lat, city.lon, (b.s + b.n) / 2, (b.w + b.e) / 2));
    const ft = fts[0], fs0 = Date.now(), fl0 = (LM.net.log || []).length, fr = firmsOf(await LM.overpass(LM.qFirms(ft), null, 2), city, new Set()), fsec = (Date.now() - fs0) / 1000;
    say('Firmen in einer Kachel (' + (firmTile(city) / 1000) + ' km, zentral): ' + fr.length + ' in ' + fsec.toFixed(1) + ' s' + tries(fl0));
    say('Schätzung Firmen für die ganze Stadt: ' + fts.length + ' Kacheln, ca. ' + Math.round(fsec * fts.length / 2) + ' s bei zwei Abfragen gleichzeitig; Straßen und Firmen zusammen ca. ' + Math.round(est.seconds + fsec * fts.length / 2) + ' s');
    // Weitere Messungen: Wie schnell antwortet jeder Server auf diese Straßenabfrage? Hilft eine größere Kachel? Verträgt der Server mehrere Abfragen gleichzeitig?
    try { await probeMore(city, sorted, pick, say, tries); } catch (e) { say('Zusatzmessung abgebrochen: ' + ((e && e.message) || e)); }
    say('Fertig nach ' + Math.round((Date.now() - t0) / 1000) + ' s. Zahlen bitte weitergeben.');
    return { city: city.name, area: city.area, approx: city.approx, est, firmsSample: fr.length };
  }

  return { joinWays, overpassPolygon, roadTile, firmTile, PACK_V, TILE_ROADS, TILE_FIRMS, FIRM_CAP, store, nearby, resolve, tilesOf, tileTouches, inRings, inCity, fromGeoJSON, circle, ringArea, boxOf, cityOf,
    setRemote, compactTile, merge, forEngine, withCore, lastResolve, synthHomes, demand, prepare, link, gather, closestPair, linkOf, touches, partOf, loadRoads, loadFirms, loadCity, cached, probe, dist };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LMCity;
