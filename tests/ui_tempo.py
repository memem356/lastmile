"""Tempo-Plan der Weltzeit im Browser: Plan aktiv (Tag 15-fach, Nacht 60-fach), gemessene Geschwindigkeit, Tooltip der Uhr, Abwesenheit (Spielstunden), Neuladen mit Zeitversatz, Lücke im Takt.
Start: python3 tests/ui_tempo.py   (Ports 8382 / 9282)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9282'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8382/index.html?debug&nobase'
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
    await pg.add_init_script("window.__LM_PLAN={from:Math.floor(Date.now()/1000)-Date.UTC(2026,9,1)/1000-5400};localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
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

async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9282'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8382', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            pg, errs, started = await start_game(ctx, 'Tim Tempo', 'tempo@example.de')
            ok('T0 Spiel startet mit eigenem Plan', started)
            plan = await pg.evaluate("LMO.world.plan")
            ok('C1 Plan aktiv: 5 bis 22 Uhr 15-fach, nachts 60-fach', plan and plan['h0'] == 5 and plan['h1'] == 22 and plan['vDay'] == 15 and plan['vNight'] == 60, str(plan))

            # ================= gemessenes Tempo =================
            good = False; info = ''
            for _ in range(5):
                s1 = await pg.evaluate("[performance.now(), LMO.world.gameNow()]"); await pg.wait_for_timeout(2500); s2 = await pg.evaluate("[performance.now(), LMO.world.gameNow()]")
                v1 = await pg.evaluate("g=>LMO.world.speedAt(g)", s1[1]); v2 = await pg.evaluate("g=>LMO.world.speedAt(g)", s2[1])
                rate = (s2[1] - s1[1]) / ((s2[0] - s1[0]) / 1000); info = '%.1f (erwartet %s)' % (rate, v1)
                if v1 == v2: good = abs(rate / v1 - 1) < 0.06; break
            ok('C2 Gemessenes Tempo der Weltzeit = Tempo der Tageszeit (15 oder 60)', good, info)
            await pg.wait_for_timeout(400)
            title = await pg.evaluate("document.getElementById('clock').title"); sp = await pg.evaluate("LMO.world.speedAt(__lm.worldT())")
            ok('C3 Uhr zeigt das aktuelle Tempo als Tooltip', title in ('Spielzeit, Tempo 15-fach', 'Spielzeit, Tempo 60-fach') and ('Tempo %d-fach' % sp) in title, '%s / %s' % (title, sp))
            tut = await pg.evaluate("(()=>{ return document.body.innerHTML.indexOf('tagsüber') })()")

            # ================= Abwesenheit: Spielstunden nach Tempo-Plan =================
            r1 = await pg.evaluate("(()=>{ const r=__lm.absence(1800); return {gameH:r.gameH, capped:r.capped, cover:LMO.world.cover(1800)/3600} })()")
            ok('C4 Abwesenheit 30 Minuten: Spielstunden = Weltzeit dieser 30 Minuten (nicht mehr starr 15)', abs(r1['gameH'] - r1['cover']) < 0.02 and not r1['capped'], str(r1))
            r2 = await pg.evaluate("(()=>{ const r=__lm.absence(5400); return {gameH:r.gameH, capped:r.capped, cover:LMO.world.cover(3600)/3600} })()")
            ok('C5 Abwesenheit 90 Minuten: angerechnet wird höchstens 1 Stunde (Spielstunden der letzten Stunde)', abs(r2['gameH'] - r2['cover']) < 0.02 and r2['capped'], str(r2))
            if await vis(pg, '#dlg'): await pg.keyboard.press('Escape')

            # ================= Lücke im Takt (Tab im Hintergrund): echte Sekunden aus der Spielzeit =================
            await pg.evaluate("window.__gn = LMO.world.gameNow; window.__gA = window.__gn(); LMO.world.gameNow = () => window.__gn() + 3600")
            await pg.wait_for_timeout(500)
            await pg.evaluate("LMO.world.gameNow = window.__gn")
            exp = await pg.evaluate("Math.round(LMO.world.realSpan(window.__gA, window.__gA + 3600) / 60)")
            dl = await pg.evaluate("document.getElementById('dlg') && !document.getElementById('dlg').hidden ? document.getElementById('dlg').innerText : ''")
            ok('C6 Lücke von 3600 Spielsekunden: Abwesenheit in echten Minuten laut Plan (1 oder 4)', exp in (1, 4) and ('Du warst %d Minuten weg' % exp) in dl, '%s | %s' % (exp, dl[:120].replace('\n', ' | ')))
            if await vis(pg, '#dlg'): await pg.keyboard.press('Escape')

            # ================= Neuladen nach 30 Minuten =================
            ok('Z0 Keine Skriptfehler bis hier', not errs, str(errs[:3]))
            await pg.evaluate("__lm.push(false)"); await pg.wait_for_timeout(600)
            await pg.goto('about:blank'); await pg.wait_for_timeout(800)
            ctl('skew', {'ms': 1800000}); await pg.goto(URL)
            up = await wait_app(pg, 40000)
            dl = ''
            if up and await wait_vis(pg, '#dlg', 8000): dl = await pg.inner_text('#dlg')
            m = re.search(r'sind in dieser Zeit ([\d,]+) Stunden vergangen', dl)
            gh = float(m.group(1).replace(',', '.')) if m else -1
            cov = await pg.evaluate("LMO.world.cover(1800)/3600") if up else -1
            ok('C7 Neuladen nach 30 Minuten: Willkommen nennt die Spielstunden nach Tempo-Plan', up and 'Willkommen' in await pg.inner_text('#dlgT') and gh > 0 and abs(gh - cov) <= max(0.3, 0.04 * cov) , '%s h, Plan %.1f h' % (gh, cov))
            ok('Z1 Keine Skriptfehler', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
