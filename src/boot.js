(function boot() {
  const SUGGEST = ['Hamburg', 'Wien', 'Paris', 'New York', 'Tokio', 'Kapstadt', 'São Paulo', 'Sydney'];
  const el = { q: $('q'), form: $('searchForm'), btn: $('searchBtn'), res: $('results'), msg: $('searchMsg'), recent: $('recent'),
    recentBox: $('recentBox'), chips: $('chips'), status: $('status'), st: $('statusT'), si: $('statusI'), sb: $('statusBtns'), bar: $('statusBar') };
  const SECTIONS = ['accBar', 'playSec', 'modeSec', 'searchBox', 'recentBox', 'chipBox', 'saveBox', 'fileBox', 'gateBox', 'onlineBox'];
  let cachedList = [], saves = [], mode = 'relaxed', play = 'solo', locked = false;
  try { mode = localStorage.getItem('lm-mode') === 'rush' ? 'rush' : 'relaxed'; play = localStorage.getItem('lm-play') === 'online' ? 'online' : 'solo'; } catch (e) {}
  const onlineReady = () => { const s = LMO.state(); return s.signedIn && s.hasProfile; };
  // Welche Teile der Startseite zu sehen sind, hängt von Spielart und Anmeldung ab
  function layout() {
    const on = play === 'online', ready = on && onlineReady();
    const show = { accBar: true, playSec: true, modeSec: !on, searchBox: !on || ready, recentBox: cachedList.length > 0 && (!on || ready), chipBox: !on || ready, saveBox: !on && saves.length > 0, fileBox: !on, gateBox: on && !ready, onlineBox: ready };
    for (const id of SECTIONS) $(id).hidden = locked || !show[id];
    if (on && !ready) {
      const s = LMO.state();
      $('gateTxt').textContent = !s.signedIn ? 'Für den Online-Modus brauchst du ein Konto. Melde dich an oder registriere dich (dafür brauchst du einen Einladungscode).' : 'Deine Registrierung ist noch nicht abgeschlossen. Schließe sie ab, dann kannst du online spielen.';
      $('gateBtn').textContent = !s.signedIn ? 'Anmelden oder registrieren' : 'Registrierung abschließen';
    }
    if (on && ready && !locked) loadOnlineList();
  }
  const lock = on => { locked = on; layout(); };
  const mq2 = () => '&m=' + (play === 'online' ? 'o' : mode === 'rush' ? 'r' : 'e');
  function setPlay(p) {
    play = p; try { localStorage.setItem('lm-play', p); } catch (e) {}
    for (const b of $('playBox').children) b.setAttribute('aria-pressed', String(b.dataset.p === p));
    layout();
  }
  for (const b of $('playBox').children) b.onclick = () => setPlay(b.dataset.p);
  $('gateBtn').onclick = () => { if (window.__lmAcc) window.__lmAcc.open('main'); };
  for (const b of $('playBox').children) b.setAttribute('aria-pressed', String(b.dataset.p === play));
  LMO.on(() => layout());
  // Die Online-Unternehmen des Kontos (aus der Cloud)
  let listSeq = 0, listFor = '';
  async function loadOnlineList() {
    const uid = LMO.state().uid, tag = uid + '|' + (loadOnlineList.again || 0);
    if (listFor === tag) return; listFor = tag; const my = ++listSeq;
    const ul = $('onlineList'), msg = $('onlineMsg'); ul.textContent = ''; msg.textContent = 'Lade …';
    try {
      const list = (await LMO.cloud.list()).filter(x => x.slot.startsWith('o_'));
      if (my !== listSeq) return;
      msg.textContent = list.length ? 'Oder suche unten eine Stadt, in der du ein neues Unternehmen gründen willst.' : 'Du hast noch kein Online-Unternehmen. Such unten eine Stadt, um eines zu gründen.';
      for (const x of list) {
        const parts = x.slot.slice(2).split('_'), info = String(x.info || '').split(' · ');
        const lat = parts.length === 4 ? +(parts[0] + '.' + parts[1]) : NaN, lon = parts.length === 4 ? +(parts[2] + '.' + parts[3]) : NaN;
        const place = { name: info[1] || 'Stadt', sub: '', lat, lon };
        const demo = ESSEN && ESSEN.ref && LMO.world.ckOf(ESSEN.ref.lat, ESSEN.ref.lon) === x.slot.slice(2);
        const hit = cachedList.find(p => LMO.world.ckOf(p.lat, p.lon) === x.slot.slice(2));
        ul.appendChild(item(info[1] || x.slot, info.slice(2).join(' · '), 'fortsetzen', () => begin(demo ? { demo: true } : hit || place)));
      }
    } catch (e) { if (my === listSeq) { msg.textContent = 'Die Unternehmen konnten nicht geladen werden: ' + (e.message || e); listFor = ''; } }
  }
  function setMode(m) {
    mode = m; try { localStorage.setItem('lm-mode', m); } catch (e) {}
    for (const b of $('modeBox').children) b.setAttribute('aria-pressed', String(b.dataset.m === m));
  }
  for (const b of $('modeBox').children) b.onclick = () => setMode(b.dataset.m);
  setMode(mode);

  function item(label, sub, tag, fn) {
    const li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
    const l = document.createElement('span'); l.textContent = label;
    if (sub) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = ' ' + sub; l.appendChild(s); }
    b.appendChild(l);
    if (tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = tag; b.appendChild(t); }
    b.onclick = fn; li.appendChild(b); return li;
  }
  const key = p => p.lat.toFixed(3) + ',' + p.lon.toFixed(3);

  function status(text, pct, err) {
    el.status.hidden = false; el.status.classList.toggle('err', !!err);
    el.st.textContent = text; el.bar.hidden = !!err; el.si.style.width = pct + '%'; el.sb.hidden = !err;
  }
  function backToSearch() { el.status.hidden = true; lock(false); history.replaceState(null, '', location.pathname); el.q.focus(); }
  $('statusBack').onclick = backToSearch;
  $('switchCity').onclick = () => { history.replaceState(null, '', location.pathname); location.reload(); };

  // Beim Online-Start ist das Konto womöglich noch nicht geladen (direkt nach dem Öffnen der Seite): kurz darauf warten
  async function accountReady() {
    for (let i = 0; i < 100; i++) {
      const s = LMO.state();
      if (!s.signedIn) return false;
      if (s.hasProfile) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }
  async function launch(data) {
    let pre = null;
    try {
      if (play === 'online') {
        status(data.name + ': Konto wird geprüft …', 92);
        if (!(await accountReady())) throw new Error('Für den Online-Modus bitte zuerst anmelden (oder Solo spielen).');
        status(data.name + ': Verbindung zum Server und Unternehmen …', 94);
        pre = await LMO.company.open(LMO.world.ckOf(data.ref.lat, data.ref.lon));
        if (pre.raw) {
          let o = null; try { o = JSON.parse(pre.raw); } catch (e) {}
          if (o && o.v > 2) throw new Error('Dein Online-Unternehmen wurde mit einer neueren Version des Spiels gespeichert. Bitte lade die Seite neu (Strg+F5), damit die neue Version geladen wird.');
          if (!o || !(o.v >= 1) || !Array.isArray(o.drivers) || !o.drivers.length) throw new LMO.OErr('CORRUPT');
        }
      }
      $('start').hidden = true; $('app').hidden = false;
      startGame(data, play === 'online' ? 'online' : mode, pre);
    } catch (e) { console.error(e); status(String((e && e.message) || e), 0, true); }
  }

  async function begin(place) {
    lock(true);
    if (place.demo) {
      history.replaceState(null, '', '#c=essen-demo' + mq2());
      status('Essen-Innenstadt wird gestartet …', 80);
      return setTimeout(() => launch(ESSEN), 30);
    }
    history.replaceState(null, '', '#c=' + place.lat.toFixed(4) + ',' + place.lon.toFixed(4) + ',' + encodeURIComponent(place.name) + mq2());
    try {
      status(place.name + ': Gespeicherte Karte wird gesucht …', 8);
      let data = await LM.getCached(place);
      if (!data) {
        data = await LM.loadCity(place, (step, text) => status(place.name + ': ' + text + ' … (beim ersten Mal bis zu einer Minute, danach ist die Stadt gespeichert)', step === 1 ? 25 : step === 2 ? 60 : 82));
        LM.saveCity(place, data);
      }
      if (!data.tz && data.ref) { const tz = await LM.fetchTz(data.ref.lat, data.ref.lon); if (tz) { data.tz = tz; LM.saveCity(place, data); } }
            status(place.name + ': Straßennetz und Routen werden berechnet …', 90);
      await new Promise(r => setTimeout(r, 40));
      launch(data);
    } catch (e) {
      console.error(e);
      status(String((e && e.message) || e), 0, true);
    }
  }

  async function doSearch(q) {
    q = q.trim(); if (!q) return;
    el.res.textContent = ''; el.msg.textContent = 'Suche …'; el.btn.disabled = true;
    try {
      const r = await LM.search(q), have = new Set(cachedList.map(key));
      el.msg.textContent = r.length ? '' : 'Nichts gefunden. Probiere eine andere Schreibweise.';
      for (const p of r) el.res.appendChild(item(p.name, p.sub, have.has(key(p)) ? 'gespeichert' : '', () => begin(p)));
    } catch (e) { el.msg.textContent = 'Die Suche ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.'; }
    el.btn.disabled = false;
  }
  el.form.addEventListener('submit', e => { e.preventDefault(); doSearch(el.q.value); });

  for (const n of ['Essen (Demo)'].concat(SUGGEST)) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = n;
    b.onclick = n.startsWith('Essen') ? () => begin({ demo: true }) : () => { el.q.value = n; doSearch(n); };
    el.chips.appendChild(b);
  }

  const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 2 ? 'gerade eben' : m < 90 ? 'vor ' + m + ' Min.' : m < 2880 ? 'vor ' + Math.round(m / 60) + ' Std.' : 'vor ' + Math.round(m / 1440) + ' Tagen'; };
  // Spielstände als Datei sichern und wieder einlesen, auch defekte Stände
  function dl(name, text) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  const fmsg = (t, err) => { const m = $('fileMsg'); m.hidden = !t; m.textContent = t || ''; m.style.color = err ? '#e0402a' : ''; };
  // Prüft einen Spielstand und legt ihn unter seinem Speicherplatz ab (ein vorhandener Stand bleibt als Sicherung). Gibt eine Fehlermeldung oder null zurück.
  const saveKeyOf = sv => 'lm.save.' + (+sv.place.lat).toFixed(3) + ',' + (+sv.place.lon).toFixed(3) + '.' + (sv.mode === 'rush' ? 'rush' : 'relaxed');
  function storeSave(sv) {
    if (!sv || !sv.place || !isFinite(+sv.place.lat) || !isFinite(+sv.place.lon) || !Array.isArray(sv.drivers) || !sv.drivers.length) return 'Das ist kein gültiger Lastmile-Spielstand.';
    if (!(sv.v >= 1)) return 'Das ist kein gültiger Lastmile-Spielstand.';
    if (sv.v > 2) return 'Dieser Spielstand stammt aus einer neueren Version des Spiels.';
    try {
      const k = saveKeyOf(sv), old = localStorage.getItem(k);
      if (old) localStorage.setItem(k + '.bak', old);
      localStorage.setItem(k, JSON.stringify(sv));
    } catch (e) { return 'Der Browser erlaubt keinen Speicher.'; }
    return null;
  }
  function importFile(file) {
    const rd = new FileReader();
    rd.onerror = () => fmsg('Die Datei konnte nicht gelesen werden.', true);
    rd.onload = () => {
      let sv = null;
      try { const o = JSON.parse(String(rd.result)); sv = o && o.lm === 'lastmile-save' ? o.save : null; } catch (e) {}
      const err = storeSave(sv);
      if (err) return fmsg(err, true);
      fmsg('Importiert: ' + sv.place.name + '. Du findest ihn jetzt oben unter „Weiter spielen“.'); refreshStart();
    };
    rd.readAsText(file);
  }
  function refreshStart() { init.again = true; saves.length = 0; init(); }
  // Schnittstelle für das Konto-Fenster (account.js)
  window.LMUI = {
    saveKeyOf,
    importSave(sv) { const e = storeSave(sv); if (!e) refreshStart(); return e; },
    localSaves() {
      const out = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('lm.save.') && !k.endsWith('.bak')) { const raw = localStorage.getItem(k), sv = JSON.parse(raw); if (sv && sv.place && sv.v >= 1 && Array.isArray(sv.drivers)) out.push({ key: k, sv, raw }); } } } catch (e) {}
      return out.sort((a, b) => b.sv.at - a.sv.at);
    }
  };
  function fileSection() {
    const ul = $('fileList'); ul.textContent = '';
    ul.appendChild(item('Spielstand importieren', '(Datei)', 'wählen', () => { const f = document.createElement('input'); f.type = 'file'; f.accept = '.json,application/json'; f.onchange = () => { if (f.files[0]) importFile(f.files[0]); }; f.click(); }));
    const bad = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('lm.bad.')) bad.push(k); } } catch (e) {}
    bad.sort().reverse().forEach(k => {
      const ts = +k.split('.')[2]; ul.appendChild(item('Beschädigter Stand', 'vom ' + new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }), 'sichern', () => dl('lastmile-defekt-' + ts + '.json', localStorage.getItem(k) || '')));
    });
  }
  async function init() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('lm.save.') && !k.endsWith('.bak')) { const sv = JSON.parse(localStorage.getItem(k)); if (sv && sv.place && sv.v >= 1) saves.push(sv); }
      }
    } catch (e) {}
    saves.sort((a, b) => b.at - a.at);
    $('saveList').textContent = '';
    for (const sv of saves) {
      const m = sv.mode === 'rush' ? 'Rush' : 'Entspannt', cash = Math.round(sv.cash).toLocaleString('de-DE') + ' €';
      $('saveList').appendChild(item(sv.place.name + ' · ' + m, cash + ' · ' + sv.stats.n + (sv.stats.n === 1 ? ' Lieferung' : ' Lieferungen') + ' · ' + ago(sv.at), 'fortsetzen', () => { setPlay('solo'); setMode(sv.mode === 'rush' ? 'rush' : 'relaxed'); begin(sv.place); }));
    }
    fileSection();
    cachedList = await LM.listCached();
    el.recent.textContent = '';
    for (const p of cachedList) el.recent.appendChild(item(p.name, p.sub, '', () => begin(p)));
    layout();
    if (init.again) { init.again = false; return; }
    layout();
    const m = location.hash.match(/^#c=(.+?)(?:&m=([reo]))?$/);
    if (m) {
      if (m[2] === 'o') setPlay('online'); else if (m[2]) { setPlay('solo'); setMode(m[2] === 'r' ? 'rush' : 'relaxed'); }
      if (m[1] === 'essen-demo') return begin({ demo: true });
      const [lat, lon, ...rest] = m[1].split(',');
      if (isFinite(+lat) && isFinite(+lon) && rest.length) {
        const name = decodeURIComponent(rest.join(',')), hit = cachedList.find(p => key(p) === key({ lat: +lat, lon: +lon }));
        return begin(hit || { name, sub: '', lat: +lat, lon: +lon });
      }
    }
    el.q.focus();
  }
  init();
})();
