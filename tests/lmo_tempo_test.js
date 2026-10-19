'use strict';
// Tests des Tempo-Plans der Weltzeit (src/online.js): 30-fach bis zum Umstellzeitpunkt, danach nach Tageszeit (tagsüber 15-fach, nachts 60-fach), stetiger Übergang.
// Reine Rechnung, ohne Firebase-Nachbau. Start: node tests/lmo_tempo_test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'online.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FEHLER:', m); } };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, m + ' (ist ' + a + ', soll ' + b + ')');
let NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
class FDate extends Date { static now() { return NOW; } }
function load(plan) {
  const store = {}, ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const env = { fetch: async () => { throw new Error('kein Netz'); }, localStorage: ls, AbortController, setTimeout, clearTimeout, Date: FDate, JSON, Math, console, URL, encodeURIComponent, Promise };
  if (plan !== undefined) env.__LM_PLAN = plan;
  const ctx = vm.createContext(env); vm.runInContext(SRC + '\nthis.LMO = LMO;', ctx); return ctx.LMO;
}
const EPOCH = Date.UTC(2026, 9, 1) / 1000, SW = Date.UTC(2026, 9, 20, 4, 0, 0);       // Standard-Umstellung: 20.10.2026, 04:00 UTC
const G = (L, ms) => L.world.gameAt(ms);

{ // ---------- Standardplan ----------
  const L = load(), W = L.world;
  ok(W.plan && W.plan.h0 === 5 && W.plan.h1 === 22 && W.plan.vDay === 15 && W.plan.vNight === 60, 'Standardplan: 5 bis 22 Uhr 15-fach, nachts 60-fach');
  ok(W.plan.from === SW / 1000 - EPOCH, 'Umstellung am 20.10.2026 um 04:00 UTC');
  ok(W.speed === 30 && W.maxAway === 3600, 'speed (alt) bleibt 30, Abwesenheit höchstens 1 Stunde');
  // vor der Umstellung: 30-fach wie bisher
  const t1 = SW - 3 * 86400000;
  near(G(L, t1), (t1 / 1000 - EPOCH) * 30, 1e-6, 'vor der Umstellung 30-fach');
  near(G(L, t1 + 1000) - G(L, t1), 30, 1e-9, 'vor der Umstellung: 30 Spielsekunden je Sekunde');
  // stetig am Übergang
  near(G(L, SW - 1), G(L, SW + 1), 0.1, 'stetig am Übergang (kein Sprung)');
  near(G(L, SW), (SW / 1000 - EPOCH) * 30, 1e-6, 'Übergangspunkt = alte Weltzeit');
  near(G(L, SW) % 86400, 0, 1e-6, 'Umstellung liegt auf Spielmitternacht');
  // Tagesablauf nach der Umstellung: 0 bis 5 Uhr 60-fach (300 s), 5 bis 22 Uhr 15-fach (4080 s), 22 bis 24 Uhr 60-fach (120 s)
  const g0 = G(L, SW);
  near(W.speedAt(g0 + 2 * 3600), 60, 0, 'Tempo um 2 Uhr');
  near(W.speedAt(g0 + 5 * 3600), 15, 0, 'Tempo um 5:00');
  near(W.speedAt(g0 + 12 * 3600), 15, 0, 'Tempo um 12 Uhr');
  near(W.speedAt(g0 + 22 * 3600 - 1), 15, 0, 'Tempo um 21:59:59');
  near(W.speedAt(g0 + 22 * 3600), 60, 0, 'Tempo um 22 Uhr');
  near(W.speedAt(g0 + 86400 * 3 + 23 * 3600), 60, 0, 'Tempo um 23 Uhr an einem späteren Tag');
  near(G(L, SW + 300 * 1000) - g0, 5 * 3600, 1e-6, 'nach 300 echten Sekunden ist es 5:00 (Nacht 60-fach)');
  near(G(L, SW + 4380 * 1000) - g0, 22 * 3600, 1e-6, 'nach 4380 echten Sekunden ist es 22:00 (Tag 15-fach)');
  near(G(L, SW + 4500 * 1000) - g0, 86400, 1e-6, 'ein Spieltag dauert 75 echte Minuten');
  for (const off of [0, 77, 1234, 3600, 100000, 987654]) near(G(L, SW + off * 1000 + 4500000) - G(L, SW + off * 1000), 86400, 1e-6, 'jeder Zeitraum von 75 Minuten = ein Spieltag (Versatz ' + off + ')');
  // streng wachsend, Steigung = Tempo der Tageszeit
  let mono = true, slope = true, prev = -Infinity;
  for (let off = -7200; off < 4 * 86400; off += 37) {
    const ms = SW + off * 1000, g = G(L, ms); if (!(g > prev)) mono = false; prev = g;
    if (off > 5) { const d = G(L, ms + 1000) - g, s0 = W.speedAt(g), s1 = W.speedAt(g + d); if (s0 === s1 && Math.abs(d - s0) > 1e-6) slope = false; }
  }
  ok(mono, 'Weltzeit wächst ständig'); ok(slope, 'Steigung = Tempo der jeweiligen Tageszeit');
  // Umkehrung und echte Sekunden zwischen zwei Spielzeiten
  let inv = true; for (const off of [-1e6, -5, 0, 5, 299, 300, 301, 4379, 4380, 4381, 4500, 123456, 3e6]) { const r = SW / 1000 - EPOCH + off, g = L.world.gameAt((r + EPOCH) * 1000); if (Math.abs(W.realSpan(0, g) - (r - W.realSpan(0, 0))) > 1e-6) inv = false; }
  ok(inv, 'realSpan ist die Umkehrung von gameAt');
  near(W.realSpan(g0 + 5 * 3600, g0 + 22 * 3600), 4080, 1e-6, 'der Tag (5 bis 22 Uhr) dauert 4080 echte Sekunden');
  near(W.realSpan(g0 + 22 * 3600, g0 + 29 * 3600), 420, 1e-6, 'die Nacht (22 bis 5 Uhr) dauert 420 echte Sekunden');
  near(W.realSpan(g0 - 3600 * 30, g0), 3600, 1e-6, 'vor der Umstellung: 30 Spielstunden = 1 echte Stunde');
  near(W.realSpan(g0 - 3600 * 15, g0 + 5 * 3600), 1800 + 300, 1e-6, 'Zeitraum über die Umstellung: 30 Minuten alt + 5 Minuten Nacht');
}

{ // ---------- cover: Spielsekunden der letzten x echten Sekunden ----------
  const L = load(), W = L.world;
  NOW = SW + 600 * 1000;                                                                                   // 10 Minuten nach der Umstellung: 5 Minuten Nacht, dann Tag
  near(W.cover(300), 300 * 15, 1e-6, 'cover: die letzten 300 s liefen am Tag (15-fach)');
  near(W.cover(600), 300 * 60 + 300 * 15, 1e-6, 'cover: 300 s Nacht (60-fach) + 300 s Tag');
  near(W.cover(900), 300 * 30 + 300 * 60 + 300 * 15, 1e-6, 'cover über die Umstellung: 300 s alt (30-fach), Nacht, Tag');
  near(W.cover(3600), G(L, NOW) - G(L, NOW - 3600000), 1e-9, 'cover = Unterschied der Weltzeit');
  NOW = SW + 4380 * 1000 + 30 * 1000;                                                                      // kurz nach 22:00
  near(W.cover(60), 30 * 60 + 30 * 15, 1e-6, 'cover über 22:00: erst 15-fach, dann 60-fach');
  NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
  near(W.cover(1800), 1800 * 30, 1e-6, 'vor der Umstellung: cover = 30-fach');
}

{ // ---------- immer 30-fach (Tests) ----------
  const L = load('legacy'), W = L.world;
  ok(W.plan === null, 'legacy: kein Plan');
  const t = Date.UTC(2026, 11, 24, 18, 0, 0);
  near(G(L, t), (t / 1000 - EPOCH) * 30, 1e-6, 'legacy: immer 30-fach, auch nach dem Umstellzeitpunkt');
  near(W.speedAt(12345), 30, 0, 'legacy: Tempo 30');
  near(W.realSpan(1000, 4000), 100, 1e-9, 'legacy: realSpan = Spielsekunden / 30');
  NOW = Date.UTC(2026, 11, 24, 18, 0, 0); near(W.cover(120), 3600, 1e-9, 'legacy: cover = x * 30');
}

{ // ---------- eigener Plan und ungültige Pläne ----------
  const L = load({ from: 0, h0: 6, h1: 20, vDay: 10, vNight: 40 }), W = L.world;
  ok(W.plan && W.plan.vDay === 10 && W.plan.vNight === 40 && W.plan.h0 === 6 && W.plan.h1 === 20 && W.plan.from === 0, 'eigener Plan wird übernommen');
  const per = 14 * 3600 / 10 + 10 * 3600 / 40;
  near(G(L, EPOCH * 1000 + per * 1000 * 5 + 1000 * 0) - G(L, EPOCH * 1000), 5 * 86400, 1e-6, 'eigener Plan: Tageslänge ' + per + ' s');
  const L2 = load({ from: Date.UTC(2026, 9, 25) / 1000 - EPOCH, vDay: 20 }), W2 = L2.world;
  ok(W2.plan && W2.plan.vDay === 20 && W2.plan.vNight === 60 && W2.plan.h0 === 5, 'teilweiser Plan: fehlende Werte kommen aus dem Standard');
  for (const bad of [{ h0: 22, h1: 5 }, { vDay: 0 }, { vNight: -3 }, { from: NaN }, { h1: 25 }]) { const Lb = load(bad); ok(Lb.world.plan === null, 'ungültiger Plan ' + JSON.stringify(bad) + ' → 30-fach wie bisher'); }
}

console.log(pass + ' bestanden, ' + fail + ' fehlgeschlagen');
process.exit(fail ? 1 : 0);
