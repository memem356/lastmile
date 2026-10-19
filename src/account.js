// Konto: Anmelden und Registrieren stehen direkt auf der Startseite (mountAuth); im Spiel öffnet das Menü das Konto-Fenster.
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

  let open = false, view = 'main', tab = 'login', rendered = '', renderedIn = '', inline = false, note = null, lastFocus = null;
  const draft = { email: '', name: '' };
  // Hinweis, der nach einem Neuladen oder an anderer Stelle der Seite angezeigt wird (z. B. „Willkommen“ nach der Registrierung)
  function takeNote() {
    let t = note; note = null;
    try { const x = sessionStorage.getItem('lm-note'); if (x) { sessionStorage.removeItem('lm-note'); t = t || x; } } catch (e) {}
    return t;
  }
  function setNote(t) { note = t; try { document.dispatchEvent(new Event('lm-note')); } catch (e) {} }
  function noteForReload(t) { try { sessionStorage.setItem('lm-note', t); } catch (e) {} }

  // ---------- Fenster (im Spiel) und Einbettung (Startseite) ----------
  function openWin(v) {
    lastFocus = document.activeElement; view = v || 'main'; open = true;
    el('accWrap').hidden = false; render(true);
  }
  function closeWin() { open = false; el('accWrap').hidden = true; if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} } }
  el('accClose').onclick = closeWin;
  el('accWrap').addEventListener('mousedown', e => { if (e.target === el('accWrap')) closeWin(); });
  document.addEventListener('keydown', e => { if (open && e.key === 'Escape') { e.preventDefault(); if (view !== 'main') { view = 'main'; render(true); } else closeWin(); } });
  function mountAuth() { inline = true; view = 'main'; renderedIn = ''; render(true, false); }
  function unmountAuth() { inline = false; renderedIn = ''; el('authBody').textContent = ''; }

  const modeKey = () => { const s = L.state(); return !s.signedIn ? 'out' : s.hasProfile ? (s.blocked ? 'inblk' : 'in') : 'noprof'; };
  function draw(body, title, isInline, focus) {
    body.textContent = '';
    const s = L.state();
    if (view === 'privacy') { title.textContent = 'Datenschutz'; body.appendChild(privacyView()); }
    else if (view === 'forgot') { title.textContent = 'Passwort vergessen'; body.appendChild(forgotView()); }
    else if (!s.signedIn) { title.textContent = isInline ? 'Anmelden oder registrieren' : 'Konto'; body.appendChild(authView()); }
    else if (!s.hasProfile) { title.textContent = 'Registrierung abschließen'; body.appendChild(completeView()); }
    else if (!isInline) { title.textContent = 'Konto'; body.appendChild(accountView()); }
    else return;
    const f = body.querySelector('input:not([type=checkbox])'); if (f && focus && modeKey() !== 'in') { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }
  function render(force, focus) {
    if (focus === undefined) focus = true;
    const k = view + '|' + modeKey() + '|' + tab;
    if (open && (force || k !== rendered)) { rendered = k; draw(el('accBody'), el('accTitle'), false, focus); }
    if (inline && (force || k !== renderedIn)) { renderedIn = k; draw(el('authBody'), el('authTitle'), true, focus); }
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
    { const t = takeNote(); if (t) root.appendChild(mk('p', 'accmsg ok', t)); }
    const mb = msgBox();
    if (tab === 'login') {
      root.appendChild(mk('p', 'note', 'Melde dich mit deinem Konto an. Danach geht es direkt mit deinem Unternehmen weiter. Neu hier? Wechsle zu „Registrieren“.'));
      const fe = field('E-Mail-Adresse', { type: 'email', name: 'email', auto: 'username', value: draft.email }), fp = field('Passwort', { type: 'password', name: 'password', auto: 'current-password' });
      const go = btn('Anmelden', 'primary');
      const submit = () => run(go, mb, async () => { draft.email = fe.i.value; await L.login(fe.i.value, fp.i.value); view = 'main'; render(true); });
      go.onclick = submit; root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
      root.append(fe.w, fp.w, mb.m, go, link('Passwort vergessen?', () => { draft.email = fe.i.value; view = 'forgot'; render(true); }));
    } else {
      root.appendChild(mk('p', 'note', 'Mit einem Konto spielst du in der gemeinsamen Online-Welt (für alle gilt dieselbe Weltzeit) und erscheinst in den Ranglisten. Dein Name ist für alle angemeldeten Spieler sichtbar. Wähle am besten keinen echten Namen. Die E-Mail-Adresse sieht niemand außer dir. Gleich nach der Registrierung wählst du deinen Startort.'));
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
        draft.name = ''; view = 'main'; setNote('Willkommen, ' + s.name + '! Wir haben eine E-Mail an ' + s.email + ' geschickt. Bitte bestätige die Adresse über den Link darin (das geht auch später).'); render(true);
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
    root.appendChild(mk('p', 'note', 'Dein Zugang (' + s.email + ') besteht, aber der Spielername ist noch nicht festgelegt. Das holen wir jetzt nach. Hast du dich schon früher registriert und es fehlte nur die Verbindung, tippe auf „Neu laden“.'));
    const sug = btn('Vorschlag', '', () => { fn.i.value = L.suggestName(); });
    const fn = field('Spielername (3 bis 16 Zeichen)', { name: 'name', max: 16, value: draft.name, extra: sug }), fc = field('Einladungscode', { name: 'code', ph: 'LM-XXXX-XXXX' });
    const go = btn('Registrierung abschließen', 'primary');
    go.onclick = () => run(go, mb, async () => { await L.completeRegistration({ name: fn.i.value, code: fc.i.value }); try { await L.sendVerify(); } catch (e) {} view = 'main'; setNote('Willkommen, ' + L.state().name + '! Wir haben eine E-Mail an ' + L.state().email + ' geschickt. Bitte bestätige die Adresse über den Link darin (das geht auch später).'); render(true); });
    const re = btn('Neu laden', '', () => run(re, mb, async () => { await L.loadProfile(); render(true); }));
    const out = btn('Abmelden', '', () => { L.logout(); view = 'main'; render(true); });
    const row = mk('div', 'accrow'); row.append(re, out);
    root.append(fn.w, fc.w, mb.m, go, row);
    return root;
  }
  function privacyView() {
    const root = mk('div', 'privacy');
    root.appendChild(mk('p', '', 'Kurz gesagt: Zum Spielen brauchst du ein Konto. Dafür werden die folgenden Daten verarbeitet.'));
    const ul = mk('ul'), items = [
      'Auf deinem Gerät: Karten der Städte, die du lädst, Einstellungen (zum Beispiel Ton) und eine Sicherungskopie deines Unternehmens liegen im Speicher deines Browsers.',
      'Konto: E-Mail-Adresse und Passwort verwaltet Google Firebase Authentication (Google). Das Spiel selbst sieht dein Passwort nie. Die E-Mail wird für die Bestätigung und das Zurücksetzen des Passworts genutzt.',
      'Datenbank (Google Firebase Realtime Database): Spielername (für andere sichtbar), Kontokennung, Zeitpunkt der Registrierung, der benutzte Einladungscode und dein Unternehmen (der Spielstand, mit deinem Startort). Die E-Mail-Adresse steht nicht in der Datenbank.',
      'Spiel: dein Unternehmen (Spielstand), eine Sitzungskennung, Zeitstempel des Servers und Ranglisteneinträge mit Name, Stadt, Wachstum, Lieferungen, Ruf und Zeitraum. Die Ranglisten sind für alle angemeldeten Spieler sichtbar.',
      'Clans: Clan-Name, Leiter, Mitgliederliste (nur für Mitglieder sichtbar: Name und Beitrag zum Wachstum des Clans), geheimer Beitrittscode und die Clan-Wertung. Clan-Name und Clan-Wertung sind für alle angemeldeten Spieler sichtbar.',
      'Melden und Sperren: Wenn du einen Spieler oder Clan meldest, speichert die Datenbank deine Kontokennung, die Kennung und den Namen des Gemeldeten, den gewählten Grund (feste Auswahl, kein Freitext) und den Zeitpunkt. Meldungen sind nicht öffentlich; sie sieht nur der Betreiber. Je Konto sind höchstens 10 Meldungen innerhalb von 24 Stunden möglich. Der Betreiber löscht eine Meldung nach der Prüfung (verwerfen oder sperren). Es wird nichts automatisch gesperrt.',
      'Sperrliste: Sperrt der Betreiber einen Namen, steht dieser (nur der Name und der Zeitpunkt, ohne Bezug zu einem Konto) auf einer Sperrliste, die alle angemeldeten Spieler lesen können. Gesperrte Namen sind in Ranglisten und Clan-Listen nicht mehr sichtbar und können nicht mehr gewählt werden. Wer gesperrt wurde, behält Konto und Spielstände und wählt einen neuen Namen.',
      'Gemeinsamer Kartenspeicher: Lädst du einen Ort oder eine Stadt als Erster, legt das Spiel das fertige Kartenpaket (Straßen, Stadtgrenze, Firmen, Höhenraster; Daten von OpenStreetMap, ODbL) in der Datenbank ab, damit andere Spieler es schneller bekommen und die Kartenserver entlastet werden. In diesen Paketen steht weder dein Name noch deine Kontokennung noch etwas über dein Unternehmen. Alle angemeldeten Spieler können Pakete abrufen, der Betreiber kann sie löschen.',
      'Keine Werbung, keine Tracking-Cookies, keine Analyse-Dienste. Damit du angemeldet bleibst, speichert dein Browser eine Anmeldemarke im lokalen Speicher; „Abmelden“ löscht sie.',
      'Kartenbild: Das Bild unter dem Spiel kommt von OpenFreeMap (tiles.openfreemap.org, Daten von OpenStreetMap). Dein Browser holt dort Kartenkacheln für den Ausschnitt, den du gerade ansiehst; der Dienst bekommt dafür deine IP-Adresse und die Kachelnummern des Ausschnitts, aber weder Namen noch Konto noch Spielstand. Auf der Karte erscheint nichts von anderen Spielern. Unter Menü → „Kartenbild“ kannst du es auf „nur eigene Straßen“ stellen; dann wird nichts vom Kartenanbieter geladen.',
      'Beim Aufruf der Seite und bei jeder Verbindung zu den genannten Diensten (GitHub Pages, Google Firebase, OpenFreeMap, OpenStreetMap-Dienste) wird technisch deine IP-Adresse an die jeweiligen Server übermittelt.',
      'Löschen: Im Konto-Fenster entfernt „Konto löschen“ Profil, Namen, Unternehmen und Spielstand, Ranglisteneinträge, deine Clan-Mitgliedschaft und das Konto selbst. „Neu anfangen“ löscht nur dein Unternehmen und seine Einträge in der Rangliste deiner Stadt; dein bester Wert in der Weltrangliste bleibt dabei erhalten. Eigene Meldungen werden mitgelöscht, soweit sie älter als 24 Stunden sind; jüngere bleiben bis zur Prüfung durch den Betreiber gespeichert. Als Leiter gibst du die Leitung dabei an das dienstälteste Mitglied ab; bist du allein im Clan, wird er aufgelöst.',
      'Kontakt zum Betreiber dieses Hobby-Projekts: über die Projektseite github.com/memem356/lastmile.'
    ];
    for (const t of items) ul.appendChild(mk('li', '', t));
    root.appendChild(ul);
    const back = btn('Zurück', '', () => { view = 'main'; render(true); }); back.style.marginTop = '12px';
    root.appendChild(back);
    return root;
  }

  // ---------- Konto-Fenster im Spiel ----------
  function confirmBtn(b, ask, fn) {
    let armed = false, t = null; const orig = b.textContent;
    b.onclick = () => {
      if (!armed) { armed = true; b.textContent = ask; t = setTimeout(() => { armed = false; b.textContent = orig; }, 6000); return; }
      clearTimeout(t); armed = false; b.textContent = orig; fn(b);
    };
  }
  const game = () => (window.LMUI && window.LMUI.game) || null;
  // Dein Unternehmen: Startort, Stand und „Neu anfangen“
  function companySection() {
    const sec = mk('section', ''); sec.appendChild(mk('h4', '', 'Dein Unternehmen'));
    const box = mk('div', 'accform'); sec.appendChild(box);
    const g = game(), city = g ? g.city : '';
    const info = mk('p', '', g ? 'Startort: ' + city : 'Wird geladen …'); box.appendChild(info);
    const extra = mk('p', 'note', ''); extra.hidden = true; box.appendChild(extra);
    box.appendChild(mk('p', 'note', 'Dein Konto hat genau einen Startort und einen Spielstand. Willst du an einem anderen Ort beginnen, fängst du hier neu an. Das geht nicht rückgängig: Unternehmen, Spielstand und deine Einträge in der Rangliste deiner Stadt werden gelöscht. Dein bester Wert in der Weltrangliste bleibt erhalten. Deinen Clan behältst du.'));
    const mb = msgBox(), go = btn('Neu anfangen …', 'danger'), row = mk('div', 'accrow'); row.appendChild(go); box.append(mb.m, row);
    L.company.mine().then(m => {
      if (!sec.isConnected || !m) return;
      info.textContent = 'Startort: ' + (city || m.name) + (m.info ? ' · ' + m.info.split(' · ').slice(2).join(' · ') : '') + ' · gesichert ' + ago(m.t, L.serverNow());
      if (m.others) extra.hidden = false;
      if (m.others) extra.textContent = 'Auf diesem Konto liegen außerdem ' + m.others + (m.others === 1 ? ' älteres Unternehmen' : ' ältere Unternehmen') + ' aus früheren Versionen, die nicht mehr gespielt werden. „Neu anfangen“ löscht auch diese.';
    }).catch(() => { if (!g) info.textContent = 'Dein Unternehmen konnte nicht geladen werden.'; });
    confirmBtn(go, 'Wirklich? Dein Unternehmen' + (city ? ' in ' + city : '') + ' wird gelöscht', async b => {
      b.disabled = true; mb.set(''); const gm = game();
      try {
        if (gm) { gm.stop(); await gm.settle(); }
        await L.company.removeAll();
      } catch (e) { if (gm) gm.resume(); fail(mb, e); console.warn('Neu anfangen:', e && e.code, e && e.detail); b.disabled = false; return; }
      if (gm) gm.wipeLocal();
      noteForReload('Dein Unternehmen wurde gelöscht. Such dir jetzt einen neuen Startort aus.');
      location.reload();
    });
    return sec;
  }
  function accountView() {
    const s = L.state(), root = mk('div', 'accform');
    { const t = takeNote(); if (t) root.appendChild(mk('p', 'accmsg ok', t)); }
    const who = mk('div', ''); const nm = mk('p', '', ''); const b = mk('b', '', s.name); nm.appendChild(b); nm.appendChild(document.createTextNode('  ·  ' + s.email)); who.appendChild(nm);
    root.appendChild(who);
    if (s.blocked) { const bh = mk('div', ''); root.appendChild(bh); LMMod.renameForm(bh, { onDone: name => { setNote('Dein neuer Name ist „' + name + '“.'); if (game()) game().refresh(); render(true); } }); }
    const vm = msgBox();
    if (!s.verified) {
      vm.set('Die E-Mail-Adresse ist noch nicht bestätigt. Öffne den Link in der E-Mail von Firebase (auch im Spam-Ordner nachsehen) und tippe dann auf „Ich habe bestätigt“.', 'err');
      const row = mk('div', 'accrow');
      const chk = btn('Ich habe bestätigt', 'primary', () => run(chk, vm, async () => { const v = await L.checkVerified(); if (v) { render(true); } else vm.set('Noch nicht bestätigt. Bitte erst den Link in der E-Mail öffnen.', 'err'); }));
      const again = btn('E-Mail erneut senden', '', () => run(again, vm, async () => { await L.sendVerify(); vm.set('Die E-Mail wurde erneut gesendet.', 'ok'); }));
      row.append(chk, again); root.append(vm.m, row);
    } else root.appendChild(mk('p', 'accmsg ok', 'E-Mail-Adresse bestätigt.'));

    root.appendChild(companySection());

    const cn = mk('section', ''); cn.appendChild(mk('h4', '', 'Clan')); const chost = mk('div', ''); cn.appendChild(chost); root.appendChild(cn);
    const hooks = { report: t => LMMod.reportForm(chost, t, { back: () => LMClan.render(chost, null, hooks) }) };
    LMClan.render(chost, null, hooks);

    const adm = mk('section', ''), ah = mk('div', ''); adm.hidden = true; adm.append(mk('h4', '', 'Betreiber: Meldungen und Sperren'), ah); root.appendChild(adm);
    L.mod.isAdmin().then(yes => { if (yes && adm.isConnected) { adm.hidden = false; LMMod.adminPanel(ah); } }).catch(() => {});

    // Abmelden: erst den Stand sichern, dann das Spiel anhalten, damit danach nichts mehr in das Konto geschrieben wird
    const om = msgBox(), out = btn('Abmelden', ''); let force = false;
    out.onclick = async () => {
      out.disabled = true; om.set(''); const gm = game(), old = out.textContent; out.textContent = 'Wird gespeichert …';
      let saved = true;
      if (gm) { try { saved = (await gm.flush()) || gm.halted(); } catch (e) { saved = false; } }
      if (!saved && !force) { force = true; out.disabled = false; out.textContent = old; om.set('Der Stand konnte nicht in die Cloud gespeichert werden (keine Verbindung?). Eine Kopie bleibt auf diesem Gerät und wird beim nächsten Anmelden hier genutzt. Tippe noch einmal auf „Abmelden“, um trotzdem abzumelden.', 'err'); return; }
      if (gm) { gm.stop(); await gm.settle(); }
      L.logout(); location.reload();
    };
    const acts = mk('div', 'accrow'); acts.appendChild(out);
    acts.appendChild(link('Datenschutz', () => { view = 'privacy'; render(true); }));
    root.append(om.m, acts);

    const tech = mk('details', ''); tech.appendChild(mk('summary', '', 'Technische Angaben'));
    const cpy = btn('Kopieren', '', async () => { try { await navigator.clipboard.writeText(s.uid); cpy.textContent = 'Kopiert'; setTimeout(() => { cpy.textContent = 'Kopieren'; }, 1500); } catch (e) { tf.i.focus(); tf.i.select(); } });
    const tf = field('Kontokennung', { name: 'uid', value: s.uid, extra: cpy }); tf.i.readOnly = true; tf.i.onfocus = () => tf.i.select();
    const tw = mk('div', 'accform'); tw.style.marginTop = '10px'; tw.append(mk('p', 'note', 'Diese Kennung brauchst du nur, wenn dieses Konto in der Datenbank als Betreiber-Konto eingetragen werden soll (siehe README, Phase 8f). Sie gibt keinen Zugriff auf das Konto.'), tf.w);
    tech.appendChild(tw); root.appendChild(tech);

    const del = mk('details', ''); del.appendChild(mk('summary', '', 'Konto löschen …'));
    const dm = msgBox(), dp = field('Passwort zur Bestätigung', { type: 'password', name: 'password', auto: 'current-password' });
    const dgo = btn('Konto endgültig löschen', 'danger', () => run(dgo, dm, async () => {
      const gm = game(); if (gm) { gm.stop(); await gm.settle(); }
      try { await L.deleteAccount(dp.i.value); } catch (e) { if (gm) gm.resume(); throw e; }
      if (gm) gm.wipeLocal();
      noteForReload('Dein Konto und alle Daten dazu wurden gelöscht.'); location.reload();
    }));
    const dw = mk('div', 'accform'); dw.style.marginTop = '10px'; dw.append(mk('p', 'note', 'Löscht Profil, Spielernamen, dein Unternehmen mit Spielstand, Ranglisteneinträge, deine Clan-Mitgliedschaft und das Konto. Das lässt sich nicht rückgängig machen.'), dp.w, dm.m, dgo);
    del.appendChild(dw); root.appendChild(del);
    return root;
  }

  L.on(() => render(false));
  window.__lmAcc = { open: openWin, close: closeWin, mountAuth, unmountAuth, takeNote };
})();
