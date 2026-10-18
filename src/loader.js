// Stadtlader: Suche (Nominatim), Straßen/Orte (Overpass), Kompaktformat, Cache (IndexedDB)
const LM = (function () {
  const FORMAT = 1;
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  const HW = { motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2,
    tertiary: 3, tertiary_link: 3, unclassified: 4, residential: 4, living_street: 5, service: 6, cycleway: 7 };
  const HW_RE = Object.keys(HW).join('|');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const net = { bytes: 0, calls: 0 };                              // Zähler für den Stadt-Test: übertragene Zeichen und Abfragen

  // ---------- Suche ----------
  async function search(q) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&accept-language=de&featuretype=settlement&q=' + encodeURIComponent(q);
    const r = await fetch(url);
    if (!r.ok) throw new Error('Suche nicht erreichbar (' + r.status + ')');
    const j = await r.json(), seen = new Set(), out = [];
    for (const x of j) {
      const a = x.address || {};
      const name = x.name || a.city || a.town || a.village || x.display_name.split(',')[0];
      const sub = [a.state || a.region || a.county, a.country].filter(Boolean).join(', ');
      const lat = Number(x.lat), lon = Number(x.lon), key = name + '|' + sub;
      if (seen.has(key) || !isFinite(lat) || !isFinite(lon)) continue;
      seen.add(key); out.push({ name, sub, lat, lon });
    }
    return out;
  }

  // ---------- Overpass ----------
  async function overpass(query, onTry, rounds) {
    let lastErr = null;
    for (let round = 0; round < (rounds || 2); round++) {
      for (let m = 0; m < OVERPASS.length; m++) {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 70000);
        try {
          if (onTry) onTry(m, round);
          const r = await fetch(OVERPASS[m], { method: 'POST', body: 'data=' + encodeURIComponent(query),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
          if (r.ok) {
            const txt = await r.text(); net.bytes += txt.length; net.calls++; const j = JSON.parse(txt);
            // Overpass antwortet bei Zeitüberschreitung oder Speichermangel mit 200 und einer unvollständigen Antwort samt Hinweis: das darf nicht als Ergebnis (und nicht in den Zwischenspeicher) gelten
            if (j && typeof j.remark === 'string' && /runtime error/i.test(j.remark)) throw new Error('Kartenserver überlastet (' + j.remark.slice(0, 80) + ')');
            clearTimeout(to); return j;
          }
          lastErr = new Error('Kartenserver antwortet mit ' + r.status);
        } catch (e) { lastErr = e; }
        clearTimeout(to);
        await sleep(600);
      }
      await sleep(2500);
    }
    throw new Error('Kartendaten konnten nicht geladen werden (' + (lastErr && lastErr.message || 'unbekannt') + ')');
  }

  function bboxOf(lat, lon, R) {
    const dlat = R / 110574, dlon = R / (111320 * Math.cos(lat * Math.PI / 180));
    return { s: lat - dlat, n: lat + dlat, w: lon - dlon, e: lon + dlon };
  }
  const bbStr = b => [b.s, b.w, b.n, b.e].map(v => v.toFixed(6)).join(',');

  const qRoads = b => `[out:json][timeout:60];way["highway"~"^(${HW_RE})$"](${bbStr(b)});out body;>;out skel qt;`;
  // Nur die großen Straßen (Autobahn bis Kreisstraße): für die Verbindung zwischen Städten, die nicht aneinander liegen
  const LINK_HW = 'motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
  const qLink = b => `[out:json][timeout:60];way["highway"~"^(${LINK_HW})$"](${bbStr(b)});out body;>;out skel qt;`;
  const qPlaces = b => `[out:json][timeout:90];(nwr["amenity"~"^(restaurant|fast_food|cafe)$"]["name"](${bbStr(b)});nwr["shop"~"^(bakery|supermarket)$"]["name"](${bbStr(b)}););out center tags;way["building"~"^(apartments|residential|house|detached|terraced|semidetached_house|dormitory|yes)$"](${bbStr(b)});out skel center qt;`;

  // Firmen für das Fulfillment Center: Büros, Betriebe, Geschäfte, Praxen, Banken (mit Namen). Restaurants, Cafés, Bäckereien und Supermärkte sind schon Abholorte.
  const qFirms = b => { const bb = bbStr(b); return `[out:json][timeout:90];(nwr["office"]["name"](${bb});nwr["craft"]["name"](${bb});nwr["shop"]["name"](${bb});nwr["amenity"~"^(pharmacy|doctors|dentist|clinic|veterinary|bank|post_office|coworking_space)$"]["name"](${bb});nwr["building"~"^(industrial|warehouse|commercial|office|retail)$"]["name"](${bb}););out center tags;`; };

  // ---------- Umwandlung ins Kompaktformat ----------
  // Straßenklasse c, Merkmale f (1 Einbahn, 2 nur Rad, 4 nicht für Räder) und ob die Richtung umzudrehen ist; null: Weg zählt nicht
  function wayInfo(t) {
    const hw = t.highway; if (!(hw in HW)) return null;
    if (t.access === 'private' || t.access === 'no' || t.area === 'yes') return null;
    if (hw === 'service' && /^(parking_aisle|driveway|drive-through|emergency_access)$/.test(t.service || '')) return null;
    const c = HW[hw]; let f = 0, rev = false;
    const ow = t.oneway;
    if (ow === '-1' || ow === 'reverse') { rev = true; f |= 1; }
    else if (ow === 'yes' || ow === '1' || ow === 'true' || t.junction === 'roundabout' || t.junction === 'circular' || (c === 0 && ow !== 'no')) f |= 1;
    if (c === 7) f |= 2;
    if (c === 0 || t.bicycle === 'no') f |= 4;
    return { c, f, rev };
  }
  function convertRoads(osm, b) {
    const pad = 0.0006; // ca. 60 m Rand
    const inside = n => n.lat >= b.s - pad && n.lat <= b.n + pad && n.lon >= b.w - pad && n.lon <= b.e + pad;
    const nodes = new Map(), ways = [];
    for (const el of osm.elements) {
      if (el.type === 'node') nodes.set(el.id, el);
      else if (el.type === 'way' && el.tags && el.tags.highway in HW) ways.push(el);
    }
    const idx = new Map(), coords = [], names = [], nameIdx = new Map(), out = [];
    const nodeIndex = id => {
      let i = idx.get(id);
      if (i === undefined) { const n = nodes.get(id); i = coords.length; coords.push([Math.round(n.lat * 1e5), Math.round(n.lon * 1e5)]); idx.set(id, i); }
      return i;
    };
    for (const w of ways) {
      const t = w.tags, info = wayInfo(t); if (!info) continue;
      const c = info.c, f = info.f; let ids = w.nodes.slice();
      if (info.rev) ids.reverse();
      let nm = -1;
      if (t.name) { nm = nameIdx.get(t.name); if (nm === undefined) { nm = names.length; names.push(t.name); nameIdx.set(t.name, nm); } }
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          const arr = [c, f, nm]; let p = 0;
          for (const id of run) { const i = nodeIndex(id); arr.push(i - p); p = i; }
          out.push(arr);
        }
        run = [];
      };
      for (const id of ids) {
        const n = nodes.get(id);
        if (n && inside(n)) run.push(id); else flush();
      }
      flush();
    }
    if (!coords.length) throw new Error('Keine Straßen gefunden');
    const o = coords[0], flat = []; let pa = o[0], po = o[1];
    for (const [la, lo] of coords) { flat.push(la - pa, lo - po); pa = la; po = lo; }
    return { o, n: flat, w: out, s: names };
  }

  function convertPlaces(osm, ref, o, b) {
    const pois = [], seen = new Set();
    for (const el of osm.elements) {
      const t = el.tags; if (!t || !t.name) continue;
      const lat = el.lat !== undefined ? el.lat : el.center && el.center.lat, lon = el.lon !== undefined ? el.lon : el.center && el.center.lon;
      if (lat === undefined || lat < b.s || lat > b.n || lon < b.w || lon > b.e) continue;
      const type = t.amenity === 'restaurant' ? 0 : t.amenity === 'fast_food' ? 1 : t.amenity === 'cafe' ? 2 : t.shop === 'bakery' ? 3 : t.shop === 'supermarket' ? 4 : -1;
      if (type < 0) continue;
      const key = type + t.name + Math.round(lat * 2000) + Math.round(lon * 2000);
      if (seen.has(key)) continue; seen.add(key);
      pois.push({ d: (lat - ref.lat) ** 2 + ((lon - ref.lon) * 0.62) ** 2, v: [type, Math.round(lat * 1e5) - o[0], Math.round(lon * 1e5) - o[1], t.name] });
    }
    pois.sort((a, b2) => a.d - b2.d);
    return pois.slice(0, 320).map(p => p.v);
  }

  function convertHomes(osm, o, b) {
    const all = [];
    for (const el of osm.elements) {
      if (el.tags) continue; const c = el.center; if (!c || c.lat < b.s || c.lat > b.n || c.lon < b.w || c.lon > b.e) continue;
      all.push([Math.round(c.lat * 1e5) - o[0], Math.round(c.lon * 1e5) - o[1]]);
    }
    const cap = 900, step = Math.max(1, all.length / cap), out = [];
    for (let i = 0; i < all.length; i += step) out.push(all[Math.floor(i)]);
    return out;
  }

  const firmKind = t => { const a = t.amenity || '';
    return t.office || a === 'coworking_space' ? 0 : t.craft || /^(industrial|warehouse)$/.test(t.building || '') ? 1 : t.shop || t.building === 'retail' ? 2 : /^(pharmacy|doctors|dentist|clinic|veterinary)$/.test(a) ? 3 : 4; };
  // Firmenkunden als [Art, Breite·1e5, Länge·1e5, Name]; Art: 0 Büro, 1 Betrieb, 2 Geschäft, 3 Praxis, 4 Bank oder Dienst. Die nächsten 400 zum Ortsmittelpunkt.
  function convertFirms(osm, ref, b) {
    const out = [], seen = new Set();
    for (const el of osm.elements || []) {
      const t = el.tags; if (!t || !t.name) continue;
      const lat = el.lat !== undefined ? el.lat : el.center && el.center.lat, lon = el.lon !== undefined ? el.lon : el.center && el.center.lon;
      if (lat === undefined || lat < b.s || lat > b.n || lon < b.w || lon > b.e) continue;
      if (t.shop === 'bakery' || t.shop === 'supermarket' || /^(restaurant|fast_food|cafe)$/.test(t.amenity || '')) continue;
      const kind = firmKind(t);
      const key = t.name + Math.round(lat * 4000) + Math.round(lon * 4000);
      if (seen.has(key)) continue; seen.add(key);
      out.push({ d: (lat - ref.lat) ** 2 + ((lon - ref.lon) * 0.62) ** 2, v: [kind, Math.round(lat * 1e5), Math.round(lon * 1e5), String(t.name).slice(0, 60)] });
    }
    out.sort((p, q) => p.d - q.d);
    return out.slice(0, 400).map(p => p.v);
  }

  // ---------- Höhenraster (Open-Meteo, 16 x 16 Punkte) ----------
  async function fetchElevation(b) {
    const n = 16, la = [], lo = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { la.push((b.s + (b.n - b.s) * r / (n - 1)).toFixed(5)); lo.push((b.w + (b.e - b.w) * c / (n - 1)).toFixed(5)); }
    const jobs = [];
    for (let i = 0; i < la.length; i += 100) {
      const url = 'https://api.open-meteo.com/v1/elevation?latitude=' + la.slice(i, i + 100).join(',') + '&longitude=' + lo.slice(i, i + 100).join(',');
      jobs.push((async () => {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
        try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw 0; return (await r.json()).elevation; } finally { clearTimeout(to); }
      })());
    }
    const parts = await Promise.all(jobs), z = [].concat(...parts).map(v => Math.round(v * 10) / 10);
    if (z.length !== n * n || z.some(v => typeof v !== 'number' || !isFinite(v))) throw new Error('Höhendaten unvollständig');
    return { n, b: [b.s, b.w, b.n, b.e], z };
  }

  // Zeitzone der Stadt (IANA-Name), damit das Spiel mit der echten Ortszeit startet
  async function fetchTz(lat, lon) {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3) + '&current=temperature_2m&timezone=auto';
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 4000);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw 0; const j = await r.json(); return typeof j.timezone === 'string' ? j.timezone : null; }
    catch (e) { return null; } finally { clearTimeout(to); }
  }

  // ---------- Stadt laden ----------
  async function loadCity(place, progress) {
    const say = (step, text) => progress && progress(step, text);
    let R = 1800, last = null;
    for (let attempt = 0; attempt < 2; attempt++, R *= 1.5) {
      const b = bboxOf(place.lat, place.lon, R);
      const note = m => (m || attempt ? ' (anderer Server …)' : '');
      say(1, 'Straßennetz wird geladen' + (attempt ? ' – größeres Gebiet' : ''));
      const roadsOsm = await overpass(qRoads(b), (m, r) => { if (m || r) say(1, 'Straßennetz wird geladen' + note(m + r)); });
      const roads = convertRoads(roadsOsm, b);
      say(2, 'Restaurants, Läden und Wohnhäuser werden geladen');
      const placesOsm = await overpass(qPlaces(b));
      const pois = convertPlaces(placesOsm, place, roads.o, b), homes = convertHomes(placesOsm, roads.o, b);
      last = { pois: pois.length, homes: homes.length, ways: roads.w.length };
      if (pois.length >= 6 && homes.length >= 20 && roads.w.length >= 80) {
        say(3, 'Höhenprofil wird geladen');
        let elev = null; try { elev = await fetchElevation(b); } catch (e) { elev = null; }
        const tz = await fetchTz(place.lat, place.lon);
        return {
          v: FORMAT, name: place.name, sub: place.sub,
          ref: { lat: place.lat, lon: place.lon }, hub: { lat: place.lat, lon: place.lon },
          bbox: [b.s, b.w, b.n, b.e], roads, pois, homes, radius: R, elev, tz
        };
      }
    }
    throw new Error('Für diesen Ort gibt es zu wenige Kartendaten (' + last.ways + ' Straßen, ' + last.pois + ' Läden, ' + last.homes + ' Häuser). Versuche eine größere Stadt oder einen anderen Ortsteil.');
  }

  // ---------- Cache (IndexedDB) ----------
  const idOf = p => p.lat.toFixed(3) + ',' + p.lon.toFixed(3);
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      try {
        const rq = indexedDB.open('lastmile', 2);
        rq.onupgradeneeded = () => { const d = rq.result; for (const n of ['cities', 'packs']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); };   // packs: Stadtgebiete, Kacheln, Firmen
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  async function tx(mode, fn, store) {
    try {
      const d = await db(), st = store || 'cities';
      return await new Promise((res, rej) => {
        const t = d.transaction(st, mode), r = fn(t.objectStore(st));
        t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
      });
    } catch (e) { return null; }
  }
  const dbGet = async id => { const r = await tx('readonly', s => s.get(id), 'packs'); return r ? r.data : null; };
  const dbPut = (id, data) => tx('readwrite', s => s.put({ id, savedAt: Date.now(), data }), 'packs');
  const dbDel = id => tx('readwrite', s => s.delete(id), 'packs');
  const dbKeys = async prefix => ((await tx('readonly', s => s.getAllKeys(), 'packs')) || []).filter(k => k.startsWith(prefix));
  const saveCity = (place, data) => tx('readwrite', s => s.put({ id: idOf(place), savedAt: Date.now(), data }));
  const getCached = async place => { const r = await tx('readonly', s => s.get(idOf(place))); return r && r.data && r.data.v === FORMAT ? r.data : null; };
  const listCached = async () => ((await tx('readonly', s => s.getAll())) || []).filter(r => r.data && r.data.v === FORMAT)
    .sort((a, b) => b.savedAt - a.savedAt).map(r => ({ name: r.data.name, sub: r.data.sub, lat: r.data.ref.lat, lon: r.data.ref.lon, savedAt: r.savedAt }));
  const removeCached = place => tx('readwrite', s => { s.delete(idOf(place)); s.delete(idOf(place) + '#f'); });

  // Firmen einer Stadt: aus dem Zwischenspeicher oder von Overpass (Hintergrund, ohne Fehlermeldung). null: nicht erreichbar, dann gibt es nur Privatkunden.
  const FIRMS_V = 'f1';
  async function loadFirms(place, bbox) {
    const c = await tx('readonly', s => s.get(idOf(place) + '#f'));
    if (c && c.data && c.data.v === FIRMS_V && Array.isArray(c.data.firms)) return c.data.firms;
    try {
      const b = { s: bbox[0], w: bbox[1], n: bbox[2], e: bbox[3] };
      const firms = convertFirms(await overpass(qFirms(b), null, 1), place, b);
      await tx('readwrite', s => s.put({ id: idOf(place) + '#f', savedAt: Date.now(), data: { v: FIRMS_V, firms } }));
      return firms;
    } catch (e) { return null; }
  }

  return { search, loadCity, saveCity, getCached, listCached, removeCached, fetchTz, loadFirms, convertFirms, qFirms,
    overpass, bboxOf, bbStr, qRoads, qLink, wayInfo, firmKind, dbGet, dbPut, dbDel, dbKeys, net, sleep, HW };
})();
