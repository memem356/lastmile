(function boot() {
  const SUGGEST = ['Hamburg', 'Wien', 'Paris', 'New York', 'Tokio', 'Kapstadt', 'São Paulo', 'Sydney'];
  const el = { q: $('q'), form: $('searchForm'), btn: $('searchBtn'), res: $('results'), msg: $('searchMsg'), recent: $('recent'),
    recentBox: $('recentBox'), chips: $('chips'), status: $('status'), st: $('statusT'), si: $('statusI'), sb: $('statusBtns'), bar: $('statusBar') };
  const lock = on => { for (const id of ['searchBox', 'recentBox', 'chipBox']) $(id).hidden = on || (id === 'recentBox' && !cachedList.length); };
  let cachedList = [];

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
    startGame(data);
  }

  async function begin(place) {
    lock(true);
    if (place.demo) {
      history.replaceState(null, '', '#c=essen-demo');
      status('Essen-Innenstadt wird gestartet …', 80);
      return setTimeout(() => launch(ESSEN), 30);
    }
    history.replaceState(null, '', '#c=' + place.lat.toFixed(4) + ',' + place.lon.toFixed(4) + ',' + encodeURIComponent(place.name));
    try {
      status(place.name + ': Gespeicherte Karte wird gesucht …', 8);
      let data = await LM.getCached(place);
      if (!data) {
        data = await LM.loadCity(place, (step, text) => status(place.name + ': ' + text + ' … (beim ersten Mal bis zu einer Minute, danach ist die Stadt gespeichert)', step === 1 ? 25 : 60));
        LM.saveCity(place, data);
      }
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

  async function init() {
    cachedList = await LM.listCached();
    el.recent.textContent = '';
    for (const p of cachedList) el.recent.appendChild(item(p.name, p.sub, '', () => begin(p)));
    el.recentBox.hidden = !cachedList.length;
    const m = location.hash.match(/^#c=(.+)$/);
    if (m) {
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
