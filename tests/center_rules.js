// Regeln des Fulfillment Centers (src/center.js): Abfahrten, Annahmeschluss, Zeitfenster, Preise, Bewertung
const L = require('../src/center.js');
let ok = 0, bad = 0;
const check = (name, cond, extra) => { if (cond) ok++; else { bad++; console.log('FEHLER:', name, extra === undefined ? '' : extra); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// Abfahrten und Annahmeschluss
check('5 Abfahrten', L.DEP.length === 5);
check('Abfahrt 6:35', near(L.DEP[0], 6 + 35 / 60) && L.hm(L.DEP[0]) === '6:35');
check('Abfahrten 9:35 12:00 14:35 17:00', L.hm(L.DEP[1]) === '9:35' && L.hm(L.DEP[2]) === '12:00' && L.hm(L.DEP[3]) === '14:35' && L.hm(L.DEP[4]) === '17:00');
check('Fahrer beginnt 30 min vorher', [0, 1, 2, 3, 4].every(k => near(L.drvStart(k), L.DEP[k] - 0.5)));
check('Annahmeschluss 5:05 8:05 10:30 13:05 15:30', [0, 1, 2, 3, 4].map(k => L.hm(L.cutoff(k))).join(' ') === '5:05 8:05 10:30 13:05 15:30', [0, 1, 2, 3, 4].map(k => L.hm(L.cutoff(k))).join(' '));
check('nextSlot um 0 Uhr = 0', L.nextSlot(0) === 0);
check('nextSlot 5:05 genau = 0', L.nextSlot(L.cutoff(0)) === 0);
check('nextSlot 5:06 = 1', L.nextSlot(L.cutoff(0) + 1 / 60) === 1);
check('nextSlot 10:31 = 3', L.nextSlot(10.52) === 3);
check('nextSlot 15:30 = 4', L.nextSlot(15.5) === 4);
check('nextSlot 15:31 = -1', L.nextSlot(15.52) === -1);
check('nextSlot 23 Uhr = -1', L.nextSlot(23) === -1);

// Wochentage
check('Sonntag kein Betrieb', !L.opDay(2) && [0, 1, 3, 4, 5, 6].every(L.opDay));
check('Firmen nur Mo–Fr', !L.firmDay(1) && !L.firmDay(2) && [0, 3, 4, 5, 6].every(L.firmDay));
check('wdOf negativ', L.wdOf(-1) === 6 && L.wdOf(7) === 0 && L.wdOf(9) === 2);

// deterministischer Zufall
function mkRnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Zeitfenster: 100000 Ziehungen zu zufälligen Zeitpunkten und Firmen/Privat
{
  const rnd = mkRnd(12345); let n = 0, bad1 = 0, bad2 = 0, bad3 = 0, bad4 = 0, bad5 = 0, l2 = 0, l4 = 0, sun = 0, firmSat = 0, today = 0, later = 0;
  for (let i = 0; i < 100000; i++) {
    const abs = Math.floor(rnd() * 14 * 86400), firm = rnd() < 0.3;
    const d0 = Math.floor(abs / 86400), h = (abs % 86400) / 3600;
    const w = L.planWindow(rnd, abs, firm); n++;
    const len = w.we - w.ws;
    if (len !== 2 && len !== 4) bad1++;
    if (len === 2) l2++; else l4++;
    if (w.ws < 7 || w.we > 22 || !Number.isInteger(w.ws) || !Number.isInteger(w.we)) bad2++;
    if (!L.opDay(L.wdOf(w.day))) sun++;
    if (firm && !L.firmDay(L.wdOf(w.day))) firmSat++;
    if (w.day < d0 || w.day > d0 + 8) bad3++;
    if (w.day === d0) {
      today++;
      const k = L.nextSlot(h);
      if (k < 0 || w.we < L.DEP[k] + 0.5 - 1e-9) bad4++;      // heute nur, wenn eine Abfahrt das Fenster noch erreichen kann
    } else later++;
    if (w.day === d0 && h > L.cutoff(4) + 1e-9) bad5++;           // nach dem letzten Annahmeschluss nie mehr für heute
  }
  check('Fensterlänge nur 2 oder 4 h', bad1 === 0, bad1);
  check('Fenster ganz zwischen 7 und 22 Uhr, volle Stunden', bad2 === 0, bad2);
  check('nie Sonntag', sun === 0, sun);
  check('Firmen nie am Samstag oder Sonntag', firmSat === 0, firmSat);
  check('Liefertag nicht in der Vergangenheit, höchstens 8 Tage', bad3 === 0, bad3);
  check('heute nur mit erreichbarem Fenster', bad4 === 0, bad4);
  check('nach 15:30 nie für heute', bad5 === 0, bad5);
  check('2 h und 4 h beide häufig', l2 > 30000 && l4 > 30000, l2 + '/' + l4);
  check('heute und später kommen vor', today > 5000 && later > 5000, today + '/' + later);
}
// Beispiele
{
  const fri = 0, sat = 1, sun = 2, mon = 3;
  const r1 = () => 0;                       // immer das erste Element: heute, 2 h, frühester Beginn
  let w = L.planWindow(r1, fri * 86400 + 2 * 3600, false);          // Freitag 2:00
  check('Fr 2:00 -> heute 7–9 möglich', w.day === fri && w.ws === 7 && w.we === 9, JSON.stringify(w));
  w = L.planWindow(r1, fri * 86400 + 9 * 3600, false);              // Freitag 9:00: nächste Abfahrt 12:00 (10:30 Schluss)
  check('Fr 9:00 -> erstes Fenster endet nach 12:30', w.day === fri && w.we >= 12.5, JSON.stringify(w));
  w = L.planWindow(r1, fri * 86400 + 16 * 3600, false);             // Freitag 16:00: heute zu spät
  check('Fr 16:00 -> Samstag', w.day === sat, JSON.stringify(w));
  w = L.planWindow(r1, fri * 86400 + 16 * 3600, true);              // Firma: Wochenende gibt es nicht
  check('Fr 16:00 Firma -> Montag', w.day === mon, JSON.stringify(w));
  w = L.planWindow(r1, sat * 86400 + 16 * 3600, false);             // Samstag 16:00 -> Sonntag fällt aus -> Montag
  check('Sa 16:00 Privat -> Montag', w.day === mon, JSON.stringify(w));
  w = L.planWindow(r1, sun * 86400 + 11 * 3600, false);
  check('So 11:00 -> Montag', w.day === mon, JSON.stringify(w));
  w = L.planWindow(() => 0.999, mon * 86400 + 3 * 3600, false);    // Mo 3:00, letzter Platz in der Verteilung: 2 Betriebstage später (Mi)
  check('Mo 3:00 spätester Platz -> Mittwoch', w.day === mon + 2, JSON.stringify(w));
}

// Mengen, Lohn, Zeiten
{
  const rnd = mkRnd(7); let pmin = 99, pmax = 0, fmin = 99, fmax = 0, ps = 0, fs = 0;
  for (let i = 0; i < 20000; i++) { const a = L.parcels(rnd, false), b = L.parcels(rnd, true); pmin = Math.min(pmin, a); pmax = Math.max(pmax, a); fmin = Math.min(fmin, b); fmax = Math.max(fmax, b); ps += a; fs += b; }
  check('Privat 1 bis 4 Pakete', pmin === 1 && pmax === 4, pmin + '-' + pmax);
  check('Firma 2 bis 12 Pakete', fmin === 2 && fmax === 12, fmin + '-' + fmax);
  check('Firmen bekommen mehr Pakete', fs / 20000 > 2 * ps / 20000, fs / 20000 + ' vs ' + ps / 20000);
}
check('Lohn steigt mit der Menge', L.pay(1, false) < L.pay(4, false) && L.pay(2, true) < L.pay(12, true));
check('Firma zahlt mehr als Privat bei gleicher Menge', L.pay(3, true) > L.pay(3, false));
check('Vergütung: 1,50 € Aufschlag je Kunde (Privat 5,50 + 1,60 je Paket, Firma 8,50 + 1,90 je Paket)', L.pay(1, false) === 7.1 && L.pay(4, false) === 11.9 && L.pay(2, true) === 12.3 && L.pay(12, true) === 31.3, [L.pay(1, false), L.pay(4, false), L.pay(2, true), L.pay(12, true)].join(' '));
check('Durchschnitt je Kunde liegt 1 bis 2 € über der alten Formel (privat 4 + 1,6 n, Firma 7 + 1,9 n)', [[1, false], [2, false], [3, false], [4, false], [2, true], [7, true], [12, true]].every(([n, f]) => { const d = L.pay(n, f) - (f ? 7 + 1.9 * n : 4 + 1.6 * n); return d > 1.4 && d < 1.6; }));
check('Übergabe dauert mit mehr Paketen länger', L.dwell(1, false) < L.dwell(4, false) && L.dwell(2, true) < L.dwell(12, true));
check('Firma braucht länger an der Tür', L.dwell(3, true) > L.dwell(3, false));
check('Mehr Lohn heißt längere Übergabe (alle möglichen Stopps)', (() => { const all = []; for (let n = 1; n <= 4; n++) all.push([L.pay(n, false), L.dwell(n, false)]); for (let n = 2; n <= 12; n++) all.push([L.pay(n, true), L.dwell(n, true)]); for (const a of all) for (const b of all) if (a[0] > b[0] + 1e-9 && a[1] < b[1] - 1e-9) return false; return true; })());
check('Beladen wächst mit der Menge', L.loadSec(1) < L.loadSec(5) && L.loadSec(5) < L.loadSec(12));
check('Beispiel: 10 Stopps mit je 4 Paketen werden in 30 min beladen', 10 * L.loadSec(4) < 30 * 60, 10 * L.loadSec(4));

// Bewertung
check('Note im Fenster 5', L.grade(-3000) === 5 && L.grade(0) === 5);
check('Note nimmt mit Verspätung ab', L.grade(60) > L.grade(1000) && L.grade(1000) > L.grade(2500) && L.grade(2500) > L.grade(5000) && L.grade(5000) >= 1.5);
check('Note nie unter 1,5 bei Lieferung', L.grade(100000) === 1.5);

// Zulauf
check('Zulauf Tag > Nacht', L.inflow(12) === 1 && L.inflow(3) === 0.3);
check('Zulauf stetig um 21 und 24 Uhr', near(L.inflow(21), 1) && near(L.inflow(24), L.inflow(0)) && near(L.inflow(23.999), 0.3, 0.01));
{
  let s = 0; for (let m = 0; m < 1440; m++) s += L.inflow(m / 60) / 60;
  check('DAYSUM stimmt mit dem Tagesintegral überein', near(s, 17.7, 0.05), s);
  let t = 0; for (let m = 0; m < 1440; m++) t += L.ratePerSec(40, m / 60) * 60;
  check('Tagesrate ergibt perDay', near(t, 40, 0.3), t);
}

// Tourgrenzen
check('Tour höchstens 8 h', L.MAXTOUR === 8 * 3600 && L.EXPIRE === 7200 && L.UNLOAD === 300);
check('Fensterbeschriftung', L.winLabel(14, 16) === '14–16 Uhr' && L.hm(12) === '12:00');

// Touren: Abfahrten, Zulassung, Fahrplan, Reihenfolge
{
  const fri = 0, sat = 1, sun = 2, mon = 3;
  check('Beladen Montag 12:00-Tour um 11:30', L.loadA(mon, 2) === mon * 86400 + 11.5 * 3600 && L.depA(mon, 2) === mon * 86400 + 12 * 3600);
  check('Annahmeschluss 10:30 absolut', L.cutA(mon, 2) === mon * 86400 + 10.5 * 3600);
  check('canJoin: vor Schluss ja, nach Schluss nein, anderer Tag nein', L.canJoin(mon * 86400 + 10 * 3600, mon, mon, 2) && !L.canJoin(mon * 86400 + 10.6 * 3600, mon, mon, 2) && !L.canJoin(mon * 86400 + 3600, mon + 1, mon, 2));
  let u = L.upcoming(fri * 86400 + 5 * 3600, 5);
  check('upcoming Fr 5:00: zuerst 6:35 (Beladen 6:05 liegt voraus), dann 9:35 ...', u.length === 5 && u[0].k === 0 && u[0].day === fri && u[1].k === 1 && u[4].k === 4, JSON.stringify(u.map(x => [x.day, x.k])));
  u = L.upcoming(fri * 86400 + 6.2 * 3600, 3);
  check('upcoming Fr 6:12: Beladen der 6:35-Tour läuft schon -> ab 9:35', u[0].k === 1 && u[0].day === fri);
  u = L.upcoming(sat * 86400 + 18 * 3600, 3);
  check('upcoming Sa abends: Sonntag fällt aus, weiter Montag 6:35', u[0].day === mon && u[0].k === 0, JSON.stringify(u.map(x => [x.day, x.k])));
  check('upcoming liefert genau n Einträge, aufsteigend', (() => { const a = L.upcoming(0, 12); return a.length === 12 && a.every((x, i) => i === 0 || x.load > a[i - 1].load); })());
  check('Beladezeit mit Schnellbeladung 30 % kürzer', near(L.loadTime([{ n: 2 }, { n: 4 }], true), L.loadTime([{ n: 2 }, { n: 4 }], false) * 0.7));
  const stops = [{ ws: 12 * 3600, we: 14 * 3600, n: 2, firm: false }, { ws: 12 * 3600, we: 14 * 3600, n: 3, firm: true }, { ws: 7 * 3600, we: 9 * 3600, n: 1, firm: false }];
  const legT = () => 300, dep = 12 * 3600;
  const sc = L.schedule(dep, stops, legT);
  check('Fahrplan: erster Stopp nach 300 s', sc.rows[0].arr === dep + 300 && sc.rows[0].wait === 0 && sc.rows[0].late < 0);
  check('Fahrplan: Übergabe verlängert den Weg', near(sc.rows[1].arr, sc.rows[0].done + 300));
  check('Fahrplan: dritter Stopp zu spät (Fenster 7-9 vorbei)', sc.rows[2].late > 3 * 3600 && sc.late > 3 * 3600);
  check('Fahrplan: Ende = letzter Stopp + Rückfahrt + 5 min Übergabe', near(sc.end, sc.rows[2].done + 300 + L.UNLOAD) && near(sc.dur, sc.end - dep));
  const early = L.schedule(10 * 3600, [{ ws: 12 * 3600, we: 14 * 3600, n: 1, firm: false }], legT);
  check('Fahrplan: zu früh -> Warten bis Fensterbeginn', early.rows[0].start === 12 * 3600 && near(early.rows[0].wait, 12 * 3600 - (10 * 3600 + 300)) && early.late === 0);
  check('Fahrplan: leere Tour hat keine Rückfahrt', L.schedule(dep, [], legT).back === 0);
  const xs = [900, 100, 500, 300, 700];
  const dist = (a, b) => Math.abs((a < 0 ? 0 : xs[a]) - (b < 0 ? 0 : xs[b]));
  const cost = o => { let c = 0, p = -1; for (const i of o) { c += dist(p, i); p = i; } return c + dist(p, -1); };
  const o1 = L.optimize(5, cost, dist);
  check('optimize: Linie ergibt aufsteigend (Weg 1800)', cost(o1) === 1800 && o1.length === 5 && new Set(o1).size === 5, JSON.stringify(o1) + cost(o1));
  check('optimize: Zufallsfälle nie schlechter als Nächster-Nachbar', (() => { const r = mkRnd(99); for (let k = 0; k < 40; k++) { const n = 2 + Math.floor(r() * 12), P = Array.from({ length: n }, () => [r() * 1000, r() * 1000]); const d = (a, b) => { const A = a < 0 ? [0, 0] : P[a], B = b < 0 ? [0, 0] : P[b]; return Math.hypot(A[0] - B[0], A[1] - B[1]); }; const c = o => { let s = 0, p = -1; for (const i of o) { s += d(p, i); p = i; } return s + d(p, -1); }; const o = L.optimize(n, c, d); const left = new Set(P.keys()); let cur = -1, nn = []; while (left.size) { let b = -1, bd = Infinity; for (const i of left) if (d(cur, i) < bd) { bd = d(cur, i); b = i; } nn.push(b); left.delete(b); cur = b; } if (new Set(o).size !== n || c(o) > c(nn) + 1e-6) return false; } return true; })());
  check('optimize: 0 und 1 Stopp', L.optimize(0, cost, dist).length === 0 && L.optimize(1, cost, dist)[0] === 0);
  check('optimize: Fensterstrafe zieht frühe Fenster nach vorn', (() => { const P = [[1000, 0], [0, 1000]], W = [300, 100000]; const d = (a, b) => { const A = a < 0 ? [0, 0] : P[a], B = b < 0 ? [0, 0] : P[b]; return Math.hypot(A[0] - B[0], A[1] - B[1]); }; const c = o => { let t = 0, p = -1, pen = 0; for (const i of o) { t += d(p, i) / 5; if (t > W[i]) pen += t - W[i]; p = i; } return t + 100 * pen; }; const o = L.optimize(2, c, d); return o.join() === '0,1'; })());
}

console.log(ok + ' Prüfungen ok, ' + bad + ' Fehler');
process.exit(bad ? 1 : 0);
