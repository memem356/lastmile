// Startseite: nur Anmelden/Registrieren und, beim allerersten Mal, die Wahl des Startorts.
// Ein Konto hat genau einen Startort und einen Spielstand; danach geht es nach jeder Anmeldung direkt ins Spiel.
(function boot() {
  const SUGGEST = ['Hamburg', 'Wien', 'Paris', 'New York', 'Tokio', 'Kapstadt', 'São Paulo', 'Sydney'];
  const el = { q: $('q'), form: $('searchForm'), btn: $('searchBtn'), res: $('results'), msg: $('searchMsg'), chips: $('chips'),
    status: $('status'), st: $('statusT'), si: $('statusI'), sb: $('statusBtns'), bar: $('statusBar'), retry: $('statusRetry'), back: $('statusBack'), extra: $('statusExtra') };
  const ckOf = (lat, lon) => LMO.world.ckOf(lat, lon);
  const key = p => p.lat.toFixed(3) + ',' + p.lon.toFixed(3);
  const errMsg = e => (typeof LMMod !== 'undefined' && LMMod.errText) ? LMMod.errText(e) : String((e && e.message) || e);
  let cachedList = [], started = false, live = false, routeKey = null, seq = 0, chosen = null, retryFn = null, backFn = null;

  // Was gerade zu sehen ist: 'auth' | 'pick' | 'confirm' | 'busy' (Statusanzeige mit Fortschritt oder Fehler)
  function view(v) {
    $('authBox').hidden = v !== 'auth';
    $('pickBox').hidden = v !== 'pick' && v !== 'confirm';
    $('pickMain').hidden = v !== 'pick'; $('confirmBox').hidden = v !== 'confirm';
    el.status.hidden = v !== 'busy';
  }
  function status(text, pct, err) {
    view('busy'); el.status.classList.toggle('err', !!err);
    el.st.textContent = text; el.bar.hidden = !!err; el.si.style.width = pct + '%'; el.sb.hidden = !err;
  }
  // Fehleranzeige mit „Erneut versuchen“ und einem zweiten Ausweg (z. B. Abmelden)
  function failed(text, retry, backLabel, back, resettable) {
    retryFn = retry; backFn = back; el.back.textContent = backLabel;
    el.extra.hidden = !resettable; el.extra.disabled = false; el.extra.textContent = 'Unternehmen löschen und neu anfangen'; armedTimer = clearTimeout(armedTimer); armed = false;
    status(text, 0, true); try { el.retry.focus({ preventScroll: true }); } catch (e) {}
  }
  // Ausweg bei einem unlesbaren Stand: Unternehmen löschen (zweistufig). Der Stand wird nie von selbst gelöscht.
  let armed = false, armedTimer = null;
  el.extra.onclick = async () => {
    if (!armed) { armed = true; el.extra.textContent = 'Wirklich? Das Unternehmen wird endgültig gelöscht'; armedTimer = setTimeout(() => { armed = false; el.extra.textContent = 'Unternehmen löschen und neu anfangen'; }, 6000); return; }
    clearTimeout(armedTimer); armed = false; el.extra.disabled = true; const my = ++seq;
    try {
      status('Unternehmen wird gelöscht …', 50);
      await LMO.company.removeAll();
      try { const uid = LMO.state().uid; for (const k of Object.keys(localStorage)) if (k.startsWith('lm.osave.' + uid + '.')) localStorage.removeItem(k); } catch (e) {}
    } catch (e) { if (my !== seq) return; console.error(e); failed('Das Löschen ist nicht gelungen: ' + errMsg(e), () => route(true), logoutBack[0], logoutBack[1], true); return; }
    route(true);
  };
  el.retry.onclick = () => { if (retryFn) retryFn(); };
  el.back.onclick = () => { if (backFn) backFn(); };
  const logoutBack = ['Abmelden', () => LMO.logout()];

  function showAuth() { view('auth'); window.__lmAcc.mountAuth(); }
  function showPick() {
    window.__lmAcc.unmountAuth();
    const s = LMO.state();
    $('pickWho').textContent = 'Angemeldet als ' + s.name + (s.verified ? '' : ' · E-Mail noch nicht bestätigt');
    showNote(); chosen = null; el.res.textContent = ''; el.msg.textContent = '';
    view('pick'); try { el.q.focus({ preventScroll: true }); } catch (e) {}
  }
  function showNote() {
    const t = window.__lmAcc.takeNote(), n = $('pickNote');
    if (t) { n.textContent = t; n.hidden = false; }
  }
  document.addEventListener('lm-note', () => { if (!$('pickBox').hidden) showNote(); });
  $('pickOut').onclick = () => LMO.logout();

  // Welche Seite zu sehen ist, ergibt sich aus dem Konto: abgemeldet → Anmeldung; angemeldet → das Unternehmen des Kontos starten
  // oder, wenn es noch keines gibt, den Startort wählen lassen.
  async function route(force) {
    if (started || !live) return;
    const s = LMO.state(), k = !s.signedIn ? 'out' : s.hasProfile ? 'in:' + s.uid : 'np:' + s.uid;
    if (!force && k === routeKey) return;
    routeKey = k; const my = ++seq;
    if (k === 'out') { showAuth(); return; }
    if (k[0] === 'n') {
      // angemeldet, aber ohne Profil: war nur die Verbindung weg, oder fehlt die Registrierung wirklich?
      status('Konto wird geprüft …', 15);
      try { await LMO.loadProfile(); }
      catch (e) { if (my !== seq) return; console.error(e); failed(errMsg(e), () => route(true), logoutBack[0], logoutBack[1]); return; }
      if (my !== seq) return;
      if (LMO.state().hasProfile) return route(true);
      showAuth(); return;
    }
    window.__lmAcc.unmountAuth();
    status('Dein Unternehmen wird gesucht …', 20);
    let co;
    try { co = await LMO.company.mine(); }
    catch (e) { if (my !== seq) return; console.error(e); failed('Dein Unternehmen konnte nicht geladen werden: ' + errMsg(e), () => route(true), logoutBack[0], logoutBack[1]); return; }
    if (my !== seq || started) return;
    if (!co) return showPick();
    const demo = ESSEN && ESSEN.ref && ckOf(ESSEN.ref.lat, ESSEN.ref.lon) === co.ck;
    const hit = cachedList.find(p => ckOf(p.lat, p.lon) === co.ck);
    if (demo) return begin({ demo: true }, true);
    if (hit) return begin(hit, true);
    if (!isFinite(co.lat) || !isFinite(co.lon)) return failed('Der Startort deines Unternehmens ist nicht lesbar gespeichert. Bitte melde dich beim Betreiber (Kennung: ' + co.ck + ').', () => route(true), logoutBack[0], logoutBack[1]);
    begin({ name: co.name, sub: '', lat: co.lat, lon: co.lon }, true);
  }

  // Karte holen (aus dem Browser-Speicher oder von OpenStreetMap) und das Spiel starten. existing: das Unternehmen gibt es schon.
  async function begin(place, existing) {
    const my = ++seq, name = place.demo ? ESSEN.name : place.name, back = existing ? logoutBack : ['Anderen Ort wählen', () => showPick()];
    const again = () => begin(place, existing);
    let data;
    try {
      if (place.demo) { status(name + ': wird gestartet …', 80); data = ESSEN; await new Promise(r => setTimeout(r, 30)); }
      else {
        status(name + ': Gespeicherte Karte wird gesucht …', 8);
        data = await LM.getCached(place);
        if (!data) {
          data = await LM.loadCity(place, (step, text) => status(name + ': ' + text + ' … (beim ersten Mal bis zu einer Minute, danach ist die Karte gespeichert)', step === 1 ? 25 : step === 2 ? 60 : 82));
          LM.saveCity(place, data);
        }
        if (!data.tz && data.ref) { const tz = await LM.fetchTz(data.ref.lat, data.ref.lon); if (tz) { data.tz = tz; LM.saveCity(place, data); } }
        status(name + ': Straßennetz und Routen werden berechnet …', 90);
        await new Promise(r => setTimeout(r, 40));
      }
    } catch (e) { if (my !== seq) return; console.error(e); failed(errMsg(e), again, back[0], back[1]); return; }
    if (my !== seq) return;
    launch(data, back);
  }

  // Städte der Center laden und mit der Kernkarte zu einer Karte verbinden. o: der Stand aus der Cloud (wird um aktuelle Städte-Verweise ergänzt).
  // Stände ohne Städte (bis Version 4) bekommen die Stadt der Kernkarte. Das Spiel nimmt beim Start aber auch die Kopie auf dem Gerät, wenn sie neuer ist (template.html, onlineLoad):
  // darum werden die Städte beider Stände geladen. Ergebnis: die Spieldaten mit zusammengesetzten Straßen und Städten.
  const mirrorOf = data => {
    try {
      const m = JSON.parse(localStorage.getItem('lm.osave.' + (LMO.state().uid || 'x') + '.' + ckOf(data.ref.lat, data.ref.lon)) || 'null');
      return m && Array.isArray(m.centers) ? m : null;
    } catch (e) { return null; }
  };
  async function withCities(data, o, say, m) {
    const srcs = [o]; if (m) srcs.push(m);
    const list = [], add = r => { if (!list.some(q => q.id === r.id)) list.push(r); };
    const needHome = srcs.some(s => s.centers.some(c => !Array.isArray(c.cities) || !c.cities.length));
    let home = null;
    if (needHome) {
      say({ text: 'Heimatstadt wird bestimmt …' });
      const ct = await LMCity.resolve({ name: data.name, lat: data.ref.lat, lon: data.ref.lon, place: 'city' });
      home = { id: ct.id, name: ct.name, lat: ct.lat, lon: ct.lon, rel: ct.rel || 0, place: ct.place || '', pop: ct.pop || 0, ap: ct.approx ? 1 : 0 }; add(home);
    }
    for (const s of srcs) for (const c of s.centers) if (Array.isArray(c.cities)) for (const r of c.cities) if (r && typeof r.id === 'string') add(r);
    const res = await LMCity.prepare(data, list, say, roadsToTyped), byId = new Map(list.map((r, i) => [r.id, res.refs[i]]));
    for (const c of o.centers) c.cities = Array.isArray(c.cities) && c.cities.length ? c.cities.map(r => (r && byId.get(r.id)) || r) : [byId.get(home.id)];
    return Object.assign({}, data, { roads: res.roads, cities: res.cities });
  }

  async function launch(data, back) {
    const my = seq; let pre, o = null, game = data;
    const again = () => launch(data, back);
    try {
      status(data.name + ': Verbindung zum Server und Unternehmen …', 94);
      pre = await LMO.company.open(ckOf(data.ref.lat, data.ref.lon));
      if (my !== seq) return;
      if (pre.raw) {
        try { o = JSON.parse(pre.raw); } catch (e) { o = null; }
        if (o && o.v > 5) throw new Error('Dein Online-Unternehmen wurde mit einer neueren Version des Spiels gespeichert. Bitte lade die Seite neu (Strg+F5), damit die neue Version geladen wird.');
        if (!o || !(o.v >= 1) || !Array.isArray(o.drivers) || !o.drivers.length) throw new LMO.OErr('CORRUPT');
      }
    } catch (e) { if (my !== seq) return; console.error(e); failed(errMsg(e), again, back[0], back[1], e && e.code === 'CORRUPT'); return; }
    const mir = data !== ESSEN && o && Array.isArray(o.centers) ? mirrorOf(data) : null;
    if (data !== ESSEN && o && Array.isArray(o.centers) && (o.centers.length || (mir && mir.centers.length))) {
      try {
        game = await withCities(data, o, p => { if (my === seq) status(data.name + ': ' + p.text, 96); }, mir);
        pre.raw = JSON.stringify(o);
      } catch (e) { if (my !== seq) return; console.error(e); failed('Die Städte deiner Fulfillment Center konnten nicht geladen werden: ' + errMsg(e), again, back[0], back[1]); return; }
      if (my !== seq) return;
    }
    started = true;
    try { $('start').hidden = true; $('app').hidden = false; startGame(game, 'online', pre); }
    catch (e) { console.error(e); started = false; $('app').hidden = true; $('start').hidden = false; failed(errMsg(e), again, back[0], back[1]); }
  }

  // ---------- Startort wählen ----------
  function item(label, sub, tag, fn) {
    const li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
    const l = document.createElement('span'); l.textContent = label;
    if (sub) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = ' ' + sub; l.appendChild(s); }
    b.appendChild(l);
    if (tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = tag; b.appendChild(t); }
    b.onclick = fn; li.appendChild(b); return li;
  }
  function choose(p) {
    chosen = p; $('confirmName').textContent = p.demo ? ESSEN.name : p.name; $('confirmSub').textContent = p.demo ? ESSEN.sub || '' : p.sub || '';
    view('confirm'); try { $('confirmGo').focus({ preventScroll: true }); } catch (e) {}
  }
  $('confirmGo').onclick = () => { if (chosen) begin(chosen, false); };
  $('confirmBack').onclick = () => { view('pick'); try { el.q.focus({ preventScroll: true }); } catch (e) {} };

  async function doSearch(q) {
    q = q.trim(); if (!q) return;
    el.res.textContent = ''; el.msg.textContent = 'Suche …'; el.btn.disabled = true;
    try {
      const r = await LM.search(q), have = new Set(cachedList.map(key));
      el.msg.textContent = r.length ? '' : 'Nichts gefunden. Probiere eine andere Schreibweise.';
      for (const p of r) el.res.appendChild(item(p.name, p.sub, have.has(key(p)) ? 'gespeichert' : '', () => choose(p)));
    } catch (e) { el.msg.textContent = 'Die Suche ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.'; }
    el.btn.disabled = false;
  }
  el.form.addEventListener('submit', e => { e.preventDefault(); doSearch(el.q.value); });
  for (const n of ['Essen (kleine Karte)'].concat(SUGGEST)) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = n;
    b.onclick = n.startsWith('Essen') ? () => choose({ demo: true }) : () => { el.q.value = n; doSearch(n); };
    el.chips.appendChild(b);
  }

  // ---------- Start ----------
  async function start() {
    if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} } // alte Links mit #c=… führen nirgends mehr hin
    LMO.init();
    if (LMO.state().signedIn) status('Konto wird geprüft …', 10);
    LMO.on(() => route());
    await Promise.all([LMO.ready(), LM.listCached().then(l => { cachedList = l; }).catch(() => {})]);
    live = true; route(true);
  }
  // ---------- Stadt-Test (versteckt): ?probe=Bochum lädt Stichproben einer ganzen Stadt und schreibt Zahlen zum Weitergeben ----------
  function probeUi() {
    const name = new URLSearchParams(location.search).get('probe'), host = document.querySelector('#start .card'); if (!name || !host) return;
    const box = document.createElement('section'); box.className = 'authbox'; box.id = 'probeBox';
    box.innerHTML = '<h2>Stadt-Test</h2><p class="note" style="margin-bottom:8px">Prüft, wie gut Straßen und Firmen einer ganzen Stadt geladen werden. Das dauert ein bis zwei Minuten und lädt einige MB.</p>';
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn primary'; go.id = 'probeGo'; go.textContent = '„' + name + '“ testen';
    const out = document.createElement('pre'); out.id = 'probeOut'; out.style.cssText = 'white-space:pre-wrap;font-size:12px;margin-top:10px;max-height:260px;overflow:auto';
    box.appendChild(go); box.appendChild(out); host.insertBefore(box, host.querySelector('.foot'));
    go.onclick = async () => {
      go.disabled = true; out.textContent = '';
      try { await LMCity.probe(name, t => { out.textContent += t + '\n'; }); } catch (e) { out.textContent += 'Fehler: ' + (e && e.message || e) + '\n'; }
      go.disabled = false;
    };
  }
  probeUi();
  start();
})();
