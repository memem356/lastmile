// Konto-Fenster der Startseite: Anmelden, Registrieren, Cloud-Sicherung der Spielstände, Konto löschen
(function accountUI() {
  const L = LMO, el = id => document.getElementById(id);
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, cls, fn) => { const b = mk('button', 'btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; if (fn) b.onclick = fn; return b; };
  const link = (text, fn) => { const b = mk('button', 'linkbtn', text); b.type = 'button'; b.onclick = fn; return b; };
  function field(label, o) {
    const w = mk('label', 'fld'); w.appendChild(mk('span', 'fl', label));
    const i = document.createElement('input'); i.type = o.type || 'text'; i.name = o.name; i.autocomplete = o.auto || 'off';
    if (o.max) i.maxLength = o.max; if (o.value) i.value = o.value; if (o.ph) i.placeholder = o.ph;
    i.setAttribute('autocapitalize', 'off'); i.spellcheck = false;
    if (o.extra) { const row = mk('div', 'nrow'); row.appendChild(i); row.appendChild(o.extra); w.appendChild(row); } else w.appendChild(i);
    if (o.hint) w.appendChild(mk('small', 'fh', o.hint));
    return { w, i };
  }
  const ago = (ms, ref) => { const m = Math.round(((ref || Date.now()) - ms) / 60000); return m < 2 ? 'gerade eben' : m < 90 ? 'vor ' + m + ' Min.' : m < 2880 ? 'vor ' + Math.round(m / 60) + ' Std.' : 'vor ' + Math.round(m / 1440) + ' Tagen'; };
  const eur = v => Math.round(v).toLocaleString('de-DE') + ' €', lief = n => n + (n === 1 ? ' Lieferung' : ' Lieferungen');

  let open = false, view = 'main', tab = 'login', last = null, rendered = '', note = null, lastFocus = null;
  const draft = { email: '', name: '' };

  // ---------- Leiste auf der Startseite ----------
  function updateBar() {
    const s = L.state(), dot = el('accDot'), txt = el('accTxt'), b = el('accBtn');
    dot.className = 'dot' + (s.signedIn && s.hasProfile ? (s.verified ? ' on' : ' warn') : '');
    if (!s.signedIn) { txt.textContent = 'Nicht angemeldet · Solo spielen geht ohne Konto'; b.textContent = 'Anmelden'; }
    else if (!s.hasProfile) { txt.textContent = 'Angemeldet · Registrierung noch nicht abgeschlossen'; b.textContent = 'Fortsetzen'; }
    else { txt.textContent = 'Angemeldet als ' + s.name + (s.verified ? '' : ' · E-Mail noch nicht bestätigt'); b.textContent = 'Konto'; }
  }

  // ---------- Fenster ----------
  function openWin(v) {
    lastFocus = document.activeElement; view = v || 'main'; open = true;
    el('accWrap').hidden = false; render(true);
  }
  function closeWin() { open = false; el('accWrap').hidden = true; if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} } }
  el('accBtn').onclick = () => openWin('main');
  el('accClose').onclick = closeWin;
  el('accWrap').addEventListener('mousedown', e => { if (e.target === el('accWrap')) closeWin(); });
  document.addEventListener('keydown', e => { if (open && e.key === 'Escape') { e.preventDefault(); if (view !== 'main') { view = 'main'; render(true); } else closeWin(); } });

  const modeKey = () => { const s = L.state(); return !s.signedIn ? 'out' : s.hasProfile ? 'in' : 'noprof'; };
  function render(force) {
    if (!open) return;
    const k = view + '|' + modeKey() + '|' + tab;
    if (!force && k === rendered) return;
    rendered = k;
    const body = el('accBody'); body.textContent = '';
    const s = L.state();
    if (view === 'privacy') { el('accTitle').textContent = 'Datenschutz'; body.appendChild(privacyView()); }
    else if (view === 'forgot') { el('accTitle').textContent = 'Passwort vergessen'; body.appendChild(forgotView()); }
    else if (!s.signedIn) { el('accTitle').textContent = 'Konto'; body.appendChild(authView()); }
    else if (!s.hasProfile) { el('accTitle').textContent = 'Registrierung abschließen'; body.appendChild(completeView()); }
    else { el('accTitle').textContent = 'Konto'; body.appendChild(accountView()); }
    const f = body.querySelector('input:not([type=checkbox])'); if (f && modeKey() !== 'in') { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }
  function msgBox() { const m = mk('p', 'accmsg'); m.setAttribute('role', 'status'); m.setAttribute('aria-live', 'polite'); const set = (t, kind) => { m.textContent = t || ''; m.className = 'accmsg' + (kind ? ' ' + kind : ''); }; return { m, set }; }
  async function run(b, mb, work) {
    const old = b.textContent; b.disabled = true; b.textContent = 'Bitte warten …'; mb.set('');
    try { await work(); } catch (e) { fail(mb, e); console.warn('Konto:', e && e.code, e && e.detail); }
    b.disabled = false; b.textContent = old;
  }
  // Bei technischen Fehlern steht darunter eine kurze Angabe, die man dem Betreiber nennen kann
  const KNOWN = ['BAD_CODE', 'NAME_TAKEN', 'BAD_NAME', 'EMAIL_EXISTS', 'INVALID_EMAIL', 'WEAK_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD', 'EMAIL_NOT_FOUND', 'MISSING_EMAIL', 'MISSING_PASSWORD', 'TOO_MANY_ATTEMPTS_TRY_LATER', 'USER_DISABLED', 'TOKEN_EXPIRED', 'NOT_SIGNED_IN', 'UI'];
  const errText = e => { if (!e) return ''; const m = e.message || String(e); return e.code && !KNOWN.includes(e.code) ? m + ' [Technisch: ' + e.code + (e.detail ? ', ' + String(e.detail).slice(0, 120) : '') + ']' : m; };
  function fail(mb, e) { mb.set(errText(e), 'err'); }

  // ---------- Ansichten ----------
  function authView() {
    const root = mk('div', 'accform');
    const tabs = mk('div', 'acctabs');
    for (const [id, t] of [['login', 'Anmelden'], ['reg', 'Registrieren']]) { const b = mk('button', '', t); b.type = 'button'; b.setAttribute('aria-pressed', String(tab === id)); b.onclick = () => { tab = id; render(true); }; tabs.appendChild(b); }
    root.appendChild(tabs);
    if (note) { const n = mk('p', 'accmsg ok', note); root.appendChild(n); note = null; }
    const mb = msgBox();
    if (tab === 'login') {
      root.appendChild(mk('p', 'note', 'Mit einem Konto kannst du online spielen (gemeinsame Weltzeit für alle), in Ranglisten erscheinen und Spielstände in der Cloud sichern. Solo spielen geht weiterhin ohne Konto.'));
      const fe = field('E-Mail-Adresse', { type: 'email', name: 'email', auto: 'username', value: draft.email }), fp = field('Passwort', { type: 'password', name: 'password', auto: 'current-password' });
      const go = btn('Anmelden', 'primary');
      const submit = () => run(go, mb, async () => { draft.email = fe.i.value; await L.login(fe.i.value, fp.i.value); view = 'main'; render(true); updateBar(); });
      go.onclick = submit; root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
      root.append(fe.w, fp.w, mb.m, go, link('Passwort vergessen?', () => { draft.email = fe.i.value; view = 'forgot'; render(true); }));
    } else {
      root.appendChild(mk('p', 'note', 'Dein Name steht in den Ranglisten und ist für alle angemeldeten Spieler sichtbar. Wähle am besten keinen echten Namen. Die E-Mail-Adresse sieht niemand außer dir.'));
      const sug = btn('Vorschlag', '', () => { fn.i.value = L.suggestName(); fn.i.dispatchEvent(new Event('input')); });
      const fn = field('Spielername (3 bis 16 Zeichen)', { name: 'name', max: 16, auto: 'nickname', value: draft.name, extra: sug });
      const fe = field('E-Mail-Adresse', { type: 'email', name: 'email', auto: 'email', value: draft.email, hint: 'Für die Bestätigung und, falls nötig, zum Zurücksetzen des Passworts.' });
      const fp = field('Passwort (mindestens 8 Zeichen)', { type: 'password', name: 'password', auto: 'new-password' });
      const fc = field('Einladungscode', { name: 'code', auto: 'off', ph: 'LM-XXXX-XXXX', hint: 'Den Code bekommst du vom Betreiber.' });
      const chk = mk('label', 'chk'), cb = document.createElement('input'); cb.type = 'checkbox'; chk.appendChild(cb);
      const ct = mk('span', ''); ct.appendChild(document.createTextNode('Ich habe die ')); ct.appendChild(link('Datenschutz-Hinweise', () => { draft.name = fn.i.value; draft.email = fe.i.value; view = 'privacy'; render(true); })); ct.appendChild(document.createTextNode(' gelesen.')); chk.appendChild(ct);
      const go = btn('Konto erstellen', 'primary');
      const hint = () => { const e = L.tidyName(fn.i.value) ? L.checkName(fn.i.value) : ''; if (e) mb.set(e, 'err'); else if (mb.m.className.includes('err')) mb.set(''); };
      fn.i.addEventListener('input', () => { draft.name = fn.i.value; if (fn.i.value.length >= 3) hint(); });
      fe.i.addEventListener('input', () => { draft.email = fe.i.value; });
      go.onclick = () => run(go, mb, async () => {
        if (!cb.checked) throw Object.assign(new Error('Bitte bestätige, dass du die Datenschutz-Hinweise gelesen hast.'), { code: 'UI' });
        const s = await L.register({ name: fn.i.value, email: fe.i.value, password: fp.i.value, code: fc.i.value });
        note = 'Willkommen, ' + s.name + '! Wir haben eine E-Mail an ' + s.email + ' geschickt. Bitte bestätige die Adresse über den Link darin.';
        draft.name = ''; view = 'main'; render(true); updateBar();
      });
      root.append(fn.w, fe.w, fp.w, fc.w, chk, mb.m, go);
    }
    return root;
  }
  function forgotView() {
    const root = mk('div', 'accform'), mb = msgBox();
    root.appendChild(mk('p', 'note', 'Wir schicken dir eine E-Mail mit einem Link, über den du ein neues Passwort festlegen kannst.'));
    const fe = field('E-Mail-Adresse', { type: 'email', name: 'email', auto: 'email', value: draft.email }), go = btn('E-Mail senden', 'primary');
    go.onclick = () => run(go, mb, async () => { draft.email = fe.i.value; await L.resetPassword(fe.i.value); mb.set('Wenn es zu dieser Adresse ein Konto gibt, ist die E-Mail unterwegs. Sieh auch im Spam-Ordner nach.', 'ok'); });
    root.append(fe.w, mb.m, go, link('Zurück zur Anmeldung', () => { tab = 'login'; view = 'main'; render(true); }));
    return root;
  }
  function completeView() {
    const root = mk('div', 'accform'), mb = msgBox(), s = L.state();
    root.appendChild(mk('p', 'note', 'Dein Zugang (' + s.email + ') besteht, aber der Spielername ist noch nicht festgelegt. Das holen wir jetzt nach.'));
    const sug = btn('Vorschlag', '', () => { fn.i.value = L.suggestName(); });
    const fn = field('Spielername (3 bis 16 Zeichen)', { name: 'name', max: 16, value: draft.name, extra: sug }), fc = field('Einladungscode', { name: 'code', ph: 'LM-XXXX-XXXX' });
    const go = btn('Registrierung abschließen', 'primary');
    go.onclick = () => run(go, mb, async () => { await L.completeRegistration({ name: fn.i.value, code: fc.i.value }); try { await L.sendVerify(); } catch (e) {} view = 'main'; render(true); updateBar(); });
    const re = btn('Neu laden', '', () => run(re, mb, async () => { await L.loadProfile(); render(true); updateBar(); }));
    const out = btn('Abmelden', '', () => { L.logout(); view = 'main'; render(true); updateBar(); });
    const row = mk('div', 'accrow'); row.append(re, out);
    root.append(fn.w, fc.w, mb.m, go, row);
    return root;
  }
  function privacyView() {
    const root = mk('div', 'privacy');
    root.appendChild(mk('p', '', 'Kurz gesagt: Solo spielen funktioniert ohne Konto und ohne Daten an Server. Für ein Konto werden die folgenden Daten verarbeitet.'));
    const ul = mk('ul'), items = [
      'Solo: Spielstände, Städte und Einstellungen bleiben ausschließlich in deinem Browser.',
      'Konto: E-Mail-Adresse und Passwort verwaltet Google Firebase Authentication (Google). Das Spiel selbst sieht dein Passwort nie. Die E-Mail wird für die Bestätigung und das Zurücksetzen des Passworts genutzt.',
      'Datenbank (Google Firebase Realtime Database): Spielername (für andere sichtbar), Kontokennung, Zeitpunkt der Registrierung, der benutzte Einladungscode und die Spielstände, die du selbst in die Cloud lädst. Die E-Mail-Adresse steht nicht in der Datenbank.',
      'Online-Modus: dein Online-Unternehmen (Spielstand), eine Sitzungskennung, Zeitstempel des Servers und Ranglisteneinträge mit Name, Stadt, Wachstum, Lieferungen, Ruf und Zeitraum. Die Ranglisten sind für alle angemeldeten Spieler sichtbar.',
      'Clans: Clan-Name, Leiter, Mitgliederliste (nur für Mitglieder sichtbar: Name und Beitrag zum Wachstum des Clans), geheimer Beitrittscode und die Clan-Wertung. Clan-Name und Clan-Wertung sind für alle angemeldeten Spieler sichtbar.',
      'Keine Werbung, keine Tracking-Cookies, keine Analyse-Dienste. Damit du angemeldet bleibst, speichert dein Browser eine Anmeldemarke im lokalen Speicher; „Abmelden“ löscht sie.',
      'Beim Aufruf der Seite und bei jeder Verbindung zu den genannten Diensten (GitHub Pages, Google Firebase, OpenStreetMap-Dienste) wird technisch deine IP-Adresse an die jeweiligen Server übermittelt.',
      'Löschen: Im Konto-Fenster entfernt „Konto löschen“ Profil, Namen, Cloud-Spielstände, Online-Unternehmen, Ranglisteneinträge, deine Clan-Mitgliedschaft und das Konto selbst. Als Leiter gibst du die Leitung dabei an das dienstälteste Mitglied ab; bist du allein im Clan, wird er aufgelöst.',
      'Kontakt zum Betreiber dieses Hobby-Projekts: über die Projektseite github.com/memem356/lastmile.'
    ];
    for (const t of items) ul.appendChild(mk('li', '', t));
    root.appendChild(ul);
    const back = btn('Zurück', '', () => { view = 'main'; render(true); }); back.style.marginTop = '12px';
    root.appendChild(back);
    return root;
  }

  // ---------- Konto und Cloud ----------
  function accountView() {
    const s = L.state(), root = mk('div', 'accform');
    if (note) { root.appendChild(mk('p', 'accmsg ok', note)); note = null; }
    const who = mk('div', ''); const nm = mk('p', '', ''); const b = mk('b', '', s.name); nm.appendChild(b); nm.appendChild(document.createTextNode('  ·  ' + s.email)); who.appendChild(nm);
    root.appendChild(who);
    const vm = msgBox();
    if (!s.verified) {
      vm.set('Die E-Mail-Adresse ist noch nicht bestätigt. Öffne den Link in der E-Mail von Firebase (auch im Spam-Ordner nachsehen) und tippe dann auf „Ich habe bestätigt“.', 'err');
      const row = mk('div', 'accrow');
      const chk = btn('Ich habe bestätigt', 'primary', () => run(chk, vm, async () => { const v = await L.checkVerified(); if (v) { render(true); updateBar(); } else vm.set('Noch nicht bestätigt. Bitte erst den Link in der E-Mail öffnen.', 'err'); }));
      const again = btn('E-Mail erneut senden', '', () => run(again, vm, async () => { await L.sendVerify(); vm.set('Die E-Mail wurde erneut gesendet.', 'ok'); }));
      row.append(chk, again); root.append(vm.m, row);
    } else root.appendChild(mk('p', 'accmsg ok', 'E-Mail-Adresse bestätigt.'));

    const cn = mk('section', ''); cn.appendChild(mk('h4', '', 'Clan')); const chost = mk('div', ''); cn.appendChild(chost); root.appendChild(cn);
    LMClan.render(chost);

    const cs = mk('section', ''); cs.appendChild(mk('h4', '', 'Cloud-Sicherung (nur für dich sichtbar)'));
    cs.appendChild(mk('p', 'note', 'Lade Solo-Spielstände hoch, um sie auf einem anderen Gerät weiterzuspielen. Beim Laden bleibt der bisherige Stand auf diesem Gerät als Sicherung erhalten.'));
    const box = mk('div', ''); box.style.cssText = 'display:flex;flex-direction:column;gap:12px;margin-top:10px'; cs.appendChild(box); root.appendChild(cs);
    loadCloud(box);

    const acts = mk('div', 'accrow'); acts.appendChild(btn('Abmelden', '', () => { L.logout(); view = 'main'; tab = 'login'; render(true); updateBar(); }));
    acts.appendChild(link('Datenschutz', () => { view = 'privacy'; render(true); }));
    root.appendChild(acts);

    const del = mk('details', ''); del.appendChild(mk('summary', '', 'Konto löschen …'));
    const dm = msgBox(), dp = field('Passwort zur Bestätigung', { type: 'password', name: 'password', auto: 'current-password' });
    const dgo = btn('Konto endgültig löschen', 'danger', () => run(dgo, dm, async () => { await L.deleteAccount(dp.i.value); note = 'Dein Konto und alle Daten dazu wurden gelöscht.'; tab = 'login'; view = 'main'; render(true); updateBar(); }));
    const dw = mk('div', 'accform'); dw.style.marginTop = '10px'; dw.append(mk('p', 'note', 'Löscht Profil, Spielernamen, Cloud-Spielstände, Online-Unternehmen, Ranglisteneinträge, deine Clan-Mitgliedschaft und das Konto. Das lässt sich nicht rückgängig machen. Spielstände auf diesem Gerät bleiben erhalten.'), dp.w, dm.m, dgo);
    del.appendChild(dw); root.appendChild(del);
    return root;
  }

  function confirmBtn(b, ask, fn) {
    let armed = false, t = null; const orig = b.textContent;
    b.onclick = () => {
      if (!armed) { armed = true; b.textContent = ask; t = setTimeout(() => { armed = false; b.textContent = orig; }, 5000); return; }
      clearTimeout(t); armed = false; b.textContent = orig; fn(b);
    };
  }
  async function loadCloud(box, flash) {
    box.textContent = ''; box.appendChild(mk('p', 'note', 'Cloud-Stände werden geladen …'));
    const seq = loadCloud.seq = (loadCloud.seq || 0) + 1;
    let list;
    try { try { await L.syncClock(); } catch (e) { if (e.code === 'NETWORK') throw e; } list = await L.cloud.list(); }
    catch (e) { if (seq !== loadCloud.seq) return; box.textContent = ''; const m = mk('p', 'accmsg err', e.message); box.appendChild(m); box.appendChild(btn('Erneut versuchen', '', () => loadCloud(box))); return; }
    if (seq !== loadCloud.seq || !box.isConnected) return;
    box.textContent = '';
    const ref = L.serverNow(), clouds = new Map(list.map(x => [x.slot, x])), locals = LMUI.localSaves().map(x => Object.assign(x, { slot: L.cloud.slotOf(x.key) }));
    const msg = msgBox(); box.appendChild(msg.m); if (flash) msg.set(flash, 'ok');

    const h1 = mk('h4', '', 'Auf diesem Gerät'); box.appendChild(h1);
    const u1 = mk('ul', 'cl'); box.appendChild(u1);
    if (!locals.length) u1.replaceWith(mk('p', 'note', 'Noch keine Spielstände auf diesem Gerät.'));
    for (const x of locals) {
      const sv = x.sv, c = clouds.get(x.slot), li = mk('li', '');
      const tx = mk('div', ''); tx.appendChild(mk('span', 'tt', sv.place.name + ' · ' + (sv.mode === 'rush' ? 'Rush' : 'Entspannt')));
      tx.appendChild(mk('span', 'ss', eur(sv.cash) + ' · ' + lief(sv.stats ? sv.stats.n : 0) + ' · gespielt ' + ago(sv.at) + (c ? ' · Cloud: ' + ago(c.t, ref) : ' · noch nicht in der Cloud')));
      const acts = mk('div', 'acts'), up = btn(c ? 'Hochladen (ersetzt)' : 'Hochladen', '');
      const cloudNewer = c && c.t > sv.at + 120000;
      const doUp = async () => {
        up.disabled = true; msg.set('');
        try {
          if (x.raw.length > 390000) throw Object.assign(new Error('Dieser Spielstand ist zu groß für die Cloud.'), { code: 'UI' });
          await L.cloud.put(x.slot, x.raw, sv.place.name + ' · ' + (sv.mode === 'rush' ? 'Rush' : 'Entspannt') + ' · ' + eur(sv.cash) + ' · ' + lief(sv.stats ? sv.stats.n : 0), sv.v);
          await loadCloud(box, '„' + sv.place.name + '“ ist in der Cloud gesichert.');
        } catch (e) { fail(msg, e); up.disabled = false; }
      };
      if (cloudNewer) { up.onclick = null; confirmBtn(up, 'Neueren Cloud-Stand ersetzen?', doUp); } else up.onclick = doUp;
      acts.appendChild(up); li.append(tx, acts); u1.appendChild(li);
    }

    const h2 = mk('h4', '', 'In der Cloud'); box.appendChild(h2);
    const u2 = mk('ul', 'cl'); box.appendChild(u2);
    if (!list.length) u2.replaceWith(mk('p', 'note', 'Noch nichts in der Cloud.'));
    for (const c of list) {
      const li = mk('li', ''), loc = locals.find(x => x.slot === c.slot), tx = mk('div', '');
      tx.appendChild(mk('span', 'tt', c.info || c.slot)); tx.appendChild(mk('span', 'ss', 'gesichert ' + ago(c.t, ref)));
      const acts = mk('div', 'acts'), dl = btn('Hierher laden', ''), rm = btn('Löschen', 'danger');
      if (c.slot.startsWith('o_')) { // Online-Unternehmen: lebt in der Cloud, wird nicht auf das Gerät kopiert
        const ck = c.slot.slice(2);
        tx.firstChild.textContent = c.info || c.slot; tx.lastChild.textContent = 'Online-Unternehmen · gesichert ' + ago(c.t, ref);
        confirmBtn(rm, 'Unternehmen und Rangeintrag wirklich löschen?', async () => { rm.disabled = true; try { await L.company.remove(ck); await loadCloud(box, 'Das Online-Unternehmen wurde gelöscht.'); } catch (e) { fail(msg, e); rm.disabled = false; } });
        acts.append(rm); li.append(tx, acts); u2.appendChild(li); continue;
      }
      const localNewer = loc && loc.sv.at > c.t + 120000;
      const doDl = async () => {
        dl.disabled = true; msg.set('');
        try {
          const d = await L.cloud.get(c.slot); let sv; try { sv = JSON.parse(d.data); } catch (e) { throw Object.assign(new Error('Der Cloud-Stand ist beschädigt.'), { code: 'UI' }); }
          const err = LMUI.importSave(sv); if (err) throw Object.assign(new Error(err), { code: 'UI' });
          await loadCloud(box, 'Geladen. Du findest den Stand oben unter „Weiter spielen“.');
        } catch (e) { fail(msg, e); dl.disabled = false; }
      };
      if (localNewer) confirmBtn(dl, 'Neueren Stand hier ersetzen?', doDl); else dl.onclick = doDl;
      confirmBtn(rm, 'Wirklich löschen?', async () => { rm.disabled = true; try { await L.cloud.del(c.slot); await loadCloud(box); } catch (e) { fail(msg, e); rm.disabled = false; } });
      acts.append(dl, rm); li.append(tx, acts); u2.appendChild(li);
    }
  }

  L.on(() => { updateBar(); if (open) render(false); });
  L.init(); updateBar();
  window.__lmAcc = { open: openWin, close: closeWin };
})();
