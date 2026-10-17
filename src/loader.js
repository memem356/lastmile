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
  async function overpass(query, onTry) {
    let lastErr = null;
    for (let round = 0; round < 2; round++) {
      for (let m = 0; m < OVERPASS.length; m++) {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 70000);
        try {
          if (onTry) onTry(m, round);
          const r = await fetch(OVERPASS[m], { method: 'POST', body: 'data=' + encodeURIComponent(query),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
          if (r.ok) { const j = await r.json(); clearTimeout(to); return j; }
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
  const qPlaces = b => `[out:json][timeout:90];(nwr["amenity"~"^(restaurant|fast_food|cafe)$"]["name"](${bbStr(b)});nwr["shop"~"^(bakery|supermarket)$"]["name"](${bbStr(b)}););out center tags;way["building"~"^(apartments|residential|house|detached|terraced|semidetached_house|dormitory|yes)$"](${bbStr(b)});out skel center qt;`;

  // ---------- Umwandlung ins Kompaktformat ----------
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
      const t = w.tags, hw = t.highway;
      if (t.access === 'private' || t.access === 'no' || t.area === 'yes') continue;
      if (hw === 'service' && /^(parking_aisle|driveway|drive-through|emergency_access)$/.test(t.service || '')) continue;
      const c = HW[hw]; let f = 0, ids = w.nodes.slice();
      const ow = t.oneway;
      if (ow === '-1' || ow === 'reverse') { ids.reverse(); f |= 1; }
      else if (ow === 'yes' || ow === '1' || ow === 'true' || t.junction === 'roundabout' || t.junction === 'circular' || (c === 0 && ow !== 'no')) f |= 1;
      if (c === 7) f |= 2;
      if (c === 0 || t.bicycle === 'no') f |= 4;
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

  // ---------- Stadt laden ----------
  async function loadCity(place, progress) {
    const say = (step, text) => progress && progress(step, text);
    let R = 2200, last = null;
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
        return {
          v: FORMAT, name: place.name, sub: place.sub,
          ref: { lat: place.lat, lon: place.lon }, hub: { lat: place.lat, lon: place.lon },
          bbox: [b.s, b.w, b.n, b.e], roads, pois, homes, radius: R
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
        const rq = indexedDB.open('lastmile', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('cities', { keyPath: 'id' });
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  async function tx(mode, fn) {
    try {
      const d = await db();
      return await new Promise((res, rej) => {
        const t = d.transaction('cities', mode), r = fn(t.objectStore('cities'));
        t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
      });
    } catch (e) { return null; }
  }
  const saveCity = (place, data) => tx('readwrite', s => s.put({ id: idOf(place), savedAt: Date.now(), data }));
  const getCached = async place => { const r = await tx('readonly', s => s.get(idOf(place))); return r && r.data && r.data.v === FORMAT ? r.data : null; };
  const listCached = async () => ((await tx('readonly', s => s.getAll())) || []).filter(r => r.data && r.data.v === FORMAT)
    .sort((a, b) => b.savedAt - a.savedAt).map(r => ({ name: r.data.name, sub: r.data.sub, lat: r.data.ref.lat, lon: r.data.ref.lon, savedAt: r.savedAt }));
  const removeCached = place => tx('readwrite', s => s.delete(idOf(place)));

  return { search, loadCity, saveCity, getCached, listCached, removeCached };
})();
