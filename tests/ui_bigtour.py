"""Fulfillment Center, Tourenplaner mit 30 Stopps und vielen Bestellungen: Vorschlag, Optimieren und Stopps hinzufügen bleiben schnell und rechnen kaum Routen.
Start: python3 tests/ui_bigtour.py   (Ports 8381 / 9281)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9281'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8381/index.html?debug&nobase'
CODE = re.search(r"'(LM-[A-Z0-9-]+)'", open(HERE + '../firebase-rules.json').read()).group(1)
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE,PATCH,OPTIONS'}
FB = re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*')


def mockreq(method, path, body=None, headers=None):
    req = urllib.request.Request(MOCK + path, data=body, method=method, headers=headers or {})
    try:
        r = urllib.request.urlopen(req, timeout=20); return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()


def ctl(p, b=None): return json.loads(mockreq('POST', '/ctl/' + p, json.dumps(b or {}).encode())[1])


async def fbhandler(route, request):
    u = request.url
    if request.method == 'OPTIONS': return await route.fulfill(status=204, headers=CORS)
    m = re.match(r'https://identitytoolkit\.googleapis\.com/v1/accounts:(\w+)\?(.*)$', u)
    if m: mu = '/auth/%s?%s' % m.groups()
    elif (m := re.match(r'https://securetoken\.googleapis\.com/v1/token\?(.*)$', u)): mu = '/token?' + m.group(1)
    elif (m := re.match(r'https://([^/]+)/(.*)$', u)): mu = '/db/%s/%s' % m.groups()
    else: return await route.abort()
    h = {k: v for k, v in request.headers.items() if k.lower() in ('content-type', 'x-firebase-locale')}
    st, body = await asyncio.to_thread(mockreq, request.method, mu, request.post_data_buffer, h)
    await route.fulfill(status=st, headers=dict(CORS, **{'content-type': 'application/json'}), body=body)


async def newctx(b, vw=(1000, 900)):
    ctx = await b.new_context(viewport={'width': vw[0], 'height': vw[1]})
    await ctx.route(FB, fbhandler)
    return ctx


async def newpage(ctx, url=URL, wait=800):
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)) if 'Access is denied' not in str(e) else None)
    pg.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' and 'fonts' not in m.text and 'ERR_' not in m.text and 'Failed to load resource' not in m.text and 'Access is denied' not in m.text else None)
    await pg.add_init_script("window.__LM_PLAN='legacy';localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
    await pg.goto(url); await pg.wait_for_timeout(wait)
    return pg, errs


async def vis(pg, sel): return await pg.evaluate("s=>{const e=document.querySelector(s);return !!e&&!e.hidden&&(e.offsetParent!==null||getComputedStyle(e).position==='fixed')}", sel)


async def wait_vis(pg, sel, ms=8000):
    for _ in range(ms // 100):
        try:
            if await vis(pg, sel): return True
        except Exception: pass
        await pg.wait_for_timeout(100)
    return False


async def wait_for(pg, expr, ms=20000, step=200):
    for _ in range(ms // step):
        try:
            if await pg.evaluate(expr): return True
        except Exception: pass
        await pg.wait_for_timeout(step)
    return False


async def wait_app(pg, ms=25000): return await wait_for(pg, "!document.getElementById('app').hidden && !!window.__lm", ms, 250)


async def start_game(ctx, name, email, url=URL):
    pg, errs = await newpage(ctx, url)
    await pg.evaluate("a=>LMO.register({name:a.name,email:a.email,password:'geheim123',code:a.code})", {'name': name, 'email': email, 'code': CODE})
    await wait_vis(pg, '#pickMain')
    await pg.click('#chips button >> text=Essen'); await pg.click('#confirmGo')
    return pg, errs, await wait_app(pg)



POI_BUILD = """()=>{const E=__lm.E; __lm.setCash(Math.max(__lm.cash(), 200000)); __lm.cen.build(E.HUB.x, E.HUB.y); return __lm.cen.centers().length}"""
OUT = HERE + 'out/'; os.makedirs(OUT, exist_ok=True)
txt = lambda pg, sel: pg.evaluate("s=>document.querySelector(s)?document.querySelector(s).textContent:null", sel)
FAKE = {"elements": [
    {"type": "node", "id": 1, "lat": 51.4512, "lon": 7.0120, "tags": {"name": "Muster GmbH", "office": "company"}},
    {"type": "way", "id": 2, "center": {"lat": 51.4520, "lon": 7.0160}, "tags": {"name": "Schmidt Elektro", "craft": "electrician"}},
    {"type": "node", "id": 3, "lat": 51.4505, "lon": 7.0170, "tags": {"name": "Apotheke am Markt", "amenity": "pharmacy"}},
    {"type": "node", "id": 4, "lat": 51.4530, "lon": 7.0100, "tags": {"name": "Buchladen", "shop": "books"}},
    {"type": "node", "id": 10, "lat": 51.4498, "lon": 7.0152, "tags": {"name": "Sparkasse", "amenity": "bank"}},
    {"type": "way", "id": 11, "center": {"lat": 51.4535, "lon": 7.0190}, "tags": {"name": "Lager Nord", "building": "warehouse"}},
    {"type": "node", "id": 12, "lat": 51.4500, "lon": 7.0105, "tags": {"name": "Coworking Hub", "amenity": "coworking_space"}},
]}
# Bestellung mit festem Fenster, fester Lage (Heim- oder Firmenliste nach Nummer), Menge und Anwesenheit
MK = """(a)=>{ const c=__lm.cen.centers()[a.ci], z=__lm.cen.zone(c); const x=__lm.cen.spawn(a.ci, a.firm?'firm':'private'); const pool=a.firm?z.zf:z.zh, h=pool[(a.idx*53+7)%pool.length];
  x.x=h.x; x.y=h.y; x.node=__lm.E.nearest(h.x,h.y,__lm.E.nets.car.ok); if(a.firm){x.name=h.name;x.kind=h.kind} x.street=h.street||'';
  x.day=a.day; x.wh=[a.a,a.b]; x.ws=__lm.cen.simOf(a.day,a.a); x.we=__lm.cen.simOf(a.day,a.b); x.n=a.n||2; x.pay=Math.round(LMC.pay(x.n,x.firm)*10)/10;
  x.created=(a.ca===undefined?__lm.cen.absT()-3*86400:a.ca); x.pres=!!a.pres; return x.id }"""
OUT = HERE + 'out/'; os.makedirs(OUT, exist_ok=True)
txt = lambda pg, sel: pg.evaluate("s=>document.querySelector(s)?document.querySelector(s).textContent:null", sel)
HM = lambda sec: '%d:%02d' % (int(sec // 3600) % 24, int(sec % 3600 // 60))


async def setT(pg, h, di):
    await pg.evaluate("a=>{__lm.world.setHour(a[0], a[1]); __lm.cen.refit()}", [h, di])


async def mk(pg, ci=0, firm=False, day=3, a=10, b=12, n=2, idx=0, pres=False, ca=None):
    return await pg.evaluate(MK, {'ci': ci, 'firm': firm, 'day': day, 'a': a, 'b': b, 'n': n, 'idx': idx, 'pres': pres, 'ca': ca})


TOUR = "(id)=>{const T=__lm.cen.tour.list(0).find(t=>t.id===id); return T?{st:T.st,i:T.i,stops:T.stops.length,van:T.van,drv:T.drv,hold:T.hold,km:T.km,res:T.res.length,dep:T.dep,t0:T.t0,stall:!!T.stall,est:T.est}:null}"


async def run_until(pg, tid, until, step=30, maxs=14 * 3600):
    """Zeit in Schritten vorspulen, bis until(zustand) wahr ist oder die Tour fertig ist; liefert (Zustände, Verlauf)."""
    seen = []; t = 0; last = None
    while t < maxs:
        await pg.evaluate("s=>__lm.adv(s, 10)", step); t += step
        st = await pg.evaluate(TOUR, tid)
        if st is None: return None, seen
        last = st
        if not seen or seen[-1] != st['st']: seen.append(st['st'])
        if until(st): return st, seen
    return last, seen


RAND = """(a)=>{ const E=__lm.E, ok=E.nets.car.ok, c=__lm.cen.centers()[0]; let seed=a.seed; const rnd=()=>(seed=(seed*1664525+1013904223)>>>0)/4294967296;
  const ids=[]; for (let n=0;n<E.N;n++) if (ok[n] && Math.hypot(E.nx[n]-E.nx[c.node], E.ny[n]-E.ny[c.node])<7000) ids.push(n);
  const arr=__lm.cen.orders(); arr.splice(0,arr.length); const out=[];
  for (let i=0;i<a.n;i++){ const x=__lm.cen.spawn(0,'private'); const nd=ids[Math.floor(rnd()*ids.length)]; x.node=nd; x.x=E.nx[nd]; x.y=E.ny[nd]; x.street='S'+i;
    x.day=3; const w=[[8,12],[10,14],[12,16],[9,13]][i%4]; x.wh=w; x.ws=__lm.cen.simOf(3,w[0]); x.we=__lm.cen.simOf(3,w[1]); x.n=2+(i%3); x.pay=7; x.created=__lm.cen.absT()-3*86400; out.push(x.id) }
  return out }"""
COUNT = "(()=>{const E=__lm.E, f=E.returnLeg; window.__rl={n:0}; E.returnLeg=function(){__rl.n++; return f.apply(this,arguments)}})()"
STOPS = "[...document.querySelectorAll('#plStops .pstop')].map(li=>li.querySelector('strong').textContent)"
BACK = "(()=>{const m=/zurück etwa (\\d+):(\\d+)/.exec(document.getElementById('plSum').textContent); return m?Number(m[1])*60+Number(m[2]):-1})()"


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9281'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8381', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R = []

    def ok(name, cond, info=''):
        R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await newctx(b)

            async def overpass(route, request):
                await route.fulfill(status=200, headers={'content-type': 'application/json', 'access-control-allow-origin': '*'}, body=json.dumps(FAKE))
            await ctx.route(re.compile(r'https://(overpass-api\.de|overpass\.private\.coffee|overpass\.kumi\.systems|maps\.mail\.ru)/.*'), overpass)
            pg, errs, started = await start_game(ctx, 'Tim Gross', 'big@example.de')
            ok('T0 Spiel startet', started)
            await pg.evaluate("Math.random = () => 0.5; __lm.cen.auto(false); __lm.drivers().forEach(d => { d.rest = 'on'; }); __lm.setCash(900000)")
            await pg.evaluate(POI_BUILD); await pg.evaluate("__lm.cen.setView('cen')")
            await pg.evaluate("for (let i=0;i<2;i++) __lm.cen.buyVan(0); for (let i=0;i<2;i++) __lm.cen.hire(0); for (let i=0;i<10;i++) __lm.cen.upg('stops', 0)")
            await setT(pg, 5.0, 3)
            ids = await pg.evaluate(RAND, {'seed': 12345, 'n': 150}); await pg.wait_for_timeout(300)
            ok('B1 Center fährt 30 Stopps je Tour, 150 Bestellungen an verschiedenen Orten', await pg.evaluate("__lm.cen.cStops(__lm.cen.centers()[0])") == 30 and len(set(ids)) == 150)
            await pg.click('#tourNew'); await wait_vis(pg, '#planner')
            await pg.evaluate(COUNT)

            # ================= Vorschlag =================
            t0 = time.time(); await pg.click('#plSug', timeout=60000); dt = time.time() - t0
            n_rt = await pg.evaluate("__rl.n"); info = await txt(pg, '#plInfo'); st = await pg.evaluate(STOPS)
            ok('B2 Vorschlag mit 150 Bestellungen und 30 Stopps ist in wenigen Sekunden fertig', dt < 8 and (info or '').startswith('Vorschlag:'), '%.1f s, %s' % (dt, (info or '')[:60]))
            ok('B3 Dabei werden nur wenige Routen berechnet (vorher fast 200.000)', n_rt <= 400, str(n_rt))
            ok('B4 Mindestens 24 Stopps, keiner zu spät, Tour speicherbar', len(st) >= 24 and await pg.evaluate("document.querySelectorAll('#plStops .peta.late').length") == 0 and not await pg.evaluate("document.getElementById('plSave').disabled"), '%d Stopps' % len(st))
            back1 = await pg.evaluate(BACK)
            ok('B5 Zusammenfassung: 8-Stunden-Grenze eingehalten', 0 < back1 and 'zu spät' not in await txt(pg, '#plSum'), await txt(pg, '#plSum'))

            # ================= Optimieren und erneuter Vorschlag =================
            await pg.evaluate("__rl.n = 0")
            t0 = time.time(); await pg.click('#plOpt', timeout=60000); dt = time.time() - t0
            ok('B6 "Reihenfolge optimieren" bei vollen 30 Stopps ist schnell und wird nicht schlechter', dt < 8 and await pg.evaluate("__rl.n") <= 400 and await pg.evaluate(BACK) <= back1, '%.1f s, %d Routen, %s -> %s' % (dt, await pg.evaluate("__rl.n"), back1, await pg.evaluate(BACK)))
            keep = await pg.evaluate(STOPS)
            await pg.evaluate("__rl.n = 0")
            t0 = time.time(); await pg.click('#plSug', timeout=60000); dt = time.time() - t0
            ok('B7 Nochmal "Vorschlag" bei voller Tour: nichts mehr zu ergänzen, Reihenfolge bleibt', dt < 4 and await pg.evaluate(STOPS) == keep, '%.1f s %s' % (dt, ((await txt(pg, '#plInfo')) or '')[:60]))

            # ================= Speichern: Prognose stimmt mit der Rechnung überein =================
            await pg.click('#plSave'); await pg.wait_for_timeout(400)
            tl = await pg.evaluate("__lm.cen.tour.list(0).map(t=>({n:t.stops.length, est:t.est, van:t.van, drv:t.drv, ids:t.stops, day:t.day, k:t.k}))")
            ok('B8 Tour gespeichert mit den vorgeschlagenen Stopps', len(tl) == 1 and tl[0]['n'] == len(keep), str(tl)[:120])
            if tl:
                T = tl[0]
                end = await pg.evaluate("a=>__lm.cen.tour.calc(0, __lm.cen.centers()[0].drv.find(x=>x.id===a.drv), a.day, a.k, a.ids).sc.end", T)
                ok('B9 Rückkehrzeit der Tour = echte Rechnung (Prüfung mit echten Fahrzeiten)', abs(end - T['est']) < 1, '%s %s' % (end, T['est']))

            # ================= Zeitgrenze: Vorschlag in Schritten =================
            await pg.evaluate("(()=>{const c=__lm.cen.centers()[0]; c.tours.filter(t=>t.st==='plan').forEach(t=>__lm.cen.tour.cancel(0,t.id))})()")
            await pg.click('#tourNew'); await wait_vis(pg, '#planner')
            await pg.evaluate("(()=>{ window.__dn = Date.now; let s = 0; Date.now = () => window.__dn.call(Date) + (s += 400); })()")
            await pg.click('#plSug', timeout=60000)
            part = await pg.evaluate(STOPS); info = (await txt(pg, '#plInfo')) or ''
            await pg.evaluate("Date.now = window.__dn")
            ok('B10 Zeitgrenze erreicht: Teilergebnis mit Hinweis, noch einmal zu drücken', 0 < len(part) < 30 and 'noch einmal' in info, '%d Stopps, %s' % (len(part), info[:100]))
            await pg.click('#plSug', timeout=60000)
            more = await pg.evaluate(STOPS)
            ok('B11 Zweiter Druck ergänzt weitere Bestellungen zur bestehenden Tour', len(more) > len(part) and all(s in more for s in part), '%d -> %d' % (len(part), len(more)))

            # ================= Stopps einzeln hinzufügen =================
            await pg.click('#plClr'); await pg.wait_for_timeout(300)
            await pg.evaluate("__rl.n = 0")
            t0 = time.time()
            for oid in ids[:20]:
                await pg.evaluate("i=>{const b=document.querySelector('#colist li[data-id=\"'+i+'\"] button[data-act=tourToggle]'); if (b) b.click()}", oid)
            await pg.wait_for_timeout(300)
            dt = time.time() - t0; got = await pg.evaluate(STOPS)
            ok('B12 20 Stopps nacheinander in die Tour nehmen: schnell, wenige Routen', dt < 20 and await pg.evaluate("__rl.n") <= 500 and len(got) >= 12, '%.1f s, %d Routen, %d Stopps' % (dt, await pg.evaluate("__rl.n"), len(got)))
            await pg.keyboard.press('Escape')
            ok('Z1 Keine Skriptfehler', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
