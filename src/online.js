// Lastmile Online: Konto und Cloud über die offenen Schnittstellen von Firebase (ohne Bibliothek, nur fetch)
// Die Zugangsdaten unten sind öffentlich gedacht (Webschlüssel). Geschützt werden die Daten durch die Regeln in firebase-rules.json.
const LMO = (function () {
  const CFG = {
    apiKey: 'AIzaSyAdEbVh2P13tdupXlrT07nTGabqq9kLb1I',
    projectId: 'lastmile-c6976',
    // Die Datenbank liegt je nach Wahl in einer dieser Regionen; die richtige wird beim ersten Start gefunden und gemerkt.
    db: ['https://lastmile-c6976-default-rtdb.europe-west1.firebasedatabase.app', 'https://lastmile-c6976-default-rtdb.firebaseio.com', 'https://lastmile-c6976-default-rtdb.asia-southeast1.firebasedatabase.app']
  };
  const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:', TOKEN = 'https://securetoken.googleapis.com/v1/token';
  const LSK = 'lm.auth', DBK = 'lm.fbdb';
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  // ---------- Fehler ----------
  const TEXT = {
    NETWORK: 'Keine Verbindung zum Server. Bitte Internet prüfen und noch einmal versuchen.',
    DB_NOT_FOUND: 'Die Datenbank wurde nicht gefunden. Bitte melde das dem Betreiber.',
    EMAIL_EXISTS: 'Zu dieser E-Mail-Adresse gibt es schon ein Konto. Melde dich an oder setze das Passwort zurück.',
    INVALID_EMAIL: 'Die E-Mail-Adresse sieht nicht richtig aus.',
    MISSING_EMAIL: 'Bitte eine E-Mail-Adresse eingeben.',
    MISSING_PASSWORD: 'Bitte ein Passwort eingeben.',
    WEAK_PASSWORD: 'Das Passwort ist zu schwach. Nimm mindestens 8 Zeichen.',
    INVALID_LOGIN_CREDENTIALS: 'E-Mail oder Passwort stimmt nicht.',
    INVALID_PASSWORD: 'E-Mail oder Passwort stimmt nicht.',
    EMAIL_NOT_FOUND: 'E-Mail oder Passwort stimmt nicht.',
    USER_DISABLED: 'Dieses Konto wurde gesperrt.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Zu viele Versuche. Bitte warte ein paar Minuten.',
    OPERATION_NOT_ALLOWED: 'Die Anmeldung mit E-Mail und Passwort ist im Firebase-Projekt noch nicht eingeschaltet (Authentication, Anmeldemethode).',
    CREDENTIAL_TOO_OLD_LOGIN_AGAIN: 'Bitte melde dich neu an und versuche es dann noch einmal.',
    TOKEN_EXPIRED: 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.',
    INVALID_REFRESH_TOKEN: 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.',
    USER_NOT_FOUND: 'Dieses Konto gibt es nicht mehr.',
    NOT_SIGNED_IN: 'Du bist nicht angemeldet.',
    NAME_TAKEN: 'Dieser Name ist schon vergeben.',
    BAD_NAME: 'Dieser Name ist nicht möglich.',
    BAD_CODE: 'Der Einladungscode stimmt nicht.',
    PERMISSION_DENIED: 'Der Server hat das abgelehnt (keine Berechtigung).',
    RULES: 'Die Datenbank ist noch nicht für Konten eingerichtet (Sicherheitsregeln fehlen). Bitte melde das dem Betreiber.',
    ADMIN_ONLY_OPERATION: 'Neue Konten sind im Firebase-Projekt gerade nicht erlaubt (Authentication, Einstellungen).',
    NO_PROFILE: 'Die Registrierung ist noch nicht abgeschlossen.',
    QUOTA: 'Der Server ist gerade überlastet. Bitte später noch einmal versuchen.',
    API_KEY: 'Der Zugangsschlüssel zu Firebase wird abgelehnt. Bitte melde das dem Betreiber.',
    CLOCK: 'Die Serverzeit konnte nicht gelesen werden.'
  };
  class OErr extends Error {
    constructor(code, detail) { super(TEXT[code] || ('Unbekannter Fehler (' + code + ')')); this.code = code; this.detail = detail || ''; }
  }
  const oerr = (c, d) => new OErr(c, d);

  // ---------- Netz ----------
  async function http(url, opt, ms) {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms || 20000);
    let r, txt;
    try { r = await fetch(url, Object.assign({ signal: ctl.signal }, opt)); txt = await r.text(); }
    catch (e) { throw oerr('NETWORK', String(e && e.message || e)); }
    finally { clearTimeout(to); }
    let json = null; try { json = txt ? JSON.parse(txt) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, json, text: txt };
  }
  async function authApi(method, body, extraHeaders) {
    const url = AUTH + method + '?key=' + encodeURIComponent(CFG.apiKey), send = h => http(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: JSON.stringify(body) });
    let r;
    // Sprachkopf für die E-Mail-Vorlage: lehnt der Browser ihn ab (Vorabprüfung), geht es ohne ihn noch einmal
    try { r = await send(extraHeaders); } catch (e) { if (e.code === 'NETWORK' && extraHeaders) r = await send(); else throw e; }
    if (!r.ok) {
      const m = String((r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status)), code = m.split(/[ :]/)[0];
      throw oerr(code === 'API_KEY_INVALID' || /API key/i.test(m) ? 'API_KEY' : code, m);
    }
    return r.json || {};
  }

  // ---------- Sitzung ----------
  let sess = null, profile = null, offset = 0, base = null, refreshing = null, dead = false;
  const subs = new Set();
  const emit = () => { for (const f of subs) { try { f(state()); } catch (e) { console.error(e); } } };
  function persist() { if (sess) ls.set(LSK, JSON.stringify({ uid: sess.uid, email: sess.email, refreshToken: sess.refreshToken, idToken: sess.idToken, exp: sess.exp, verified: !!sess.verified, name: profile ? profile.name : (sess.name || null) })); else ls.del(LSK); }
  function setSession(o, keep) {
    sess = { uid: o.localId || o.user_id || (sess && sess.uid), email: o.email || (sess && sess.email) || '', idToken: o.idToken || o.id_token, refreshToken: o.refreshToken || o.refresh_token,
      exp: Date.now() + (+(o.expiresIn || o.expires_in) || 3600) * 1000, verified: keep && sess ? sess.verified : false, name: keep && sess ? sess.name : null };
    persist();
  }
  function clearSession() { sess = null; profile = null; ls.del(LSK); emit(); }
  function state() {
    return { signedIn: !!sess, uid: sess && sess.uid, email: sess && sess.email, verified: !!(sess && sess.verified), name: profile ? profile.name : (sess && sess.name) || null, profile, hasProfile: !!profile, offset };
  }
  async function fresh() {
    if (!sess) throw oerr('NOT_SIGNED_IN');
    if (sess.exp - Date.now() > 120000) return sess.idToken;
    if (!refreshing) {
      refreshing = (async () => {
        const r = await http(TOKEN + '?key=' + encodeURIComponent(CFG.apiKey), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(sess.refreshToken) });
        if (!r.ok) {
          const m = String((r.json && r.json.error && r.json.error.message) || '');
          if (/TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_REFRESH_TOKEN|CREDENTIAL_MISMATCH/.test(m)) { clearSession(); throw oerr('TOKEN_EXPIRED', m); }
          throw oerr('NETWORK', m || ('HTTP ' + r.status));
        }
        const j = r.json; sess.idToken = j.id_token; sess.refreshToken = j.refresh_token || sess.refreshToken; sess.exp = Date.now() + (+j.expires_in || 3600) * 1000; persist();
      })().finally(() => { refreshing = null; });
    }
    await refreshing;
    return sess.idToken;
  }

  // ---------- Datenbank (REST) ----------
  async function baseUrl() {
    if (base) return base;
    const saved = ls.get(DBK), cands = (saved ? [saved] : []).concat(CFG.db.filter(u => u !== saved));
    let net = 0;
    for (const u of cands) {
      let r;
      try { r = await http(u + '/.json?shallow=true', {}, 12000); } catch (e) { net++; continue; }
      if (r.status === 200 || r.status === 401 || r.status === 403) { base = u; ls.set(DBK, u); return u; }
    }
    throw oerr(net === cands.length ? 'NETWORK' : 'DB_NOT_FOUND');
  }
  // method: GET, PUT, DELETE. auth=false liest ohne Anmeldung (nur dort erlaubt, wo die Regeln es erlauben).
  async function db(method, path, body, o) {
    o = o || {};
    const b = await baseUrl(), q = [];
    if (o.auth !== false) q.push('auth=' + encodeURIComponent(await fresh()));
    if (o.shallow) q.push('shallow=true');
    const r = await http(b + '/' + path.split('/').map(encodeURIComponent).join('/') + '.json' + (q.length ? '?' + q.join('&') : ''), { method, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401 || r.status === 403) throw oerr('PERMISSION_DENIED', (r.json && r.json.error) || '');
    if (r.status === 429 || r.status === 503) throw oerr('QUOTA', r.text);
    if (!r.ok) throw oerr('DB_' + r.status, (r.json && r.json.error) || r.text);
    return r.json;
  }
  const SV = { '.sv': 'timestamp' };

  // Serverzeit: ein Schreibzugriff mit Zeitstempel des Servers liefert die Zeit zurück (Mitte der Laufzeit als Näherung)
  async function syncClock() {
    if (!sess) throw oerr('NOT_SIGNED_IN');
    const t0 = Date.now();
    let v = await db('PUT', 'clock/' + sess.uid, SV);
    const t1 = Date.now();
    if (typeof v !== 'number') v = await db('GET', 'clock/' + sess.uid); // falls die Antwort nur den Platzhalter enthält
    if (typeof v !== 'number') throw oerr('CLOCK');
    offset = v - Math.round((t0 + t1) / 2); emit();
    return { offset, rtt: t1 - t0 };
  }
  const serverNow = () => Date.now() + offset;

  // ---------- Namen ----------
  const NAME_OK = /^[A-Za-zÄÖÜäöüß0-9_-]([A-Za-zÄÖÜäöüß0-9 _-]{1,14})[A-Za-zÄÖÜäöüß0-9_-]$/;
  const nameKey = n => String(n).toLowerCase().replace(/ /g, '_');
  const tidyName = n => String(n || '').replace(/\s+/g, ' ').trim();
  // Namensfilter: Zahlen-Buchstaben-Tricks (4=a, 3=e …) werden mitgeprüft. Die Listen sind bewusst kurz; alles Weitere geht über „Melden“.
  const RESERVED = ['admin', 'administrator', 'moderator', 'support', 'system', 'lastmile', 'claude', 'anthropic', 'server', 'staff', 'team', 'gast', 'guest', 'root', 'null', 'undefined'];
  const RES_SUB = ['lastmile', 'admin', 'moderator'];
  const BAD_SUB = ['nazi', 'hitler', 'fotze', 'wichser', 'scheiss', 'fuck', 'shit', 'bitch', 'nigger', 'nigga', 'neger', 'schwuchtel', 'hurensohn', 'vergewalt', 'pimmel', 'nutte', 'porn', 'ficker', 'ficken', 'spast', 'behindert', 'mongo'];
  const BAD_EXACT = ['sex', 'kz', 'arsch', 'idiot', 'isis', 'heil', 'sieg', 'dumm', 'penis', 'vagina', 'terror', 'hure', 'fick', 'kacke', 'depp'];
  function checkName(raw) {
    const n = tidyName(raw);
    if (n.length < 3) return 'Der Name braucht mindestens 3 Zeichen.';
    if (n.length > 16) return 'Der Name darf höchstens 16 Zeichen haben.';
    if (!NAME_OK.test(n)) return 'Erlaubt sind Buchstaben, Zahlen, Leerzeichen, Unterstrich und Bindestrich (nicht am Anfang oder Ende).';
    const k = nameKey(n).replace(/_/g, '');
    if (!/[a-zäöüß]/.test(k)) return 'Der Name braucht mindestens einen Buchstaben.';
    const flat = k.replace(/-/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
    const stem = flat.replace(/[0-9]+$/, '');
    if (RESERVED.includes(stem) || RES_SUB.some(w => flat.includes(w))) return 'Dieser Name ist reserviert.';
    if (BAD_SUB.some(w => flat.includes(w)) || BAD_EXACT.includes(stem)) return 'Dieser Name ist nicht erlaubt. Bitte wähle einen anderen.';
    return '';
  }
  const ADJ = ['Flinker', 'Schneller', 'Rasanter', 'Wendiger', 'Cooler', 'Kluger', 'Mutiger', 'Fixer', 'Ruhiger', 'Sturer'];
  const NOUN = ['Kurier', 'Bote', 'Radler', 'Fahrer', 'Flitzer', 'Lotse', 'Pedal', 'Express', 'Pizzabote', 'Lieferant'];
  function suggestName() {
    for (let i = 0; i < 40; i++) {
      const n = ADJ[Math.floor(Math.random() * ADJ.length)] + NOUN[Math.floor(Math.random() * NOUN.length)] + (10 + Math.floor(Math.random() * 90));
      if (n.length <= 16 && !checkName(n)) return n;
    }
    return 'Kurier' + (1000 + Math.floor(Math.random() * 9000));
  }
  const mailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

  // ---------- Konto ----------
  async function lookup() {
    const j = await authApi('lookup', { idToken: await fresh() }), u = j.users && j.users[0];
    if (!u) throw oerr('USER_NOT_FOUND');
    sess.verified = !!u.emailVerified; if (u.email) sess.email = u.email; persist();
    return sess.verified;
  }
  async function loadProfile() {
    profile = await db('GET', 'users/' + sess.uid);
    if (profile && typeof profile !== 'object') profile = null;
    persist(); emit();
    if (profile && profile.key) {
      // Ist der Name aus einer unterbrochenen Registrierung noch nicht beansprucht, wird das nachgeholt
      try { const owner = await db('GET', 'names/' + profile.key, undefined, { auth: false }); if (!owner) await db('PUT', 'names/' + profile.key, sess.uid); } catch (e) {}
    }
    return profile;
  }
  async function sendVerify() {
    await authApi('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: await fresh() }, { 'X-Firebase-Locale': 'de' });
  }
  // Legt Einladung, Profil und Namensanspruch an (auch zum Abschluss einer unterbrochenen Registrierung). Wirft bei Fehlern, räumt aber nicht auf.
  async function claim(name, code) {
    const uid = sess.uid, key = nameKey(name);
    try { await db('PUT', 'redeemed/' + uid, String(code).trim().toUpperCase()); }
    catch (e) { throw e.code === 'PERMISSION_DENIED' ? oerr('BAD_CODE') : e; }
    try { await db('PUT', 'users/' + uid, { name, key, created: SV }); }
    catch (e) { throw e.code === 'PERMISSION_DENIED' ? oerr('NAME_TAKEN') : e; }
    try { await db('PUT', 'names/' + key, uid); }
    catch (e) { throw e.code === 'PERMISSION_DENIED' ? oerr('NAME_TAKEN') : e; }
  }
  async function rollbackAll() {
    try { const uid = sess.uid; for (const p of ['names/' + nameKey(pend.name || '_'), 'users/' + uid, 'redeemed/' + uid]) { try { await db('DELETE', p); } catch (e) {} } } catch (e) {}
    try { await authApi('delete', { idToken: await fresh() }); } catch (e) {}
    clearSession();
  }
  let pend = {};
  // Wer hat den Namen? Ohne passende Regeln darf niemand lesen: dann fehlt die Einrichtung der Datenbank.
  async function nameOwner(name) {
    try { return await db('GET', 'names/' + nameKey(name), undefined, { auth: false }); }
    catch (e) { throw e.code === 'PERMISSION_DENIED' ? oerr('RULES') : e; }
  }
  async function register(o) {
    const name = tidyName(o.name), email = String(o.email || '').trim(), pw = String(o.password || ''), code = String(o.code || '').trim();
    const bad = checkName(name); if (bad) { const e = oerr('BAD_NAME'); e.message = bad; throw e; }
    if (!mailOk(email)) throw oerr('INVALID_EMAIL');
    if (pw.length < 8) throw oerr('WEAK_PASSWORD');
    if (!code) throw oerr('BAD_CODE');
    const taken = await nameOwner(name);
    if (taken) throw oerr('NAME_TAKEN');
    const j = await authApi('signUp', { email, password: pw, returnSecureToken: true });
    setSession(j); pend = { name };
    try { await claim(name, code); }
    catch (e) { await rollbackAll(); throw e; }
    profile = { name, key: nameKey(name), created: Date.now() };
    persist(); emit();
    try { await sendVerify(); } catch (e) { console.warn('Bestätigungsmail:', e); }
    try { await loadProfile(); } catch (e) {}
    return state();
  }
  async function completeRegistration(o) {
    if (!sess) throw oerr('NOT_SIGNED_IN');
    const name = tidyName(o.name), code = String(o.code || '').trim();
    const bad = checkName(name); if (bad) { const e = oerr('BAD_NAME'); e.message = bad; throw e; }
    if (!code) throw oerr('BAD_CODE');
    const owner = await nameOwner(name);
    if (owner && owner !== sess.uid) throw oerr('NAME_TAKEN');
    await claim(name, code);
    await loadProfile();
    return state();
  }
  async function login(email, password) {
    email = String(email || '').trim();
    if (!email) throw oerr('MISSING_EMAIL');
    if (!password) throw oerr('MISSING_PASSWORD');
    const j = await authApi('signInWithPassword', { email, password, returnSecureToken: true });
    setSession(j);
    try { await lookup(); } catch (e) {}
    try { await loadProfile(); } catch (e) { if (e.code === 'NETWORK') throw e; }
    emit();
    return state();
  }
  const logout = () => clearSession();
  async function resetPassword(email) {
    email = String(email || '').trim(); if (!mailOk(email)) throw oerr('INVALID_EMAIL');
    try { await authApi('sendOobCode', { requestType: 'PASSWORD_RESET', email }, { 'X-Firebase-Locale': 'de' }); }
    catch (e) { if (e.code !== 'EMAIL_NOT_FOUND') throw e; }
  }
  async function checkVerified() { const v = await lookup(); emit(); return v; }
  // Löscht alle Daten des Kontos und das Konto selbst. Das Passwort wird zur Sicherheit noch einmal abgefragt.
  async function deleteAccount(password) {
    if (!sess) throw oerr('NOT_SIGNED_IN');
    const email = sess.email, uid = sess.uid;
    const j = await authApi('signInWithPassword', { email, password: String(password || ''), returnSecureToken: true });
    setSession(j, true);
    let key = profile && profile.key; if (!key) { try { const p = await db('GET', 'users/' + uid); key = p && p.key; } catch (e) {} }
    // Erst alle Daten, dann das Konto: scheitert ein Schritt, bleibt das Konto bestehen und es kann erneut versucht werden.
    // Ohne Profil (unterbrochene Registrierung) darf der Server manche Löschungen ablehnen, weil es nichts zu löschen gibt.
    const lenient = !key, del = async p => { try { await db('DELETE', p); } catch (e) { if (!(lenient && e.code === 'PERMISSION_DENIED')) throw e; } };
    for (const p of ['saves/' + uid, 'savemeta/' + uid, 'clock/' + uid]) await del(p);
    if (key) await del('names/' + key);
    await del('users/' + uid);
    await del('redeemed/' + uid);
    await authApi('delete', { idToken: await fresh() });
    clearSession();
  }

  // ---------- Cloud-Spielstände ----------
  // Plätze heißen s_<Stadt-Koordinaten>_<Modus>; erlaubt sind nur Buchstaben, Zahlen, _ und -
  const slotOf = localKey => 's_' + String(localKey).replace(/^lm\.save\./, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  async function cloudList() {
    if (!sess) throw oerr('NOT_SIGNED_IN');
    const m = await db('GET', 'savemeta/' + sess.uid) || {};
    return Object.keys(m).map(slot => ({ slot, t: m[slot].t, info: m[slot].info, v: m[slot].v })).sort((a, b) => b.t - a.t);
  }
  async function cloudPut(slot, raw, info, v) {
    if (!sess) throw oerr('NOT_SIGNED_IN');
    await db('PUT', 'saves/' + sess.uid + '/' + slot, { t: SV, v: v || 1, data: raw });
    await db('PUT', 'savemeta/' + sess.uid + '/' + slot, { t: SV, v: v || 1, info: String(info || '').slice(0, 160) });
  }
  async function cloudGet(slot) {
    if (!sess) throw oerr('NOT_SIGNED_IN');
    const d = await db('GET', 'saves/' + sess.uid + '/' + slot);
    if (!d || typeof d.data !== 'string') throw oerr('USER_NOT_FOUND', 'Spielstand nicht gefunden');
    return d;
  }
  async function cloudDel(slot) {
    if (!sess) throw oerr('NOT_SIGNED_IN');
    await db('DELETE', 'saves/' + sess.uid + '/' + slot);
    await db('DELETE', 'savemeta/' + sess.uid + '/' + slot);
  }

  // ---------- Start ----------
  function init() {
    const raw = ls.get(LSK); if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!o || !o.uid || !o.refreshToken) throw 0;
      sess = { uid: o.uid, email: o.email || '', refreshToken: o.refreshToken, idToken: o.idToken || '', exp: +o.exp || 0, verified: !!o.verified, name: o.name || null };
    } catch (e) { ls.del(LSK); return; }
    (async () => { try { await lookup(); await loadProfile(); } catch (e) { if (e.code !== 'NETWORK') console.warn('Konto:', e.code); } emit(); })();
  }

  return {
    CFG, OErr, init, state, on(f) { subs.add(f); return () => subs.delete(f); },
    checkName, suggestName, mailOk, nameKey, tidyName,
    register, completeRegistration, login, logout, resetPassword, sendVerify, checkVerified, loadProfile, deleteAccount,
    syncClock, serverNow, cloud: { slotOf, list: cloudList, put: cloudPut, get: cloudGet, del: cloudDel },
    _db: db
  };
})();
