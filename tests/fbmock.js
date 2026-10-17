'use strict';
// Nachbau von Firebase Auth (REST) und Realtime Database (REST) mit Regelprüfung, nur für Tests.
// Start: node tests/fbmock.js <port> [rules.json]   (die Regeln stammen standardmäßig aus firebase-rules.json)
const http = require('http'), fs = require('fs'), crypto = require('crypto'), path = require('path');
const PORT = +process.argv[2] || 9199, RULES_FILE = process.argv[3] || path.join(__dirname, '..', 'firebase-rules.json');
const PRIMARY = process.env.PRIMARY_HOST || 'lastmile-c6976-default-rtdb.europe-west1.firebasedatabase.app';
const ANC = process.env.ANCESTOR_VALIDATE === '1';
const RULES0 = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')).rules;
let RULES = RULES0;

String.prototype.matches = function (re) { return re.test(String(this)); };
String.prototype.contains = function (s) { return String(this).includes(s); };
String.prototype.beginsWith = function (s) { return String(this).startsWith(s); };

let skew = 0, frozen = null; const now = () => frozen !== null ? frozen : Date.now() + skew;
let DB = {}, USERS = {}, REFRESH = {}, MAILS = [], LOG = [], FAIL = null, COUNT = { db: 0, auth: 0 };
const clone = o => o === null || o === undefined ? null : JSON.parse(JSON.stringify(o));
const isObj = v => v !== null && typeof v === 'object';
const getAt = (root, segs) => { let n = root; for (const s of segs) { if (!isObj(n) || !(s in n)) return null; n = n[s]; } return n === undefined ? null : n; };
const prune = n => { for (const k of Object.keys(n)) { if (isObj(n[k])) { prune(n[k]); if (!Object.keys(n[k]).length) delete n[k]; } else if (n[k] === null || n[k] === undefined) delete n[k]; } };
function setAt(root, segs, val) {
  if (!segs.length) { const r = val === null ? {} : clone(val); if (isObj(r)) prune(r); return r; }
  const r = clone(root) || {}; let n = r;
  for (let i = 0; i < segs.length - 1; i++) { const s = segs[i]; if (!isObj(n[s])) n[s] = {}; n = n[s]; }
  const last = segs[segs.length - 1]; if (val === null) delete n[last]; else n[last] = clone(val);
  prune(r); return r;
}
function resolveSv(v) {
  if (isObj(v) && v['.sv'] === 'timestamp') return now();
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = resolveSv(v[k]); return o; }
  return v;
}
class Snap {
  constructor(root, segs) { this.r = root; this.s = segs; }
  raw() { return getAt(this.r, this.s); }
  val() { const v = this.raw(); return isObj(v) ? null : v; }
  exists() { return this.raw() !== null; }
  child(p) { return new Snap(this.r, this.s.concat(String(p).split('/').filter(Boolean))); }
  parent() { return new Snap(this.r, this.s.slice(0, -1)); }
  hasChild(p) { return this.child(p).exists(); }
  hasChildren(a) { const v = this.raw(); if (!isObj(v)) return false; return a ? a.every(k => v[k] !== undefined && v[k] !== null) : Object.keys(v).length > 0; }
  isString() { return typeof this.raw() === 'string'; }
  isNumber() { return typeof this.raw() === 'number'; }
  isBoolean() { return typeof this.raw() === 'boolean'; }
  getPriority() { return null; }
  get root() { return new Snap(this.r, []); }
}
function evalExpr(expr, ctx) {
  if (typeof expr === 'boolean') return expr;
  const code = String(expr).replace(/\.replace\(/g, '.replaceAll(');
  const names = Object.keys(ctx.vars).concat(['auth', 'now', 'root', 'data', 'newData']);
  try {
    const fn = new Function(...names, 'return (' + code + ');');
    return fn(...names.map(n => (n in ctx.vars) ? ctx.vars[n] : ctx[n])) === true;
  } catch (e) { LOG.push('Regelfehler: ' + expr + ' -> ' + e.message); return false; }
}
function step(node, seg) {
  if (Object.prototype.hasOwnProperty.call(node, seg) && !seg.startsWith('$') && !seg.startsWith('.')) return { node: node[seg], bind: null };
  const w = Object.keys(node).find(k => k.startsWith('$'));
  return w ? { node: node[w], bind: [w, seg] } : null;
}
function walk(segs) { // Regelknoten entlang des Pfades (mit Bindungen)
  const out = [{ node: RULES, vars: {}, path: [] }];
  let node = RULES, vars = {};
  for (let i = 0; i < segs.length; i++) {
    const st = step(node, segs[i]); if (!st) break;
    node = st.node; vars = Object.assign({}, vars); if (st.bind) vars[st.bind[0]] = st.bind[1];
    out.push({ node, vars, path: segs.slice(0, i + 1) });
  }
  return out;
}
function canRead(segs, auth, old) {
  for (const w of walk(segs)) if (w.node['.read'] !== undefined && evalExpr(w.node['.read'], { auth, now: now(), root: new Snap(old, []), data: new Snap(old, w.path), newData: new Snap(old, w.path), vars: w.vars })) return true;
  return false;
}
function canWrite(segs, auth, old, neu) {
  const ws = walk(segs); let allowed = false;
  for (const w of ws) if (w.node['.write'] !== undefined && evalExpr(w.node['.write'], { auth, now: now(), root: new Snap(old, []), data: new Snap(old, w.path), newData: new Snap(neu, w.path), vars: w.vars })) allowed = true;
  if (!allowed) return 'write';
  const ctx = (w, p) => ({ auth, now: now(), root: new Snap(old, []), data: new Snap(old, p), newData: new Snap(neu, p), vars: w.vars });
  const val = (rnode, vars, p) => {
    const nd = new Snap(neu, p); if (!nd.exists()) return true;
    if (rnode['.validate'] !== undefined && !evalExpr(rnode['.validate'], { auth, now: now(), root: new Snap(old, []), data: new Snap(old, p), newData: nd, vars })) { LOG.push('validate fehlgeschlagen: /' + p.join('/')); return false; }
    const v = nd.raw();
    if (isObj(v)) for (const k of Object.keys(v)) { const st = step(rnode, k); if (!st) continue; const nv = Object.assign({}, vars); if (st.bind) nv[st.bind[0]] = st.bind[1]; if (!val(st.node, nv, p.concat(k))) return false; }
    return true;
  };
  const at = ws.length - 1 === segs.length || ws[ws.length - 1].path.length === segs.length ? ws[ws.length - 1] : null;
  if (ANC) for (const w of ws) if (w.path.length < segs.length && w.node['.validate'] !== undefined && new Snap(neu, w.path).exists() && !evalExpr(w.node['.validate'], ctx(w, w.path))) return 'validate-anc';
  if (at && new Snap(neu, segs).exists()) { if (!val(at.node, at.vars, segs)) return 'validate'; }
  else if (new Snap(neu, segs).exists()) {
    // Pfad liegt unterhalb der Regeln (kein Regelknoten): keine Prüfung
  }
  return null;
}

// ---------- Auth ----------
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function mkTokens(u) {
  const exp = Math.floor(now() / 1000) + 3600, id = 'h.' + b64({ uid: u.localId, email: u.email, exp, ev: !!u.emailVerified }) + '.s';
  const rt = 'rt_' + crypto.randomBytes(12).toString('hex'); REFRESH[rt] = u.localId;
  return { idToken: id, refreshToken: rt, expiresIn: '3600', localId: u.localId, email: u.email };
}
function parseTok(t) {
  try { const p = JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()); if (p.exp * 1000 < now() || !USERS[p.uid]) return null; return { uid: p.uid, token: { email: p.email, email_verified: !!USERS[p.uid].emailVerified } }; } catch (e) { return null; }
}
const aerr = (res, m, code) => send(res, code || 400, { error: { code: code || 400, message: m, errors: [{ message: m, domain: 'global', reason: 'invalid' }] } });
function authApi(method, body, res, headers) {
  COUNT.auth++;
  if (method === 'signUp') {
    const email = String(body.email || '').toLowerCase();
    if (!email) return aerr(res, 'MISSING_EMAIL');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return aerr(res, 'INVALID_EMAIL');
    if (!body.password) return aerr(res, 'MISSING_PASSWORD');
    if (String(body.password).length < 6) return aerr(res, 'WEAK_PASSWORD : Password should be at least 6 characters');
    if (Object.values(USERS).some(u => u.email === email)) return aerr(res, 'EMAIL_EXISTS');
    const u = { localId: crypto.randomBytes(14).toString('hex').slice(0, 28), email, password: body.password, emailVerified: false };
    USERS[u.localId] = u; return send(res, 200, Object.assign({ kind: 'identitytoolkit#SignupNewUserResponse' }, mkTokens(u)));
  }
  if (method === 'signInWithPassword') {
    const email = String(body.email || '').toLowerCase(), u = Object.values(USERS).find(x => x.email === email);
    if (!u || u.password !== body.password) return aerr(res, 'INVALID_LOGIN_CREDENTIALS');
    if (u.disabled) return aerr(res, 'USER_DISABLED');
    return send(res, 200, Object.assign({ kind: 'identitytoolkit#VerifyPasswordResponse', registered: true }, mkTokens(u)));
  }
  if (method === 'lookup') {
    const a = parseTok(body.idToken); if (!a) return aerr(res, 'INVALID_ID_TOKEN');
    const u = USERS[a.uid]; return send(res, 200, { kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: u.localId, email: u.email, emailVerified: !!u.emailVerified }] });
  }
  if (method === 'sendOobCode') {
    MAILS.push({ type: body.requestType, email: body.email || (parseTok(body.idToken) ? USERS[parseTok(body.idToken).uid].email : null), locale: headers['x-firebase-locale'] || '' });
    return send(res, 200, { kind: 'identitytoolkit#GetOobConfirmationCodeResponse', email: body.email || '' });
  }
  if (method === 'delete') {
    const a = parseTok(body.idToken); if (!a) return aerr(res, 'INVALID_ID_TOKEN');
    delete USERS[a.uid]; return send(res, 200, { kind: 'identitytoolkit#DeleteAccountResponse' });
  }
  return aerr(res, 'OPERATION_NOT_ALLOWED');
}

// ---------- Hilfen ----------
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE,PATCH,OPTIONS', 'access-control-max-age': '600' };
function send(res, code, obj, raw) { res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS)); res.end(raw !== undefined ? raw : JSON.stringify(obj)); }
function body(req) { return new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); }); }

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const raw = await body(req);
  try {
    if (p.startsWith('/ctl/')) {
      const c = p.slice(5);
      if (c === 'rules') { RULES = JSON.parse(raw).rules; return send(res, 200, { ok: 1 }); }
      if (c === 'reset') { RULES = RULES0; DB = {}; USERS = {}; REFRESH = {}; MAILS = []; LOG = []; FAIL = null; skew = 0; COUNT = { db: 0, auth: 0 }; return send(res, 200, { ok: 1 }); }
      if (c === 'state') return send(res, 200, { DB, USERS: Object.values(USERS).map(x => ({ uid: x.localId, email: x.email, ev: !!x.emailVerified })), MAILS, LOG, COUNT });
      if (c === 'verify') { const e = JSON.parse(raw).email; for (const x of Object.values(USERS)) if (x.email === e) x.emailVerified = true; return send(res, 200, { ok: 1 }); }
      if (c === 'skew') { skew = +JSON.parse(raw).ms; return send(res, 200, { ok: 1 }); }
      if (c === 'fail') { FAIL = JSON.parse(raw); return send(res, 200, { ok: 1 }); } // {match:'users/',status:500,times:1}
      if (c === 'put') { const j = JSON.parse(raw); DB = setAt(DB, j.path.split('/').filter(Boolean), j.value); return send(res, 200, { ok: 1 }); }
      return send(res, 404, { error: 'ctl' });
    }
    if (p.startsWith('/auth/')) {
      if (u.searchParams.get('key') !== 'AIzaSyAdEbVh2P13tdupXlrT07nTGabqq9kLb1I') return aerr(res, 'API key not valid. Please pass a valid API key.');
      return authApi(p.slice(6), raw ? JSON.parse(raw) : {}, res, req.headers);
    }
    if (p === '/token') {
      const f = new URLSearchParams(raw), uid = REFRESH[f.get('refresh_token')];
      if (f.get('grant_type') !== 'refresh_token' || !uid || !USERS[uid]) return aerr(res, 'INVALID_REFRESH_TOKEN');
      const t = mkTokens(USERS[uid]); delete REFRESH[f.get('refresh_token')];
      return send(res, 200, { access_token: t.idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: t.refreshToken, id_token: t.idToken, user_id: uid, project_id: 'x' });
    }
    if (p.startsWith('/db/')) {
      const rest = p.slice(4), host = rest.split('/')[0], path = rest.slice(host.length + 1);
      if (host !== PRIMARY) return send(res, 404, { error: 'Firebase error. Please ensure that you have the URL of your Firebase Realtime Database instance configured correctly.' });
      COUNT.db++; frozen = Date.now() + skew;
      if (FAIL && path.includes(FAIL.match) && (!FAIL.method || FAIL.method === req.method) && (FAIL.times === undefined || FAIL.times-- > 0)) return send(res, FAIL.status || 500, { error: 'simulierter Fehler' });
      const segs = path.replace(/\.json$/, '').split('/').filter(Boolean);
      const tok = u.searchParams.get('auth'), auth = tok ? parseTok(tok) : null;
      if (tok && !auth) return send(res, 401, { error: 'Auth token is expired' });
      if (req.method === 'GET') {
        if (!canRead(segs, auth, DB)) return send(res, 401, { error: 'Permission denied' });
        let v = getAt(DB, segs);
        if (u.searchParams.get('shallow') === 'true' && isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = true; return send(res, 200, o); }
        const ob = u.searchParams.get('orderBy');
        if (ob) { // Abfragen wie bei Firebase: nach Kindfeld sortieren, filtern, begrenzen; ohne .indexOn ein Fehler
          let key; try { key = JSON.parse(ob); } catch (e) { return send(res, 400, { error: 'orderBy muss in Anführungszeichen stehen' }); }
          if (typeof key !== 'string') return send(res, 400, { error: 'orderBy ungültig' });
          if (!['$key', '$value', '$priority'].includes(key)) {
            const ws = walk(segs), last = ws[ws.length - 1], idx = last.path.length === segs.length ? last.node['.indexOn'] : null;
            const ok = idx && [].concat(idx).includes(key);
            if (!ok) return send(res, 400, { error: 'Index not defined, add ".indexOn": "' + key + '", for path "/' + segs.join('/') + '", to the rules' });
          }
          if (isObj(v)) {
            const pj = n => { const x = u.searchParams.get(n); return x === null ? undefined : JSON.parse(x); };
            const val = (k, x) => key === '$key' ? k : key === '$value' ? x : (isObj(x) && key in x ? x[key] : null);
            const rank = x => x === null ? 0 : typeof x === 'boolean' ? 1 : typeof x === 'number' ? 2 : 3;
            const cmp = (a, b) => rank(a) !== rank(b) ? rank(a) - rank(b) : (a < b ? -1 : a > b ? 1 : 0);
            let ents = Object.keys(v).map(k => [k, val(k, v[k])]).sort((a, b) => cmp(a[1], b[1]) || (a[0] < b[0] ? -1 : 1));
            const eq = pj('equalTo'), st = pj('startAt'), en = pj('endAt'), lf = pj('limitToFirst'), ll = pj('limitToLast');
            if (eq !== undefined) ents = ents.filter(e => cmp(e[1], eq) === 0);
            if (st !== undefined) ents = ents.filter(e => cmp(e[1], st) >= 0);
            if (en !== undefined) ents = ents.filter(e => cmp(e[1], en) <= 0);
            if (lf !== undefined) ents = ents.slice(0, lf);
            if (ll !== undefined) ents = ents.slice(Math.max(0, ents.length - ll));
            const o = {}; for (const e of ents) o[e[0]] = v[e[0]]; v = o;
          }
        }
        return send(res, 200, v);
      }
      if (req.method === 'PUT' || req.method === 'DELETE') {
        const val = req.method === 'DELETE' ? null : resolveSv(JSON.parse(raw));
        const neu = setAt(DB, segs, val), why = canWrite(segs, auth, DB, neu);
        if (why) return send(res, 401, { error: 'Permission denied' });
        DB = neu; return send(res, 200, val);
      }
      return send(res, 405, { error: 'Methode' });
    }
    send(res, 404, { error: 'nicht gefunden' });
  } catch (e) { LOG.push('Serverfehler ' + e.stack); send(res, 500, { error: String(e) }); }
  finally { frozen = null; }
}).listen(PORT, '127.0.0.1', () => console.log('fbmock ' + PORT));
