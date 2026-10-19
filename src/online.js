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
    CLOCK: 'Die Serverzeit konnte nicht gelesen werden.',
    SUPERSEDED: 'Dein Unternehmen wird jetzt in einem anderen Tab oder auf einem anderen Gerät gespielt. Diese Sitzung wurde beendet, damit nichts doppelt gezählt wird.',
    CORRUPT: 'Der gespeicherte Online-Stand ist beschädigt und wurde nicht verändert. Bitte melde das dem Betreiber. Wenn du nicht warten willst, kannst du dein Unternehmen löschen und neu anfangen.',
    RULES_ONLINE: 'Die Datenbank ist noch nicht für den Online-Modus eingerichtet (neue Sicherheitsregeln fehlen). Bitte melde das dem Betreiber.',
    RULES_CLAN: 'Die Datenbank ist noch nicht für Clans eingerichtet (neue Sicherheitsregeln fehlen). Bitte melde das dem Betreiber.',
    CLAN_HAVE: 'Du bist schon in einem Clan. Verlasse ihn zuerst.',
    CLAN_BAD_CODE: 'Diesen Clan-Code gibt es nicht (oder der Code wurde erneuert).',
    CLAN_NAME_TAKEN: 'Dieser Clan-Name ist schon vergeben.',
    CLAN_FULL: 'Dieser Clan ist voll (höchstens 12 Mitglieder).',
    CLAN_OWNER_LEAVE: 'Als Leiter kannst du den Clan erst verlassen, wenn du die Leitung übergeben oder den Clan aufgelöst hast.',
    CLAN_NOT_OWNER: 'Das darf nur der Leiter des Clans.',
    CLAN_GONE: 'Du bist in keinem Clan (mehr).',
    RULES_MOD: 'Meldungen und Sperren sind noch nicht eingerichtet (neue Sicherheitsregeln fehlen). Bitte melde das dem Betreiber.',
    REPORT_DUP: 'Du hast das schon gemeldet. Die Meldung liegt dem Betreiber vor.',
    REPORT_LIMIT: 'Du hast in den letzten 24 Stunden schon 10 Meldungen abgegeben. Bitte versuche es später noch einmal.',
    REPORT_SELF: 'Dich selbst kannst du nicht melden.',
    NOT_ADMIN: 'Dieses Konto ist kein Betreiber-Konto.',
    RENAME_NOT_ALLOWED: 'Umbenennen ist nur möglich, wenn dein Name gesperrt wurde.'
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
  let sess = null, profile = null, blocked = false, adminMemo = false, offset = 0, clockAt = 0, base = null, refreshing = null, dead = false;
  const subs = new Set();
  const emit = () => { for (const f of subs) { try { f(state()); } catch (e) { console.error(e); } } };
  function persist() { if (sess) ls.set(LSK, JSON.stringify({ uid: sess.uid, email: sess.email, refreshToken: sess.refreshToken, idToken: sess.idToken, exp: sess.exp, verified: !!sess.verified, name: profile ? profile.name : (sess.name || null) })); else ls.del(LSK); }
  function setSession(o, keep) {
    sess = { uid: o.localId || o.user_id || (sess && sess.uid), email: o.email || (sess && sess.email) || '', idToken: o.idToken || o.id_token, refreshToken: o.refreshToken || o.refresh_token,
      exp: Date.now() + (+(o.expiresIn || o.expires_in) || 3600) * 1000, verified: keep && sess ? sess.verified : false, name: keep && sess ? sess.name : null };
    persist();
  }
  function clearSession() { sess = null; profile = null; blocked = false; adminMemo = false; blkAt = 0; ls.del(LSK); emit(); }
  function state() {
    return { signedIn: !!sess, uid: sess && sess.uid, blocked, email: sess && sess.email, verified: !!(sess && sess.verified), name: profile ? profile.name : (sess && sess.name) || null, profile, hasProfile: !!profile, offset };
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
    if (o.query) for (const k of Object.keys(o.query)) q.push(k + '=' + encodeURIComponent(o.query[k]));
    const r = await http(b + '/' + path.split('/').map(encodeURIComponent).join('/') + '.json' + (q.length ? '?' + q.join('&') : ''), { method, body: body === undefined ? undefined : JSON.stringify(body), keepalive: !!o.keepalive });
    if (r.status === 401 || r.status === 403) {
      const msg = String((r.json && r.json.error) || '');
      // Abgelaufener Zugangsschlüssel (z. B. nach langer Pause oder bei falsch gehender Uhr): einmal erneuern und wiederholen
      if (/token/i.test(msg) && o.auth !== false && !o.retried && sess) { sess.exp = 0; return db(method, path, body, Object.assign({}, o, { retried: true })); }
      throw oerr('PERMISSION_DENIED', msg);
    }
    if (r.status === 429 || r.status === 503) throw oerr('QUOTA', r.text);
    if (!r.ok) throw oerr('DB_' + r.status, (r.json && r.json.error) || r.text);
    return r.json;
  }
  const SV = { '.sv': 'timestamp' };

  // Serverzeit: ein Schreibzugriff mit Zeitstempel des Servers liefert die Zeit zurück (Mitte der Laufzeit als Näherung).
  // Bei mehreren Messungen gilt die mit der kürzesten Laufzeit, sie ist am genauesten.
  async function syncClock(times) {
    if (!sess) throw oerr('NOT_SIGNED_IN');
    let best = null;
    for (let i = 0; i < (times || 1); i++) {
      const t0 = Date.now();
      let v = await db('PUT', 'clock/' + sess.uid, SV);
      const t1 = Date.now();
      if (typeof v !== 'number') v = await db('GET', 'clock/' + sess.uid); // falls die Antwort nur den Platzhalter enthält
      if (typeof v !== 'number') throw oerr('CLOCK');
      if (!best || t1 - t0 < best.rtt) best = { offset: v - Math.round((t0 + t1) / 2), rtt: t1 - t0 };
    }
    offset = best.offset; clockAt = Date.now(); emit();
    return best;
  }
  const ensureClock = async () => { if (!clockAt) await syncClock(1); };
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
  const badName = msg => { const e = oerr('BAD_NAME'); e.message = msg; return e; };
  // Steht der Name auf der Sperrliste des Betreibers? Ohne die neuen Regeln gibt es keine Liste.
  async function nameBlocked(name) {
    try { return !!(await db('GET', 'blockednames/' + nameKey(name), undefined, { auth: false })); }
    catch (e) { if (e.code === 'PERMISSION_DENIED') return false; throw e; }
  }
  // Gesperrte Namen (vom Betreiber): als Menge von Schlüsseln, 5 Minuten zwischengespeichert. Ohne die neuen Regeln oder offline bleibt die bisherige Liste.
  let blkSet = new Set(), blkAt = 0, blkP = null;
  function blockedSet(force) {
    if (!force && Date.now() - blkAt < 300000) return Promise.resolve(blkSet);
    if (blkP) return blkP;
    blkP = (async () => {
      let ok = true;
      try { const j = await db('GET', 'blockednames'); blkSet = new Set(Object.keys(j || {})); } catch (e) { ok = false; }
      blkAt = ok ? Date.now() : Date.now() - 240000; blkP = null; return blkSet;
    })();
    return blkP;
  }
  const mailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

  // ---------- Konto ----------
  async function lookup() {
    let j;
    try { j = await authApi('lookup', { idToken: await fresh() }); }
    catch (e) { // abgelaufener Zugangsschlüssel (lange Pause, falsch gehende Uhr): einmal erneuern
      if (!/INVALID_ID_TOKEN|TOKEN_EXPIRED/.test(e.code) || !sess) throw e;
      sess.exp = 0; j = await authApi('lookup', { idToken: await fresh() });
    }
    const u = j.users && j.users[0];
    if (!u) throw oerr('USER_NOT_FOUND');
    sess.verified = !!u.emailVerified; if (u.email) sess.email = u.email; persist();
    return sess.verified;
  }
  async function loadProfile() {
    profile = await db('GET', 'users/' + sess.uid);
    if (profile && typeof profile !== 'object') profile = null;
    blocked = false;
    if (profile && profile.key) { try { blocked = !!(await db('GET', 'blockednames/' + profile.key)); } catch (e) { /* ohne die neuen Regeln gibt es keine Sperren */ } }
    persist(); emit();
    if (profile && profile.key && !blocked) {
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
    if (await nameBlocked(name)) throw badName('Dieser Name ist nicht erlaubt. Bitte wähle einen anderen.');
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
    if (await nameBlocked(name)) throw badName('Dieser Name ist nicht erlaubt. Bitte wähle einen anderen.');
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
    // Clan zuerst verlassen: der Leiter gibt die Leitung ab (oder löst den Clan auf, wenn er allein ist). Ohne die Clan-Regeln gibt es keinen Clan.
    try {
      const cm = await clanMine({ code: false });
      if (cm) {
        if (cm.isOwner && cm.members.length > 1) await clanTransfer(cm.members.find(x => x.uid !== uid).uid, cm);
        await clanLeave();
      }
    } catch (e) { if (e.code !== 'RULES_CLAN' && !lenient) throw e; }
    try { await db('DELETE', 'clanof/' + uid); } catch (e) { if (e.code !== 'PERMISSION_DENIED') throw e; }
    for (let i = 0; i < 10; i++) { try { await db('DELETE', 'reports/' + uid + '/s' + i); } catch (e) { if (e.code !== 'PERMISSION_DENIED') throw e; } } // frische Meldungen bleiben bis zur Prüfung beim Betreiber
    // Ranglisteneinträge (Städte der Online-Unternehmen und weltweit), dann Sitzungen, Stände, Uhr
    let metas = {}; try { metas = await db('GET', 'savemeta/' + uid) || {}; } catch (e) { if (!lenient) throw e; }
    for (const slot of Object.keys(metas)) if (slot.startsWith('o_')) for (const sc of ['all', 'day', 'week']) await del('board/' + slot.slice(2) + '/' + sc + '/' + uid);
    for (const sc of ['all', 'day', 'week']) await del('board/_global/' + sc + '/' + uid);
    for (const p of ['sessions/' + uid, 'saves/' + uid, 'savemeta/' + uid, 'clock/' + uid]) await del(p);
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

  // ---------- Online-Welt, Unternehmen und Rangliste ----------
  // Die Weltzeit ist eine feste Funktion der Serverzeit: alle Spieler erleben zur gleichen Sekunde dieselbe Spielzeit.
  // Tempo-Plan: Bis PLAN.from läuft die Zeit 30-fach (wie bisher), danach nach Tageszeit der Spielwelt: tagsüber (h0 bis h1 Uhr) vDay-fach, nachts vNight-fach.
  // So bleiben die Planungs-Abstände im Fulfillment-Betrieb (Tourstarts) länger, die ruhige Nacht ist schnell vorbei. Der Übergang ist stetig (kein Zeitsprung).
  // Tests: window.__LM_PLAN = 'legacy' (immer 30-fach) oder ein eigener Plan { from (Sekunden seit epoch), h0, h1, vDay, vNight }.
  const ONLINE = { speed: 30, epoch: Date.UTC(2026, 9, 1) / 1000, maxAway: 3600, shift: 7200000 };
  const PLAN0 = { from: Date.UTC(2026, 9, 20, 4, 0, 0) / 1000 - ONLINE.epoch, h0: 5, h1: 22, vDay: 15, vNight: 60 };   // 20.10.2026, 04:00 UTC = Spielmitternacht
  function mkClock(p) {
    const LEG = ONLINE.speed;
    if (!p || !(p.h0 >= 0 && p.h1 > p.h0 && p.h1 <= 24 && p.vDay > 0 && p.vNight > 0 && isFinite(p.from))) return { plan: null, gameAt: r => r * LEG, realAt: g => g / LEG, speedAt: () => LEG };
    const a = p.h0 * 3600, b = p.h1 * 3600, vD = p.vDay, vN = p.vNight, ra = a / vN, rb = ra + (b - a) / vD, Pd = rb + (86400 - b) / vN;
    const Rday = x => x <= a ? x / vN : x <= b ? ra + (x - a) / vD : rb + (x - b) / vN;                       // echte Sekunden vom Tagesbeginn bis zur Tageszeit x (Spielsekunden)
    const RdayInv = r => r <= ra ? r * vN : r <= rb ? a + (r - ra) * vD : b + (r - rb) * vN;
    const R = g => { const c = Math.floor(g / 86400); return c * Pd + Rday(g - c * 86400); };
    const Rinv = r => { const c = Math.floor(r / Pd); return c * 86400 + RdayInv(r - c * Pd); };
    const r0 = p.from, g0 = r0 * LEG, R0 = R(g0);
    return { plan: { from: r0, h0: p.h0, h1: p.h1, vDay: vD, vNight: vN },
      gameAt: r => r < r0 ? r * LEG : Rinv(r - r0 + R0),                                                // r: echte Sekunden seit epoch
      realAt: g => g < g0 ? g / LEG : r0 + R(g) - R0,
      speedAt: g => { const x = ((g % 86400) + 86400) % 86400; return x >= a && x < b ? vD : vN; } };
  }
  const planOvr = (() => { try { return typeof __LM_PLAN !== 'undefined' ? __LM_PLAN : undefined; } catch (e) { return undefined; } })();
  const CLOCK = mkClock(planOvr === 'legacy' ? null : planOvr && typeof planOvr === 'object' ? Object.assign({}, PLAN0, planOvr) : PLAN0);
  const gameAt = ms => CLOCK.gameAt(ms / 1000 - ONLINE.epoch);
  const gameNow = () => gameAt(serverNow());
  // Spielsekunden, die in den letzten x echten Sekunden vergangen sind; echte Sekunden zwischen zwei Spielzeiten
  const cover = x => { const r = serverNow() / 1000 - ONLINE.epoch; return CLOCK.gameAt(r) - CLOCK.gameAt(r - x); };
  const realSpan = (g0, g1) => CLOCK.realAt(g1) - CLOCK.realAt(g0);
  // Tage und Wochen der Rangliste beginnen um 02:00 UTC (Woche: Montag), damit die Grenze mitten in der Nacht liegt
  function period(scope, ms) {
    if (scope === 'all') return 0;
    const d = ((ms === undefined ? serverNow() : ms) - ONLINE.shift) / 86400000;
    return scope === 'day' ? Math.floor(d) : Math.floor((d + 3) / 7);
  }
  const ckOf = (lat, lon) => (Number(lat).toFixed(3) + ',' + Number(lon).toFixed(3)).replace(/[^A-Za-z0-9_-]/g, '_');
  const newSess = () => { const a = new Uint8Array(12); try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); } return Array.from(a, b => b.toString(36).padStart(2, '0')).join('').slice(0, 20); };
  const needProfile = () => { if (!sess) throw oerr('NOT_SIGNED_IN'); if (!profile) throw oerr('NO_PROFILE'); };

  // Öffnet das Online-Unternehmen einer Stadt: Serverzeit messen, Stand aus der Cloud lesen und die Sitzung übernehmen.
  // Wer das Unternehmen gerade woanders spielt, wird beim nächsten Speichern dort beendet (Fehler SUPERSEDED).
  async function companyOpen(ck) {
    needProfile();
    await syncClock(3);
    const slot = 'o_' + ck, uid = sess.uid;
    let cur, sv;
    try { [cur, sv] = await Promise.all([db('GET', 'sessions/' + uid + '/' + slot), db('GET', 'saves/' + uid + '/' + slot)]); }
    catch (e) { throw e.code === 'PERMISSION_DENIED' ? oerr('RULES_ONLINE') : e; } // ohne die neuen Regeln darf „sessions“ nicht gelesen werden
    const mine = newSess();
    try { await db('PUT', 'sessions/' + uid + '/' + slot, { sess: mine, t: SV }); }
    catch (e) { throw e.code === 'PERMISSION_DENIED' ? oerr('RULES_ONLINE') : e; }
    return { ck, slot, sess: mine, prev: cur && cur.sess || null, raw: sv && typeof sv.data === 'string' ? sv.data : null, t: sv && typeof sv.t === 'number' ? sv.t : null, now: serverNow() };
  }
  async function companyPush(slot, mine, raw, info, opt) {
    needProfile(); const uid = sess.uid;
    try {
      await db('PUT', 'saves/' + uid + '/' + slot, { t: SV, v: 2, sess: mine, data: raw }, { keepalive: !!(opt && opt.keepalive) });
      await db('PUT', 'savemeta/' + uid + '/' + slot, { t: SV, v: 2, info: String(info || '').slice(0, 160) }, { keepalive: !!(opt && opt.keepalive) });
    } catch (e) {
      if (e.code === 'PERMISSION_DENIED') {
        let cur; try { cur = await db('GET', 'sessions/' + uid + '/' + slot); } catch (e2) { cur = undefined; }
        if (cur !== undefined && !(cur && cur.sess === mine)) throw oerr('SUPERSEDED');
      }
      throw e;
    }
  }
  // Das Unternehmen des Kontos = das zuletzt gespeicherte Online-Unternehmen (ein Konto, ein Spielstand). Ältere Konten mit mehreren behalten das zuletzt gespielte; die anderen bleiben unangetastet in der Cloud.
  async function companyMine() {
    const list = (await cloudList()).filter(x => /^o_/.test(x.slot) && typeof x.t === 'number').sort((a, b) => b.t - a.t);
    const x = list[0]; if (!x) return null;
    const ck = x.slot.slice(2), parts = ck.split('_'), info = String(x.info || '').split(' · ');
    const lat = parts.length === 4 ? +(parts[0] + '.' + parts[1]) : NaN, lon = parts.length === 4 ? +(parts[2] + '.' + parts[3]) : NaN;
    return { ck, slot: x.slot, name: info[1] || 'Stadt', info: x.info || '', t: x.t, lat, lon, others: list.length - 1 };
  }
  // Alle Online-Unternehmen des Kontos löschen („Neu anfangen“). Gibt die Zahl der gelöschten zurück.
  async function companyRemoveAll() {
    const list = (await cloudList()).filter(x => /^o_/.test(x.slot));
    for (const x of list) await companyRemove(x.slot.slice(2));
    return list.length;
  }
  async function companyRemove(ck) {
    needProfile(); const uid = sess.uid, slot = 'o_' + ck;
    for (const sc of ['all', 'day', 'week']) await db('DELETE', 'board/' + ck + '/' + sc + '/' + uid);
    await db('DELETE', 'saves/' + uid + '/' + slot);
    await db('DELETE', 'savemeta/' + uid + '/' + slot);
    await db('DELETE', 'sessions/' + uid + '/' + slot);
    boardCache.delete(ck);
  }

  // Rangliste. Eintrag je Spieler und Stadt: n Name, c Stadt, g Wachstum, l Lieferungen, r Ruf, p Zeitraum, t Serverzeit.
  // g und l sind Höchstwerte des Zeitraums (sie sinken nie); die Regeln prüfen Name, Zeitraum und plausible Zuwächse.
  const boardCache = new Map();
  const r2 = v => Math.round(v * 100) / 100;
  async function boardMine(ck) {
    let c = boardCache.get(ck); if (c) return c;
    needProfile(); const uid = sess.uid; c = { city: {}, glob: {} };
    await Promise.all(['all', 'day', 'week'].map(async sc => {
      c.city[sc] = await db('GET', 'board/' + ck + '/' + sc + '/' + uid);
      c.glob[sc] = await db('GET', 'board/_global/' + sc + '/' + uid);
    }));
    boardCache.set(ck, c); return c;
  }
  // st = { city: 'Essen', l: Lieferungen, r: Ruf, g: { all, day, week } }
  async function boardSubmit(ck, st) {
    needProfile(); const uid = sess.uid, name = profile.name, c = await boardMine(ck), ms = serverNow(), done = [];
    let firstErr = null;
    const put = async (path, e, store, sc) => {
      try { await db('PUT', path, e); store[sc] = Object.assign({}, e, { t: ms }); done.push(path); }
      catch (err) { if (err.code === 'PERMISSION_DENIED') boardCache.delete(ck); if (!firstErr) firstErr = err; }
    };
    for (const sc of ['all', 'day', 'week']) {
      const p = period(sc, ms), g = st.g[sc], l = Math.max(0, Math.round(st.l || 0)), all = sc === 'all';
      // Lieferungen und Ruf stehen nur in der Gesamtliste; Tag und Woche zählen allein das Wachstum
      if (!(g > 0) && !(all && l > 0)) continue;
      const cur = c.city[sc], same = cur && cur.p === p;
      if (!same || g > cur.g || cur.n !== name || (all && l > (cur.l || 0))) {
        const e = { n: name, c: String(st.city || '').slice(0, 40), g: r2(Math.max(0, g, same ? cur.g : 0)), p, t: SV };
        if (all) { e.l = Math.max(l, same ? (cur.l || 0) : 0); e.r = Math.min(5, Math.max(1, r2(st.r || 3))); }
        await put('board/' + ck + '/' + sc + '/' + uid, e, c.city, sc);
      }
      const gc = c.glob[sc];
      if (g > 0 && (!gc || gc.p !== p || gc.n !== name || g > gc.g)) {
        await put('board/_global/' + sc + '/' + uid, { n: name, c: String(st.city || '').slice(0, 40), g: r2(g), p, t: SV }, c.glob, sc);
      }
    }
    if (firstErr) throw firstErr;
    return done;
  }
  // Spitzenliste: Gesamt nach Wachstum, Lieferungen oder Ruf; Tag und Woche nach Wachstum im laufenden Zeitraum
  async function boardTop(ck, scope, metric, n) {
    needProfile(); n = n || 25; metric = metric || 'g';
    const path = 'board/' + ck + '/' + scope;
    const j = scope === 'all' ? await db('GET', path, undefined, { query: { orderBy: '"' + metric + '"', limitToLast: n } })
      : await db('GET', path, undefined, { query: { orderBy: '"p"', equalTo: period(scope) } });
    const rows = Object.keys(j || {}).map(uid => { const e = j[uid] || {}; return { uid, name: String(e.n || '?'), city: e.c || '', g: +e.g || 0, l: +e.l || 0, r: +e.r || 0, t: e.t }; });
    const key = scope === 'all' ? metric : 'g';
    const hide = await blockedSet();
    return rows.filter(x => typeof x[key] === 'number' && x[key] > 0 && !hide.has(nameKey(x.name))).sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name)).slice(0, n);
  }
  async function boardRank(ck) {
    const rows = await boardTop(ck, 'all', 'g', 100), i = rows.findIndex(x => x.uid === (sess && sess.uid));
    return { rank: i < 0 ? null : i + 1, total: rows.length, full: rows.length >= 100 };
  }

  // ---------- Clans ----------
  // Ein Clan hat einen Leiter, einen geheimen Beitrittscode (8 Zeichen) und höchstens 12 Mitglieder (es zählen die zuerst beigetretenen).
  // clans/<id>: Name, Leiter · members/<id>/<uid>: Mitglied samt Beitrag zur Wertung · clanof/<uid>: eigener Clan
  // clanboard/<Zeitraum>/<id>: Wertung (Summe der Beiträge) · clancodes/<Code>: Clan-Id · clansecret/<id>: der Code, nur für Mitglieder
  const CLAN_CAP = 12, CODE_CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', ID_CH = 'abcdefghijkmnpqrstuvwxyz23456789', SCOPES = ['all', 'day', 'week'];
  const rnd = (alpha, n) => { const a = new Uint8Array(n); try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); } return Array.from(a, b => alpha[b % alpha.length]).join(''); };
  const fmtCode = c => 'CL-' + c.slice(0, 4) + '-' + c.slice(4);
  const normCode = s => { s = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return s.length === 10 && s.startsWith('CL') ? s.slice(2) : s; };
  const ruleErr = (e, code) => e && e.code === 'PERMISSION_DENIED' ? oerr(code || 'RULES_CLAN') : e;
  const lastPut = {}; // zuletzt geschriebene Wertung je Zeitraum, damit nichts unnötig neu geschrieben wird
  async function clanMine(o) {
    needProfile(); const uid = sess.uid; o = o || {};
    const hideP = blockedSet(); // läuft nebenher (meist aus dem Zwischenspeicher)
    await ensureClock();
    let cid; try { cid = await db('GET', 'clanof/' + uid); } catch (e) { throw ruleErr(e); }
    if (!cid) return null;
    let mem; try { mem = await db('GET', 'members/' + cid); } catch (e) { if (e.code !== 'PERMISSION_DENIED') throw e; mem = undefined; }
    if (!mem || !mem[uid]) { try { await db('DELETE', 'clanof/' + uid); } catch (e) {} return null; } // entfernt worden oder Clan aufgelöst: Zeiger aufräumen
    const [cl, code] = await Promise.all([db('GET', 'clans/' + cid), o.code === false ? null : db('GET', 'clansecret/' + cid)]);
    if (!cl) { // Auflösung wurde unterbrochen: eigenen Rest wegräumen
      try { await db('DELETE', 'members/' + cid + '/' + uid); await db('DELETE', 'clanof/' + uid); } catch (e) {}
      return null;
    }
    const hide = await hideP;
    const members = Object.keys(mem).map(u => { const x = mem[u] || {}; return { uid: u, name: hide.has(nameKey(x.n || '')) ? 'Gesperrter Name' : String(x.n || '?'), hidden: hide.has(nameKey(x.n || '')), raw: String(x.n || ''), t: +x.t || 0, k: x.k, a: x.a, d: x.d, pd: x.pd, w: x.w, pw: x.pw }; })
      .sort((x, y) => x.t - y.t || (x.uid < y.uid ? -1 : 1));
    return { cid, name: cl.n, key: cl.k, owner: cl.o, isOwner: cl.o === uid, code: typeof code === 'string' ? code : null, members, cap: CLAN_CAP };
  }
  async function undoAll(done) { for (const p of done.slice().reverse()) { try { await db('DELETE', p); } catch (e) {} } }
  async function clanCreate(rawName) {
    needProfile(); const uid = sess.uid, name = tidyName(rawName);
    const bad = checkName(name); if (bad) { const e = oerr('BAD_NAME'); e.message = bad.replace('Der Name', 'Der Clan-Name').replace('Dieser Name', 'Dieser Clan-Name'); throw e; }
    if (await clanMine({ code: false })) throw oerr('CLAN_HAVE');
    const key = nameKey(name);
    let taken, blk; try { [taken, blk] = await Promise.all([db('GET', 'clannames/' + key), nameBlocked(name)]); } catch (e) { throw ruleErr(e); }
    if (taken) throw oerr('CLAN_NAME_TAKEN');
    if (blk) throw badName('Dieser Clan-Name ist nicht erlaubt. Bitte wähle einen anderen.');
    const cid = rnd(ID_CH, 16), code = rnd(CODE_CH, 8), done = [];
    const put = async (path, val, onDenied) => { try { await db('PUT', path, val); done.push(path); } catch (e) { await undoAll(done); throw ruleErr(e, onDenied || 'PERMISSION_DENIED'); } };
    await put('clans/' + cid, { n: name, k: key, o: uid, t: SV }, 'CLAN_NAME_TAKEN');
    await put('clannames/' + key, cid, 'CLAN_NAME_TAKEN');
    await put('clansecret/' + cid, code);
    await put('clancodes/' + code, cid);
    await put('clanof/' + uid, cid);
    await put('members/' + cid + '/' + uid, { n: profile.name, t: SV, k: code });
    return clanMine();
  }
  async function clanJoin(rawCode) {
    needProfile(); const uid = sess.uid, code = normCode(rawCode);
    if (!/^[A-Z2-9]{8}$/.test(code)) throw oerr('CLAN_BAD_CODE');
    if (await clanMine({ code: false })) throw oerr('CLAN_HAVE');
    let cid; try { cid = await db('GET', 'clancodes/' + code); } catch (e) { throw ruleErr(e); }
    if (!cid) throw oerr('CLAN_BAD_CODE');
    let cl; try { cl = await db('GET', 'clans/' + cid); } catch (e) { throw ruleErr(e); }
    if (!cl) throw oerr('CLAN_BAD_CODE');
    try { await db('PUT', 'clanof/' + uid, cid); } catch (e) { throw ruleErr(e, 'PERMISSION_DENIED'); }
    try { await db('PUT', 'members/' + cid + '/' + uid, { n: profile.name, t: SV, k: code }); }
    catch (e) { try { await db('DELETE', 'clanof/' + uid); } catch (e2) {} throw ruleErr(e, 'CLAN_BAD_CODE'); }
    // Platz prüfen: wer nach den ersten 12 beigetreten ist, tritt wieder aus
    const m = await clanMine({ code: false });
    if (!m || m.members.findIndex(x => x.uid === uid) >= CLAN_CAP) {
      try { await db('DELETE', 'members/' + cid + '/' + uid); await db('DELETE', 'clanof/' + uid); } catch (e) {}
      throw oerr('CLAN_FULL');
    }
    return clanMine();
  }
  async function clanLeave() {
    const m = await clanMine({ code: false }); if (!m) return;
    if (m.isOwner && m.members.length > 1) throw oerr('CLAN_OWNER_LEAVE');
    if (m.isOwner) return clanDisband(m);
    await db('DELETE', 'members/' + m.cid + '/' + sess.uid); await db('DELETE', 'clanof/' + sess.uid);
    for (const sc of SCOPES) delete lastPut[sc];
  }
  // Auflösen (Leiter): erst Wertung und Mitglieder, ganz zuletzt der Clan selbst (er belegt, wer Leiter ist). Die Zeiger der anderen Mitglieder räumen diese selbst auf.
  async function clanDisband(m) {
    m = m || await clanMine(); if (!m) throw oerr('CLAN_GONE'); if (!m.isOwner) throw oerr('CLAN_NOT_OWNER');
    const uid = sess.uid;
    for (const sc of SCOPES) await db('DELETE', 'clanboard/' + sc + '/' + m.cid);
    for (const x of m.members) if (x.uid !== uid) await db('DELETE', 'members/' + m.cid + '/' + x.uid);
    await db('DELETE', 'members/' + m.cid + '/' + uid); await db('DELETE', 'clanof/' + uid);
    if (m.code) await db('DELETE', 'clancodes/' + m.code);
    await db('DELETE', 'clansecret/' + m.cid); await db('DELETE', 'clannames/' + m.key); await db('DELETE', 'clans/' + m.cid);
    for (const sc of SCOPES) delete lastPut[sc];
  }
  async function clanKick(uid2) {
    const m = await clanMine({ code: false }); if (!m) throw oerr('CLAN_GONE'); if (!m.isOwner) throw oerr('CLAN_NOT_OWNER');
    if (uid2 === sess.uid) throw oerr('CLAN_OWNER_LEAVE');
    await db('DELETE', 'members/' + m.cid + '/' + uid2);
  }
  async function clanTransfer(uid2, m) {
    m = m || await clanMine({ code: false }); if (!m) throw oerr('CLAN_GONE'); if (!m.isOwner) throw oerr('CLAN_NOT_OWNER');
    await db('PUT', 'clans/' + m.cid + '/o', uid2);
  }
  // Neuer Code, der alte gilt nicht mehr (bisherige Mitglieder bleiben)
  async function clanRenew() {
    const m = await clanMine(); if (!m) throw oerr('CLAN_GONE'); if (!m.isOwner) throw oerr('CLAN_NOT_OWNER');
    const code = rnd(CODE_CH, 8);
    await db('PUT', 'clansecret/' + m.cid, code);
    try { await db('PUT', 'clancodes/' + code, m.cid); }
    catch (e) { try { await db('PUT', 'clansecret/' + m.cid, m.code); } catch (e2) {} throw e; }
    if (m.code) { try { await db('DELETE', 'clancodes/' + m.code); } catch (e) {} }
    return code;
  }
  async function clanMyId() { needProfile(); try { return await db('GET', 'clanof/' + sess.uid); } catch (e) { throw ruleErr(e); } }
  // Beiträge der Mitglieder zusammenzählen: Tag und Woche nur, wenn der Beitrag aus dem laufenden Zeitraum stammt
  function clanRows(m, ms) {
    const pd = period('day', ms), pw = period('week', ms), total = { all: 0, day: 0, week: 0 };
    const rows = m.members.map((x, i) => {
      const r = { uid: x.uid, name: x.name, hidden: !!x.hidden, all: +x.a || 0, day: x.pd === pd ? (+x.d || 0) : 0, week: x.pw === pw ? (+x.w || 0) : 0, owner: x.uid === m.owner, counts: i < CLAN_CAP };
      if (r.counts) { total.all += r.all; total.day += r.day; total.week += r.week; }
      return r;
    }).sort((a, b) => b.all - a.all || a.name.localeCompare(b.name));
    return { rows, total, count: Math.min(m.members.length, CLAN_CAP) };
  }
  // Eigenen Beitrag aus den (schon geprüften) weltweiten Ranglisteneinträgen übernehmen und die Wertung des Clans schreiben.
  // Liefert { m, rows, total, count } oder null, wenn man in keinem Clan ist.
  async function clanRefresh() {
    needProfile(); const uid = sess.uid, name = profile.name;
    const m = await clanMine(); if (!m) return null;
    const gl = {}; await Promise.all(SCOPES.map(async sc => { gl[sc] = await db('GET', 'board/_global/' + sc + '/' + uid); }));
    const me = m.members.find(x => x.uid === uid), want = {};
    const num = v => typeof v === 'number' ? v : undefined;
    if (num(gl.all && gl.all.g) !== undefined) want.a = gl.all.g;
    if (num(gl.day && gl.day.g) !== undefined) { want.d = gl.day.g; want.pd = gl.day.p; }
    if (num(gl.week && gl.week.g) !== undefined) { want.w = gl.week.g; want.pw = gl.week.p; }
    let firstErr = null;
    if (me && (me.raw !== name || Object.keys(want).some(k => me[k] !== want[k]))) {
      try { await db('PUT', 'members/' + m.cid + '/' + uid, Object.assign({ n: name, t: me.t, k: m.code || me.k }, want)); Object.assign(me, want); }
      catch (e) { firstErr = e; }
    }
    const ms = serverNow(), res = clanRows(m, ms);
    for (const sc of SCOPES) {
      const g = r2(res.total[sc]), p = period(sc, ms), lp = lastPut[sc];
      if (g <= 0 && !lp) continue;
      if (lp && lp.cid === m.cid && lp.g === g && lp.m === res.count && lp.p === p && lp.n === m.name && ms - lp.at < 1800000) continue;
      try { await db('PUT', 'clanboard/' + sc + '/' + m.cid, { n: m.name, g, m: res.count, p, t: SV }); lastPut[sc] = { cid: m.cid, g, m: res.count, p, n: m.name, at: ms }; }
      catch (e) { if (!firstErr) firstErr = e; }
    }
    return Object.assign({ m, err: firstErr }, res);
  }
  // Clan-Rangliste: Gesamt nach Summe, Tag und Woche nur Einträge des laufenden Zeitraums
  async function clanTop(scope, n) {
    needProfile(); n = n || 25; await ensureClock();
    const path = 'clanboard/' + scope; let j;
    try {
      j = scope === 'all' ? await db('GET', path, undefined, { query: { orderBy: '"g"', limitToLast: n } })
        : await db('GET', path, undefined, { query: { orderBy: '"p"', equalTo: period(scope) } });
    } catch (e) { throw ruleErr(e); }
    const hide = await blockedSet();
    return Object.keys(j || {}).map(cid => { const e = j[cid] || {}; return { cid, name: String(e.n || '?'), g: +e.g || 0, m: +e.m || 0, t: e.t }; })
      .filter(x => x.g > 0 && !hide.has(nameKey(x.name))).sort((a, b) => b.g - a.g || a.name.localeCompare(b.name)).slice(0, n);
  }

  // ---------- Sperren, Melden, Betreiber ----------
  // Ist der eigene Name gesperrt? Liest Profil und Sperrliste neu; offline bleibt der bisherige Stand.
  async function checkBlocked() {
    if (!sess || !profile) return false;
    try { await loadProfile(); } catch (e) { if (e.code !== 'NETWORK') console.warn('Sperre:', e.code); }
    return blocked;
  }
  // Wer gesperrt wurde, darf (nur dann) den Namen ändern. Das Unternehmen und alle Stände bleiben erhalten.
  async function rename(raw) {
    needProfile(); const uid = sess.uid, name = tidyName(raw), key = nameKey(name);
    await checkBlocked();
    if (!blocked) throw oerr('RENAME_NOT_ALLOWED');
    const bad = checkName(name); if (bad) throw badName(bad);
    if (key === profile.key) throw badName('Bitte wähle einen anderen Namen als bisher.');
    const owner = await nameOwner(name);
    if (owner && owner !== uid) throw oerr('NAME_TAKEN');
    if (await nameBlocked(name)) throw badName('Dieser Name ist nicht erlaubt. Bitte wähle einen anderen.');
    const u = await db('GET', 'users/' + uid);
    if (!u || typeof u.created !== 'number' || !u.key) throw oerr('NO_PROFILE');
    // Reihenfolge ist durch die Regeln vorgegeben: erst das Profil, dann der Namensanspruch, zuletzt der alte Anspruch weg
    try { await db('PUT', 'users/' + uid, { name, key, created: u.created }); } catch (e) { throw e.code === 'PERMISSION_DENIED' ? oerr('NAME_TAKEN') : e; }
    try { await db('PUT', 'names/' + key, uid); } catch (e) { throw e.code === 'PERMISSION_DENIED' ? oerr('NAME_TAKEN') : e; }
    try { await db('DELETE', 'names/' + u.key); } catch (e) { console.warn('Alter Namensanspruch:', e.code); }
    profile = { name, key, created: u.created }; blocked = false; persist();
    boardCache.clear(); for (const sc of SCOPES) delete lastPut[sc];
    emit();
    await boardsRename(name);
    try { await clanRefresh(); } catch (e) { console.warn('Clan nach Umbenennen:', e.code); }
    return state();
  }
  // Eigene Ranglisteneinträge mit dem neuen Namen neu schreiben (gleiche Werte). Nicht gelingende Einträge holt das normale Spielen nach.
  async function boardsRename(name) {
    const uid = sess.uid, ms = serverNow(); let metas = {};
    try { metas = await db('GET', 'savemeta/' + uid) || {}; } catch (e) { return; }
    const cks = ['_global'].concat(Object.keys(metas).filter(x => x.startsWith('o_')).map(x => x.slice(2)));
    const jobs = []; for (const ck of cks) for (const sc of SCOPES) jobs.push([ck, sc]);
    await Promise.all(jobs.map(async ([ck, sc]) => {
      try {
        const path = 'board/' + ck + '/' + sc + '/' + uid, e = await db('GET', path);
        if (!e || e.n === name || (sc !== 'all' && e.p !== period(sc, ms))) return; // alte Zeiträume werden ohnehin nicht angezeigt
        await db('PUT', path, Object.assign({}, e, { n: name, t: SV }));
      } catch (e) { /* wird beim nächsten Spielen nachgeholt */ }
    }));
  }

  const REASONS = [['beleidigung', 'Beleidigend oder vulgär'], ['hass', 'Hass, Extremismus'], ['echt', 'Echter Name oder persönliche Daten'], ['imitation', 'Gibt sich als Betreiber oder andere Person aus'], ['sonst', 'Sonstiges']];
  const modErr = e => e && e.code === 'PERMISSION_DENIED' ? oerr('RULES_MOD') : e;
  // Meldung abgeben. target = { k: 'p' (Spieler) | 'c' (Clan), id, name }. Je Konto höchstens 10 Meldungen innerhalb von 24 Stunden.
  async function modReport(target, reason) {
    needProfile(); const uid = sess.uid;
    if (!target || (target.k !== 'p' && target.k !== 'c') || !/^[A-Za-z0-9]{12,40}$/.test(String(target.id || '')) || !REASONS.some(r => r[0] === reason)) throw oerr('PERMISSION_DENIED', 'Meldung unvollständig');
    if (target.id === uid) throw oerr('REPORT_SELF');
    await ensureClock();
    let mine; try { mine = await db('GET', 'reports/' + uid); } catch (e) { throw modErr(e); }
    mine = mine || {};
    const slots = Object.keys(mine);
    if (slots.some(x => mine[x] && mine[x].k === target.k && mine[x].id === target.id)) throw oerr('REPORT_DUP');
    const ms = serverNow(); let slot = null, oldest = Infinity;
    for (let i = 0; i < 10; i++) {
      const e = mine['s' + i];
      if (!e) { slot = 's' + i; break; }
      const t = +e.t || 0; if (t < ms - 86400000 && t < oldest) { oldest = t; slot = 's' + i; } // nur Plätze, die älter als 24 Stunden sind (so verlangen es die Regeln)
    }
    if (!slot) throw oerr('REPORT_LIMIT');
    try { await db('PUT', 'reports/' + uid + '/' + slot, { k: target.k, id: target.id, n: String(target.name || '?').slice(0, 20), r: reason, t: SV }); }
    catch (e) { throw modErr(e); }
  }
  // Betreiber? Wird in der Datenbank von Hand eingetragen (admins/<uid> = true) und hier nur gelesen.
  async function isAdmin() {
    if (!sess) return false;
    if (adminMemo) return true;
    try { adminMemo = !!(await db('GET', 'admins/' + sess.uid)); }
    catch (e) { adminMemo = false; } // ohne die neuen Regeln oder offline: kein Betreiber. Nur ein „Ja“ wird gemerkt, damit ein frischer Eintrag sofort wirkt.
    return adminMemo;
  }
  const needAdmin = async () => { needProfile(); if (!(await isAdmin())) throw oerr('NOT_ADMIN'); };
  // Alle Meldungen, zusammengefasst je gemeldetem Spieler oder Clan
  async function modReports() {
    await needAdmin();
    let all; try { all = await db('GET', 'reports'); } catch (e) { throw modErr(e); }
    const groups = new Map();
    for (const rep of Object.keys(all || {})) for (const slot of Object.keys(all[rep] || {})) {
      const e = all[rep][slot]; if (!e || !e.id) continue;
      const gk = e.k + ':' + e.id; let g = groups.get(gk);
      if (!g) { g = { k: e.k, id: e.id, name: '', count: 0, reasons: {}, last: 0, refs: [] }; groups.set(gk, g); }
      g.count++; g.reasons[e.r] = (g.reasons[e.r] || 0) + 1; g.refs.push({ uid: rep, slot });
      if ((+e.t || 0) >= g.last) { g.last = +e.t || 0; g.name = String(e.n || '?'); }
    }
    const hide = await blockedSet(true), out = [...groups.values()];
    await Promise.all(out.map(async g => {
      const key = nameKey(g.name); g.key = key; g.blocked = hide.has(key);
      try {
        if (g.k === 'p') g.status = (await db('GET', 'names/' + key)) === g.id ? 'current' : 'changed';
        else { const c = await db('GET', 'clans/' + g.id); g.status = !c ? 'gone' : (c.k === key ? 'current' : 'changed'); }
      } catch (e) { g.status = 'unknown'; }
    }));
    return out.sort((a, b) => b.count - a.count || b.last - a.last);
  }
  async function modDismiss(g) {
    await needAdmin();
    for (const r of g.refs) await db('DELETE', 'reports/' + r.uid + '/' + r.slot);
  }
  // Name sperren (für Spieler und Clans). Ein gemeldeter Clan wird zusätzlich aufgelöst; seine Mitglieder räumen ihre Zeiger beim nächsten Öffnen selbst weg.
  async function modBlock(g) {
    await needAdmin();
    const key = nameKey(g.name);
    try { await db('PUT', 'blockednames/' + key, SV); } catch (e) { throw modErr(e); }
    blkSet.add(key);
    if (g.k === 'c') {
      const delIf = async p => { if ((await db('GET', p)) != null) await db('DELETE', p); };
      for (const sc of SCOPES) await delIf('clanboard/' + sc + '/' + g.id);
      await delIf('clannames/' + key); await delIf('clans/' + g.id);
    }
    await modDismiss(g);
  }
  async function modBlockedList() {
    await needAdmin();
    let j; try { j = await db('GET', 'blockednames'); } catch (e) { throw modErr(e); }
    return Object.keys(j || {}).map(key => ({ key, t: +j[key] || 0 })).sort((a, b) => b.t - a.t || (a.key < b.key ? -1 : 1));
  }
  async function modUnblock(key) {
    await needAdmin();
    await db('DELETE', 'blockednames/' + key); blkSet.delete(key);
  }

  // ---------- Start ----------
  let readyP = Promise.resolve();
  function init() {
    const raw = ls.get(LSK); if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (!o || !o.uid || !o.refreshToken) throw 0;
      sess = { uid: o.uid, email: o.email || '', refreshToken: o.refreshToken, idToken: o.idToken || '', exp: +o.exp || 0, verified: !!o.verified, name: o.name || null };
    } catch (e) { ls.del(LSK); return; }
    readyP = (async () => {
      try { await lookup(); } catch (e) { if (e.code !== 'NETWORK') console.warn('Konto:', e.code); }
      if (sess) { try { await loadProfile(); } catch (e) { if (e.code !== 'NETWORK') console.warn('Konto:', e.code); } }
      emit();
    })();
  }

  return {
    CFG, OErr, init, ready: () => readyP, state, on(f) { subs.add(f); return () => subs.delete(f); },
    checkName, suggestName, mailOk, nameKey, tidyName,
    register, completeRegistration, login, logout, resetPassword, sendVerify, checkVerified, loadProfile, deleteAccount,
    syncClock, serverNow, cloud: { slotOf, list: cloudList, put: cloudPut, get: cloudGet, del: cloudDel },
    world: { speed: ONLINE.speed, maxAway: ONLINE.maxAway, epoch: ONLINE.epoch, gameNow, gameAt, cover, realSpan, speedAt: g => CLOCK.speedAt(g), plan: CLOCK.plan, period, ckOf },
    company: { open: companyOpen, push: companyPush, remove: companyRemove, removeAll: companyRemoveAll, mine: companyMine },
    board: { submit: boardSubmit, top: boardTop, rank: boardRank, mine: boardMine },
    mod: { reasons: REASONS, refreshBlocked: () => blockedSet(true), report: modReport, isAdmin, reports: modReports, dismiss: modDismiss, block: modBlock, blockedList: modBlockedList, unblock: modUnblock },
    rename, checkBlocked,
    clan: { cap: CLAN_CAP, fmtCode, myId: clanMyId, mine: clanMine, create: clanCreate, join: clanJoin, leave: clanLeave, disband: clanDisband, kick: clanKick, transfer: clanTransfer, renew: clanRenew, refresh: clanRefresh, rows: clanRows, top: clanTop },
    _db: db
  };
})();
