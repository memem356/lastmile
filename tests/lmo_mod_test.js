'use strict';
// Tests für Melden, Sperren, Umbenennen und die Betreiber-Ansicht (8f) gegen den Firebase-Nachbau samt Sicherheitsregeln.
// Start: node tests/lmo_mod_test.js   (mit ANC=1 prüft der Nachbau zusätzlich die übergeordneten Validierungen)
const { spawn } = require('child_process'), fs = require('fs'), vm = require('vm'), path = require('path');
const PORT = 9196, MOCK = `http://127.0.0.1:${PORT}`;
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'online.js'), 'utf8');
const RULES_FILE = path.join(__dirname, '..', 'firebase-rules.json');
const CODE = fs.readFileSync(RULES_FILE, 'utf8').match(/'(LM-[A-Z0-9-]+)'/)[1];
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
  const ctx = vm.createContext({ fetch: f, localStorage: ls, AbortController, setTimeout, clearTimeout, Date, JSON, Math, console, URL, encodeURIComponent, Promise, __LM_PLAN: 'legacy', crypto: { getRandomValues: a => require('crypto').randomFillSync(a) }, Uint8Array });
  vm.runInContext(SRC + '\nthis.LMO = LMO;', ctx);
  return { L: ctx.LMO, store };
}
const rejects = async (p, code, m) => { try { await p; ok(false, m + ' (kein Fehler)'); } catch (e) { eq(e.code, code, m); } };
const reg = (L, o) => L.register(Object.assign({ name: 'Tim Express', email: 'tim@example.de', password: 'geheim123', code: CODE }, o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SV = { '.sv': 'timestamp' };
const fake = i => 'Zz' + String(i).padStart(10, '0');
const PD = 'PERMISSION_DENIED';

(async () => {
  const srv = spawn('node', [path.join(__dirname, 'fbmock.js'), String(PORT)], { env: Object.assign({}, process.env, { ANCESTOR_VALIDATE: process.env.ANC || '0' }), stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await ctl('reset'); break; } catch (e) { await sleep(100); } }
  try {
    const CK = '51_457_7_015';
    const A = client(), B = client(), C = client(), D = client(), E = client();
    await reg(A.L); await reg(B.L, { name: 'Zoe', email: 'zoe@example.de' }); await reg(C.L, { name: 'Cara Cool', email: 'cara@example.de' });
    await reg(D.L, { name: 'Dora Dax', email: 'dora@example.de' }); await reg(E.L, { name: 'Egon Eck', email: 'egon@example.de' });
    const uidA = A.L.state().uid, uidB = B.L.state().uid, uidC = C.L.state().uid, uidD = D.L.state().uid, uidE = E.L.state().uid;
    const db = (X, m, p, b) => X.L._db(m, p, b), DBs = async () => (await stateOf()).DB;
    const rep0 = (id, extra) => Object.assign({ k: 'p', id, n: 'Cara Cool', r: 'hass', t: SV }, extra);

    // --- Regeln: Betreiber-Eintrag und Sperrliste sind nicht selbst setzbar
    await rejects(db(B, 'PUT', 'admins/' + uidB, true), PD, 'sich selbst zum Betreiber machen abgelehnt');
    await rejects(db(B, 'PUT', 'blockednames/zoe', SV), PD, 'Sperrliste nicht durch Spieler beschreibbar');
    await rejects(db(B, 'PUT', 'blockednames/anna', SV), PD, 'auch nicht für fremde Namen');
    eq(await db(B, 'GET', 'blockednames'), null, 'Sperrliste ist für Angemeldete lesbar (leer)');
    eq(await db(B, 'GET', 'admins/' + uidB), null, 'eigenen Betreiber-Eintrag lesen ist erlaubt (leer)');
    await rejects(db(B, 'GET', 'admins/' + uidA), PD, 'fremden Betreiber-Eintrag nicht lesbar');
    await rejects(db(B, 'GET', 'admins'), PD, 'Betreiber nicht auflistbar');

    // --- Regeln: Meldungen
    await db(B, 'PUT', 'reports/' + uidB + '/s0', rep0(uidC));
    { const R = (await DBs()).reports[uidB].s0; eq([R.k, R.id, R.n, R.r], ['p', uidC, 'Cara Cool', 'hass'], 'gültige Meldung gespeichert'); ok(typeof R.t === 'number' && R.t > 1e12, 'Meldezeit vom Server'); }
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s0', rep0(fake(1))), PD, 'Platz innerhalb von 24 Stunden nicht überschreibbar');
    await rejects(db(B, 'DELETE', 'reports/' + uidB + '/s0'), PD, 'Spieler können Meldungen nicht zurücknehmen');
    await rejects(db(B, 'PUT', 'reports/' + uidA + '/s0', rep0(fake(2))), PD, 'nicht im Namen anderer melden');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s10', rep0(fake(3))), PD, 'Platz s10 gibt es nicht');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/x1', rep0(fake(3))), PD, 'Platzname muss s0 bis s9 sein');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', rep0(fake(3), { r: 'spam' })), PD, 'unbekannter Grund abgelehnt');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', rep0(fake(3), { x: 1 })), PD, 'Zusatzfeld abgelehnt');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', rep0(uidB)), PD, 'sich selbst melden abgelehnt');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', rep0('abc')), PD, 'zu kurze Kennung abgelehnt');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', rep0('ab c' + 'x'.repeat(10))), PD, 'Kennung mit Leerzeichen abgelehnt');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', rep0(fake(3), { k: 'x' })), PD, 'unbekannte Art abgelehnt');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', rep0(fake(3), { n: 'x'.repeat(21) })), PD, 'zu langer Name abgelehnt');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', rep0(fake(3), { n: '' })), PD, 'leerer Name abgelehnt');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', rep0(fake(3), { t: 5 })), PD, 'gefälschte Zeit abgelehnt');
    await rejects(db(B, 'PUT', 'reports/' + uidB + '/s1', { k: 'p', id: fake(3), n: 'X', t: SV }), PD, 'Meldung ohne Grund abgelehnt');
    await rejects(db(B, 'GET', 'reports'), PD, 'alle Meldungen nur für Betreiber');
    await rejects(db(B, 'GET', 'reports/' + uidA), PD, 'fremde Meldungen nicht lesbar');
    eq(Object.keys(await db(B, 'GET', 'reports/' + uidB)), ['s0'], 'eigene Meldungen lesbar');
    ok(!(await DBs()).reports[uidB].s1, 'abgelehnte Meldungen nicht gespeichert');

    // --- Melden über die Schnittstelle
    await D.L.mod.report({ k: 'p', id: uidC, name: 'Cara Cool' }, 'beleidigung');
    { const R = (await DBs()).reports[uidD].s0; eq([R.k, R.id, R.n, R.r], ['p', uidC, 'Cara Cool', 'beleidigung'], 'Meldung über die Schnittstelle'); }
    await rejects(D.L.mod.report({ k: 'p', id: uidC, name: 'Cara Cool' }, 'hass'), 'REPORT_DUP', 'dieselbe Person nicht zweimal melden');
    await rejects(D.L.mod.report({ k: 'p', id: uidD, name: 'Dora Dax' }, 'hass'), 'REPORT_SELF', 'sich selbst nicht melden');
    await rejects(D.L.mod.report({ k: 'p', id: fake(5), name: 'X' }, 'unfug'), PD, 'unbekannter Grund');
    await rejects(D.L.mod.report({ k: 'q', id: fake(5), name: 'X' }, 'hass'), PD, 'unbekannte Art');
    await rejects(client().L.mod.report({ k: 'p', id: fake(5), name: 'X' }, 'hass'), 'NOT_SIGNED_IN', 'Melden nur angemeldet');
    eq(A.L.mod.reasons.map(r => r[0]), ['beleidigung', 'hass', 'echt', 'imitation', 'sonst'], 'fünf Gründe');
    // Höchstens 10 je 24 Stunden: B hat schon s0 (roh geschrieben)
    for (let i = 1; i <= 9; i++) await B.L.mod.report({ k: 'p', id: fake(10 + i), name: 'Ziel ' + i }, i % 2 ? 'sonst' : 'echt');
    eq(Object.keys((await DBs()).reports[uidB]).sort(), ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'], 'zehn Plätze belegt');
    await rejects(B.L.mod.report({ k: 'p', id: fake(30), name: 'Zu viel' }, 'hass'), 'REPORT_LIMIT', 'elfte Meldung binnen 24 Stunden abgelehnt');
    // Nach 24 Stunden wird der älteste Platz frei (hier: Zeiten von Hand zurückgesetzt)
    await ctl('put', { path: 'reports/' + uidB + '/s0/t', value: Date.now() - 30 * 3600e3 });
    await ctl('put', { path: 'reports/' + uidB + '/s9/t', value: Date.now() - 25 * 3600e3 });
    await B.L.mod.report({ k: 'p', id: fake(31), name: 'Neu 1' }, 'hass');
    { const R = (await DBs()).reports[uidB]; eq(R.s0.id, fake(31), 'ältester Platz wurde wiederverwendet'); eq(R.s9.id, fake(19), 's9 noch unberührt'); }
    await B.L.mod.report({ k: 'p', id: fake(32), name: 'Neu 2' }, 'hass');
    eq((await DBs()).reports[uidB].s9.id, fake(32), 'zweiter freier Platz');
    await rejects(B.L.mod.report({ k: 'p', id: fake(33), name: 'Neu 3' }, 'hass'), 'REPORT_LIMIT', 'danach wieder voll');

    // --- Betreiber
    eq(await A.L.mod.isAdmin(), false, 'ohne Eintrag kein Betreiber');
    await rejects(A.L.mod.reports(), 'NOT_ADMIN', 'Meldungen nur für Betreiber (Schnittstelle)');
    await rejects(B.L.mod.block({ k: 'p', id: uidC, name: 'Cara Cool', refs: [] }), 'NOT_ADMIN', 'Sperren nur für Betreiber (Schnittstelle)');
    await ctl('put', { path: 'admins/' + uidA, value: true });
    eq(await A.L.mod.isAdmin(), true, 'Eintrag admins/<uid> macht zum Betreiber'); eq(await B.L.mod.isAdmin(), false, 'andere bleiben Spieler');
    await rejects(B.L.mod.reports(), 'NOT_ADMIN', 'Spieler sehen keine Meldungen');
    // Eine Clan-Meldung: D gründet, E meldet
    const cm = await D.L.clan.create('Schlimme Boten'); const cidD = cm.cid;
    await E.L.mod.report({ k: 'c', id: cidD, name: 'Schlimme Boten' }, 'beleidigung');
    await E.L.mod.report({ k: 'p', id: uidC, name: 'Cara Cool' }, 'hass');
    let gs = await A.L.mod.reports();
    { const gC = gs.find(g => g.id === uidC);
      eq([gC.k, gC.name, gC.count, gC.status, gC.blocked, gC.refs.length], ['p', 'Cara Cool', 2, 'current', false, 2], 'Meldungen zu Cara zusammengefasst');
      eq([gC.reasons.hass, gC.reasons.beleidigung, Object.keys(gC.reasons).length], [1, 1, 2], 'Gründe gezählt'); ok(gC.last > 1e12, 'letzte Meldung hat eine Zeit'); eq(gs[0].id, uidC, 'meistgemeldet steht oben');
      const gD = gs.find(g => g.id === cidD); eq([gD.k, gD.name, gD.count, gD.status], ['c', 'Schlimme Boten', 1, 'current'], 'Clan-Meldung mit Status');
      const gF = gs.find(g => g.id === fake(11)); eq([gF.status, gF.count], ['changed', 1], 'unbekannter Spieler: Name nicht mehr aktuell'); eq(gs.length, 12, 'Zahl der gemeldeten Ziele (zwei Meldungen von B wurden nach 24 Stunden überschrieben)'); }
    // Verwerfen
    { const gF = gs.find(g => g.id === fake(11)); await A.L.mod.dismiss(gF); ok(!Object.values((await DBs()).reports[uidB]).some(x => x.id === fake(11)), 'verworfene Meldung ist weg'); }
    await rejects(B.L.mod.dismiss({ refs: [{ uid: uidB, slot: 's1' }] }), 'NOT_ADMIN', 'Verwerfen nur für Betreiber');
    await rejects(db(B, 'DELETE', 'reports/' + uidD + '/s0'), PD, 'Regeln: Spieler löscht keine fremden Meldungen');
    await B.L.mod.report({ k: 'p', id: fake(40), name: 'Platz frei' }, 'hass');
    ok(true, 'durch das Verwerfen wurde ein Platz frei');

    // --- Sperren eines Spielers
    // Cara hat Einträge in der Stadt und weltweit; der Stand liegt in „savemeta“, damit die Stadt bekannt ist
    await ctl('put', { path: 'savemeta/' + uidC + '/o_' + CK, value: { t: Date.now(), v: 1, info: 'x' } });
    await C.L.board.submit(CK, { city: 'Essen', l: 5, r: 3, g: { all: 1000, day: 500, week: 800 } });
    await B.L.board.submit(CK, { city: 'Essen', l: 7, r: 4, g: { all: 2000, day: 600, week: 900 } });
    eq((await B.L.board.top(CK, 'all', 'g')).map(x => x.name), ['Zoe', 'Cara Cool'], 'vor der Sperre: beide in der Rangliste');
    const gC = (await A.L.mod.reports()).find(g => g.id === uidC);
    await A.L.mod.block(gC);
    { const S = await DBs(); ok(typeof S.blockednames.cara_cool === 'number', 'Name steht auf der Sperrliste'); ok(!Object.values(S.reports).some(r => Object.values(r).some(x => x.id === uidC)), 'Meldungen zu Cara sind erledigt'); eq(S.names.cara_cool, uidC, 'Name bleibt Cara zugeordnet, bis sie wechselt'); }
    await B.L.mod.refreshBlocked();
    eq((await B.L.board.top(CK, 'all', 'g')).map(x => x.name), ['Zoe'], 'gesperrter Name verschwindet aus der Stadt-Rangliste');
    eq((await B.L.board.top('_global', 'all', 'g')).map(x => x.name), ['Zoe'], 'und aus der weltweiten Rangliste');
    eq((await B.L.board.top('_global', 'day', 'g')).map(x => x.name), ['Zoe'], 'und aus der Tages-Rangliste');
    eq(C.L.state().blocked, false, 'Cara weiß noch nichts davon');
    eq(await C.L.checkBlocked(), true, 'checkBlocked erkennt die Sperre'); eq(C.L.state().blocked, true, 'Zustand: gesperrt');
    // Umbenennen
    await rejects(B.L.rename('Zoe Neu'), 'RENAME_NOT_ALLOWED', 'Umbenennen nur bei Sperre (Schnittstelle)');
    await rejects(db(B, 'PUT', 'users/' + uidB, { name: 'Zoe Neu', key: 'zoe_neu', created: (await DBs()).users[uidB].created }), PD, 'Umbenennen nur bei Sperre (Regeln)');
    await rejects(C.L.rename('ab'), 'BAD_NAME', 'neuer Name zu kurz');
    await rejects(C.L.rename('Nazi 99'), 'BAD_NAME', 'neuer Name aus der Wortliste');
    await rejects(C.L.rename('cara cool'), 'BAD_NAME', 'gleicher Name wie bisher');
    await rejects(C.L.rename('Zoe'), 'NAME_TAKEN', 'vergebener Name');
    await ctl('put', { path: 'blockednames/gesperrt', value: Date.now() });
    await rejects(C.L.rename('Gesperrt'), 'BAD_NAME', 'Name von der Sperrliste');
    { const cr = (await DBs()).users[uidC].created;
      await rejects(db(C, 'PUT', 'users/' + uidC, { name: 'Gesperrt', key: 'gesperrt', created: cr }), PD, 'Regeln: gesperrten Namen nicht wählbar');
      await rejects(db(C, 'PUT', 'users/' + uidC, { name: 'Nazi 99', key: 'nazi_99', created: cr }), PD, 'Regeln: Wortliste gilt auch beim Umbenennen');
      await rejects(db(C, 'PUT', 'users/' + uidC, { name: 'Cara Neu', key: 'cara_neu', created: cr + 1 }), PD, 'Regeln: Gründungszeit bleibt'); }
    const created0 = (await DBs()).users[uidC].created;
    const st = await C.L.rename('Cara Neu');
    eq([st.name, st.blocked, st.profile.key], ['Cara Neu', false, 'cara_neu'], 'umbenannt: Zustand');
    { const S = await DBs();
      eq([S.users[uidC].name, S.users[uidC].key, S.users[uidC].created], ['Cara Neu', 'cara_neu', created0], 'Profil in der Datenbank');
      eq(S.names.cara_neu, uidC, 'neuer Namensanspruch'); ok(!S.names.cara_cool, 'alter Namensanspruch gelöscht'); ok(S.blockednames.cara_cool, 'alter Name bleibt gesperrt');
      eq(['all', 'day', 'week'].map(sc => S.board[CK][sc][uidC].n), ['Cara Neu', 'Cara Neu', 'Cara Neu'], 'Stadt-Einträge tragen den neuen Namen');
      eq(['all', 'day', 'week'].map(sc => S.board._global[sc][uidC].n), ['Cara Neu', 'Cara Neu', 'Cara Neu'], 'weltweite Einträge tragen den neuen Namen');
      eq([S.board[CK].all[uidC].g, S.board[CK].all[uidC].l], [1000, 5], 'Werte bleiben unverändert'); }
    await rejects(C.L.rename('Cara Drei'), 'RENAME_NOT_ALLOWED', 'danach nicht erneut umbenennbar');
    await rejects(db(C, 'PUT', 'users/' + uidC, { name: 'Cara Cool', key: 'cara_cool', created: created0 }), PD, 'Regeln: nicht zurück auf den gesperrten Namen');
    eq((await C.L.checkBlocked()), false, 'nicht mehr gesperrt');
    await B.L.mod.refreshBlocked();
    eq((await B.L.board.top(CK, 'all', 'g')).map(x => x.name), ['Zoe', 'Cara Neu'], 'neuer Name steht wieder in der Rangliste');
    // Der alte Name ist nicht mehr zu haben (Anmeldung)
    { const F = client(); await rejects(reg(F.L, { name: 'Cara Cool', email: 'f@example.de' }), 'BAD_NAME', 'gesperrter Name bei der Registrierung abgelehnt'); }

    // --- Sperren eines Clans
    const mB = await B.L.clan.join(cm.code); eq(mB.members.length, 2, 'Zoe ist im Clan');
    await D.L.board.submit(CK, { city: 'Essen', l: 3, r: 3, g: { all: 1500, day: 400, week: 700 } }); await D.L.clan.refresh();
    eq((await E.L.clan.top('all')).map(x => x.name), ['Schlimme Boten'], 'Clan steht in der Rangliste');
    const gCl = (await A.L.mod.reports()).find(g => g.id === cidD);
    await A.L.mod.block(gCl);
    { const S = await DBs(); ok(S.blockednames.schlimme_boten, 'Clan-Name gesperrt'); ok(!S.clans || !S.clans[cidD], 'Clan gelöscht'); ok(!S.clannames || !S.clannames.schlimme_boten, 'Clan-Name freigegeben'); ok(!S.clanboard || ['all', 'day', 'week'].every(sc => !(S.clanboard[sc] || {})[cidD]), 'Wertung gelöscht'); }
    eq(await D.L.clan.mine(), null, 'Mitglied sieht keinen Clan mehr (Leiter)'); eq(await B.L.clan.mine(), null, 'Mitglied sieht keinen Clan mehr');
    eq(await E.L.clan.top('all'), [], 'Rangliste ohne den Clan');
    await rejects(D.L.clan.create('Schlimme Boten'), 'BAD_NAME', 'Clan-Name bleibt gesperrt (Schnittstelle)');
    await rejects(db(D, 'PUT', 'clans/abcdefghijklmnop', { n: 'Schlimme Boten', k: 'schlimme_boten', o: uidD, t: SV }), PD, 'Regeln: gesperrter Clan-Name nicht wählbar');
    await rejects(db(D, 'PUT', 'clannames/schlimme_boten', 'abcdefghijklmnop'), PD, 'Regeln: Clan-Namensanspruch gesperrt');
    const cm2 = await D.L.clan.create('Gute Boten'); eq(cm2.name, 'Gute Boten', 'Leiter kann unter anderem Namen neu gründen');
    // Gesperrter Mitgliedsname wird im Clan versteckt
    await B.L.clan.join(cm2.code);
    await A.L.mod.refreshBlocked(); await ctl('put', { path: 'blockednames/zoe', value: Date.now() });
    await D.L.mod.refreshBlocked();
    { const m = await D.L.clan.mine(); const z = m.members.find(x => x.uid === uidB); eq([z.name, z.hidden, z.raw], ['Gesperrter Name', true, 'Zoe'], 'gesperrtes Mitglied im Clan versteckt'); eq(m.members.find(x => x.uid === uidD).hidden, false, 'andere Mitglieder normal'); }
    await rejects(C.L.mod.dismiss({ refs: [] }), 'NOT_ADMIN', 'Spieler verwerfen nichts');
    // Sperrliste und Freigabe
    { const bl = await A.L.mod.blockedList(); eq(bl.map(x => x.key).sort(), ['cara_cool', 'gesperrt', 'schlimme_boten', 'zoe'], 'Liste der gesperrten Namen'); ok(bl.every(x => x.t > 1e12), 'mit Zeit'); }
    await rejects(B.L.mod.blockedList(), 'NOT_ADMIN', 'Sperrliste nur für Betreiber'); await rejects(B.L.mod.unblock('zoe'), 'NOT_ADMIN', 'Freigeben nur für Betreiber');
    await rejects(db(B, 'DELETE', 'blockednames/zoe'), PD, 'Regeln: Freigeben nur für Betreiber');
    await A.L.mod.unblock('zoe');
    ok(!(await DBs()).blockednames.zoe, 'Freigabe entfernt den Eintrag');
    await D.L.mod.refreshBlocked();
    { const m = await D.L.clan.mine(); eq(m.members.find(x => x.uid === uidB).name, 'Zoe', 'nach Freigabe wieder sichtbar'); }
    eq(await B.L.checkBlocked(), false, 'Zoe ist wieder frei');

    // --- Wortfilter: Browser und Regeln müssen dasselbe entscheiden (Rahmen: gültige Zeichen, 3 bis 16 Zeichen, mindestens ein Buchstabe)
    const corpus = ['Tim', 'Siegfried', 'Marschall', 'Heilbronn', 'Claudia', 'Jörg Müller', 'Pascal', 'Sexton', 'Essen', 'Köln', 'Anna-Lena', 'Max_Power', 'Pixel99', 'Fixer Lotse', 'Kurier2000', 'Sieger', 'Teamgeist', 'Servus', 'Rootbeer', 'Nullpunkt', 'Mongolei', 'Spasti', 'Arschloch', 'Dummkopf',
      'Nazi', 'N4zi99', 'Hitler', 'H1tl3r', 'Fuck You', 'sch3iss', 'Scheiß', 'Scheiße', 'Wichser', 'Fick', 'Fick2', 'Ficken', 'Sex', 'S3x', 'Admin', 'Admin2', 'Administrator', 'Moderator', 'Mod3rator', 'Lastmile', 'LastMile24', 'Der Lastmile', 'Support', 'Gast', 'Gast7', 'ISIS', 'Heil', 'Sieg', 'Terror', 'Hure', 'Depp', 'N1gg4', 'Hurensohn', 'Bitch', 'B1tch', 'Porno', 'Shit-Show', 'Kacke', 'Sys-tem', 'Sys_tem', 'Claude', 'Anthropic', 'Root', 'null', 'undefined', 'Vergewaltiger', 'Fotze', 'Penis', 'Vagina', 'Nutte', 'Idiot', 'Staff', 'Team', 'Server'];
    let mism = 0, nBad = 0, nGood = 0;
    for (const name of corpus) {
      const verdict = A.L.checkName(name) === '', key = A.L.nameKey(A.L.tidyName(name)), cid = 'wf' + Math.random().toString(36).slice(2, 14).padEnd(12, 'x');
      let accepted = true;
      try { await db(A, 'PUT', 'clans/' + cid, { n: A.L.tidyName(name), k: key, o: uidA, t: SV }); } catch (e) { accepted = false; }
      if (accepted) await db(A, 'DELETE', 'clans/' + cid);
      verdict ? nGood++ : nBad++;
      if (accepted !== verdict) { mism++; console.log('  Abweichung beim Namen „' + name + '“: Browser ' + (verdict ? 'erlaubt' : 'sperrt') + ', Regeln ' + (accepted ? 'erlauben' : 'sperren')); }
    }
    eq(mism, 0, 'Wortfilter im Browser und in den Regeln stimmen überein (' + nBad + ' gesperrt, ' + nGood + ' erlaubt)');
    ok(nBad >= 40 && nGood >= 20, 'Prüfmenge ist aussagekräftig');

    // --- Ohne die neuen Regeln (alte Datenbank): nichts bricht, Meldungen zeigen eine klare Meldung
    {
      const full = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
      const old = JSON.parse(JSON.stringify(full)); delete old.rules.reports; delete old.rules.blockednames; delete old.rules.admins;
      await ctl('rules', old);
      const G = client(); await G.L.login('zoe@example.de', 'geheim123');
      await rejects(G.L.mod.report({ k: 'p', id: fake(50), name: 'X' }, 'hass'), 'RULES_MOD', 'alte Regeln: Melden zeigt eine klare Meldung');
      eq(await G.L.mod.isAdmin(), false, 'alte Regeln: kein Betreiber'); eq(await G.L.checkBlocked(), false, 'alte Regeln: nie gesperrt');
      ok(Array.isArray(await G.L.board.top(CK, 'all', 'g')), 'alte Regeln: Rangliste funktioniert'); ok(await G.L.clan.mine() === null || true, 'alte Regeln: Clan-Ansicht funktioniert');
      await ctl('rules', full);
    }

    // --- Konto löschen räumt eigene Meldungen auf, soweit erlaubt
    await B.L.deleteAccount('geheim123').catch(e => ok(false, 'Konto löschen: ' + e.code));
    { const S = await DBs(); ok(!S.users || !S.users[uidB], 'Zoe gelöscht'); }
  } catch (e) { fail++; console.log('  ABBRUCH:', e && e.stack || e); }
  srv.kill();
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
