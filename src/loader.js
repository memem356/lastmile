// Stadtlader: Suche (Nominatim), Straßen/Orte (Overpass), Kompaktformat, Cache (IndexedDB)
const LM = (function () {
  const FORMAT = 1;
  // Öffentliche Overpass-Server. Der Hauptserver ist oft überlastet; die anderen springen ein. Reihenfolge = Vorrang, bis ein anderer Server schneller war.
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  let HEDGE = 8000;                          // so lange hat der bevorzugte Server allein Zeit, danach fragt auch der nächste (der erste brauchbare Treffer gilt)
  let pref = 0;                                // zuletzt erfolgreicher Server: kommt als Nächster zuerst dran
  const HW = { motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2,
    tertiary: 3, tertiary_link: 3, unclassified: 4, residential: 4, living_street: 5, service: 6, cycleway: 7 };
  const HW_RE = Object.keys(HW).join('|');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const net = { bytes: 0, calls: 0, log: [] };                      // Zähler für den Stadt-Test: übertragene Zeichen und Abfragen; log: Versuche je Server (Antwortzeit oder Fehler)

  // ---------- Suche ----------
  // Anfrage an Nominatim: bei Verbindungsfehler oder Überlastung (429/502/503/504) einmal nach 2 s wiederholen; die Meldung sagt, was passiert ist und wie lange es dauerte
  async function nomGet(url, what, ms) {
    let last = null, net = false;
    for (let k = 0; k < 2; k++) {
      const t0 = Date.now(), ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms || 30000); let r = null, timeout = false;
      try { r = await fetch(url, { signal: ctl.signal }); } catch (e) { timeout = !!(e && e.name === 'AbortError'); } finally { clearTimeout(to); }
      const sec = ((Date.now() - t0) / 1000).toFixed(1) + ' s';
      if (r && r.ok) return r;
      net = !r && !timeout;
      last = new Error(what + ' nicht erreichbar (' + (r ? r.status : timeout ? 'keine Antwort nach ' + sec : 'Verbindung gescheitert nach ' + sec) + ')');
      if (timeout || Date.now() - t0 > 10000 || (r && !/^(429|502|503|504)$/.test(String(r.status)))) break;
      await new Promise(res => setTimeout(res, 2000));
    }
    // Verbindung gescheitert: antwortet der Server überhaupt? (Ein Aufruf ohne Lesezugriff gelingt auch dann, wenn die Antwort keine Freigabe für Webseiten enthält, wie bei Sperre oder Überlastung)
    if (net) {
      let reach = false; const c2 = new AbortController(), t2 = setTimeout(() => c2.abort(), 6000);
      try { await fetch(url, { mode: 'no-cors', signal: c2.signal }); reach = true; } catch (e) { /* nicht erreichbar */ } finally { clearTimeout(t2); }
      last = new Error(last.message.replace(/\)$/, '') + (reach ? '; der Server antwortet, aber ohne Freigabe für Webseiten – typisch für eine Sperre oder Überlastung)' : '; der Server ist von hier aus gar nicht erreichbar – Netzwerk, Firewall oder Werbeblocker?)'));
    }
    throw last;
  }
  async function searchNominatim(q) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&accept-language=de&featuretype=settlement&extratags=1&q=' + encodeURIComponent(q);
    const r = await nomGet(url, 'Suche', 30000);
    const j = await r.json(), seen = new Set(), out = [];
    for (const x of j) {
      const a = x.address || {};
      const name = x.name || a.city || a.town || a.village || x.display_name.split(',')[0];
      const sub = [a.state || a.region || a.county, a.country].filter(Boolean).join(', ');
      const lat = Number(x.lat), lon = Number(x.lon), key = name + '|' + sub;
      if (seen.has(key) || !isFinite(lat) || !isFinite(lon)) continue;
      seen.add(key);
      // nrel/nplace/npop: nur für den Stadt-Test und die Grenzsuche (Verwaltungsgrenze als Beziehung, Art des Ortes, Einwohner)
      out.push({ name, sub, lat, lon, nrel: x.osm_type === 'relation' && x.osm_id ? Number(x.osm_id) : 0, nplace: /^(city|town)$/.test(x.addresstype || x.type || '') ? (x.addresstype || x.type) : '', npop: parseInt(String((x.extratags && x.extratags.population) || '').replace(/[^0-9]/g, ''), 10) || 0 });
    }
    return out;
  }
  // Ersatz, wenn Nominatim von der Seite aus nicht zu erreichen ist: Ortsnamen direkt beim Overpass-Server suchen (Städte und Gemeinden mit genau diesem Namen)
  async function searchOverpass(q) {
    const base = String(q).trim().replace(/[\\"^$*+?()[\]{}|<>;&=%#@!~`]/g, '').replace(/\s+/g, ' ').slice(0, 60);
    if (base.length < 2) return [];
    const title = base.replace(/(^|[\s-])([a-zäöüß])/g, (m, a, b) => a + b.toUpperCase());
    let body = '';
    for (const n of new Set([base, title])) body += `node["place"~"^(city|town|village)$"]["name"="${n}"];rel["boundary"="administrative"]["admin_level"~"^[678]$"]["name"="${n}"];`;
    const j = await overpass(`[out:json][timeout:30];(${body});out tags center 60;`, null, 1);
    const items = [];
    for (const el of j.elements || []) {
      const t = el.tags || {}, c = el.type === 'relation' ? el.center : el;
      if (!t.name || !c || !isFinite(c.lat) || !isFinite(c.lon)) continue;
      const rel = el.type === 'relation' ? el.id : 0, pop = parseInt(String(t.population || '').replace(/[^0-9]/g, ''), 10) || 0;
      // Ortspunkt und Grenze desselben Ortes zusammenführen (gleicher Name, weniger als ca. 25 km Abstand)
      const same = items.find(x => x.name.toLowerCase() === t.name.toLowerCase() && Math.abs(x.lat - c.lat) < 0.25 && Math.abs(x.lon - c.lon) < 0.4);
      if (same) { if (rel && !same.nrel) same.nrel = rel; if (el.type === 'node' && !same.node) { same.node = true; same.lat = c.lat; same.lon = c.lon; } if (/^(city|town)$/.test(t.place || '') && !same.nplace) same.nplace = t.place; same.npop = same.npop || pop; same.state = same.state || t['addr:state'] || t['is_in:state'] || ''; continue; }
      items.push({ name: t.name, lat: c.lat, lon: c.lon, node: el.type === 'node', nrel: rel, nplace: /^(city|town)$/.test(t.place || '') ? t.place : '', npop: pop, state: t['addr:state'] || t['is_in:state'] || '' });
    }
    items.sort((a, b) => b.npop - a.npop || (b.nrel ? 1 : 0) - (a.nrel ? 1 : 0));
    return items.slice(0, 8).map(x => ({ name: x.name, sub: x.state || (x.npop ? 'ca. ' + x.npop.toLocaleString('de-DE') + ' Einwohner' : ''), lat: x.lat, lon: x.lon, nrel: x.nrel, nplace: x.nplace, npop: x.npop }));
  }
  async function search(q) {
    try { return await searchNominatim(q); }
    catch (e) {
      let alt = []; try { alt = await searchOverpass(q); } catch (e2) { throw new Error(e.message + ' · Ersatzsuche: ' + ((e2 && e2.message) || 'Fehler')); }
      if (!alt.length) throw e;       // ein leeres Ergebnis des Ersatzes ist kein verlässliches „gibt es nicht“
      return alt;
    }
  }

  // ---------- Overpass ----------
  const host = u => u.replace(/^https:\/\/([^/]+)\/.*$/, '$1');
  const secs = ms => (ms / 1000).toFixed(1) + ' s';
  function note(t) { net.log.push(t); if (net.log.length > 300) net.log.splice(0, 100); }
  // Eine Abfrage an einen Server: Ergebnis oder Fehler
  async function once(url, query, ctl) {
    const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
    if (!r.ok) throw new Error('Antwort ' + r.status);
    const txt = await r.text(), j = JSON.parse(txt);
    // Overpass antwortet bei Zeitüberschreitung oder Speichermangel mit 200 und einer unvollständigen Antwort samt Hinweis: das darf nicht als Ergebnis (und nicht in den Zwischenspeicher) gelten
    if (j && typeof j.remark === 'string' && /runtime error/i.test(j.remark)) throw new Error('Kartenserver überlastet (' + j.remark.slice(0, 80) + ')');
    return { j, len: txt.length };
  }
  // Der zuletzt erfolgreiche Server zuerst. Antwortet er nach HEDGE nicht, kommt der nächste dazu; fällt einer aus, sofort der nächste. Der erste brauchbare Treffer gewinnt, die anderen werden abgebrochen.
  async function overpass(query, onTry, rounds) {
    let lastErr = null;
    for (let round = 0; round < (rounds || 2); round++) {
      const order = OVERPASS.map((u, i) => (i + pref) % OVERPASS.length);
      const won = await new Promise(resolve => {
        const ctls = []; let started = 0, fails = 0, done = false, timer = null;
        const launch = () => {
          clearTimeout(timer); if (done || started >= order.length) return;
          const m = order[started++], ctl = new AbortController(), t0 = Date.now(), to = setTimeout(() => ctl.abort(), 100000); ctls.push(ctl);
          if (onTry) onTry(m, round);
          once(OVERPASS[m], query, ctl).then(o => {
            clearTimeout(to); if (done) return; done = true; clearTimeout(timer);
            note(host(OVERPASS[m]) + ' ok ' + secs(Date.now() - t0)); pref = m; net.bytes += o.len; net.calls++;
            for (const c of ctls) if (c !== ctl) c.abort();
            resolve(o);
          }, e => {
            clearTimeout(to); if (done) return;
            note(host(OVERPASS[m]) + ' ' + (e && e.name === 'AbortError' ? 'keine Antwort' : (e && e.message) || 'Fehler') + ' nach ' + secs(Date.now() - t0));
            lastErr = e; fails++;
            if (fails >= order.length) { done = true; clearTimeout(timer); resolve(null); } else launch();
          });
          if (started < order.length) timer = setTimeout(launch, HEDGE);
        };
        launch();
      });
      if (won) return won.j;
      await sleep(2500);
    }
    throw new Error('Kartendaten konnten nicht geladen werden (' + (lastErr && lastErr.message || 'unbekannt') + ')');
  }

  function bboxOf(lat, lon, R) {
    const dlat = R / 110574, dlon = R / (111320 * Math.cos(lat * Math.PI / 180));
    return { s: lat - dlat, n: lat + dlat, w: lon - dlon, e: lon + dlon };
  }
  const bbStr = b => [b.s, b.w, b.n, b.e].map(v => v.toFixed(6)).join(',');

  const qRoads = b => `[out:json][timeout:90];way["highway"~"^(${HW_RE})$"](${bbStr(b)});out body;>;out skel qt;`;
  // Nur die großen Straßen (Autobahn bis Kreisstraße): für die Verbindung zwischen Städten, die nicht aneinander liegen
  const LINK_HW = 'motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
  const qLink = b => `[out:json][timeout:90];way["highway"~"^(${LINK_HW})$"](${bbStr(b)});out body;>;out skel qt;`;
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
  let dbp = null, dbBlocked = false, dbCb = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      try {
        const rq = indexedDB.open('lastmile', 2); let late = false, tm = null, told = false;
        const tell = () => { dbBlocked = true; if (!told && dbCb) { told = true; try { dbCb(); } catch (e) { /* Anzeige ist nur ein Hinweis */ } } };
        // Hält ein anderer Tab noch die ältere Version des Spiels offen (oder steht noch dessen wartende Anfrage davor), kommt keine Antwort:
        // nach kurzer Zeit ohne Zwischenspeicher weitermachen (alles wird dann neu geladen) und später erneut versuchen
        const giveUp = () => { if (late) return; late = true; tell(); rej(new Error('Zwischenspeicher blockiert')); setTimeout(() => { if (late) dbp = null; }, 20000); };
        tm = setTimeout(giveUp, 4000);
        rq.onupgradeneeded = () => { const d = rq.result; for (const n of ['cities', 'packs']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); };   // packs: Stadtgebiete, Kacheln, Firmen
        rq.onblocked = () => { tell(); clearTimeout(tm); tm = setTimeout(giveUp, 1500); };
        rq.onsuccess = () => {
          const d = rq.result; clearTimeout(tm); dbBlocked = false;
          d.onversionchange = () => { d.close(); dbp = null; };                       // eine spätere Version darf übernehmen
          if (late) { late = false; dbp = Promise.resolve(d); } else res(d);
        };
        rq.onerror = () => { clearTimeout(tm); if (!late) rej(rq.error); };
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

  return { search, nomGet, loadCity, saveCity, getCached, listCached, removeCached, fetchTz, loadFirms, convertFirms, qFirms,
    overpass, bboxOf, bbStr, qRoads, qLink, wayInfo, firmKind, dbGet, dbPut, dbDel, dbKeys, net, sleep, HW,
    dbBlocked: () => dbBlocked, onBlocked: f => { dbCb = f; }, setHedge: ms => { HEDGE = ms; }, prefServer: () => pref, servers: () => OVERPASS.slice(), host };
})();
