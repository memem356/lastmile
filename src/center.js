// Fulfillment Center: reine Regeln ohne Spielzustand (Abfahrten, Zeitfenster, Mengen, Preise, Bewertung).
// Zeiten sind Stunden als Dezimalzahl (6,5833 = 6:35). Im Spiel heißt das Modul LMC, getestet wird es in tests/center_rules.js.
const LMC = (function () {
  const DEP = [6 + 35 / 60, 9 + 35 / 60, 12, 14 + 35 / 60, 17];   // Abfahrt aus dem Center
  const LOAD = 0.5;                  // der Fahrer beginnt eine halbe Stunde vor der Abfahrt mit dem Beladen
  const LEAD = 1;                    // Bestellungen müssen eine Stunde vor Fahrerbeginn vorliegen
  const HMIN = 7, HMAX = 22;         // Zeitfenster liegen zwischen 7 und 22 Uhr (Beginn und Ende)
  const MAXTOUR = 8 * 3600;          // eine Tour dauert höchstens 8 Stunden ab Abfahrt
  const EXPIRE = 2 * 3600;           // nach dem Fensterende verfällt eine Bestellung, wenn sie bis dahin nicht geliefert wurde
  const UNLOAD = 5 * 60;             // Übergabe im Center nach der Rückkehr
  const DAYSUM = 17.7;               // Summe von inflow() über 24 Stunden

  const drvStart = k => DEP[k] - LOAD;
  const cutoff = k => DEP[k] - LOAD - LEAD;                          // 5:05, 8:05, 10:30, 13:05, 15:30
  const wdOf = d => ((d % 7) + 7) % 7;                               // Tag-Nummer -> Wochentag (0 = Fr, 1 = Sa, 2 = So, 3 = Mo …)
  const opDay = wd => wd !== 2;                                      // Betrieb Montag bis Samstag
  const firmDay = wd => wd !== 1 && wd !== 2;                        // Firmen werden nur Montag bis Freitag beliefert
  // Erste Abfahrt, für die eine Bestellung zur Stunde h noch rechtzeitig vorliegt (-1: heute keine mehr)
  const nextSlot = h => { for (let k = 0; k < DEP.length; k++) if (cutoff(k) >= h - 1e-9) return k; return -1; };

  // Lieferwunsch einer neuen Bestellung. abs: Sekunden seit Freitag 00:00. Ergebnis: Tag (Nummer ab Freitag 0), Fensterbeginn und -ende in Stunden.
  function planWindow(rnd, abs, firm) {
    const d0 = Math.floor(abs / 86400), h = (abs - d0 * 86400) / 3600;
    const ok = d => opDay(wdOf(d)) && (!firm || firmDay(wdOf(d)));
    const slot = nextSlot(h), days = [];
    let d = slot >= 0 && ok(d0) ? d0 : d0 + 1;
    while (days.length < 3) { if (ok(d)) days.push(d); d++; }
    const W = days[0] === d0 ? [0.5, 0.3, 0.2] : [0.6, 0.3, 0.1];
    let r = rnd(), i = 0; while (i < 2 && r > W[i]) { r -= W[i]; i++; }
    const day = days[i], L = rnd() < 0.5 ? 2 : 4;
    const earliest = day === d0 ? DEP[slot] + 0.5 - L : HMIN;       // heute muss das Fenster nach der nächsten Abfahrt noch erreichbar sein
    const lo = Math.max(HMIN, Math.ceil(earliest - 1e-9)), hi = HMAX - L;
    const s = lo + Math.floor(rnd() * (hi - lo + 1));
    return { day, ws: s, we: s + L };
  }

  // Mengen (Pakete je Stopp), Lohn und Zeiten. Mehr Pakete: mehr Lohn und längere Übergabe.
  function parcels(rnd, firm) {
    if (!firm) { const r = rnd(); return r < 0.5 ? 1 : r < 0.8 ? 2 : r < 0.95 ? 3 : 4; }
    return 2 + Math.floor(rnd() * 6) + Math.floor(rnd() * 6);        // 2 bis 12, meist um 7
  }
  const pay = (n, firm) => Math.round((firm ? 8.5 + 1.9 * n : 5.5 + 1.6 * n) * 10) / 10;
  const dwell = (n, firm) => (firm ? 120 : 60) + 28 * n;              // Sekunden an der Tür
  const loadSec = n => 15 + 12 * n;                                  // Sekunden zum Beladen im Center
  // Note der Lieferung (1 bis 5). late: Sekunden nach dem Fensterende, negativ oder 0 = im Fenster.
  const grade = late => late <= 0 ? 5 : late <= 600 ? 4 : late <= 1800 ? 3 : late <= 3600 ? 2 : 1.5;

  // Zulauf neuer Bestellungen über den Tag (Faktor 0,3 bis 1); perDay Bestellungen pro Tag insgesamt
  const inflow = h => { h = ((h % 24) + 24) % 24; return h < 6 ? 0.3 : h < 9 ? 0.3 + 0.7 * (h - 6) / 3 : h < 21 ? 1 : 1 - 0.7 * (h - 21) / 3; };
  const ratePerSec = (perDay, h) => perDay * inflow(h) / DAYSUM / 3600;

  // ---- Touren: Abfahrten, Fahrplan, Reihenfolge ----
  const dayA = d => d * 86400;                                       // Beginn eines Tages in absoluten Sekunden (Sekunden seit Freitag 00:00)
  const loadA = (d, k) => dayA(d) + drvStart(k) * 3600;              // Fahrer beginnt mit dem Beladen
  const depA = (d, k) => dayA(d) + DEP[k] * 3600;                    // frühester Abfahrtszeitpunkt
  const cutA = (d, k) => dayA(d) + cutoff(k) * 3600;                 // Annahmeschluss für diese Abfahrt
  // Kann eine Bestellung (erstellt zur absoluten Zeit ca) noch auf die Tour d/k?
  const canJoin = (ca, day, d, k) => day === d && ca <= cutA(d, k) + 1e-6;
  // Die nächsten Abfahrten, bei denen das Beladen noch nicht begonnen hat (nur Betriebstage). n: Anzahl.
  function upcoming(absNow, n) {
    const out = [], d0 = Math.floor(absNow / 86400);
    for (let d = d0; d <= d0 + 7 && out.length < n; d++) if (opDay(wdOf(d))) for (let k = 0; k < DEP.length && out.length < n; k++) if (loadA(d, k) > absNow + 1e-6) out.push({ day: d, k, load: loadA(d, k), dep: depA(d, k) });
    return out;
  }
  // Zeit zum Beladen aller Stopps (Schnellbeladung: 30 % weniger)
  const loadTime = (stops, quick) => stops.reduce((a, s) => a + loadSec(s.n), 0) * (quick ? 0.7 : 1);
  // Fahrplan: stops in Fahrtreihenfolge ({ws, we, n, firm}, absolute Sekunden); legT(a, b, t) = Fahrzeit von a nach b (null = Center) bei Abfahrt zur Zeit t.
  // Kommt der Transporter zu früh, wird bis Fensterbeginn gewartet (vorsichtige Annahme; der Kunde kann auch früher da sein).
  function schedule(dep, stops, legT, doorMul) {
    const rows = []; let t = dep, prev = null, late = 0, wait = 0, drive = 0, door = 0; doorMul = doorMul || 1;
    for (const s of stops) {
      const tt = legT(prev, s, t), arr = t + tt, start = Math.max(arr, s.ws), dw = dwell(s.n, s.firm) * doorMul;
      rows.push({ arr, start, done: start + dw, wait: start - arr, late: start - s.we, drive: tt });
      drive += tt; wait += start - arr; door += dw; if (start > s.we) late += start - s.we;
      t = start + dw; prev = s;
    }
    const back = stops.length ? legT(prev, null, t) : 0, end = t + back + UNLOAD;
    return { rows, back, end, dur: end - dep, late, wait, drive: drive + back, door };
  }
  // Reihenfolge: Nächster-Nachbar und Sortierung nach Fensterbeginn als Startlösungen, dann 2-opt und Umhängen. cost(order) -> Zahl (kleiner ist besser).
  function optimize(n, cost, dist, startFrom) {
    if (n < 2) return n ? [0] : [];
    const nn = []; { const left = new Set(); for (let i = 0; i < n; i++) left.add(i); let cur = -1; while (left.size) { let b = -1, bd = Infinity; for (const i of left) { const d = dist(cur, i); if (d < bd) { bd = d; b = i; } } nn.push(b); left.delete(b); cur = b; } }
    const cands = [nn]; if (startFrom) cands.push(startFrom.slice());
    let best = null, bc = Infinity;
    for (const o0 of cands) {
      let o = o0.slice(), c = cost(o), improved = true, rounds = 0;
      while (improved && rounds++ < 40) {
        improved = false;
        for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {            // 2-opt: Teilstück umdrehen
          const q = o.slice(0, i).concat(o.slice(i, j + 1).reverse(), o.slice(j + 1)), qc = cost(q);
          if (qc < c - 1e-9) { o = q; c = qc; improved = true; }
        }
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) {        // Stopp i an Stelle j setzen
          const q = o.slice(); const x = q.splice(i, 1)[0]; q.splice(j, 0, x); const qc = cost(q);
          if (qc < c - 1e-9) { o = q; c = qc; improved = true; }
        }
      }
      if (c < bc) { bc = c; best = o; }
    }
    return best;
  }

  const hm = h => { const m = Math.round(h * 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
  const winLabel = (ws, we) => ws + '–' + we + ' Uhr';

  const api = { DEP, LOAD, LEAD, HMIN, HMAX, MAXTOUR, EXPIRE, UNLOAD, drvStart, cutoff, wdOf, opDay, firmDay, nextSlot, planWindow, parcels, pay, dwell, loadSec, grade, inflow, ratePerSec, hm, winLabel, dayA, loadA, depA, cutA, canJoin, upcoming, loadTime, schedule, optimize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
