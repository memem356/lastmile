'use strict';
// Tests der Regeln für den gemeinsamen Kartenspeicher (citystore) gegen den Firebase-Nachbau samt Sicherheitsregeln, dazu LMStore mit echtem Netzweg.
// Start: node tests/lmo_store_test.js   (mit ANC=1 prüft der Nachbau zusätzlich die übergeordneten Validierungen)
const { spawn } = require('child_process'), fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
const PORT = 9195, MOCK = `http://127.0.0.1:${PORT}`;
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'online.js'), 'utf8'), STORE = fs.readFileSync(path.join(__dirname, '..', 'src', 'citystore.js'), 'utf8');
const RULES_FILE = path.join(__dirname, '..', 'firebase-rules.json');
const CODE = fs.readFileSync(RULES_FILE, 'utf8').match(/'(LM-[A-Z0-9-]+)'/)[1];
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FEHLER:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (ist ' + JSON.stringify(a) + ', soll ' + JSON.stringify(b) + ')');
const ctl = async (p, b) => (await fetch(MOCK + '/ctl/' + p, { method: 'POST', body: JSON.stringify(b || {}) })).json();
const stateOf = async () => (await fetch(MOCK + '/ctl/state', { method: 'POST' })).json();
function client() {
  const store = {}, ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const f = async (url, opt) => {
    let u = String(url), m;
    if ((m = u.match(/^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:([A-Za-z]+)\?(.*)$/))) u = `${MOCK}/auth/${m[1]}?${m[2]}`;
    else if ((m = u.match(/^https:\/\/securetoken\.googleapis\.com\/v1\/token\?(.*)$/))) u = `${MOCK}/token?${m[1]}`;
    else if ((m = u.match(/^https:\/\/([^/]+)\/(.*)$/))) u = `${MOCK}/db/${m[1]}/${m[2]}`;
    else throw new Error('unerwartete URL ' + u);
    return fetch(u, opt);
  };
  const ctx = vm.createContext({ fetch: f, localStorage: ls, AbortController, setTimeout, clearTimeout, Date, JSON, Math, console, URL, encodeURIComponent, Promise, __LM_PLAN: 'legacy', crypto: { getRandomValues: a => crypto.randomFillSync(a) }, Uint8Array,
    CompressionStream, DecompressionStream, TextEncoder, TextDecoder, btoa, atob, Int32Array, Float64Array, ArrayBuffer, DataView, Number, String, Array, Object, Set, RegExp, Error });
  vm.runInContext(SRC + '\n' + STORE + '\nthis.LMO = LMO; this.LMStore = LMStore;', ctx);
  return { L: ctx.LMO, S: ctx.LMStore, store, ctx };
}
const rejects = async (p, code, m) => { try { await p; ok(false, m + ' (kein Fehler)'); } catch (e) { eq(e.code, code, m); } };
const reg = (L, o) => L.register(Object.assign({ name: 'Tim Express', email: 'tim@example.de', password: 'geheim123', code: CODE }, o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SV = { '.sv': 'timestamp' };
const PD = 'PERMISSION_DENIED';
const D = 'H4sIAAAAAAAA/' + 'A'.repeat(60);                      // irgendein Text von passender Länge (die Regeln prüfen nur die Form)
const rec = (o) => Object.assign({ v: 2, t: SV, d: D }, o);

(async () => {
  const srv = spawn('node', [path.join(__dirname, 'fbmock.js'), String(PORT)], { env: Object.assign({}, process.env, { ANCESTOR_VALIDATE: process.env.ANC || '0' }), stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await ctl('reset'); break; } catch (e) { await sleep(100); } }
  try {
    const A = client(), B = client(), C = client(), G = client();
    await reg(A.L); await reg(B.L, { name: 'Zoe', email: 'zoe@example.de' }); await reg(C.L, { name: 'Cara Cool', email: 'cara@example.de' });
    const uidA = A.L.state().uid;
    const db = (X, m, p, b) => X.L._db(m, p, b), DBs = async () => (await stateOf()).DB;
    await ctl('put', { path: 'admins/' + uidA, value: true });                // A ist Betreiber

    // --- Schreiben: Form des Eintrags
    await db(B, 'PUT', 'citystore/p/r62649', rec({ n: 'Essen' }));
    { const R = (await DBs()).citystore.p.r62649; eq([R.v, R.d, R.n], [2, D, 'Essen'], 'gültiger Eintrag gespeichert'); ok(typeof R.t === 'number' && R.t > 1e12, 'Zeit stammt vom Server'); }
    await db(B, 'PUT', 'citystore/s/51_457_7_015', rec({ v: 1 }));
    await db(B, 'PUT', 'citystore/c/r62649', rec());
    await db(B, 'PUT', 'citystore/c/pt_51_457_7_012', rec());
    await db(B, 'PUT', 'citystore/f/r62649', rec());
    await db(B, 'PUT', 'citystore/p/link_r62649_r62650', rec());
    await db(B, 'PUT', 'citystore/s/-33_868_151_209', rec({ v: 1 }));
    ok(true, 'alle fünf Schlüsselformen sind erlaubt (Startkarte, Grenze, Punktschlüssel, Firmen, Verbindung)');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ t: 5 })), PD, 'gefälschte Zeit abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', { v: 2, d: D }), PD, 'ohne Zeit abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', { v: 2, t: SV }), PD, 'ohne Paket abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', { t: SV, d: D }), PD, 'ohne Formatnummer abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ v: 0 })), PD, 'Format 0 abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ v: 21 })), PD, 'Format über 20 abgelehnt (sperrt sonst die Stadt für immer)');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ v: 1.5 })), PD, 'Format mit Komma abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ v: '2' })), PD, 'Format als Text abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ d: 12345 })), PD, 'Paket als Zahl abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ d: 'kurz' })), PD, 'zu kurzes Paket abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ d: 'x'.repeat(7000001) })), PD, 'Paket über 7 Millionen Zeichen abgelehnt');
    await db(B, 'PUT', 'citystore/p/r1000', rec({ d: 'x'.repeat(7000000) }));
    ok(true, 'Paket mit genau 7 Millionen Zeichen ist erlaubt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ n: 'x'.repeat(81) })), PD, 'Name über 80 Zeichen abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ n: 5 })), PD, 'Name als Zahl abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ x: 1 })), PD, 'Zusatzfeld abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', rec({ u: 'abc' })), PD, 'Zusatzfeld (z. B. Absender) abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', 'nur ein Text'), PD, 'Text statt Eintrag abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r999', { v: 2, t: SV, d: { a: 1 } }), PD, 'Paket als Objekt abgelehnt');

    // --- Schreiben: Schlüssel und Art
    await rejects(db(B, 'PUT', 'citystore/x/r62649', rec()), PD, 'unbekannte Art abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/P/r62649', rec()), PD, 'Art in Großbuchstaben abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/Essen', rec()), PD, 'Schlüssel ohne Beziehungsnummer abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r', rec()), PD, 'Schlüssel „r“ ohne Zahl abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r1234567890123', rec()), PD, 'zu lange Beziehungsnummer abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r12a', rec()), PD, 'Beziehungsnummer mit Buchstaben abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/f/link_r1_r2', rec()), PD, 'Verbindung gibt es nur bei Straßenpaketen');
    await rejects(db(B, 'PUT', 'citystore/s/r62649', rec({ v: 1 })), PD, 'Startkarte mit Beziehungsschlüssel abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/51_457_7_015', rec()), PD, 'Straßenpaket mit Koordinatenschlüssel abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/c51_456_7_012', rec()), PD, 'Kreisnäherung (Schlüssel mit c) wird nicht geteilt');
    await rejects(db(B, 'PUT', 'citystore/s/51_45_7_015', rec({ v: 1 })), PD, 'Koordinatenschlüssel mit falscher Stellenzahl abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p/r1/zusatz', rec()), PD, 'tiefer verschachtelter Pfad abgelehnt');
    await rejects(db(B, 'PUT', 'citystore/p', { r5: rec() }), PD, 'ganze Art auf einmal schreiben abgelehnt (Schlüssel wird nicht umgangen)');
    await rejects(db(B, 'PUT', 'citystore', { p: { r5: rec() } }), PD, 'ganzen Speicher auf einmal schreiben abgelehnt');

    // --- Einmal beschreibbar, nur das neuere Format ersetzt
    await rejects(db(C, 'PUT', 'citystore/p/r62649', rec({ d: D + 'B' })), PD, 'gleiches Format: bestehender Eintrag nicht überschreibbar (auch nicht vom selben Spieler)');
    await rejects(db(B, 'PUT', 'citystore/p/r62649', rec({ d: D + 'B' })), PD, 'auch der Ersteller kann nicht überschreiben');
    await rejects(db(C, 'PUT', 'citystore/p/r62649', rec({ v: 1 })), PD, 'älteres Format ersetzt nichts');
    await db(C, 'PUT', 'citystore/p/r62649', rec({ v: 3, d: D + 'C' }));
    eq((await DBs()).citystore.p.r62649.v, 3, 'neueres Format ersetzt den alten Eintrag');
    await rejects(db(B, 'PUT', 'citystore/p/r62649', rec({ v: 2 })), PD, 'danach wieder nur noch Neueres');
    await db(B, 'PUT', 'citystore/p/r62649/n', 'Essen').then(() => ok(false, 'Namensfeld nachträglich ändern sollte scheitern'), e => eq(e.code, PD, 'einzelne Felder eines Eintrags nicht änderbar'));
    await rejects(db(B, 'PUT', 'citystore/p/r62649/d', D + 'Z'), PD, 'Paket-Feld allein nicht änderbar');
    await rejects(db(B, 'PUT', 'citystore/p/r62649/v', 9), PD, 'Formatnummer allein nicht änderbar');

    // --- Löschen nur für Betreiber
    await rejects(db(B, 'DELETE', 'citystore/p/r62649'), PD, 'Spieler können nichts löschen');
    await rejects(db(B, 'DELETE', 'citystore/p'), PD, 'Spieler können keine ganze Art löschen');
    await rejects(db(B, 'DELETE', 'citystore'), PD, 'Spieler können nicht den ganzen Speicher löschen');
    await rejects(db(B, 'PUT', 'citystore/p/r62649', null), PD, 'Löschen über PUT null ist dasselbe: abgelehnt');
    await db(A, 'DELETE', 'citystore/p/r62649');
    eq((await DBs()).citystore.p.r62649, undefined, 'Betreiber kann einen Eintrag löschen');
    await db(B, 'PUT', 'citystore/p/r62649', rec());
    ok((await DBs()).citystore.p.r62649.v === 2, 'danach kann die Stadt neu abgelegt werden');

    // --- Lesen: nur Angemeldete mit Profil, nur einzelne Einträge
    eq((await db(C, 'GET', 'citystore/p/r62649')).v, 2, 'angemeldete Spieler lesen einen Eintrag');
    eq(await db(C, 'GET', 'citystore/p/r4242'), null, 'unbekannter Eintrag: leer');
    await rejects(db(C, 'GET', 'citystore/p'), PD, 'Liste einer Art nicht lesbar');
    await rejects(db(C, 'GET', 'citystore'), PD, 'Speicher nicht auflistbar');
    await rejects(db(C, 'GET', 'citystore/p', undefined), PD, 'Auflisten bleibt auch mit zweitem Versuch gesperrt');
    eq(await db(C, 'GET', 'citystore/p/r62649/v'), 2, 'das Formatfeld allein ist lesbar (Vorabfrage)');
    {
      const r = await fetch(MOCK + '/db/lastmile-c6976-default-rtdb.europe-west1.firebasedatabase.app/citystore/p/r62649.json');
      eq(r.status, 401, 'ohne Anmeldung nicht lesbar');
      const w = await fetch(MOCK + '/db/lastmile-c6976-default-rtdb.europe-west1.firebasedatabase.app/citystore/p/r5.json', { method: 'PUT', body: JSON.stringify(rec()) });
      eq(w.status, 401, 'ohne Anmeldung nicht beschreibbar');
    }
    { // Konto ohne Profil (angelegt, aber nicht fertig registriert): weder lesen noch schreiben
      const H = client(); const res = await fetch(MOCK + '/auth/signUp?key=AIzaSyAdEbVh2P13tdupXlrT07nTGabqq9kLb1I', { method: 'POST', body: JSON.stringify({ email: 'halb@example.de', password: 'geheim123', returnSecureToken: true }) }).then(r => r.json());
      const tok = res.idToken, base = MOCK + '/db/lastmile-c6976-default-rtdb.europe-west1.firebasedatabase.app/';
      eq((await fetch(base + 'citystore/p/r62649.json?auth=' + tok)).status, 401, 'Konto ohne Profil: lesen abgelehnt');
      eq((await fetch(base + 'citystore/p/r6.json?auth=' + tok, { method: 'PUT', body: JSON.stringify(rec()) })).status, 401, 'Konto ohne Profil: schreiben abgelehnt');
    }

    // --- Der Weg über LMStore (echte Anmeldung, echtes Netz zum Nachbau)
    {
      const p = { v: 2, firms: [[0, 5145000, 701000, 'Büro GmbH'], [3, 5146000, 702000, 'Praxis Dr. Ä']] };
      ok(await B.S.put('f', 'r777', p, { v: 2, n: 'Teststadt' }) === true, 'LMStore.put legt das Paket ab');
      const R = (await DBs()).citystore.f.r777; ok(R && R.n === 'Teststadt' && R.v === 2 && typeof R.d === 'string' && R.d.length > 40, 'Eintrag steht in der Datenbank');
      const got = await C.S.get('f', 'r777', { v: 2 }); eq(got, p, 'LMStore.get liefert dasselbe Paket zurück (anderer Spieler)');
      ok(await C.S.put('f', 'r777', p, { v: 2 }) === false, 'bereits geholt: nicht erneut hochgeladen');
      const A2 = client(); await A2.L.login('tim@example.de', 'geheim123'); ok(await A2.S.put('f', 'r777', p, { v: 2 }) === false && A2.S.stats().skip === 1, 'schon vorhanden: nur die Vorabfrage, kein Schreiben');
      ok(await C.S.get('f', 'r778', { v: 2 }) === null && C.S.stats().miss === 1, 'fehlender Eintrag: null');
      ok(await G.S.get('f', 'r777', { v: 2 }) === null, 'nicht angemeldet: null ohne Fehler');
      // Eintrag von jemandem, der Unsinn ablegt (Form stimmt für die Regeln, Inhalt nicht)
      await db(B, 'PUT', 'citystore/f/r779', rec());
      ok(await C.S.get('f', 'r779', { v: 2 }) === null && C.S.stats().bad === 1, 'Unsinn mit passender Form: LMStore lehnt ihn ab');
      const big = { v: 2, firms: [], junk: Uint8Array.from(crypto.randomBytes(5.3e6)) };
      B.S.check.f = () => ''; ok(await B.S.put('f', 'r780', big, { v: 2 }) === false && B.S.stats().big === 1 && !(await DBs()).citystore.f.r780, 'zu großes Paket: kein Upload');
    }
    { // Regeln noch nicht eingetragen: LMStore schaltet sich ab, das Spiel läuft normal weiter
      const old = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); delete old.rules.citystore;
      await ctl('rules', old);
      const X = client(); await X.L.login('zoe@example.de', 'geheim123');
      ok(await X.S.get('p', 'r62649', { v: 2 }) === null && X.S.stats().off === true && X.S.stats().deny === 1, 'ohne Regeln: Zugriff verweigert, LMStore schaltet sich ab');
      const n = (await stateOf()).COUNT.db; ok(await X.S.get('p', 'r62650', { v: 2 }) === null && await X.S.put('p', 'r62650', {}, { v: 2 }) === false && (await stateOf()).COUNT.db === n, 'danach keine weiteren Anfragen');
      await ctl('rules', JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')));
    }
  } catch (e) { fail++; console.log('  ABBRUCH:', e && e.stack || e); }
  srv.kill();
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
