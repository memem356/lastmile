// Kartenbild unter dem Spiel: OpenFreeMap (OpenStreetMap-Vektorkacheln), gezeichnet mit MapLibre GL JS.
// Das Spiel zeichnet seine eigene Schicht (Verkehr, Routen, Fahrer, Bestellungen, Ereignisse) auf einer durchsichtigen Fläche darüber.
// Die Kamera gehört dem Spiel; die Karte folgt ihr nur. Die Bibliothek wird erst beim Spielstart nachgeladen.
// Es werden ausschließlich Kacheln für das Kartenbild geladen. Von anderen Spielern kommt hier nichts an.
const LMBase = (function () {
  const TS = 512, MAXLAT = 85.0511287798, EARTH = 40075016.686, MAXZ = 18;
  const STYLES = { light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark' };
  const LIB = { js: 'vendor/maplibre-gl.js', css: 'vendor/maplibre-gl.css', ver: '5.7.3' };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---- Web-Mercator, normiert: u = 0 … 1 von West nach Ost, v = 0 … 1 von Nord nach Süd (wie in MapLibre bei Kachelgröße 512) ----
  const mercU = lon => (lon + 180) / 360;
  const mercV = lat => { const s = Math.sin(clamp(lat, -MAXLAT, MAXLAT) * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  const lonOf = u => u * 360 - 180;
  const latOf = v => Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180 / Math.PI;
  const worldPx = z => TS * Math.pow(2, z);                                    // Breite der ganzen Erde in Bildpunkten bei Zoomstufe z
  const metersPerPx = (lat, z) => EARTH * Math.cos(lat * Math.PI / 180) / worldPx(z);

  let libP = null;
  function loadLib() {
    if (typeof window !== 'undefined' && window.maplibregl) return Promise.resolve(window.maplibregl);
    if (libP) return libP;
    libP = new Promise((resolve, reject) => {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = LIB.css + '?v=' + LIB.ver; document.head.appendChild(l);
      const s = document.createElement('script'); s.async = true; s.src = LIB.js + '?v=' + LIB.ver;
      const t = setTimeout(() => reject(new Error('Kartenbibliothek: Zeitüberschreitung')), 25000);
      s.onload = () => { clearTimeout(t); window.maplibregl ? resolve(window.maplibregl) : reject(new Error('Kartenbibliothek fehlt')); };
      s.onerror = () => { clearTimeout(t); reject(new Error('Kartenbibliothek konnte nicht geladen werden')); };
      document.head.appendChild(s);
    });
    libP.catch(() => { libP = null; });
    return libP;
  }

  // host: leeres Element, das die Karte füllt. o.dark(): dunkles Farbschema? o.dpr(): Pixeldichte. o.onState(zustand): 'on' | 'off'.
  function create(host, o) {
    const inst = { why: 'lädt', lib: null };
    let map = null, state = 'off', styleKey = null, styleLoaded = false, okTiles = 0, errs = 0, retries = 0, retryT = null, last = '', dead = false;
    const setState = s => {
      if (s === state || dead) return; state = s; host.classList.toggle('on', s === 'on');
      if (s === 'on') { retries = 0; inst.why = ''; last = ''; }
      try { o.onState && o.onState(s); } catch (e) { console.error(e); }
    };
    const fail = why => {
      if (dead) return; inst.why = why; setState('off'); clearTimeout(retryT);
      if (retries < 3) retryT = setTimeout(() => { retries++; styleKey = null; applyStyle(); }, 20000 * (retries + 1));
    };
    function applyStyle() {
      if (!map || dead) return;
      const key = o.dark() ? 'dark' : 'light'; if (key === styleKey) return;
      styleKey = key; styleLoaded = false; okTiles = 0; errs = 0; last = '';
      map.setStyle(STYLES[key], { diff: false });
    }

    loadLib().then(lib => {
      if (dead) return; inst.lib = lib;
      try {
        const key = o.dark() ? 'dark' : 'light'; styleKey = key;
        map = new lib.Map({
          container: host, style: STYLES[key], center: [0, 0], zoom: 1, minZoom: 0, maxZoom: MAXZ + 1,
          interactive: false, attributionControl: false, trackResize: false, fadeDuration: 0, maxPitch: 0, renderWorldCopies: true,
          pixelRatio: o.dpr ? o.dpr() : 1, canvasContextAttributes: { antialias: true }
        });
      } catch (e) { console.warn('Kartenbild nicht verfügbar:', e && e.message); inst.why = 'WebGL fehlt'; map = null; return; }   // z. B. ohne WebGL: das Spiel zeichnet die Straßen selbst
      map.on('style.load', () => { styleLoaded = true; });
      map.on('sourcedata', e => { if (e && e.tile && e.sourceId !== undefined) okTiles++; });
      map.on('error', e => {
        if (dead) return;
        if (!styleLoaded) { fail('Stil nicht erreichbar'); return; }
        const st = e && e.error && e.error.status;
        if (e && e.sourceId && st !== 404) { errs++; if (state !== 'on' && !okTiles && errs >= 3) fail('Kacheln nicht erreichbar'); }
      });
      map.on('idle', () => { if (state !== 'on' && styleLoaded && okTiles > 0) setState('on'); });
      inst.map = map; last = ''; if (o.ready) o.ready();
    }).catch(e => { console.warn('Kartenbild nicht verfügbar:', e && e.message); inst.why = 'Bibliothek fehlt'; });

    // Kamera: u, v = Bildmitte (normiert), z = Zoomstufe; ruft das Spiel bei jeder Zeichnung auf, damit Bild und Spielschicht im selben Einzelbild stehen
    inst.move = (u, v, z) => {
      if (!map) return;
      const key = u + '|' + v + '|' + z + '|' + host.clientWidth + 'x' + host.clientHeight; if (key === last) return; last = key;
      map.jumpTo({ center: [lonOf(u), latOf(v)], zoom: z, bearing: 0, pitch: 0 });
      if (state === 'on') map.redraw();
    };
    inst.resize = () => { if (map) { map.resize(); last = ''; } };
    inst.setDpr = d => { if (map && map.setPixelRatio) map.setPixelRatio(d); last = ''; };
    inst.restyle = () => applyStyle();
    inst.state = () => state;
    inst.destroy = () => { dead = true; clearTimeout(retryT); if (map) { try { map.remove(); } catch (e) {} map = null; } };
    window.addEventListener('online', () => { if (!dead && state === 'off' && map && inst.why && inst.why !== 'WebGL fehlt') { styleKey = null; applyStyle(); } });
    return inst;
  }

  return { TS, MAXZ, MAXLAT, STYLES, LIB, mercU, mercV, lonOf, latOf, worldPx, metersPerPx, create };
})();
