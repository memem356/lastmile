'use strict';
// Tests der Konto-Bausteine (src/online.js) gegen den Firebase-Nachbau (fbmock.js), samt Sicherheitsregeln. Start: node tests/lmo_test.js
const { spawn } = require('child_process'), fs = require('fs'), vm = require('vm'), path = require('path');
const PORT = 9199, MOCK = `http://127.0.0.1:${PORT}`;
const HOST = 'lastmile-c6976-default-rtdb.europe-west1.firebasedatabase.app';
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'online.js'), 'utf8');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'firebase-rules.json'), 'utf8').match(/'(LM-[A-Z0-9-]+)'/)[1];
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FEHLER:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (ist ' + JSON.stringify(a) + ', soll ' + JSON.stringify(b) + ')');
const ctl = async (p, b) => (await fetch(MOCK + '/ctl/' + p, { method: 'POST', body: JSON.stringify(b || {}) })).json();
const stateOf = async () => (await fetch(MOCK + '/ctl/state', { method: 'POST' })).json();

function client(store, hostMap) {
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
  const ctx = vm.createContext({ fetch: f, localStorage: ls, AbortController, setTimeout, clearTimeout, Date, JSON, Math, console, URL, encodeURIComponent, Promise });
  vm.runInContext(SRC + '\nthis.LMO = LMO;', ctx);
  return { L: ctx.LMO, store };
}
const rejects = async (p, code, m) => { try { await p; ok(false, m + ' (kein Fehler)'); } catch (e) { eq(e.code, code, m); } };
const reg = (L, o) => L.register(Object.assign({ name: 'Tim Express', email: 'tim@example.de', password: 'geheim123', code: CODE }, o));

(async () => {
  const srv = spawn('node', [path.join(__dirname, 'fbmock.js'), String(PORT)], { env: Object.assign({}, process.env, { ANCESTOR_VALIDATE: process.env.ANC || '0' }), stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await ctl('reset'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  try {
    // --- Namensprüfung (rein lokal)
    { const { L } = client();
      eq(L.checkName('Tim'), '', 'Name Tim ok');
      ok(L.checkName('ab') !== '', 'zu kurz'); ok(L.checkName('a'.repeat(17)) !== '', 'zu lang'); ok(L.checkName(' Tim') === '' , 'Leerzeichen am Rand werden entfernt');
      ok(L.checkName('Tim!') !== '', 'Sonderzeichen'); ok(L.checkName('1234') !== '', 'nur Zahlen'); ok(L.checkName('H1tler99') !== '', 'Leetspeak-Filter'); ok(L.checkName('Admin') !== '', 'reserviert');
      ok(L.checkName('Siegfried') === '', 'Siegfried erlaubt'); ok(L.checkName('Marschall') === '', 'Marschall erlaubt'); ok(L.checkName('Heilbronn') === '', 'Heilbronn erlaubt'); ok(L.checkName('Jörg Müller') === '', 'Umlaute erlaubt');
      ok(L.checkName('Claudia') === '', 'Claudia erlaubt'); ok(L.checkName('Lastmile') !== '', 'Lastmile reserviert');
      for (let i = 0; i < 30; i++) { const n = L.suggestName(); if (L.checkName(n)) { ok(false, 'Vorschlag ungültig: ' + n); break; } }
      eq(L.nameKey('Tim Express'), 'tim_express', 'Schlüssel');
    }
    // --- Datenbank-Erkennung
    { await ctl('reset'); const { L, store } = client();
      const r = await reg(L); ok(r.signedIn && r.name === 'Tim Express', 'Registrierung ok');
      eq(store['lm.fbdb'], 'https://' + HOST, 'Region gemerkt');
    }
    await ctl('reset');
    // --- Registrierung
    const A = client();
    { const st = await reg(A.L);
      ok(st.signedIn && st.hasProfile && st.name === 'Tim Express' && st.email === 'tim@example.de', 'A angemeldet mit Profil');
      const S = await stateOf(); const uid = st.uid;
      eq(S.DB.names, { tim_express: uid }, 'Namensanspruch'); eq(S.DB.redeemed[uid], CODE, 'Einladung');
      eq(S.DB.users[uid].name, 'Tim Express', 'Profilname'); eq(S.DB.users[uid].key, 'tim_express', 'Profilschlüssel'); ok(typeof S.DB.users[uid].created === 'number', 'created ist Serverzeit');
      eq(S.MAILS.map(m => m.type + ':' + m.locale), ['VERIFY_EMAIL:de'], 'Bestätigungsmail auf Deutsch');
      eq(st.verified, false, 'noch nicht bestätigt');
      await ctl('verify', { email: 'tim@example.de' });
      eq(await A.L.checkVerified(), true, 'Bestätigung erkannt'); eq(A.L.state().verified, true, 'Status verified');
    }
    { const B = client();
      await rejects(reg(B.L, { email: 'zoe@example.de' }), 'NAME_TAKEN', 'gleicher Name');
      await rejects(reg(B.L, { email: 'zoe@example.de', name: 'tim  express' }), 'NAME_TAKEN', 'gleicher Name, andere Schreibung');
      await rejects(reg(B.L, { email: 'zoe@example.de', name: 'TIM EXPRESS' }), 'NAME_TAKEN', 'gleicher Name, Großschreibung');
      eq((await stateOf()).USERS.length, 1, 'keine Konten durch gescheiterte Namen');
      await rejects(reg(B.L, { email: 'zoe@example.de', name: 'Zoe', code: 'FALSCH' }), 'BAD_CODE', 'falscher Code');
      let S = await stateOf(); eq(S.USERS.length, 1, 'Rollback nach falschem Code: Konto wieder gelöscht'); eq(Object.keys(S.DB.redeemed).length, 1, 'keine fremde Einladung gespeichert'); eq(Object.keys(S.DB.names), ['tim_express'], 'kein Name beansprucht'); ok(!B.L.state().signedIn, 'B nicht angemeldet');
      await rejects(reg(B.L, { email: 'tim@example.de', name: 'Zoe' }), 'EMAIL_EXISTS', 'E-Mail doppelt');
      eq((await stateOf()).USERS.length, 1, 'kein Konto bei doppelter E-Mail');
      await rejects(reg(B.L, { email: 'kaputt', name: 'Zoe' }), 'INVALID_EMAIL', 'E-Mail ungültig');
      await rejects(reg(B.L, { email: 'zoe@example.de', name: 'Zoe', password: 'kurz' }), 'WEAK_PASSWORD', 'Passwort kurz');
      try { await reg(B.L, { email: 'zoe@example.de', name: 'Hitler' }); ok(false, 'Namensfilter'); } catch (e) { eq(e.code, 'BAD_NAME', 'Namensfilter wirkt'); }
      // Code klein geschrieben und mit Leerzeichen wird akzeptiert
      const st = await reg(B.L, { email: 'zoe@example.de', name: 'Zoe', code: '  ' + CODE.toLowerCase() + ' ' }); ok(st.hasProfile, 'Code unabhängig von Groß-/Kleinschreibung');
    }
    // --- Anmeldung, Sitzung, Token-Erneuerung
    { const store = A.store, L2 = client(store).L; L2.init(); await new Promise(r => setTimeout(r, 300));
      ok(L2.state().signedIn && L2.state().name === 'Tim Express', 'Sitzung bleibt nach Neustart');
      // abgelaufenes Token -> wird erneuert
      const o = JSON.parse(store['lm.auth']); o.exp = Date.now() - 1000; o.idToken = 'kaputt'; store['lm.auth'] = JSON.stringify(o);
      const L3 = client(store).L; L3.init(); await new Promise(r => setTimeout(r, 300));
      const lst = await L3.cloud.list(); ok(Array.isArray(lst), 'Liste nach Token-Erneuerung'); ok(JSON.parse(store['lm.auth']).idToken !== 'kaputt', 'Token erneuert');
      // Widerrufene Sitzung
      const o2 = JSON.parse(store['lm.auth']); o2.refreshToken = 'nope'; o2.exp = 0; store['lm.auth'] = JSON.stringify(o2);
      const L4 = client(store).L; L4.init(); await new Promise(r => setTimeout(r, 300)); await rejects(L4.cloud.list(), 'NOT_SIGNED_IN', 'ungültiges Refresh-Token'); ok(!L4.state().signedIn && !store['lm.auth'], 'abgemeldet');
    }
    { const L = client().L;
      await rejects(L.login('tim@example.de', 'falsch'), 'INVALID_LOGIN_CREDENTIALS', 'falsches Passwort'); await rejects(L.login('', 'x'), 'MISSING_EMAIL', 'E-Mail fehlt'); await rejects(L.login('x@y.de', ''), 'MISSING_PASSWORD', 'Passwort fehlt');
      const st = await L.login('tim@example.de', 'geheim123'); ok(st.signedIn && st.hasProfile && st.verified && st.name === 'Tim Express', 'Login mit Profil und Bestätigung');
      L.logout(); ok(!L.state().signedIn, 'Logout');
      await L.resetPassword('tim@example.de'); await L.resetPassword('unbekannt@example.de');
      eq((await stateOf()).MAILS.filter(m => m.type === 'PASSWORD_RESET').map(m => m.locale), ['de', 'de'], 'Passwort-Mails');
      await rejects(L.resetPassword('kaputt'), 'INVALID_EMAIL', 'Reset: ungültige E-Mail');
    }
    // --- Cloud-Spielstände
    const T = client(); await T.L.login('tim@example.de', 'geheim123');
    { const L = T.L, raw = JSON.stringify({ v: 2, place: { name: 'Essen' }, pad: 'x'.repeat(5000) });
      const slot = L.cloud.slotOf('lm.save.51.451,7.014.relaxed'); eq(slot, 's_51_451_7_014_relaxed', 'Platzname'); eq(L.cloud.slotOf('lm.save.-33.869,151.209.rush'), 's_-33_869_151_209_rush', 'Platzname negativ');
      eq(await L.cloud.list(), [], 'leer');
      await L.cloud.put(slot, raw, 'Essen · Entspannt · 100 €', 2);
      const l = await L.cloud.list(); eq(l.length, 1, 'ein Stand'); eq(l[0].info, 'Essen · Entspannt · 100 €', 'Info'); ok(Math.abs(l[0].t - Date.now()) < 5000, 'Serverzeit gesetzt');
      eq((await L.cloud.get(slot)).data, raw, 'Inhalt identisch');
      await L.cloud.put(slot, raw + ' ', 'neu', 2); eq((await L.cloud.list()).length, 1, 'überschrieben'); eq((await L.cloud.list())[0].info, 'neu', 'Info überschrieben');
      await rejects(L.cloud.put(slot, 'x'.repeat(400001), 'zu groß', 2), 'PERMISSION_DENIED', 'zu große Daten abgelehnt');
      await rejects(L.cloud.put('x_bad', raw, 'a', 2), 'PERMISSION_DENIED', 'falscher Platzname abgelehnt');
      await rejects(L.cloud.put('s_' + 'a'.repeat(70), raw, 'a', 2), 'PERMISSION_DENIED', 'zu langer Platzname abgelehnt');
      await rejects(L.cloud.put(slot, 'kurz', 'a', 2), 'PERMISSION_DENIED', 'zu kurze Daten abgelehnt');
      await rejects(L._db('PUT', 'savemeta/' + L.state().uid + '/' + slot, { t: { '.sv': 'timestamp' }, v: 2, info: 'a'.repeat(200) }), 'PERMISSION_DENIED', 'zu lange Info abgelehnt');
      await L.cloud.put(L.cloud.slotOf('lm.save.52.000,8.000.rush'), raw, 'Zweiter', 2); eq((await L.cloud.list()).length, 2, 'zwei Stände');
      await L.cloud.del(slot); eq((await L.cloud.list()).map(x => x.slot), ['s_52_000_8_000_rush'], 'gelöscht');
    }
    // --- Serverzeit
    { await ctl('skew', { ms: 7000 }); const r = await T.L.syncClock(); ok(Math.abs(r.offset - 7000) < 400, 'Zeitversatz ' + r.offset); ok(Math.abs(T.L.serverNow() - (Date.now() + 7000)) < 400, 'serverNow'); await ctl('skew', { ms: 0 }); }
    // --- Sicherheit: fremde Konten
    { const U = (await stateOf()).USERS; const uidA = T.L.state().uid;
      const Z = client(); await Z.L.login('zoe@example.de', 'geheim123'); const uidZ = Z.L.state().uid;
      const zdb = Z.L._db;
      await rejects(zdb('GET', 'users/' + uidA), 'PERMISSION_DENIED', 'fremdes Profil nicht lesbar');
      await rejects(zdb('GET', 'saves/' + uidA + '/s_52_000_8_000_rush'), 'PERMISSION_DENIED', 'fremde Stände nicht lesbar');
      await rejects(zdb('GET', 'savemeta/' + uidA), 'PERMISSION_DENIED', 'fremde Liste nicht lesbar');
      await rejects(zdb('GET', 'redeemed/' + uidA), 'PERMISSION_DENIED', 'Einladungen nicht lesbar');
      await rejects(zdb('GET', 'names', undefined, { auth: false }), 'PERMISSION_DENIED', 'Namensliste nicht lesbar');
      await rejects(zdb('GET', '', undefined, { auth: false }), 'PERMISSION_DENIED', 'Wurzel nicht lesbar');
      eq(await zdb('GET', 'names/tim_express', undefined, { auth: false }), uidA, 'einzelner Name prüfbar ohne Anmeldung');
      await rejects(zdb('PUT', 'saves/' + uidA + '/s_x', { t: { '.sv': 'timestamp' }, v: 2, data: 'x'.repeat(30) }), 'PERMISSION_DENIED', 'fremde Stände nicht beschreibbar');
      await rejects(zdb('PUT', 'users/' + uidA + '/name', 'Hacker'), 'PERMISSION_DENIED', 'fremdes Profil nicht beschreibbar');
      await rejects(zdb('DELETE', 'names/tim_express'), 'PERMISSION_DENIED', 'fremden Namen nicht löschbar');
      await rejects(zdb('PUT', 'names/tim_express', uidZ), 'PERMISSION_DENIED', 'vergebenen Namen nicht übernehmbar');
      await rejects(zdb('PUT', 'names/hintertuer', uidZ), 'PERMISSION_DENIED', 'zweiter Anspruch ohne Profil-Schlüssel');
      await rejects(zdb('PUT', 'names/zoe', uidA), 'PERMISSION_DENIED', 'Anspruch für andere Kennung');
      eq(await zdb('PUT', 'names/zoe', uidZ), uidZ, 'eigener Anspruch erlaubt (idempotent)');
      await rejects(zdb('PUT', 'users/' + uidZ + '/name', 'Admin'), 'PERMISSION_DENIED', 'Anzeigename nicht allein änderbar');
      await rejects(zdb('PUT', 'users/' + uidZ, { name: 'Tim Express', key: 'tim_express', created: Date.now() }), 'PERMISSION_DENIED', 'Profil mit vergebenem Namen abgelehnt');
      await rejects(zdb('PUT', 'users/' + uidZ, { name: 'Zoe', key: 'zoe', created: Date.now() }), 'PERMISSION_DENIED', 'created muss unverändert bleiben');
      await rejects(zdb('PUT', 'users/' + uidZ, { name: 'Zoe', key: 'zoe', created: Z.L.state().profile.created, extra: 1 }), 'PERMISSION_DENIED', 'Zusatzfelder im Profil abgelehnt');
      await rejects(zdb('PUT', 'users/' + uidZ + '/key', 'tim_express'), 'PERMISSION_DENIED', 'Schlüssel nicht allein änderbar');
      // Umbenennen als ganzes Dokument bleibt möglich
      const cr = Z.L.state().profile.created;
      eq((await zdb('PUT', 'users/' + uidZ, { name: 'Zoe Neu', key: 'zoe_neu', created: cr })).name, 'Zoe Neu', 'Umbenennen als ganzes Dokument'); await zdb('PUT', 'names/zoe_neu', uidZ); await zdb('DELETE', 'names/zoe');
      eq((await stateOf()).DB.names, { tim_express: uidA, zoe_neu: uidZ }, 'Umbenennung: alter Anspruch frei, neuer da');
      await rejects(zdb('PUT', 'clock/' + uidA, { '.sv': 'timestamp' }), 'PERMISSION_DENIED', 'fremde Uhr nicht beschreibbar');
      await rejects(zdb('PUT', 'clock/' + uidZ, 12345), 'PERMISSION_DENIED', 'Uhr nur mit Serverzeit');
      await rejects(zdb('PUT', 'unbekannt/x', 1), 'PERMISSION_DENIED', 'unbekannte Pfade gesperrt');
      await rejects(zdb('PUT', 'redeemed/' + uidZ, 'LM-XXXX-XXXX'), 'PERMISSION_DENIED', 'Einladung nicht fälschbar');
      await rejects(zdb('DELETE', 'redeemed/' + uidA), 'PERMISSION_DENIED', 'fremde Einladung nicht löschbar');
      // Konto ohne Einladung: kann nichts schreiben
      const raw = await (await fetch(MOCK + '/auth/signUp?key=AIzaSyAdEbVh2P13tdupXlrT07nTGabqq9kLb1I', { method: 'POST', body: JSON.stringify({ email: 'gast@example.de', password: 'geheim123' }) })).json();
      const G = client(); await G.L.login('gast@example.de', 'geheim123'); ok(G.L.state().signedIn && !G.L.state().hasProfile, 'Konto ohne Profil erkannt');
      const gdb = G.L._db, uidG = G.L.state().uid;
      await rejects(gdb('PUT', 'users/' + uidG, { name: 'Gast', key: 'gast', created: { '.sv': 'timestamp' } }), 'PERMISSION_DENIED', 'ohne Einladung kein Profil');
      await rejects(gdb('PUT', 'names/gast', uidG), 'PERMISSION_DENIED', 'ohne Einladung kein Name');
      await rejects(gdb('PUT', 'saves/' + uidG + '/s_a', { t: { '.sv': 'timestamp' }, v: 2, data: 'x'.repeat(30) }), 'PERMISSION_DENIED', 'ohne Profil keine Stände');
      await rejects(G.L.completeRegistration({ name: 'Gast Spieler', code: 'FALSCH' }), 'BAD_CODE', 'Abschluss mit falschem Code');
      await rejects(G.L.completeRegistration({ name: 'Zoe Neu', code: CODE }), 'NAME_TAKEN', 'Abschluss mit vergebenem Namen');
      const st = await G.L.completeRegistration({ name: 'Gast Spieler', code: CODE }); ok(st.hasProfile && st.name === 'Gast Spieler', 'Registrierung nachträglich abgeschlossen');
      eq((await stateOf()).DB.names.gast_spieler, uidG, 'Anspruch nachgeholt');
      // Selbstheilung: Anspruch fehlt -> beim Laden des Profils wird er gesetzt
      await ctl('put', { path: 'names/gast_spieler', value: null }); ok(!(await stateOf()).DB.names.gast_spieler, 'Anspruch entfernt'); await G.L.loadProfile(); eq((await stateOf()).DB.names.gast_spieler, uidG, 'Anspruch automatisch nachgeholt');
    }
    // --- Konto löschen
    { const D = client(); await D.L.login('zoe@example.de', 'geheim123'); const uid = D.L.state().uid;
      await D.L.cloud.put('s_abc', JSON.stringify({ v: 2, pad: 'y'.repeat(50) }), 'x', 2);
      await rejects(D.L.deleteAccount('falsch'), 'INVALID_LOGIN_CREDENTIALS', 'Löschen mit falschem Passwort');
      ok(D.L.state().signedIn, 'noch angemeldet'); ok(!!(await stateOf()).DB.users[uid], 'Daten noch da');
      await D.L.deleteAccount('geheim123'); const S = await stateOf();
      ok(!D.L.state().signedIn && !D.store['lm.auth'], 'abgemeldet'); ok(!S.DB.users || !S.DB.users[uid], 'Profil weg'); ok(!S.DB.saves || !S.DB.saves[uid], 'Stände weg'); ok(!S.DB.savemeta || !S.DB.savemeta[uid], 'Liste weg'); ok(!S.DB.redeemed[uid], 'Einladung weg'); ok(!S.DB.clock || !S.DB.clock[uid], 'Uhr weg');
      ok(!Object.keys(S.DB.names).includes('zoe_neu'), 'Name wieder frei'); ok(!S.USERS.some(u => u.email === 'zoe@example.de'), 'Konto weg');
      const E = client(); const st = await reg(E.L, { email: 'zoe2@example.de', name: 'Zoe Neu' }); ok(st.hasProfile, 'Name neu vergebbar');
    }
    // --- Regeln nicht eingerichtet
    { await ctl('reset'); await ctl('rules', { rules: { '.read': false, '.write': false } }); const L = client().L;
      await rejects(reg(L), 'RULES', 'ohne Regeln: klare Meldung'); eq((await stateOf()).USERS.length, 0, 'ohne Regeln: kein Konto angelegt');
      await ctl('reset'); }
    // --- Fehlerfälle im Netz
    { await ctl('reset'); const L = client().L;
      await ctl('fail', { match: 'names/', status: 500, times: 100 });
      await rejects(reg(L), 'DB_500', 'Serverfehler beim Namensanspruch');
      let S = await stateOf(); eq(S.USERS.length, 0, 'Rollback nach Serverfehler: kein Konto'); eq(S.DB.users, undefined, 'Rollback: kein Profil'); ok(!L.state().signedIn, 'Rollback: abgemeldet');
      await ctl('fail', {}); await ctl('reset');
      const M = client(); const st = await reg(M.L); ok(st.signedIn, 'danach geht es wieder');
    }
    { // Region falsch eingestellt: zweite Adresse wird gefunden
      const store = {}; store['lm.fbdb'] = 'https://lastmile-c6976-default-rtdb.firebaseio.com'; const L = client(store).L;
      const st = await L.login('tim@example.de', 'geheim123').catch(e => e); ok(!st.code, 'Login trotz falscher gemerkter Region (' + (st.code || '') + ')'); eq(store['lm.fbdb'], 'https://' + HOST, 'Region korrigiert');
    }
  } catch (e) { fail++; console.log('AUSNAHME', e && e.stack || e); }
  const S = await stateOf(); if (S.LOG.length) console.log('Mock-Log:\n  ' + S.LOG.slice(-8).join('\n  '));
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  srv.kill(); process.exit(fail ? 1 : 0);
})();
