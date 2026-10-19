'use strict';
// Tests der Clans (gründen, beitreten, Wertung, Regeln) gegen den Firebase-Nachbau samt Sicherheitsregeln.
// Start: node tests/lmo_clan_test.js
const { spawn } = require('child_process'), fs = require('fs'), vm = require('vm'), path = require('path');
const PORT = 9197, MOCK = `http://127.0.0.1:${PORT}`;
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

(async () => {
  const srv = spawn('node', [path.join(__dirname, 'fbmock.js'), String(PORT)], { env: Object.assign({}, process.env, { ANCESTOR_VALIDATE: process.env.ANC || '0' }), stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await ctl('reset'); break; } catch (e) { await sleep(100); } }
  try {
    const CK = '51_457_7_015';
    const A = client(), B = client(), C = client();
    await reg(A.L); await reg(B.L, { name: 'Zoe', email: 'zoe@example.de' }); await reg(C.L, { name: 'Cara Cool', email: 'cara@example.de' });
    const uidA = A.L.state().uid, uidB = B.L.state().uid, uidC = C.L.state().uid;
    const K = A.L.clan, db = (X, m, p, b) => X.L._db(m, p, b);
    const pDay = A.L.world.period('day'), pWeek = A.L.world.period('week');

    // --- Ohne Clan
    eq(await K.mine(), null, 'ohne Clan: mine ist leer'); eq(await K.refresh(), null, 'ohne Clan: nichts zu aktualisieren');
    await rejects(client().L.clan.mine(), 'NOT_SIGNED_IN', 'Clans nur angemeldet');
    eq(K.fmtCode('ABCDEFGH'), 'CL-ABCD-EFGH', 'Code wird gruppiert angezeigt');

    // --- Gründen
    await rejects(K.create('ab'), 'BAD_NAME', 'Clan-Name zu kurz');
    await rejects(K.create('Nazi Clan'), 'BAD_NAME', 'Clan-Name aus der Sperrliste');
    await rejects(K.create('Lastmile Team'), 'BAD_NAME', 'reservierter Clan-Name');
    const m1 = await K.create('Die Boten');
    eq([m1.name, m1.isOwner, m1.members.length, m1.cap], ['Die Boten', true, 1, 12], 'Clan gegründet'); ok(/^[A-Z2-9]{8}$/.test(m1.code), 'Code hat 8 Zeichen: ' + m1.code);
    const cid = m1.cid, code1 = m1.code;
    { const S = await stateOf();
      eq(S.DB.clans[cid].n, 'Die Boten', 'clans/<id>: Name'); eq([S.DB.clans[cid].o, S.DB.clans[cid].k], [uidA, 'die_boten'], 'clans/<id>: Leiter und Schlüssel'); ok(typeof S.DB.clans[cid].t === 'number', 'Gründungszeit');
      eq(S.DB.clannames.die_boten, cid, 'Namensanspruch'); eq(S.DB.clansecret[cid], code1, 'Code geheim hinterlegt'); eq(S.DB.clancodes[code1], cid, 'Code verweist auf den Clan');
      eq(S.DB.clanof[uidA], cid, 'Zeiger auf den eigenen Clan'); eq([S.DB.members[cid][uidA].n, S.DB.members[cid][uidA].k], ['Tim Express', code1], 'Leiter ist Mitglied'); }
    await rejects(K.create('Andere Boten'), 'CLAN_HAVE', 'zweiter Clan nicht möglich');
    await rejects(B.L.clan.create('DIE BOTEN'), 'CLAN_NAME_TAKEN', 'Clan-Name schon vergeben (Groß/Klein egal)');
    eq(await B.L.clan.mine(), null, 'fehlgeschlagenes Gründen hinterlässt nichts'); { const S = await stateOf(); eq(Object.keys(S.DB.clans), [cid], 'nur ein Clan'); eq(S.DB.clanof[uidB], undefined, 'kein Zeiger bei B'); }

    // --- Beitrag und Wertung
    await A.L.board.submit(CK, { city: 'Essen', l: 5, r: 3, g: { all: 400, day: 300, week: 350 } });
    await B.L.board.submit(CK, { city: 'Essen', l: 2, r: 3, g: { all: 250, day: 100, week: 200 } });
    { const r = await K.refresh();
      eq([r.total.all, r.total.day, r.total.week, r.count], [400, 300, 350, 1], 'Wertung mit einem Mitglied'); ok(!r.err, 'kein Fehler beim Schreiben');
      const S = await stateOf(), e = S.DB.members[cid][uidA];
      eq([e.a, e.d, e.pd, e.w, e.pw], [400, 300, pDay, 350, pWeek], 'Beitrag des Mitglieds übernommen');
      eq([S.DB.clanboard.all[cid].g, S.DB.clanboard.all[cid].m, S.DB.clanboard.all[cid].p, S.DB.clanboard.all[cid].n], [400, 1, 0, 'Die Boten'], 'Wertung Gesamt'); eq([S.DB.clanboard.day[cid].g, S.DB.clanboard.day[cid].p], [300, pDay], 'Wertung Tag'); eq([S.DB.clanboard.week[cid].g, S.DB.clanboard.week[cid].p], [350, pWeek], 'Wertung Woche');
      ok(typeof S.DB.clanboard.all[cid].t === 'number', 'Wertung mit Serverzeit'); }
    { const n0 = (await stateOf()).COUNT.db; await K.refresh(); const n1 = (await stateOf()).COUNT.db; ok(n1 - n0 <= 7, 'unverändert: nur Lesezugriffe (' + (n1 - n0) + ')'); }

    // --- Beitreten
    await rejects(B.L.clan.join(''), 'CLAN_BAD_CODE', 'leerer Code'); await rejects(B.L.clan.join('XXX'), 'CLAN_BAD_CODE', 'zu kurzer Code'); await rejects(B.L.clan.join('CL-AAAA-BBBB'), 'CLAN_BAD_CODE', 'unbekannter Code');
    const typed = 'cl-' + code1.slice(0, 4).toLowerCase() + ' ' + code1.slice(4).toLowerCase();
    const m2 = await B.L.clan.join(typed);
    eq([m2.name, m2.isOwner, m2.members.map(x => x.name)], ['Die Boten', false, ['Tim Express', 'Zoe']], 'B ist beigetreten (Code in Kleinbuchstaben mit Trennzeichen)'); eq(m2.code, code1, 'Mitglied sieht den Code');
    await rejects(B.L.clan.join(code1), 'CLAN_HAVE', 'doppelt beitreten');
    { const r = await B.L.clan.refresh(); eq([r.total.all, r.total.day, r.total.week, r.count], [650, 400, 550, 2], 'Wertung mit zwei Mitgliedern');
      eq(r.rows.map(x => [x.name, x.all, x.owner]), [['Tim Express', 400, true], ['Zoe', 250, false]], 'Zeilen sortiert nach Gesamt');
      const S = await stateOf(); eq(S.DB.clanboard.all[cid].g, 650, 'Wertung in der Datenbank'); eq(S.DB.clanboard.all[cid].m, 2, 'Mitgliederzahl'); }

    // --- Clan-Rangliste (auch für Außenstehende lesbar)
    { const p2 = 'zzzz1234abcd5678';
      await ctl('put', { path: 'clanboard/all/' + p2, value: { n: 'Riesen', g: 5000, m: 3, p: 0, t: Date.now() } });
      await ctl('put', { path: 'clanboard/day/' + p2, value: { n: 'Riesen', g: 4000, m: 3, p: pDay, t: Date.now() } });
      await ctl('put', { path: 'clanboard/day/old1', value: { n: 'Gestern', g: 9999, m: 3, p: pDay - 1, t: Date.now() } });
      eq((await C.L.clan.top('all')).map(x => [x.name, x.g, x.m]), [['Riesen', 5000, 3], ['Die Boten', 650, 2]], 'Clan-Rangliste Gesamt');
      eq((await C.L.clan.top('day')).map(x => x.name), ['Riesen', 'Die Boten'], 'Clan-Rangliste nur laufender Tag'); eq((await C.L.clan.top('week')).map(x => x.name), ['Die Boten'], 'Clan-Rangliste Woche');
      eq((await C.L.clan.top('all', 1)).map(x => x.name), ['Riesen'], 'auf die besten begrenzt');
      await ctl('put', { path: 'clanboard/all/' + p2, value: null }); await ctl('put', { path: 'clanboard/day/' + p2, value: null }); await ctl('put', { path: 'clanboard/day/old1', value: null }); }

    // --- Was Außenstehende nicht dürfen
    { await rejects(db(C, 'GET', 'members/' + cid), 'PERMISSION_DENIED', 'Mitgliederliste nur für Mitglieder'); await rejects(db(C, 'GET', 'clansecret/' + cid), 'PERMISSION_DENIED', 'Code nur für Mitglieder');
      await rejects(db(C, 'GET', 'clans'), 'PERMISSION_DENIED', 'Clans nicht auflistbar'); await rejects(db(C, 'GET', 'clancodes'), 'PERMISSION_DENIED', 'Codes nicht auflistbar'); await rejects(db(C, 'GET', 'clannames'), 'PERMISSION_DENIED', 'Namen nicht auflistbar');
      eq((await db(C, 'GET', 'clans/' + cid)).n, 'Die Boten', 'Clan-Name ist mit der Id lesbar');
      const mem = { n: 'Cara Cool', t: SV, k: code1 };
      await rejects(db(C, 'PUT', 'members/' + cid + '/' + uidC, mem), 'PERMISSION_DENIED', 'Beitritt ohne Zeiger abgelehnt');
      await db(C, 'PUT', 'clanof/' + uidC, cid); ok(true, 'Zeiger setzen geht');
      await rejects(db(C, 'PUT', 'members/' + cid + '/' + uidC, Object.assign({}, mem, { k: 'AAAAAAAA' })), 'PERMISSION_DENIED', 'Beitritt mit falschem Code abgelehnt');
      await rejects(db(C, 'PUT', 'members/' + cid + '/' + uidC, { n: 'Cara Cool', t: SV }), 'PERMISSION_DENIED', 'Beitritt ohne Code abgelehnt');
      await rejects(db(C, 'PUT', 'members/' + cid + '/' + uidC, Object.assign({}, mem, { n: 'Tim Express' })), 'PERMISSION_DENIED', 'Beitritt unter fremdem Namen abgelehnt');
      await rejects(db(C, 'PUT', 'members/' + cid + '/' + uidB, mem), 'PERMISSION_DENIED', 'niemand anderen anmelden');
      await rejects(db(C, 'PUT', 'members/' + cid + '/' + uidC, Object.assign({}, mem, { a: 5 })), 'PERMISSION_DENIED', 'Beitrag ohne Ranglisteneintrag abgelehnt');
      await db(C, 'DELETE', 'clanof/' + uidC); ok(true, 'Zeiger ohne Mitgliedschaft wieder löschbar');
      await rejects(db(C, 'PUT', 'clanof/' + uidB, cid), 'PERMISSION_DENIED', 'fremden Zeiger setzen');
      await rejects(db(C, 'GET', 'clanof/' + uidB), 'PERMISSION_DENIED', 'fremden Zeiger lesen');
      await rejects(db(C, 'DELETE', 'clans/' + cid), 'PERMISSION_DENIED', 'fremden Clan löschen'); await rejects(db(C, 'PUT', 'clans/' + cid + '/o', uidC), 'PERMISSION_DENIED', 'Leitung an sich reißen');
      await rejects(db(C, 'PUT', 'clanboard/all/' + cid, { n: 'Die Boten', g: 1, m: 1, p: 0, t: SV }), 'PERMISSION_DENIED', 'Wertung als Nichtmitglied');
      await rejects(db(C, 'PUT', 'clancodes/ZZZZ2222', cid), 'PERMISSION_DENIED', 'fremden Clan nicht mit Code versehen');
      await rejects(db(C, 'DELETE', 'clancodes/' + code1), 'PERMISSION_DENIED', 'fremden Code nicht löschen');
      await rejects(db(C, 'DELETE', 'members/' + cid + '/' + uidB), 'PERMISSION_DENIED', 'fremdes Mitglied nicht entfernen');
      await rejects(db(C, 'DELETE', 'clannames/die_boten'), 'PERMISSION_DENIED', 'fremden Namensanspruch nicht löschen');
      await rejects(db(C, 'PUT', 'clansecret/' + cid, 'ZZZZ2222'), 'PERMISSION_DENIED', 'fremden Code nicht ändern'); }

    // --- Angriffe von Mitgliedern auf Beitrag und Wertung
    { const me = (await stateOf()).DB.members[cid][uidB], put = (o, p) => db(B, 'PUT', 'members/' + cid + '/' + uidB, Object.assign({}, { n: 'Zoe', t: me.t, k: code1, a: me.a, d: me.d, pd: me.pd, w: me.w, pw: me.pw }, o));
      await rejects(put({ a: 9999 }), 'PERMISSION_DENIED', 'Beitrag über dem eigenen Eintrag'); await rejects(put({ d: 101 }), 'PERMISSION_DENIED', 'Tagesbeitrag über dem eigenen Eintrag'); await rejects(put({ pd: pDay - 1 }), 'PERMISSION_DENIED', 'falscher Tageszeitraum');
      await rejects(put({ pw: pWeek + 1 }), 'PERMISSION_DENIED', 'falscher Wochenzeitraum'); await rejects(put({ t: 5 }), 'PERMISSION_DENIED', 'Beitrittszeit nicht änderbar'); await rejects(put({ extra: 1 }), 'PERMISSION_DENIED', 'unbekanntes Feld');
      await rejects(put({ a: -1 }), 'PERMISSION_DENIED', 'negativer Beitrag'); await put({ a: 100 }); ok(true, 'kleinerer Beitrag ist erlaubt'); await B.L.clan.refresh();
      eq((await stateOf()).DB.members[cid][uidB].a, 250, 'Beitrag wird wieder auf den Eintrag gesetzt');
      const wb = (sc, o) => db(B, 'PUT', 'clanboard/' + sc + '/' + cid, Object.assign({ n: 'Die Boten', g: 650, m: 2, p: sc === 'all' ? 0 : sc === 'day' ? pDay : pWeek, t: SV }, o));
      await rejects(wb('all', { n: 'Anders' }), 'PERMISSION_DENIED', 'falscher Clan-Name in der Wertung'); await rejects(wb('all', { m: 13 }), 'PERMISSION_DENIED', 'mehr als 12 Mitglieder'); await rejects(wb('all', { m: 0 }), 'PERMISSION_DENIED', 'null Mitglieder');
      await rejects(wb('all', { g: 1e9 }), 'PERMISSION_DENIED', 'unplausible Wertung'); await rejects(wb('day', { g: 2 * 869000 + 1 }), 'PERMISSION_DENIED', 'Tageswertung über der Grenze'); await wb('day', { g: 2 * 869000 }); ok(true, 'Tageswertung an der Grenze ok');
      await rejects(wb('day', { p: pDay - 1 }), 'PERMISSION_DENIED', 'alter Tag'); await rejects(wb('all', { p: 1 }), 'PERMISSION_DENIED', 'Gesamt hat Zeitraum 0'); await rejects(wb('year', {}), 'PERMISSION_DENIED', 'unbekannter Zeitraum'); await rejects(wb('all', { x: 1 }), 'PERMISSION_DENIED', 'unbekanntes Feld'); await rejects(wb('all', { t: 5 }), 'PERMISSION_DENIED', 'falsche Zeit');
      const A3 = client(); await A3.L.login('tim@example.de', 'geheim123'); await A3.L.clan.refresh(); eq((await stateOf()).DB.clanboard.day[cid].g, 400, 'Wertung wird von einem anderen Gerät wieder korrekt geschrieben'); }

    // --- Beitragsrechnung: abgelaufene Zeiträume zählen nicht
    { const r = K.rows({ owner: 'x', members: [{ uid: 'u1', name: 'Alt', t: 1, a: 100, d: 50, pd: pDay - 1, w: 70, pw: pWeek }, { uid: 'u2', name: 'Neu', t: 2, a: 10, d: 5, pd: pDay, w: 7, pw: pWeek - 1 }] }, A.L.serverNow());
      eq([r.total.all, r.total.day, r.total.week], [110, 5, 70], 'Tag und Woche nur aus dem laufenden Zeitraum'); eq(r.rows.map(x => x.name), ['Alt', 'Neu'], 'sortiert nach Gesamt'); }

    // --- Voller Clan: das 13. Mitglied wird nicht aufgenommen
    { const fake = {}; for (let i = 0; i < 10; i++) fake['fake' + i] = { n: 'Fake' + i, t: 1000 + i, k: code1 };
      await ctl('put', { path: 'members/' + cid, value: Object.assign({}, (await stateOf()).DB.members[cid], fake) });
      eq((await A.L.clan.mine()).members.length, 12, 'zwölf Mitglieder');
      await rejects(C.L.clan.join(code1), 'CLAN_FULL', 'volle Clans nehmen niemanden auf');
      const S = await stateOf(); eq(S.DB.clanof[uidC], undefined, 'nach der Ablehnung kein Zeiger'); eq(S.DB.members[cid][uidC], undefined, 'nach der Ablehnung kein Mitglied');
      eq((await A.L.clan.refresh()).count, 12, 'Wertung zählt höchstens 12');
      await ctl('put', { path: 'members/' + cid, value: Object.fromEntries(Object.entries((await stateOf()).DB.members[cid]).filter(([k]) => !k.startsWith('fake'))) });
      eq((await A.L.clan.mine()).members.length, 2, 'wieder zwei Mitglieder'); }

    // --- Verlassen
    { await rejects(A.L.clan.leave(), 'CLAN_OWNER_LEAVE', 'Leiter kann nicht einfach gehen'); await rejects(A.L.clan.kick(uidA), 'CLAN_OWNER_LEAVE', 'Leiter kann sich nicht selbst entfernen');
      await B.L.clan.leave(); eq(await B.L.clan.mine(), null, 'B ist raus'); { const S = await stateOf(); eq([S.DB.clanof[uidB], S.DB.members[cid][uidB]], [undefined, undefined], 'Zeiger und Mitglied entfernt'); }
      const r = await A.L.clan.refresh(); eq([r.total.all, r.count], [400, 1], 'Wertung ohne B'); eq((await stateOf()).DB.clanboard.all[cid].g, 400, 'Wertung in der Datenbank gesunken');
      await rejects(B.L.clan.kick(uidA), 'CLAN_GONE', 'Nichtmitglied kann niemanden entfernen'); }

    // --- Entfernen durch den Leiter, Aufräumen beim Entfernten
    { await B.L.clan.join(code1); await rejects(B.L.clan.kick(uidA), 'CLAN_NOT_OWNER', 'Mitglied darf niemanden entfernen'); await rejects(B.L.clan.renew(), 'CLAN_NOT_OWNER', 'Mitglied darf den Code nicht erneuern'); await rejects(B.L.clan.disband(), 'CLAN_NOT_OWNER', 'Mitglied darf nicht auflösen');
      await A.L.clan.kick(uidB); eq((await stateOf()).DB.members[cid][uidB], undefined, 'B wurde entfernt'); ok((await stateOf()).DB.clanof[uidB] === cid, 'Zeiger von B besteht noch');
      eq(await B.L.clan.mine(), null, 'B merkt es und räumt auf'); eq((await stateOf()).DB.clanof[uidB], undefined, 'Zeiger von B ist weg');
      const m = await B.L.clan.join(code1); eq(m.members.length, 2, 'Wiederbeitritt nach dem Entfernen geht'); }

    // --- Leitung übergeben
    { await rejects(A.L.clan.transfer(uidC), 'PERMISSION_DENIED', 'Leitung nur an Mitglieder');
      await A.L.clan.transfer(uidB); const a = await A.L.clan.mine(), b = await B.L.clan.mine();
      eq([a.isOwner, b.isOwner, b.owner], [false, true, uidB], 'B ist jetzt Leiter');
      await rejects(A.L.clan.kick(uidB), 'CLAN_NOT_OWNER', 'bisheriger Leiter darf nichts mehr'); await rejects(db(A, 'PUT', 'clans/' + cid + '/o', uidA), 'PERMISSION_DENIED', 'Leitung nicht zurückholen');
      await rejects(A.L.clan.leave().then(() => { throw Object.assign(new Error('x'), { code: 'KEIN_FEHLER' }); }), 'KEIN_FEHLER', 'bisheriger Leiter darf gehen');
      eq(await A.L.clan.mine(), null, 'A ist raus'); await A.L.clan.join(code1); }

    // --- Code erneuern
    { const code2 = await B.L.clan.renew(); ok(/^[A-Z2-9]{8}$/.test(code2) && code2 !== code1, 'neuer Code: ' + code2);
      const S = await stateOf(); eq(S.DB.clancodes[code1], undefined, 'alter Code ungültig'); eq(S.DB.clancodes[code2], cid, 'neuer Code gilt'); eq(S.DB.clansecret[cid], code2, 'Geheimnis erneuert');
      await rejects(C.L.clan.join(code1), 'CLAN_BAD_CODE', 'mit altem Code kein Beitritt');
      await rejects(db(C, 'PUT', 'clanof/' + uidC, cid).then(() => db(C, 'PUT', 'members/' + cid + '/' + uidC, { n: 'Cara Cool', t: SV, k: code1 })), 'PERMISSION_DENIED', 'alter Code auch direkt abgelehnt'); await db(C, 'DELETE', 'clanof/' + uidC);
      const r = await A.L.clan.refresh(); ok(!r.err, 'bisheriges Mitglied kann weiter beitragen'); eq((await stateOf()).DB.members[cid][uidA].k, code2, 'Mitglied trägt den neuen Code');
      eq((await A.L.clan.mine()).code, code2, 'Mitglied sieht den neuen Code'); const m3 = await C.L.clan.join(code2); eq(m3.members.length, 3, 'Beitritt mit dem neuen Code'); await C.L.clan.leave(); }

    // --- Auflösen
    { await C.L.clan.join((await B.L.clan.mine()).code); await B.L.clan.refresh(); await C.L.board.submit(CK, { city: 'Essen', l: 1, r: 3, g: { all: 50, day: 50, week: 50 } }); await C.L.clan.refresh();
      ok((await stateOf()).DB.clanboard.all[cid], 'Wertung vorhanden vor dem Auflösen');
      await B.L.clan.disband(); const S = await stateOf();
      for (const n of ['clans', 'clansecret', 'clannames', 'members']) ok(!(S.DB[n] && Object.keys(S.DB[n]).length), n + ' leer nach dem Auflösen: ' + JSON.stringify(S.DB[n]));
      eq(Object.keys(S.DB.clancodes || {}), [], 'Codes leer'); ok(!S.DB.clanboard || ['all', 'day', 'week'].every(s => !S.DB.clanboard[s] || !S.DB.clanboard[s][cid]), 'Wertung entfernt');
      eq(S.DB.clanof[uidB], undefined, 'Zeiger des Leiters weg'); eq(await A.L.clan.mine(), null, 'A merkt die Auflösung'); eq(await C.L.clan.mine(), null, 'C merkt die Auflösung'); eq(Object.keys((await stateOf()).DB.clanof || {}), [], 'alle Zeiger aufgeräumt');
      const m = await A.L.clan.create('Die Boten'); ok(m.cid !== cid, 'der Name ist nach dem Auflösen wieder frei'); await A.L.clan.leave(); eq(await A.L.clan.mine(), null, 'allein gegründet und wieder gegangen (löst auf)'); eq(Object.keys((await stateOf()).DB.clans || {}), [], 'kein Clan mehr'); }

    // --- Konto löschen als Leiter
    { const m = await B.L.clan.create('Nachtfahrer'); await A.L.clan.join(m.code); await C.L.clan.join(m.code);
      const ob = await B.L.company.open(CK); await B.L.company.push(ob.slot, ob.sess, JSON.stringify({ v: 2, pad: 'y'.repeat(60) }), 'B');
      await B.L.board.submit(CK, { city: 'Essen', l: 1, r: 3, g: { all: 60, day: 60, week: 60 } }); await B.L.clan.refresh();
      await B.L.deleteAccount('geheim123'); const S = await stateOf(), cl = Object.keys(S.DB.clans || {})[0];
      ok(!!cl && S.DB.clans[cl].o !== uidB, 'Clan besteht weiter, Leitung wurde übergeben (' + (cl && S.DB.clans[cl].o) + ')'); ok([uidA, uidC].includes(S.DB.clans[cl].o), 'neuer Leiter ist ein Mitglied');
      const left = []; (function walk(n, p) { if (n && typeof n === 'object') for (const k of Object.keys(n)) { if (k === uidB) left.push(p + '/' + k); walk(n[k], p + '/' + k); } })(S.DB, '');
      eq(left, [], 'nach dem Löschen bleibt nichts von B');
      const a = await A.L.clan.mine(); eq(a.members.length, 2, 'zwei Mitglieder bleiben');
      await A.L.clan.leave().catch(() => {}); await C.L.clan.leave().catch(() => {}); await (a.isOwner ? C : A).L.clan.leave().catch(() => {}); }
    // allein als Leiter: Konto löschen löst den Clan auf
    { const D = client(); await reg(D.L, { name: 'Dan', email: 'dan@example.de' }); await D.L.clan.create('Einzelkaempfer'); await D.L.deleteAccount('geheim123');
      const S = await stateOf(); ok(!Object.keys(S.DB.clans || {}).some(k => S.DB.clans[k].n === 'Einzelkaempfer'), 'Einzel-Clan wurde aufgelöst'); eq(Object.keys(S.DB.clannames || {}).filter(k => k === 'einzelkaempfer'), [], 'Name frei'); }

    // --- Alte Regeln ohne Clans: klare Meldung, Konto löschen geht trotzdem
    { const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); for (const k of ['clans', 'clannames', 'clansecret', 'clancodes', 'clanof', 'members', 'clanboard']) delete rules.rules[k];
      await ctl('rules', rules);
      await rejects(A.L.clan.mine(), 'RULES_CLAN', 'ohne Clan-Regeln: klare Meldung (mine)'); await rejects(A.L.clan.create('Alt Clan'), 'RULES_CLAN', 'ohne Clan-Regeln: klare Meldung (gründen)'); await rejects(A.L.clan.join('AAAA2222'), 'RULES_CLAN', 'ohne Clan-Regeln: klare Meldung (beitreten)'); await rejects(A.L.clan.top('all'), 'RULES_CLAN', 'ohne Clan-Regeln: klare Meldung (Rangliste)');
      const E = client(); await reg(E.L, { name: 'Eva', email: 'eva@example.de' }); await E.L.deleteAccount('geheim123'); ok(true, 'Konto löschen geht auch ohne Clan-Regeln');
      await ctl('rules', JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'))); }
    { const n = await stateOf(); ok(!n.LOG.some(x => /Regelfehler/.test(x)), 'keine Regelfehler im Nachbau: ' + n.LOG.filter(x => /Regelfehler/.test(x)).slice(0, 3).join(' | ')); }
  } catch (e) { fail++; console.log('AUSNAHME', e && e.stack || e); }
  const S = await stateOf(); if (S.LOG.length) console.log('Mock-Log (letzte):\n  ' + S.LOG.slice(-8).join('\n  '));
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  srv.kill(); process.exit(fail ? 1 : 0);
})();
