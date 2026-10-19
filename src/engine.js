// Straßen: entweder im alten Kompaktformat (Kern-Karte: o, n = Abstände der Knoten, w = Wege als [Klasse, Merkmale, Name, Abstände …], s = Namen)
// oder als Zahlenfelder (R2, für große Karten aus mehreren Städten): lat/lon je Knoten in 1e-5 Grad, Wege als wc/wf/wn (Klasse, Merkmale, Name),
// wo (Anfang jedes Weges in wi) und wi (Knotennummern); o bleibt der Ursprung, auf den sich pois und homes beziehen.
function roadsToTyped(R) {
  if (R.lat) return R;
  const N = R.n.length / 2, lat = new Int32Array(N), lon = new Int32Array(N);
  let la = R.o[0], lo = R.o[1];
  for (let i = 0; i < N; i++) { la += R.n[2 * i]; lo += R.n[2 * i + 1]; lat[i] = la; lon[i] = lo; }
  const W = R.w.length, wc = new Uint8Array(W), wf = new Uint8Array(W), wn = new Int32Array(W), wo = new Int32Array(W + 1);
  let m = 0; for (const w of R.w) m += Math.max(0, w.length - 3);
  const wi = new Int32Array(m); let q = 0;
  R.w.forEach((w, k) => { wc[k] = w[0]; wf[k] = w[1]; wn[k] = w[2]; wo[k] = q; let p = 0; for (let j = 3; j < w.length; j++) { p += w[j]; wi[q++] = p; } });
  wo[W] = q;
  return { o: R.o, lat, lon, wc, wf, wn, wo, wi, s: R.s };
}
function createEngine(D) {
  const R = roadsToTyped(D.roads), LAT0 = R.o[0], LON0 = R.o[1];
  const REF = D.ref;
  const MLAT = 110574, MLON = 111320 * Math.cos(REF.lat * Math.PI / 180);
  const proj = (lat, lon) => ({ x: (lon - REF.lon) * MLON, y: -(lat - REF.lat) * MLAT });
  const unproj = (x, y) => ({ lat: REF.lat - y / MLAT, lon: REF.lon + x / MLON });   // Umkehrung von proj (für die Anzeige auf der Weltkarte)

  // ---- Knoten und Wege entschlüsseln ----
  const N = R.lat.length;
  const nx = new Float64Array(N), ny = new Float64Array(N);
  for (let i = 0; i < N; i++) { const p = proj(R.lat[i] / 1e5, R.lon[i] / 1e5); nx[i] = p.x; ny[i] = p.y; }
  // Höhenprofil (grobes Raster, bilinear auf die Knoten übertragen); ohne Daten ist alles flach
  const nz = new Float64Array(N); let elevRange = null;
  if (D.elev && D.elev.z && D.elev.z.length === D.elev.n * D.elev.n) {
    const G = D.elev, n = G.n, s0 = G.b[0], w0 = G.b[1], n0 = G.b[2], e0 = G.b[3];
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < N; i++) {
      const la = R.lat[i], lo = R.lon[i];
      const u = Math.min(n - 1.001, Math.max(0, (lo / 1e5 - w0) / (e0 - w0) * (n - 1)));
      const v = Math.min(n - 1.001, Math.max(0, (la / 1e5 - s0) / (n0 - s0) * (n - 1)));
      const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r;
      const z00 = G.z[r * n + c], z10 = G.z[r * n + c + 1], z01 = G.z[(r + 1) * n + c], z11 = G.z[(r + 1) * n + c + 1];
      nz[i] = (z00 * (1 - fu) + z10 * fu) * (1 - fv) + (z01 * (1 - fu) + z11 * fu) * fv;
      if (nz[i] < mn) mn = nz[i]; if (nz[i] > mx) mx = nz[i];
    }
    elevRange = { min: mn, max: mx };
  }
  const ways = [];
  for (let k = 0; k < R.wc.length; k++) {
    const a = R.wo[k], b = R.wo[k + 1]; if (b - a < 2) continue;
    ways.push({ c: R.wc[k], f: R.wf[k], name: R.wn[k] >= 0 ? R.s[R.wn[k]] : '', nodes: Array.from(R.wi.subarray(a, b)) });
  }
  const inc = new Uint8Array(N);
  for (const w of ways) for (let k = 1; k < w.nodes.length; k++) { inc[w.nodes[k - 1]]++; inc[w.nodes[k]]++; }

  // Hauptstraßen-Knoten: Kreuzungen großer Straßen sind die klassischen Engstellen
  const majdeg = new Uint8Array(N);
  for (const w of ways) if (w.c <= 2) for (const i of w.nodes) majdeg[i]++;

  const nodeName = new Array(N).fill('');
  for (const w of ways.filter(w => w.name).sort((a, b) => a.c - b.c))
    for (const i of w.nodes) if (!nodeName[i]) nodeName[i] = w.name;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    if (nx[i] < minX) minX = nx[i]; if (nx[i] > maxX) maxX = nx[i];
    if (ny[i] < minY) minY = ny[i]; if (ny[i] > maxY) maxY = ny[i];
  }
  for (const w of ways) {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const i of w.nodes) { if (nx[i] < a) a = nx[i]; if (nx[i] > b) b = nx[i]; if (ny[i] < c) c = ny[i]; if (ny[i] > d) d = ny[i]; }
    w.bb = [a, c, b, d];
  }
  const bounds = { minX, maxX, minY, maxY };

  // ---- Orte ----
  const TYPE_LABEL = ['Restaurant', 'Imbiss', 'Café', 'Bäckerei', 'Supermarkt'];
  const DWELL = [150, 90, 75, 60, 180]; // Sekunden bis zur Abholung
  const pois = D.pois.map((p, i) => {
    const q = proj((LAT0 + p[1]) / 1e5, (LON0 + p[2]) / 1e5);
    return { i, type: p[0], x: q.x, y: q.y, name: p[3] || '' };
  });
  const homes = D.homes.map((h, i) => {
    const q = proj((LAT0 + h[0]) / 1e5, (LON0 + h[1]) / 1e5);
    return { i, x: q.x, y: q.y };
  });

  // Raster für die Suche nach dem nächsten Knoten (Zellen von 120 m). Das Ergebnis ist exakt das gleiche wie beim Durchsuchen aller Knoten
  // (bei gleichem Abstand gewinnt der kleinere Index), nur ohne jedes Mal alle Knoten zu prüfen.
  // Bei sehr großer Ausdehnung (Center in weit entfernten Städten) wachsen die Zellen mit, damit das Raster höchstens ca. 6 Millionen Zellen hat.
  const CELL = Math.max(120, Math.ceil(Math.sqrt(Math.max(0, maxX - minX) * Math.max(0, maxY - minY) / 6e6))), GX = Math.max(1, Math.floor((maxX - minX) / CELL) + 1), GY = Math.max(1, Math.floor((maxY - minY) / CELL) + 1);
  const cellStart = new Int32Array(GX * GY + 1), cellItems = new Int32Array(N);
  {
    const cid = new Int32Array(N);
    for (let i = 0; i < N; i++) { const c = Math.floor((ny[i] - minY) / CELL) * GX + Math.floor((nx[i] - minX) / CELL); cid[i] = c; cellStart[c + 1]++; }
    for (let c = 0; c < GX * GY; c++) cellStart[c + 1] += cellStart[c];
    const pos = cellStart.slice(0, GX * GY);
    for (let i = 0; i < N; i++) cellItems[pos[cid[i]]++] = i;
  }
  function nearest(x, y, allowed) {
    const cx = Math.floor((x - minX) / CELL), cy = Math.floor((y - minY) / CELL);
    let b = -1, bd = Infinity;
    const scan = (gx, gy) => {
      const c = gy * GX + gx;
      for (let k = cellStart[c], ke = cellStart[c + 1]; k < ke; k++) {
        const i = cellItems[k]; if (allowed && !allowed[i]) continue;
        const dx = nx[i] - x, dy = ny[i] - y, d = dx * dx + dy * dy;
        if (d < bd || (d === bd && i < b)) { bd = d; b = i; }
      }
    };
    for (let r = 0; ; r++) {
      const x0 = cx - r, x1 = cx + r, y0 = cy - r, y1 = cy + r, xa = Math.max(0, x0), xb = Math.min(GX - 1, x1);
      if (r === 0) { if (cx >= 0 && cx < GX && cy >= 0 && cy < GY) scan(cx, cy); }
      else {
        if (y0 >= 0 && y0 < GY) for (let gx = xa; gx <= xb; gx++) scan(gx, y0);
        if (y1 >= 0 && y1 < GY) for (let gx = xa; gx <= xb; gx++) scan(gx, y1);
        const ya = Math.max(0, y0 + 1), yb = Math.min(GY - 1, y1 - 1);
        if (x0 >= 0 && x0 < GX) for (let gy = ya; gy <= yb; gy++) scan(x0, gy);
        if (x1 >= 0 && x1 < GX) for (let gy = ya; gy <= yb; gy++) scan(x1, gy);
      }
      if (b >= 0 && bd <= r * CELL * r * CELL) break;               // alles Weitere liegt weiter weg als der Treffer
      if (x0 <= 0 && x1 >= GX - 1 && y0 <= 0 && y1 >= GY - 1) break; // ganzes Raster abgesucht
    }
    return b;
  }
  const namedMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) namedMask[i] = nodeName[i] ? 1 : 0;
  const streetAt = (x, y) => nodeName[nearest(x, y, namedMask)] || '';
  for (const p of pois) p.street = streetAt(p.x, p.y);
  for (const h of homes) h.street = streetAt(h.x, h.y);

  // ---- Straßennetze ----
  const CS = [60, 42, 38, 32, 28, 8, 16, 16]; // Stadtgeschwindigkeit je Straßenklasse in km/h
  const VEHICLES = {
    bike:    { key: 'bike',    label: 'Fahrrad',     net: 'bike', stop: 3, sp: c => c === 7 ? 19 : c === 5 ? 11 : c === 6 ? 15 : 17, slope: g => g > 0 ? 1 / (1 + 7 * g) : 1 + Math.min(0.3, -g * 3) },
    scooter: { key: 'scooter', label: 'E-Roller',    net: 'car',  stop: 4, sp: c => Math.min(38, CS[c]), slope: g => g > 0 ? 1 / (1 + 3 * g) : 1 + Math.min(0.15, -g * 1.5) },
    van:     { key: 'van',     label: 'Transporter', net: 'car',  stop: 6, sp: c => CS[c] * 0.9, slope: g => g > 0 ? 1 / (1 + 2 * g) : 1 }
  };
  for (const v of Object.values(VEHICLES)) {
    let m = 0; for (let c = 0; c < 8; c++) m = Math.max(m, v.sp(c)); v.vmax = m;
  }

  // gerichtete Kanten mit fester Nummer (für Verkehrsstärke je Straßenabschnitt). Zahlenfelder statt Objekte: auch Netze mit
  // einer Million Knoten bleiben so im Arbeitsspeicher überschaubar. Die Nummern werden in der Reihenfolge der Wege vergeben.
  let segCount = 0; for (const w of ways) segCount += w.nodes.length - 1;
  const ECAP = 2 * segCount + 16;
  let eA = new Int32Array(ECAP), eB = new Int32Array(ECAP), eC = new Uint8Array(ECAP), EN = 0;
  let eHead = new Int32Array(N).fill(-1), eNext = new Int32Array(ECAP);
  function edgeId(a, b, c) {
    for (let k = eHead[a]; k >= 0; k = eNext[k]) if (eB[k] === b) return k;
    eA[EN] = a; eB[EN] = b; eC[EN] = c; eNext[EN] = eHead[a]; eHead[a] = EN;
    return EN++;
  }
  // Netz als Zahlenfelder (CSR): die Kanten von Knoten v stehen bei start[v] bis start[v + 1]; to, len, cls (Straßenklasse), grd (Steigung), eid (Kantennummer)
  function buildNet(kind) {
    const each = fn => {
      for (const w of ways) {
        if (kind === 'bike' && (w.f & 4)) continue;
        if (kind === 'car' && (w.f & 2)) continue;
        const oneway = (w.f & 1) && w.c !== 7, nd = w.nodes;
        for (let k = 1; k < nd.length; k++) { const a = nd[k - 1], b = nd[k]; if (a !== b) fn(a, b, w.c, oneway); }
      }
    };
    const start = new Int32Array(N + 1);
    each((a, b, c, ow) => { start[a + 1]++; if (!ow) start[b + 1]++; });
    for (let i = 0; i < N; i++) start[i + 1] += start[i];
    const M = start[N], to = new Int32Array(M), len = new Float64Array(M), cls = new Uint8Array(M), grd = new Float64Array(M), eid = new Int32Array(M), pos = start.slice(0, N);
    each((a, b, c, ow) => {
      const l = Math.hypot(nx[b] - nx[a], ny[b] - ny[a]), g = Math.max(-0.15, Math.min(0.15, (nz[b] - nz[a]) / Math.max(l, 8)));
      let p = pos[a]++; to[p] = b; len[p] = l; cls[p] = c; grd[p] = g; eid[p] = edgeId(a, b, c);
      if (!ow) { p = pos[b]++; to[p] = a; len[p] = l; cls[p] = c; grd[p] = -g; eid[p] = edgeId(b, a, c); }
    });
    return { start, to, len, cls, grd, eid };
  }

  // größte stark zusammenhängende Gruppe (nur dort kann man überall hin und wieder zurück); Kosaraju mit Zahlenfeldern
  // rects: Rechtecke von Inseln (Städte weit entfernter Center, ohne Straßenverbindung zur Kernkarte): dort zählt zusätzlich die größte Gruppe innerhalb des Rechtecks,
  // sofern sie nicht schon die größte Gruppe der Karte ist. So lassen sich Kunden, Center und Touren auch auf einer Insel platzieren (Routen zwischen Gruppen gibt es nicht).
  function largestScc(net, rects) {
    const n = N, { start, to } = net, seen = new Uint8Array(n), order = new Int32Array(n), st = new Int32Array(n), it = new Int32Array(n); let on = 0;
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      let sp = 0; st[0] = s; it[0] = start[s]; seen[s] = 1;
      while (sp >= 0) {
        const v = st[sp];
        if (it[sp] < start[v + 1]) {
          const u = to[it[sp]++];
          if (!seen[u]) { seen[u] = 1; sp++; st[sp] = u; it[sp] = start[u]; }
        } else { order[on++] = v; sp--; }
      }
    }
    const rs = new Int32Array(n + 1);
    for (let k = 0, M = start[n]; k < M; k++) rs[to[k] + 1]++;
    for (let i = 0; i < n; i++) rs[i + 1] += rs[i];
    const rto = new Int32Array(start[n]), rp = rs.slice(0, n);
    for (let v = 0; v < n; v++) for (let k = start[v]; k < start[v + 1]; k++) rto[rp[to[k]]++] = v;
    const comp = new Int32Array(n).fill(-1), size = []; let cc = 0;
    for (let k = n - 1; k >= 0; k--) {
      const s = order[k]; if (comp[s] !== -1) continue;
      let sz = 0, sp = 0; st[0] = s; comp[s] = cc;
      while (sp >= 0) {
        const v = st[sp--]; sz++;
        for (let j = rs[v]; j < rs[v + 1]; j++) { const u = rto[j]; if (comp[u] === -1) { comp[u] = cc; st[++sp] = u; } }
      }
      size.push(sz); cc++;
    }
    let best = 0; for (let c = 1; c < cc; c++) if (size[c] > size[best]) best = c;
    const ok = new Uint8Array(n); for (let v = 0; v < n; v++) ok[v] = comp[v] === best ? 1 : 0;
    for (const r of rects || []) {
      const cnt = new Map();
      for (let v = 0; v < n; v++) { const la = R.lat[v] / 1e5, lo = R.lon[v] / 1e5; if (la >= r.s && la <= r.n && lo >= r.w && lo <= r.e) cnt.set(comp[v], (cnt.get(comp[v]) || 0) + 1); }
      let bc = -1, bn = 0; for (const [c, k] of cnt) if (k > bn) { bn = k; bc = c; }
      if (bc >= 0 && bc !== best && bn >= 20) for (let v = 0; v < n; v++) if (comp[v] === bc) ok[v] = 1;
    }
    return { ok, size: size[best] };
  }

  const HUB = proj(D.hub.lat, D.hub.lon); // Lastmile-Hub im Zentrum
  const nets = {};
  // Inseln: Städte mit Kennung isl (Center ohne Straßenverbindung zur Kernkarte); je Insel ein Rechteck um alle ihre Städte
  const islands = (() => {
    const m = new Map();
    for (const c of D.cities || []) {
      if (!c || !c.isl || !c.bbox) continue;
      const r = m.get(c.isl) || { s: Infinity, w: Infinity, n: -Infinity, e: -Infinity };
      r.s = Math.min(r.s, c.bbox.s); r.w = Math.min(r.w, c.bbox.w); r.n = Math.max(r.n, c.bbox.n); r.e = Math.max(r.e, c.bbox.e); m.set(c.isl, r);
    }
    const out = [...m.values()];
    // Gibt es Inseln, zählt auch die Startregion (Kreis der Kernkarte) als eigenes Gebiet: sonst könnte eine große Insel die Startregion aus dem befahrbaren Netz drängen
    if (out.length) { const r = (D.radius || 1000) * 1.1, dla = r / 110574, dlo = r / (111320 * Math.cos(D.ref.lat * Math.PI / 180)); out.push({ s: D.ref.lat - dla, n: D.ref.lat + dla, w: D.ref.lon - dlo, e: D.ref.lon + dlo }); }
    return out;
  })();
  for (const kind of ['bike', 'car']) {
    const net = buildNet(kind), scc = largestScc(net, islands);
    nets[kind] = Object.assign(net, { ok: scc.ok, size: scc.size, depot: nearest(HUB.x, HUB.y, scc.ok) });
  }
  eA = eA.slice(0, EN); eB = eB.slice(0, EN); eC = eC.slice(0, EN); eHead = eNext = null;   // Kantenzahl steht fest, Hilfsfelder werden nicht mehr gebraucht

  // ---- Verkehr: Stärke je Kante (0 frei bis 1 Stau), abhängig von Straßenart, Lage und Richtung ----
  const eDir = new Int8Array(EN), eBase = new Float32Array(EN), eMidX = new Float32Array(EN), eMidY = new Float32Array(EN);
  const cong = new Float32Array(EN), mulCar = new Float32Array(EN).fill(1), mulBike = new Float32Array(EN).fill(1);
  const LOAD_C = [1, 0.95, 0.85, 0.65, 0.28, 0.03, 0, 0];
  const QUEUE_C = [0.1, 0.35, 0.45, 0.5, 1.0, 0.3, 0, 0];
  for (let id = 0; id < EN; id++) {
    const a = eA[id], b = eB[id], c = eC[id], len = Math.max(5, Math.hypot(nx[b] - nx[a], ny[b] - ny[a]));
    const mx = (nx[a] + nx[b]) / 2, my = (ny[a] + ny[b]) / 2; eMidX[id] = mx; eMidY[id] = my;
    const da = Math.hypot(nx[a] - HUB.x, ny[a] - HUB.y), db = Math.hypot(nx[b] - HUB.x, ny[b] - HUB.y), dd = (da - db) / len;
    eDir[id] = dd > 0.3 ? 1 : dd < -0.3 ? -1 : 0; // 1: Richtung Zentrum
    const central = 1.15 - 0.4 * Math.min(1, Math.hypot(mx - HUB.x, my - HUB.y) / 1200);
    // Rückstau an Kreuzungen: Zufahrten auf Knoten, an denen Hauptstraßen aufeinandertreffen (oder Nebenstraßen einmünden), laufen zur Stoßzeit voll
    const jq = inc[b] >= 3 ? (majdeg[b] >= 2 ? 1 : majdeg[b] >= 1 ? 0.6 : 0.25) : 0;
    const f = Math.sin(id * 12.9898) * 43758.5453, noise = 0.88 + 0.24 * (f - Math.floor(f));
    // Engstellen: räumlich zusammenhängende Zonen (rund 350 m), die zur Stoßzeit schlechter laufen als andere
    const cx = Math.floor(mx / 350), cy = Math.floor(my / 350), g = Math.sin(cx * 127.1 + cy * 311.7) * 43758.5453, zone = 0.85 + 0.35 * (g - Math.floor(g));
    eBase[id] = (LOAD_C[c] + jq * QUEUE_C[c]) * central * noise * zone;
  }
  // load: Tageslast 0 bis 1, bias: +1 Richtung Zentrum (Morgen), -1 aus dem Zentrum (Abend), extra: Zuschlag durch Ereignisse
  // Die Tageslast wirkt überproportional (Potenz): mittags und nachts bleibt es überwiegend grün, zur Stoßzeit laufen Hauptstraßen und Kreuzungen auch ohne Ereignis rot
  const LOAD_EXP = 1.35, LOAD_GAIN = 0.55;
  function updateTraffic(load, bias, extra) {
    let sum = 0, cnt = 0;
    const lf = Math.pow(Math.max(0, load), LOAD_EXP) * LOAD_GAIN;
    for (let id = 0; id < EN; id++) {
      let v = lf * eBase[id] * (1 + 0.42 * bias * eDir[id]);
      if (extra) v += extra[id];
      if (v > 1) v = 1;
      cong[id] = v; mulCar[id] = Math.max(0.15, 1 - v); mulBike[id] = 1 - 0.2 * v;
      if (eC[id] <= 2) { sum += v; cnt++; }
    }
    return cnt ? sum / cnt : 0;
  }

  // ---- Routenberechnung (A*) ----
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
      if (n > 0) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1; if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  // q: Anteil des Verkehrs, den der Fahrer bei der Routenwahl kennt (0 = ignoriert Stau, 1 = kennt alles)
  // Die Suchfelder werden für alle Routen wiederverwendet (Stempel statt Neuanlegen), das spart bei großen Netzen Zeit und Speicher.
  const gS = new Float64Array(N), stampS = new Int32Array(N), doneS = new Int32Array(N), peS = new Int32Array(N), pkS = new Int32Array(N); let stampN = 0;
  function route(net, veh, s, t, q) {
    const tm = veh.net === 'bike' ? mulBike : mulCar; q = q || 0;
    const { start, to, len, cls, grd, eid } = net, stamp = ++stampN;
    const hv = veh.vmax * 1.4 / 3.6, tx = nx[t], ty = ny[t];
    const h = i => Math.hypot(nx[i] - tx, ny[i] - ty) / hv;
    const hp = new Heap(); gS[s] = 0; stampS[s] = stamp; hp.push(h(s), s);
    while (hp.size) {
      const v = hp.pop(); if (doneS[v] === stamp) continue; doneS[v] = stamp; if (v === t) break;
      for (let k = start[v], ke = start[v + 1]; k < ke; k++) {
        const u = to[k]; if (doneS[u] === stamp) continue;
        const dt = len[k] / (veh.sp(cls[k]) * veh.slope(grd[k]) * (1 - (1 - tm[eid[k]]) * q) / 3.6) + (inc[u] >= 3 ? veh.stop : 0);
        const ng = gS[v] + dt;
        if (stampS[u] !== stamp || ng < gS[u]) { stampS[u] = stamp; gS[u] = ng; peS[u] = v; pkS[u] = k; hp.push(ng + h(u), u); }
      }
    }
    if (stampS[t] !== stamp || !isFinite(gS[t])) return null;
    const nodes = [t], segs = []; let c = t;
    while (c !== s) { segs.push(pkS[c]); c = peS[c]; nodes.push(c); }
    nodes.reverse(); segs.reverse();
    return { nodes, segs, time: gS[t] };   // segs: Kantenstellen im Netz (start/to/len/…)
  }

  // Zeiten mit dem tatsächlichen Verkehr; eid und mp merken die Kante und die damals gültige Verkehrsbremse
  function buildLeg(r, veh) {
    const tm = veh.net === 'bike' ? mulBike : mulCar, net = nets[veh.net], nlen = net.len, ncls = net.cls, ngrd = net.grd, neid = net.eid;
    const xs = [nx[r.nodes[0]]], ys = [ny[r.nodes[0]]], tt = [0], dd = [0], sp = [], eid = [], mp = [];
    for (let i = 0; i < r.segs.length; i++) {
      const k = r.segs[i], b = r.nodes[i + 1], id = neid[k], m = tm[id], l = nlen[k];
      const dt = l / (veh.sp(ncls[k]) * veh.slope(ngrd[k]) * m / 3.6) + (inc[b] >= 3 ? veh.stop : 0);
      xs.push(nx[b]); ys.push(ny[b]);
      tt.push(tt[i] + dt); dd.push(dd[i] + l);
      sp.push(l / dt * 3.6); eid.push(id); mp.push(m);
    }
    return { xs, ys, t: tt, d: dd, sp, eid, mp, len: dd[dd.length - 1], time: tt[tt.length - 1], nodes: r.nodes };
  }

  // Fahrt ab beliebigem Startknoten: Anfahrt zum Abholort, Abholung, Lieferung, Übergabe
  function planTrip(vehKey, startNode, pickIdx, homeIdx, q) {
    const veh = VEHICLES[vehKey], net = nets[veh.net];
    const p = pois[pickIdx], h = homes[homeIdx];
    const s = startNode == null ? net.depot : startNode;
    const a = nearest(p.x, p.y, net.ok), b = nearest(h.x, h.y, net.ok);
    const r1 = route(net, veh, s, a, q), r2 = route(net, veh, a, b, q);
    if (!r1 || !r2) return null;
    const L1 = buildLeg(r1, veh), L2 = buildLeg(r2, veh), D1 = DWELL[p.type], D2 = 45;
    return {
      veh, pick: p, home: h, legs: [L1, L2],
      T1: L1.time, D1, T2: L2.time, D2,
      total: L1.time + D1 + L2.time + D2, len: L1.len + L2.len,
      stopA: { x: nx[a], y: ny[a] }, stopB: { x: nx[b], y: ny[b] },
      start: { x: nx[s], y: ny[s] }, startNode: s, endNode: b
    };
  }

  // Leerfahrt (z. B. zurück zum Hub)
  function returnLeg(vehKey, from, to, q) {
    const veh = VEHICLES[vehKey], net = nets[veh.net];
    if (from === to) return null;
    const r = route(net, veh, from, to, q);
    return r ? buildLeg(r, veh) : null;
  }
  const hubNode = (vehKey, x, y) => nearest(x, y, nets[VEHICLES[vehKey].net].ok);

  // Firmenkunden (nachgeladen): Liste aus [Art, Breite·1e5, Länge·1e5, Name]. Nur Firmen nahe am befahrbaren Straßennetz kommen in Frage.
  const FIRM_LABEL = ['Büro', 'Betrieb', 'Geschäft', 'Praxis', 'Bank oder Dienst'];
  function addFirms(list) {
    const out = [], ok = nets.car.ok;
    for (const f of list || []) {
      if (!Array.isArray(f) || f.length < 4 || !isFinite(f[1]) || !isFinite(f[2])) continue;
      const q = proj(f[1] / 1e5, f[2] / 1e5);
      if (q.x < bounds.minX - 60 || q.x > bounds.maxX + 60 || q.y < bounds.minY - 60 || q.y > bounds.maxY + 60) continue;
      const node = nearest(q.x, q.y, ok);
      if (node < 0 || Math.hypot(nx[node] - q.x, ny[node] - q.y) > 150) continue;
      out.push({ i: out.length, kind: Math.min(4, Math.max(0, f[0] | 0)), x: q.x, y: q.y, name: String(f[3]), node, street: streetAt(q.x, q.y) });
    }
    return out;
  }

  // Privatkunden der Städte (aus Wohnstraßen erzeugt): Liste aus [Breite·1e5, Länge·1e5, Straße]. Hubs sehen sie nicht (sie liegen nicht in homes).
  function addHomes(list) {
    const out = [];
    for (const h of list || []) {
      if (!Array.isArray(h) || !isFinite(h[0]) || !isFinite(h[1])) continue;
      const q = proj(h[0] / 1e5, h[1] / 1e5);
      if (q.x < bounds.minX - 60 || q.x > bounds.maxX + 60 || q.y < bounds.minY - 60 || q.y > bounds.maxY + 60) continue;
      out.push({ i: -1, x: q.x, y: q.y, street: String(h[2] || '') });
    }
    return out;
  }

  // Verkehrsbremse (0.25 bis 1) auf der Kante, auf der der Fahrer gerade ist
  const trafficMul = (vehKey, eid) => (VEHICLES[vehKey].net === 'bike' ? mulBike : mulCar)[eid];
  // Ausweichen unterwegs: neue Route ab dem nächsten Knoten, wenn sie bei aktuellem Verkehr schneller ist.
  // scale: aktuelles Tempo-Verhältnis des Fahrers (Stufe, Wetter), damit die Zeiten zur gestreckten Fahrt passen.
  function reroute(vehKey, leg, tNow, q, scale) {
    if (!leg.eid) return null;
    const veh = VEHICLES[vehKey], net = nets[veh.net], tm = veh.net === 'bike' ? mulBike : mulCar, sc = scale || 1;
    const s = sample(leg, tNow), i = s.i, n = leg.nodes.length;
    if (i + 1 >= n - 1) return null;
    const from = leg.nodes[i + 1], target = leg.nodes[n - 1];
    const here = (leg.t[i + 1] - tNow) * leg.mp[i] / tm[leg.eid[i]];
    let cur = here;
    for (let k = i + 1; k < leg.eid.length; k++) cur += (leg.t[k + 1] - leg.t[k]) * leg.mp[k] / tm[leg.eid[k]];
    const r = route(net, veh, from, target, q); if (!r) return null;
    const nl = buildLeg(r, veh), gain = cur - (here + nl.time / sc);
    const m = i + 2, t0 = leg.t[i + 1], d0 = leg.d[i + 1];
    const merged = {
      xs: leg.xs.slice(0, m).concat(nl.xs.slice(1)), ys: leg.ys.slice(0, m).concat(nl.ys.slice(1)),
      t: leg.t.slice(0, m).concat(nl.t.slice(1).map(v => t0 + v / sc)), d: leg.d.slice(0, m).concat(nl.d.slice(1).map(v => d0 + v)),
      sp: leg.sp.slice(0, i + 1).concat(nl.sp.map(v => v * sc)), nodes: leg.nodes.slice(0, m).concat(nl.nodes.slice(1)),
      eid: leg.eid.slice(0, i + 1).concat(nl.eid), mp: leg.mp.slice(0, i + 1).concat(nl.mp)
    };
    merged.len = merged.d[merged.d.length - 1]; merged.time = merged.t[merged.t.length - 1];
    return { gain, cur, leg: merged };
  }

  // Position auf einer Teilstrecke zum Zeitpunkt t (Sekunden)
  function sample(leg, t) {
    const T = leg.t, n = T.length;
    if (n < 2) return { x: leg.xs[0], y: leg.ys[0], i: 0, f: 0, hd: 0, sp: 0, d: 0 };
    if (t <= 0) t = 0; if (t >= leg.time) t = leg.time;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const f = (t - T[lo]) / Math.max(1e-9, T[hi] - T[lo]);
    return {
      x: leg.xs[lo] + (leg.xs[hi] - leg.xs[lo]) * f,
      y: leg.ys[lo] + (leg.ys[hi] - leg.ys[lo]) * f,
      i: lo, f,
      hd: Math.atan2(leg.ys[hi] - leg.ys[lo], leg.xs[hi] - leg.xs[lo]),
      sp: leg.sp[lo],
      d: leg.d[lo] + (leg.d[hi] - leg.d[lo]) * f
    };
  }

  // Zustand der Fahrt zur Fahrtzeit tt: Phase 0 Anfahrt, 1 Abholung, 2 Lieferung, 3 Übergabe, 4 fertig
  function tripState(trip, tt) {
    const { T1, D1, T2, D2, legs } = trip;
    if (tt < T1) { const s = sample(legs[0], tt); return { phase: 0, leg: 0, s, left: legs[0].len - s.d + legs[1].len }; }
    if (tt < T1 + D1) { const s = sample(legs[0], T1); return { phase: 1, leg: 0, s: { ...s, sp: 0 }, left: legs[1].len }; }
    if (tt < T1 + D1 + T2) { const s = sample(legs[1], tt - T1 - D1); return { phase: 2, leg: 1, s, left: legs[1].len - s.d }; }
    const s = sample(legs[1], T2);
    if (tt < T1 + D1 + T2 + D2) return { phase: 3, leg: 1, s: { ...s, sp: 0 }, left: 0 };
    return { phase: 4, leg: 1, s: { ...s, sp: 0 }, left: 0 };
  }

  return {
    N, nx, ny, ways, inc, nodeName, bounds, pois, homes, TYPE_LABEL, DWELL, VEHICLES, nets, HUB,
    nearest, planTrip, sample, tripState, proj, unproj, MLAT, MLON, returnLeg, hubNode, addFirms, FIRM_LABEL, elevRange, nz,
    EN, eA, eB, eC, eDir, eMidX, eMidY, eBase, cong, updateTraffic, trafficMul, reroute, addHomes
  };
}
