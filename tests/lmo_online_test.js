'use strict';
// Tests der Online-Bausteine (Unternehmen, Sitzungssperre, Rangliste) gegen den Firebase-Nachbau samt Sicherheitsregeln.
// Start: node tests/lmo_online_test.js
const { spawn } = require('child_process'), fs = require('fs'), vm = require('vm'), path = require('path');
const PORT = 9198, MOCK = `http://127.0.0.1:${PORT}`;
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'online.js'), 'utf8');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'firebase-rules.json'), 'utf8').match(/'(LM-[A-Z0-9-]+)'/)[1];
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FEHLER:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (ist ' + JSON.stringify(a) + ', soll ' + JSON.stringify(b) + ')');
const ctl = async (p, b) => (await fetch(MOCK + '/ctl/' + p, { method: 'POST', body: JSON.stringify(b || {}) })).json();
const stateOf = async () => (await fetch(MOCK + '/ctl/state', { method: 'POST' })).json();
function client(store) {
  store = store || {};
  const ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const f = async (url, opt) => {
    let u = String(url), m;
    if ((m = u.match(/^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:([A-Za-z]+)\?(.*)$/))) u = `${MOCK}/auth/${m[1]}?${m[2]}`;
    else if ((m = u.match(/^https:\/\/securetoken\.googleapis\.com\/v1\/token\?(.*)$/))) u = `${MOCK}/token?${m[1]}`;
    else if ((m = u.match(/^https:\/\/([^/]+)\/(.*)$/))) u = `${MOCK}/db/${m[1]}/${m[2]}`;
    else throw new Error('unerwartete URL ' + u);
    return fetch(u, opt);
  };
  const ctx = vm.createContext({ fetch: f, localStorage: ls, AbortController, setTimeout, clearTimeout, Date, JSON, Math, console, URL, encodeURIComponent, Promise, __LM_PLAN: 'legacy' });
  vm.runInContext(SRC + '\nthis.LMO = LMO;', ctx);
  return { L: ctx.LMO, store };
}
const rejects = async (p, code, m) => { try { await p; ok(false, m + ' (kein Fehler)'); } catch (e) { eq(e.code, code, m); } };
const reg = (L, o) => L.register(Object.assign({ name: 'Tim Express', email: 'tim@example.de', password: 'geheim123', code: CODE }, o));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn('node', [path.join(__dirname, 'fbmock.js'), String(PORT)], { env: Object.assign({}, process.env, { ANCESTOR_VALIDATE: process.env.ANC || '0' }), stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await ctl('reset'); break; } catch (e) { await sleep(100); } }
  try {
    const CK = '51_457_7_015';
    const A = client(), B = client();
    await reg(A.L); await reg(B.L, { name: 'Zoe', email: 'zoe@example.de' });
    const uidA = A.L.state().uid, uidB = B.L.state().uid;

    // --- Weltzeit
    { const w = A.L.world;
      eq(w.speed, 30, 'Weltzeit 30-fach'); eq(w.maxAway, 3600, 'Abwesenheit höchstens 1 Stunde');
      await ctl('skew', { ms: 4000 }); await A.L.syncClock(3);
      const off = A.L.state().offset; ok(Math.abs(off - 4000) < 300, 'Uhrenabgleich findet die Abweichung (' + off + ')');
      const g1 = w.gameNow(); await sleep(200); const g2 = w.gameNow();
      ok(g2 - g1 > 4.5 && g2 - g1 < 8, 'Weltzeit läuft 30-fach (' + (g2 - g1).toFixed(2) + ' in 0,2 s)');
      ok(Math.abs(g1 - ((Date.now() + 4000) / 1000 - Date.UTC(2026, 9, 1) / 1000) * 30) < 30 * 0.4, 'Weltzeit folgt der Serverzeit');
      eq(w.ckOf(51.4569, 7.0151), '51_457_7_015', 'Stadtschlüssel'); eq(w.ckOf(-33.8688, 151.2093), '-33_869_151_209', 'Stadtschlüssel negativ');
      await ctl('skew', { ms: 0 });
      // Tage/Wochen: 02:00 UTC ist die Grenze, Montag der Wochenbeginn
      const d = Date.UTC(2026, 9, 19, 2, 0, 0); // Montag 19.10.2026 02:00 UTC
      eq(w.period('day', d) - w.period('day', d - 1), 1, 'Tagesgrenze um 02:00 UTC'); eq(w.period('week', d) - w.period('week', d - 1), 1, 'Wochengrenze Montag 02:00 UTC');
      eq(w.period('week', d + 6 * 86400000) - w.period('week', d), 0, 'bis Sonntag dieselbe Woche'); eq(w.period('week', d + 7 * 86400000) - w.period('week', d), 1, 'nächste Woche');
      eq(w.period('all'), 0, 'Gesamt ist Zeitraum 0');
    }

    // --- Unternehmen und Sitzungssperre
    let o1, o2;
    { o1 = await A.L.company.open(CK);
      eq([o1.prev, o1.raw, o1.t], [null, null, null], 'neues Unternehmen: nichts vorhanden'); ok(typeof o1.sess === 'string' && o1.sess.length >= 8, 'Sitzungskennung');
      let S = await stateOf(); eq(S.DB.sessions[uidA]['o_' + CK].sess, o1.sess, 'Sitzung in der Datenbank'); ok(typeof S.DB.sessions[uidA]['o_' + CK].t === 'number', 'Sitzung mit Serverzeit');
      const raw = JSON.stringify({ v: 2, pad: 'x'.repeat(60) });
      await A.L.company.push(o1.slot, o1.sess, raw, 'Online · Essen · 150 € · 0 Lieferungen');
      S = await stateOf(); eq(S.DB.saves[uidA]['o_' + CK].data, raw, 'Stand gespeichert'); eq(S.DB.saves[uidA]['o_' + CK].sess, o1.sess, 'Stand trägt die Sitzung'); eq(S.DB.savemeta[uidA]['o_' + CK].info, 'Online · Essen · 150 € · 0 Lieferungen', 'Info gespeichert');
      await A.L.company.push(o1.slot, o1.sess, raw + ' ', 'Info 2'); ok(true, 'zweites Speichern geht');
      // zweites Gerät übernimmt
      const A2 = client(); await A2.L.login('tim@example.de', 'geheim123');
      o2 = await A2.L.company.open(CK);
      eq(o2.prev, o1.sess, 'zweites Gerät sieht die alte Sitzung'); eq(o2.raw, raw + ' ', 'zweites Gerät bekommt den Stand'); ok(typeof o2.t === 'number', 'Stand hat Serverzeit');
      await rejects(A.L.company.push(o1.slot, o1.sess, raw, 'alt'), 'SUPERSEDED', 'altes Gerät wird beendet');
      await A2.L.company.push(o2.slot, o2.sess, raw + 'neu', 'neu'); ok(true, 'neues Gerät speichert');
      eq((await stateOf()).DB.saves[uidA]['o_' + CK].data, raw + 'neu', 'Stand des neuen Geräts gilt');
      A.A2 = A2;
    }
    // --- Mein Unternehmen (ein Konto, ein Spielstand) und ready()
    { const A2 = A.A2, CK2 = '48_137_11_575', raw = JSON.stringify({ v: 2, pad: 'm'.repeat(60) });
      let m = await A.L.company.mine();
      eq([m.ck, m.slot, m.lat, m.lon, m.others, typeof m.t], [CK, 'o_' + CK, 51.457, 7.015, 0, 'number'], 'mine: das einzige Unternehmen mit Koordinaten');
      eq(m.name, 'Stadt', 'mine: ohne lesbare Info bleibt ein Platzhalter für den Städtenamen');
      await A2.L.company.push(o2.slot, o2.sess, raw, 'Online · Essen · 150 € · 3 Lieferungen');
      m = await A.L.company.mine(); eq([m.name, m.info], ['Essen', 'Online · Essen · 150 € · 3 Lieferungen'], 'mine: Stadtname aus der Info');
      await sleep(30);
      const o3 = await A2.L.company.open(CK2); await A2.L.company.push(o3.slot, o3.sess, raw, 'Online · München · 90 € · 1 Lieferung');
      m = await A.L.company.mine(); eq([m.ck, m.name, m.lat, m.lon, m.others], [CK2, 'München', 48.137, 11.575, 1], 'mine: bei mehreren gilt das zuletzt gespeicherte, die anderen werden gezählt');
      await sleep(30); await A.L.cloud.put('s_solo_test', JSON.stringify({ v: 2, pad: 's'.repeat(60) }), 'Solo · Bochum', 1);
      m = await A.L.company.mine(); eq(m.ck, CK2, 'mine: Solo-Stände (s_) zählen nicht');
      await A2.L.company.remove(CK2);
      m = await A.L.company.mine(); eq([m.ck, m.others], [CK, 0], 'mine: nach dem Aufgeben gilt wieder das andere');
      await A.L.cloud.del('s_solo_test');
      await rejects(client().L.company.mine(), 'NOT_SIGNED_IN', 'mine: nur angemeldet');
      // removeAll: alle Online-Unternehmen des Kontos, Solo-Stände und fremde Konten bleiben
      await A2.L.company.open(CK2).then(o => A2.L.company.push(o.slot, o.sess, raw, 'Online · München · 90 € · 1 Lieferung'));
      await A.L.cloud.put('s_solo_test', JSON.stringify({ v: 2, pad: 's'.repeat(60) }), 'Solo · Bochum', 1);
      eq(await A.L.company.removeAll(), 2, 'removeAll: beide Unternehmen gelöscht');
      eq(await A.L.company.mine(), null, 'removeAll: danach kein Unternehmen mehr');
      eq((await A.L.cloud.list()).map(x => x.slot), ['s_solo_test'], 'removeAll: Solo-Stand bleibt');
      eq(await A.L.company.removeAll(), 0, 'removeAll ohne Unternehmen: nichts zu tun');
      await A.L.cloud.del('s_solo_test');
      { const o = await A.L.company.open(CK); await A.L.company.push(o.slot, o.sess, raw, 'Online · Essen · 150 € · 3 Lieferungen'); }
      // ready(): wartet, bis Konto und Profil geladen sind
      const R = client(A.store).L; await R.ready(); ok(!R.state().signedIn, 'ready ohne init: sofort fertig, nicht angemeldet');
      R.init(); await R.ready(); eq([R.state().signedIn, R.state().uid, !!R.state().name], [true, uidA, true], 'ready: nach init sind Konto und Profil geladen');
      const N = client(); N.L.init(); await N.L.ready(); ok(!N.L.state().signedIn, 'ready ohne gespeicherte Anmeldung: nicht angemeldet');
    }
    // Regeln der Sitzung direkt prüfen
    { const raw = JSON.stringify({ v: 2, pad: 'x'.repeat(60) }), cur = (await stateOf()).DB.sessions[uidA]['o_' + CK].sess;
      await rejects(A.L._db('PUT', 'saves/' + uidA + '/o_' + CK, { t: { '.sv': 'timestamp' }, v: 2, data: raw }), 'PERMISSION_DENIED', 'Online-Stand ohne Sitzung abgelehnt');
      await rejects(A.L._db('PUT', 'saves/' + uidA + '/o_' + CK, { t: { '.sv': 'timestamp' }, v: 2, sess: 'falsch123456', data: raw }), 'PERMISSION_DENIED', 'Online-Stand mit falscher Sitzung abgelehnt');
      await A.L._db('PUT', 'saves/' + uidA + '/o_' + CK, { t: { '.sv': 'timestamp' }, v: 2, sess: cur, data: raw }); ok(true, 'mit richtiger Sitzung ok');
      await rejects(A.L._db('PUT', 'saves/' + uidA + '/o_andere', { t: { '.sv': 'timestamp' }, v: 2, sess: cur, data: raw }), 'PERMISSION_DENIED', 'ohne Sitzung für diese Stadt abgelehnt');
      await rejects(A.L._db('PUT', 'saves/' + uidA + '/s_x', { t: { '.sv': 'timestamp' }, v: 2, sess: cur, data: raw }), 'PERMISSION_DENIED', 'Solo-Platz darf keine Sitzung tragen');
      await A.L._db('PUT', 'saves/' + uidA + '/s_x', { t: { '.sv': 'timestamp' }, v: 2, data: raw }); ok(true, 'Solo-Platz ohne Sitzung ok');
      await rejects(B.L._db('PUT', 'sessions/' + uidA + '/o_' + CK, { sess: 'fremd1234567', t: { '.sv': 'timestamp' } }), 'PERMISSION_DENIED', 'fremde Sitzung nicht überschreibbar');
      await rejects(B.L._db('GET', 'sessions/' + uidA), 'PERMISSION_DENIED', 'fremde Sitzungen nicht lesbar');
      await rejects(A.L._db('PUT', 'sessions/' + uidA + '/s_x', { sess: 'abcdefgh1234', t: { '.sv': 'timestamp' } }), 'PERMISSION_DENIED', 'Sitzung nur für Online-Plätze');
      await rejects(A.L._db('PUT', 'sessions/' + uidA + '/o_' + CK, { sess: 'kurz', t: { '.sv': 'timestamp' } }), 'PERMISSION_DENIED', 'zu kurze Sitzungskennung');
      await rejects(A.L._db('PUT', 'sessions/' + uidA + '/o_' + CK, { sess: 'abcdefgh1234', t: 5 }), 'PERMISSION_DENIED', 'Sitzung mit falscher Zeit');
    }

    // --- Rangliste: Schreiben
    const st1 = { city: 'Essen', l: 12, r: 4.2, g: { all: 340.5, day: 340.5, week: 340.5 } };
    { const done = await A.L.board.submit(CK, st1); eq(done.length, 6, 'sechs Einträge geschrieben (Stadt und weltweit je Tag/Woche/Gesamt)');
      const S = await stateOf(), e = S.DB.board[CK].all[uidA];
      eq([e.n, e.c, e.g, e.l, e.r, e.p], ['Tim Express', 'Essen', 340.5, 12, 4.2, 0], 'Eintrag Stadt/Gesamt'); ok(typeof e.t === 'number', 'Eintrag mit Serverzeit');
      eq(S.DB.board[CK].day[uidA].p, A.L.world.period('day'), 'Tagesnummer'); eq([S.DB.board[CK].day[uidA].l, S.DB.board[CK].day[uidA].r], [undefined, undefined], 'Tag ohne Lieferungen und Ruf'); eq(S.DB.board[CK].week[uidA].p, A.L.world.period('week'), 'Wochennummer');
      eq(S.DB.board._global.all[uidA].g, 340.5, 'weltweit'); eq(S.DB.board._global.all[uidA].l, undefined, 'weltweit ohne Lieferungen');
      // nichts Neues: kein Schreiben
      eq((await A.L.board.submit(CK, st1)).length, 0, 'unverändert: nichts geschrieben');
      // niedrigere Werte: nichts geschrieben, Höchstwert bleibt
      eq((await A.L.board.submit(CK, { city: 'Essen', l: 12, r: 3, g: { all: 300, day: 300, week: 300 } })).length, 0, 'niedriger: nichts geschrieben');
      const d2 = await A.L.board.submit(CK, { city: 'Essen', l: 15, r: 3, g: { all: 300, day: 300, week: 300 } });
      eq(d2.length, 1, 'mehr Lieferungen: nur die Gesamtliste wird aktualisiert'); const S2 = await stateOf(); eq(S2.DB.board[CK].all[uidA].g, 340.5, 'Höchstwert Wachstum bleibt'); eq(S2.DB.board[CK].all[uidA].l, 15, 'Lieferungen steigen'); eq(S2.DB.board[CK].all[uidA].r, 3, 'Ruf aktuell');
      const d3 = await A.L.board.submit(CK, { city: 'Essen', l: 20, r: 4, g: { all: 360, day: 360, week: 360 } }); eq(d3.length, 6, 'neuer Höchstwert: Stadt und weltweit'); 
      ok(!(await stateOf()).LOG.some(x => /Regelfehler/.test(x)), 'keine Regelfehler im Nachbau: ' + (await stateOf()).LOG.join(' | '));
    }
    // Regeln der Rangliste direkt prüfen (Angriffe)
    { const pD = A.L.world.period('day'), base = { n: 'Tim Express', c: 'Essen', g: 100, l: 3, r: 4, p: 0, t: { '.sv': 'timestamp' } };
      const put = (L, path, e) => L._db('PUT', path, e);
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidA, base), 'PERMISSION_DENIED', 'fremden Eintrag schreiben');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, base), 'PERMISSION_DENIED', 'fremden Namen eintragen');
      const b2 = Object.assign({}, base, { n: 'Zoe' });
      await put(B.L, 'board/' + CK + '/all/' + uidB, b2); ok(true, 'eigener Eintrag mit eigenem Namen ok');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { g: 50 })), 'PERMISSION_DENIED', 'Wachstum darf nicht sinken');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { g: 1e6 })), 'PERMISSION_DENIED', 'unplausibler Sprung');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { g: -1 })), 'PERMISSION_DENIED', 'negatives Wachstum');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { t: 5 })), 'PERMISSION_DENIED', 'falscher Zeitstempel');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { p: 1 })), 'PERMISSION_DENIED', 'Gesamt hat Zeitraum 0');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { x: 1 })), 'PERMISSION_DENIED', 'unbekanntes Feld');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { r: 6 })), 'PERMISSION_DENIED', 'Ruf über 5');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { l: 2.5 })), 'PERMISSION_DENIED', 'Lieferungen ganzzahlig');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { l: 100000 })), 'PERMISSION_DENIED', 'unplausibel viele Lieferungen');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { l: 1 })), 'PERMISSION_DENIED', 'Lieferungen dürfen nicht sinken');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { c: 'x'.repeat(41) })), 'PERMISSION_DENIED', 'Stadtname zu lang');
      const bn = Object.assign({}, b2); delete bn.g; await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, bn), 'PERMISSION_DENIED', 'ohne Wachstum');
      await rejects(put(B.L, 'board/' + CK + '/year/' + uidB, b2), 'PERMISSION_DENIED', 'unbekannter Zeitraum');
      await rejects(put(B.L, 'board/ab/all/' + uidB, b2), 'PERMISSION_DENIED', 'Stadtschlüssel zu kurz');
      await rejects(put(B.L, 'board/' + CK + '/day/' + uidB, Object.assign({}, b2, { p: pD + 1 })), 'PERMISSION_DENIED', 'Tag in der Zukunft');
      await rejects(put(B.L, 'board/' + CK + '/day/' + uidB, Object.assign({}, b2, { p: pD - 1 })), 'PERMISSION_DENIED', 'Tag in der Vergangenheit');
      await put(B.L, 'board/' + CK + '/day/' + uidB, Object.assign({}, b2, { p: pD })); ok(true, 'heutiger Tag ok');
      await rejects(put(B.L, 'board/' + CK + '/week/' + uidB, Object.assign({}, b2, { p: A.L.world.period('week') + 1 })), 'PERMISSION_DENIED', 'Woche in der Zukunft');
      await put(B.L, 'board/' + CK + '/week/' + uidB, Object.assign({}, b2, { p: A.L.world.period('week') })); ok(true, 'heutige Woche ok');
      // ein Konto ohne Profil darf nichts eintragen: Eintrag löschen darf nur der Besitzer
      await rejects(B.L._db('DELETE', 'board/' + CK + '/all/' + uidA), 'PERMISSION_DENIED', 'fremden Eintrag löschen');
      await rejects(B.L._db('GET', 'board/' + CK), 'PERMISSION_DENIED', 'Rangliste einer Stadt nicht am Stück ohne Zeitraum lesbar');
      // Sprünge im Wachstum: gemessen an der Zeit seit dem letzten Eintrag
      const cur = (await stateOf()).DB.board[CK].all[uidB];
      await put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { g: cur.g + 4000 })); ok(true, 'Zuwachs innerhalb der Grenze ok');
      await rejects(put(B.L, 'board/' + CK + '/all/' + uidB, Object.assign({}, b2, { g: cur.g + 4000 + 5200 })), 'PERMISSION_DENIED', 'Zuwachs über der Grenze');
      // neuer Zeitraum: Tageswert beginnt neu und darf kleiner sein
      await ctl('put', { path: 'board/' + CK + '/day/' + uidB, value: Object.assign({}, b2, { p: pD - 1, g: 4000, t: Date.now() - 86400000 }) });
      await put(B.L, 'board/' + CK + '/day/' + uidB, Object.assign({}, b2, { p: pD, g: 20 })); ok(true, 'neuer Tag beginnt neu');
      await rejects(put(B.L, 'board/' + CK + '/day/' + uidB, Object.assign({}, b2, { p: pD - 1, g: 20 })), 'PERMISSION_DENIED', 'Tag darf nicht zurückgehen');
    }

    // --- Rangliste: Lesen
    { await ctl('put', { path: 'board/' + CK + '/all/' + uidB, value: { n: 'Zoe', c: 'Essen', g: 100, l: 3, r: 4, p: 0, t: Date.now() } });
      await ctl('put', { path: 'board/' + CK + '/all/other1', value: { n: 'Alt', c: 'Essen', g: 900, l: 2, r: 5, p: 0, t: Date.now() } });
      await ctl('put', { path: 'board/' + CK + '/all/other2', value: { n: 'Mitte', c: 'Essen', g: 500, l: 80, r: 2, p: 0, t: Date.now() } });
      const top = await B.L.board.top(CK, 'all', 'g', 25); eq(top.map(x => x.name), ['Alt', 'Mitte', 'Tim Express', 'Zoe'], 'Gesamt nach Wachstum'); ok(top[0].uid === 'other1' && top[0].g === 900, 'Zeile enthält Werte');
      eq((await B.L.board.top(CK, 'all', 'l', 25)).map(x => x.name), ['Mitte', 'Tim Express', 'Zoe', 'Alt'], 'Gesamt nach Lieferungen'); eq((await B.L.board.top(CK, 'all', 'r', 25)).map(x => x.name), ['Alt', 'Tim Express', 'Zoe', 'Mitte'], 'Gesamt nach Ruf');
      eq((await B.L.board.top(CK, 'all', 'g', 2)).map(x => x.name), ['Alt', 'Mitte'], 'auf die besten begrenzt');
      const pD = A.L.world.period('day');
      await ctl('put', { path: 'board/' + CK + '/day/old1', value: { n: 'Gestern', c: 'Essen', g: 9999, p: pD - 1, t: Date.now() - 86400000 } });
      eq((await B.L.board.top(CK, 'day', 'g', 25)).map(x => x.name), ['Tim Express', 'Zoe'], 'Tag: nur der laufende Tag (' + JSON.stringify((await B.L.board.top(CK, 'day', 'g', 25)).map(x => x.name)) + ')');
      eq((await B.L.board.top(CK, 'week', 'g', 25)).map(x => x.name), ['Tim Express', 'Zoe'], 'Woche');
      eq((await B.L.board.top('_global', 'all', 'g', 25)).map(x => x.name), ['Tim Express'], 'weltweit');
      const rk = await B.L.board.rank(CK); eq([rk.rank, rk.total, rk.full], [4, 4, false], 'eigener Rang'); eq((await A.L.board.rank(CK)).rank, 3, 'Rang von A');
      eq((await A.L.board.rank('99_999_9_999')).rank, null, 'ohne Eintrag kein Rang');
      await rejects(client().L.board.top(CK, 'all', 'g'), 'NOT_SIGNED_IN', 'Lesen nur angemeldet');
    }

    // --- Unternehmen aufgeben und Konto löschen
    { await A.L.company.remove(CK);
      let S = await stateOf();
      ok(!S.DB.board[CK] || !S.DB.board[CK].all || !S.DB.board[CK].all[uidA], 'Stadt-Eintrag weg'); ok(!(S.DB.saves[uidA] && S.DB.saves[uidA]['o_' + CK]), 'Stand weg'); ok(!(S.DB.sessions && S.DB.sessions[uidA]), 'Sitzung weg');
      ok(!!S.DB.board._global.all[uidA], 'weltweiter Eintrag bleibt (Höchstwert)');
      const o = await A.L.company.open(CK); eq([o.prev, o.raw], [null, null], 'neues Unternehmen nach Löschen');
      await A.L.company.push(o.slot, o.sess, JSON.stringify({ v: 2, pad: 'z'.repeat(60) }), 'neu');
      await A.L.board.submit(CK, { city: 'Essen', l: 1, r: 3, g: { all: 10, day: 10, week: 10 } });
      S = await stateOf(); ok(!!S.DB.board[CK].all[uidA] && !!S.DB.board._global.all[uidA], 'Einträge vorhanden vor dem Löschen des Kontos');
      await A.L.deleteAccount('geheim123'); S = await stateOf();
      const left = []; (function walk(n, p) { if (n && typeof n === 'object') for (const k of Object.keys(n)) { if (k === uidA) left.push(p + '/' + k); walk(n[k], p + '/' + k); } })(S.DB, '');
      eq(left, [], 'nach dem Löschen bleibt nichts vom Konto (Rangliste, Sitzungen, Stände)');
      ok(S.DB.board[CK].all[uidB] && S.DB.board[CK].all.other1, 'Einträge anderer bleiben');
    }
    // --- Alte Regeln ohne Online-Teil: klare Meldung
    { const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase-rules.json'), 'utf8')); delete rules.rules.sessions; delete rules.rules.board;
      await ctl('rules', rules); const C = client(); await C.L.login('zoe@example.de', 'geheim123');
      await rejects(C.L.company.open('11_111_1_111'), 'RULES_ONLINE', 'ohne neue Regeln: klare Meldung beim Öffnen');
      await ctl('rules', JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase-rules.json'), 'utf8'))); }
    // --- Ohne Profil nichts
    { const C = client(); await C.L.login('zoe@example.de', 'geheim123'); const n = await stateOf(); ok(!n.LOG.some(x => /Regelfehler/.test(x)), 'keine Regelfehler: ' + n.LOG.join(' | ')); }
  } catch (e) { fail++; console.log('AUSNAHME', e && e.stack || e); }
  const S = await stateOf(); if (S.LOG.length) console.log('Mock-Log:\n  ' + S.LOG.slice(-8).join('\n  '));
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  srv.kill(); process.exit(fail ? 1 : 0);
})();
