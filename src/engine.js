function createEngine(D) {
  const R = D.roads, LAT0 = R.o[0], LON0 = R.o[1];
  const REF = { lat: 51.4510, lon: 7.0140 };
  const MLAT = 110574, MLON = 111320 * Math.cos(REF.lat * Math.PI / 180);
  const proj = (lat, lon) => ({ x: (lon - REF.lon) * MLON, y: -(lat - REF.lat) * MLAT });

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
  const ways = [];
  for (const w of R.w) {
    const nodes = []; let p = 0;
    for (let k = 3; k < w.length; k++) { p += w[k]; nodes.push(p); }
    if (nodes.length > 1) ways.push({ c: w[0], f: w[1], name: w[2] >= 0 ? R.s[w[2]] : '', nodes });
  }
  const inc = new Uint8Array(N);
  for (const w of ways) for (let k = 1; k < w.nodes.length; k++) { inc[w.nodes[k - 1]]++; inc[w.nodes[k]]++; }

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
    bike:    { key: 'bike',    label: 'Fahrrad',     net: 'bike', stop: 3, sp: c => c === 7 ? 19 : c === 5 ? 11 : c === 6 ? 15 : 17 },
    scooter: { key: 'scooter', label: 'E-Roller',    net: 'car',  stop: 4, sp: c => Math.min(38, CS[c]) },
    van:     { key: 'van',     label: 'Transporter', net: 'car',  stop: 6, sp: c => CS[c] * 0.9 }
  };
  for (const v of Object.values(VEHICLES)) {
    let m = 0; for (let c = 0; c < 8; c++) m = Math.max(m, v.sp(c)); v.vmax = m;
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
        adj[a].push({ to: b, len, c: w.c });
        if (!oneway) adj[b].push({ to: a, len, c: w.c });
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

  const HUB = proj(51.4513, 7.0147); // Lastmile-Hub nahe Hauptbahnhof
  const nets = {};
  for (const kind of ['bike', 'car']) {
    const adj = buildAdj(kind), scc = largestScc(adj);
    nets[kind] = { adj, ok: scc.ok, size: scc.size, depot: nearest(HUB.x, HUB.y, scc.ok) };
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

  function route(net, veh, s, t) {
    const adj = net.adj, g = new Float64Array(N).fill(Infinity), pe = new Array(N).fill(null), done = new Uint8Array(N);
    const hv = veh.vmax / 3.6;
    const h = i => Math.hypot(nx[i] - nx[t], ny[i] - ny[t]) / hv;
    const hp = new Heap(); g[s] = 0; hp.push(h(s), s);
    while (hp.size) {
      const v = hp.pop(); if (done[v]) continue; done[v] = 1; if (v === t) break;
      for (const e of adj[v]) {
        const u = e.to; if (done[u]) continue;
        const dt = e.len / (veh.sp(e.c) / 3.6) + (inc[u] >= 3 ? veh.stop : 0);
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

  function buildLeg(r) {
    const xs = [nx[r.nodes[0]]], ys = [ny[r.nodes[0]]], tt = [0], dd = [0], sp = [];
    for (let i = 0; i < r.segs.length; i++) {
      const s = r.segs[i], b = r.nodes[i + 1];
      xs.push(nx[b]); ys.push(ny[b]);
      tt.push(tt[i] + s.dt); dd.push(dd[i] + s.e.len);
      sp.push(s.e.len / s.dt * 3.6);
    }
    return { xs, ys, t: tt, d: dd, sp, len: dd[dd.length - 1], time: tt[tt.length - 1] };
  }

  // Fahrt ab beliebigem Startknoten: Anfahrt zum Abholort, Abholung, Lieferung, Übergabe
  function planTrip(vehKey, startNode, pickIdx, homeIdx) {
    const veh = VEHICLES[vehKey], net = nets[veh.net];
    const p = pois[pickIdx], h = homes[homeIdx];
    const s = startNode == null ? net.depot : startNode;
    const a = nearest(p.x, p.y, net.ok), b = nearest(h.x, h.y, net.ok);
    const r1 = route(net, veh, s, a), r2 = route(net, veh, a, b);
    if (!r1 || !r2) return null;
    const L1 = buildLeg(r1), L2 = buildLeg(r2), D1 = DWELL[p.type], D2 = 45;
    return {
      veh, pick: p, home: h, legs: [L1, L2],
      T1: L1.time, D1, T2: L2.time, D2,
      total: L1.time + D1 + L2.time + D2, len: L1.len + L2.len,
      stopA: { x: nx[a], y: ny[a] }, stopB: { x: nx[b], y: ny[b] },
      start: { x: nx[s], y: ny[s] }, startNode: s, endNode: b
    };
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
    nearest, planTrip, sample, tripState, proj
  };
}
