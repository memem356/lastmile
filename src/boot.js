(function boot() {
  const SUGGEST = ['Hamburg', 'Wien', 'Paris', 'New York', 'Tokio', 'Kapstadt', 'São Paulo', 'Sydney'];
  const el = { q: $('q'), form: $('searchForm'), btn: $('searchBtn'), res: $('results'), msg: $('searchMsg'), recent: $('recent'),
    recentBox: $('recentBox'), chips: $('chips'), status: $('status'), st: $('statusT'), si: $('statusI'), sb: $('statusBtns'), bar: $('statusBar') };
  const lock = on => { for (const id of ['modeSec', 'searchBox', 'recentBox', 'chipBox', 'saveBox', 'fileBox']) $(id).hidden = on || (id === 'recentBox' && !cachedList.length) || (id === 'saveBox' && !saves.length); };
  let cachedList = [], saves = [], mode = 'relaxed';
  try { mode = localStorage.getItem('lm-mode') === 'rush' ? 'rush' : 'relaxed'; } catch (e) {}
  const mq2 = () => '&m=' + (mode === 'rush' ? 'r' : 'e');
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

  function launch(data) {
    $('start').hidden = true; $('app').hidden = false;
    startGame(data, mode);
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
  function importFile(file) {
    const rd = new FileReader();
    rd.onerror = () => fmsg('Die Datei konnte nicht gelesen werden.', true);
    rd.onload = () => {
      try {
        const o = JSON.parse(String(rd.result)), sv = o && o.lm === 'lastmile-save' ? o.save : null;
        if (!sv || !sv.place || !isFinite(+sv.place.lat) || !isFinite(+sv.place.lon) || !Array.isArray(sv.drivers) || !sv.drivers.length) throw new Error('format');
        if (!(sv.v >= 1)) throw new Error('format');
        if (sv.v > 2) return fmsg('Dieser Spielstand stammt aus einer neueren Version des Spiels.', true);
        const k = 'lm.save.' + (+sv.place.lat).toFixed(3) + ',' + (+sv.place.lon).toFixed(3) + '.' + (sv.mode === 'rush' ? 'rush' : 'relaxed'), old = localStorage.getItem(k);
        if (old) localStorage.setItem(k + '.bak', old);
        localStorage.setItem(k, JSON.stringify(sv));
        fmsg('Importiert: ' + sv.place.name + '. Du findest ihn jetzt oben unter „Weiter spielen“.'); init.again = true; saves.length = 0; init();
      } catch (e) { fmsg('Das ist kein gültiger Lastmile-Spielstand.', true); }
    };
    rd.readAsText(file);
  }
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
        if (k && k.startsWith('lm.save.')) { const sv = JSON.parse(localStorage.getItem(k)); if (sv && sv.place && sv.v >= 1) saves.push(sv); }
      }
    } catch (e) {}
    saves.sort((a, b) => b.at - a.at);
    $('saveList').textContent = '';
    for (const sv of saves) {
      const m = sv.mode === 'rush' ? 'Rush' : 'Entspannt', cash = Math.round(sv.cash).toLocaleString('de-DE') + ' €';
      $('saveList').appendChild(item(sv.place.name + ' · ' + m, cash + ' · ' + sv.stats.n + ' Lieferungen · ' + ago(sv.at), 'fortsetzen', () => { setMode(sv.mode === 'rush' ? 'rush' : 'relaxed'); begin(sv.place); }));
    }
    $('saveBox').hidden = !saves.length;
    fileSection();
    cachedList = await LM.listCached();
    el.recent.textContent = '';
    for (const p of cachedList) el.recent.appendChild(item(p.name, p.sub, '', () => begin(p)));
    el.recentBox.hidden = !cachedList.length;
    if (init.again) { init.again = false; return; }
    const m = location.hash.match(/^#c=(.+?)(?:&m=([re]))?$/);
    if (m) {
      if (m[2]) setMode(m[2] === 'r' ? 'rush' : 'relaxed');
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
