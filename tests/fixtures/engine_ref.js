function createEngine(D) {
  const R = D.roads, LAT0 = R.o[0], LON0 = R.o[1];
  const REF = D.ref;
  const MLAT = 110574, MLON = 111320 * Math.cos(REF.lat * Math.PI / 180);
  const proj = (lat, lon) => ({ x: (lon - REF.lon) * MLON, y: -(lat - REF.lat) * MLAT });
  const unproj = (x, y) => ({ lat: REF.lat - y / MLAT, lon: REF.lon + x / MLON });   // Umkehrung von proj (für die Anzeige auf der Weltkarte)

  // ---- Knoten und Wege entschlüsseln ----
  const N = R.n.length / 2;
  const nx = new Float64Array(N), ny = new Float64Array(N);
  {
    let la = LAT0, lo = LON0;
    for (let i = 0; i < N; i++) {
      la += R.n[2 * i]; lo += R.n[2 * i + 1];
      const p = proj(la / 1e5, lo / 1e5);
      nx[i] = p.x; ny[i] = p.y;
    }
  }
  // Höhenprofil (grobes Raster, bilinear auf die Knoten übertragen); ohne Daten ist alles flach
  const nz = new Float64Array(N); let elevRange = null;
  if (D.elev && D.elev.z && D.elev.z.length === D.elev.n * D.elev.n) {
    const G = D.elev, n = G.n, s0 = G.b[0], w0 = G.b[1], n0 = G.b[2], e0 = G.b[3];
    let la = LAT0, lo = LON0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < N; i++) {
      la += R.n[2 * i]; lo += R.n[2 * i + 1];
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
  for (const w of R.w) {
    const nodes = []; let p = 0;
    for (let k = 3; k < w.length; k++) { p += w[k]; nodes.push(p); }
    if (nodes.length > 1) ways.push({ c: w[0], f: w[1], name: w[2] >= 0 ? R.s[w[2]] : '', nodes });
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

  function nearest(x, y, allowed) {
    let b = -1, bd = Infinity;
    for (let i = 0; i < N; i++) {
      if (allowed && !allowed[i]) continue;
      const dx = nx[i] - x, dy = ny[i] - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; b = i; }
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

  // gerichtete Kanten mit fester Nummer (für Verkehrsstärke je Straßenabschnitt)
  const eReg = new Map(), eA = [], eB = [], eC = [];
  function edgeId(a, b, c) {
    const k = a * N + b; let id = eReg.get(k);
    if (id === undefined) { id = eA.length; eReg.set(k, id); eA.push(a); eB.push(b); eC.push(c); }
    return id;
  }
  function buildAdj(kind) {
    const adj = Array.from({ length: N }, () => []);
    for (const w of ways) {
      if (kind === 'bike' && (w.f & 4)) continue;
      if (kind === 'car' && (w.f & 2)) continue;
      const oneway = (w.f & 1) && w.c !== 7;
      for (let k = 1; k < w.nodes.length; k++) {
        const a = w.nodes[k - 1], b = w.nodes[k]; if (a === b) continue;
        const len = Math.hypot(nx[b] - nx[a], ny[b] - ny[a]);
        const g = Math.max(-0.15, Math.min(0.15, (nz[b] - nz[a]) / Math.max(len, 8)));
        adj[a].push({ to: b, len, c: w.c, g, id: edgeId(a, b, w.c) });
        if (!oneway) adj[b].push({ to: a, len, c: w.c, g: -g, id: edgeId(b, a, w.c) });
      }
    }
    return adj;
  }

  function largestScc(adj) {
    const n = adj.length, seen = new Uint8Array(n), order = [];
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      const st = [s], it = [0]; seen[s] = 1;
      while (st.length) {
        const v = st[st.length - 1], i = it[it.length - 1];
        if (i < adj[v].length) {
          it[it.length - 1]++;
          const u = adj[v][i].to;
          if (!seen[u]) { seen[u] = 1; st.push(u); it.push(0); }
        } else { order.push(v); st.pop(); it.pop(); }
      }
    }
    const radj = Array.from({ length: n }, () => []);
    for (let v = 0; v < n; v++) for (const e of adj[v]) radj[e.to].push(v);
    const comp = new Int32Array(n).fill(-1), size = []; let cc = 0;
    for (let k = n - 1; k >= 0; k--) {
      const s = order[k]; if (comp[s] !== -1) continue;
      let sz = 0; const st = [s]; comp[s] = cc;
      while (st.length) {
        const v = st.pop(); sz++;
        for (const u of radj[v]) if (comp[u] === -1) { comp[u] = cc; st.push(u); }
      }
      size.push(sz); cc++;
    }
    let best = 0; for (let c = 1; c < cc; c++) if (size[c] > size[best]) best = c;
    const ok = new Uint8Array(n); for (let v = 0; v < n; v++) ok[v] = comp[v] === best ? 1 : 0;
    return { ok, size: size[best] };
  }

  const HUB = proj(D.hub.lat, D.hub.lon); // Lastmile-Hub im Zentrum
  const nets = {};
  for (const kind of ['bike', 'car']) {
    const adj = buildAdj(kind), scc = largestScc(adj);
    nets[kind] = { adj, ok: scc.ok, size: scc.size, depot: nearest(HUB.x, HUB.y, scc.ok) };
  }

  // ---- Verkehr: Stärke je Kante (0 frei bis 1 Stau), abhängig von Straßenart, Lage und Richtung ----
  const EN = eA.length;
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
  function route(net, veh, s, t, q) {
    const tm = veh.net === 'bike' ? mulBike : mulCar; q = q || 0;
    const adj = net.adj, g = new Float64Array(N).fill(Infinity), pe = new Array(N).fill(null), done = new Uint8Array(N);
    const hv = veh.vmax * 1.4 / 3.6;
    const h = i => Math.hypot(nx[i] - nx[t], ny[i] - ny[t]) / hv;
    const hp = new Heap(); g[s] = 0; hp.push(h(s), s);
    while (hp.size) {
      const v = hp.pop(); if (done[v]) continue; done[v] = 1; if (v === t) break;
      for (const e of adj[v]) {
        const u = e.to; if (done[u]) continue;
        const dt = e.len / (veh.sp(e.c) * veh.slope(e.g) * (1 - (1 - tm[e.id]) * q) / 3.6) + (inc[u] >= 3 ? veh.stop : 0);
        const ng = g[v] + dt;
        if (ng < g[u]) { g[u] = ng; pe[u] = { from: v, e, dt }; hp.push(ng + h(u), u); }
      }
    }
    if (!isFinite(g[t])) return null;
    const nodes = [t], segs = []; let c = t;
    while (c !== s) { const p = pe[c]; segs.push(p); c = p.from; nodes.push(c); }
    nodes.reverse(); segs.reverse();
    return { nodes, segs, time: g[t] };
  }

  // Zeiten mit dem tatsächlichen Verkehr; eid und mp merken die Kante und die damals gültige Verkehrsbremse
  function buildLeg(r, veh) {
    const tm = veh.net === 'bike' ? mulBike : mulCar;
    const xs = [nx[r.nodes[0]]], ys = [ny[r.nodes[0]]], tt = [0], dd = [0], sp = [], eid = [], mp = [];
    for (let i = 0; i < r.segs.length; i++) {
      const s = r.segs[i], b = r.nodes[i + 1], e = s.e, m = tm[e.id];
      const dt = e.len / (veh.sp(e.c) * veh.slope(e.g) * m / 3.6) + (inc[b] >= 3 ? veh.stop : 0);
      xs.push(nx[b]); ys.push(ny[b]);
      tt.push(tt[i] + dt); dd.push(dd[i] + e.len);
      sp.push(e.len / dt * 3.6); eid.push(e.id); mp.push(m);
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
    EN, eA, eB, eC, eDir, eMidX, eMidY, eBase, cong, updateTraffic, trafficMul, reroute
  };
}
