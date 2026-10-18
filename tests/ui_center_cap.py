"""Fulfillment Center, Obergrenze offener Bestellungen und Größe des Cloud-Spielstands.
Start: python3 tests/ui_center_cap.py   (Ports 8393 / 9293)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9293'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8393/index.html?debug&nobase'
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
    await pg.add_init_script("localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
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
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9293'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8393', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            pg, errs, started = await start_game(ctx, 'Tim Cap', 'cap@example.de')
            ok('C0 Spiel startet', started)
            await pg.evaluate("__lm.cen.auto(false); __lm.drivers().forEach(d => { d.rest = 'on'; }); __lm.setCash(5000000)")
            # acht große Center (je 20 Transporter, 22 Fahrer, 30 Stopps) im Ring um den Mittelpunkt
            offs = [(0, 0), (450, 0), (-450, 0), (0, 450), (0, -450), (450, 450), (-450, -450), (450, -450)]
            for k, (ox, oy) in enumerate(offs):
                n = await pg.evaluate("o=>{const E=__lm.E; __lm.cen.build(E.HUB.x+o[0], E.HUB.y+o[1]); return __lm.cen.centers().length}", [ox, oy])
                ok('C1.%d Center %d gebaut' % (k, k + 1), n == k + 1)
                await pg.evaluate("ci=>{for(let i=0;i<8;i++) __lm.cen.upg('slots', ci); for(let i=0;i<10;i++) __lm.cen.upg('stops', ci); for(let i=0;i<20;i++) __lm.cen.buyVan(ci); for(let i=0;i<22;i++) __lm.cen.hire(ci)}", k)
            ok('C2 acht Center mit je 20 Transportern und 22 Fahrern', await pg.evaluate("__lm.cen.centers().map(c=>[c.vans.length,c.drv.length])") == [[20, 22]] * 8)
            cap = await pg.evaluate("[0,1,2,3,4,5,6,7].map(ci=>__lm.cen.cap(ci))")
            ok('C3 Obergrenze je Center: 700 / 8 = 87 (kleiner als 40 je Transporter)', cap == [87] * 8, str(cap))
            # Montag 6:00: Bestellungen entstehen von allein; ohne Planung füllt sich der Vorrat bis zur Obergrenze
            await pg.evaluate("__lm.cen.cities().forEach(c => { c.dem = 4000; }); __lm.world.setHour(6, 3); __lm.cen.refit(); __lm.cen.auto(true)")
            CNT = "[0,1,2,3,4,5,6,7].map(ci=>__lm.cen.orders().filter(o=>o.c===ci&&(o.state==='open'||o.state==='tour')).length)"
            for _ in range(6):
                await pg.evaluate("__lm.adv(4*3600, 30)")
            cnt = await pg.evaluate(CNT); tot = sum(cnt)
            ok('C4 kein Center über 87 offenen Bestellungen, insgesamt höchstens 700', all(0 < n <= 87 for n in cnt) and tot <= 700, '%s %d' % (cnt, tot))
            ok('C5 die Obergrenze wird erreicht (Vorrat gedeckelt)', sum(1 for n in cnt if n == 87) >= 4, str(cnt))
            full = await pg.evaluate("[0,1,2,3,4,5,6,7].map(ci=>__lm.cen.full(ci))")
            await pg.evaluate("__lm.adv(1800, 30)")
            cnt2 = await pg.evaluate(CNT)
            ok('C6 weiterer Zulauf bleibt unter der Obergrenze', any(full) and all(n <= 87 for n in cnt2), '%s %s' % (full, cnt2))
            # Spielstand im Worst Case
            L = await pg.evaluate("JSON.stringify(__lm.save.snapshot()).length")
            ok('C7 Spielstand (8 große Center, Vorrat voll) unter 300.000 Zeichen', L < 300000, str(L))
            # Größe einer Ein-Stopp-Tour im Spielstand: damit lässt sich der schlimmste Fall (jede Bestellung in eigener Tour) abschätzen
            r = await pg.evaluate("""()=>{const c=__lm.cen.centers()[0], d0=Math.floor(__lm.cen.absT()/86400); const o=__lm.cen.orders().find(o=>o.c===0&&o.state==='open'&&o.day>d0);
              const L0=JSON.stringify(__lm.save.snapshot()).length; const pl=__lm.cen.tour.plan(0,{k:4,day:o.day,van:c.vans[0].id,drv:c.drv[0].id,stops:[o.id]}); const L1=JSON.stringify(__lm.save.snapshot()).length;
              return {ok:pl.ok, err:pl.err, d:L1-L0, o:JSON.stringify(__lm.save.snapshot().corders[0]).length}}""")
            ok('C7b Ein-Stopp-Tour belegt unter 450 Zeichen', r['ok'] and 0 < r['d'] < 450, str(r))
            worst = 700 * (r['o'] + r['d']) + 20000
            ok('C7c schlimmster Fall (700 Bestellungen je in eigener Tour) unter 400.000 Zeichen', worst < 400000, str(worst))
            # Verfällt eine Bestellung, ist wieder Platz
            ci = full.index(True) if True in full else 0
            r = await pg.evaluate("ci=>{const was=__lm.cen.full(ci); const o=__lm.cen.orders().find(o=>o.c===ci&&o.state==='open'); o.we=-1e9; __lm.cen.expire(); return [was, __lm.cen.full(ci)]}", ci)
            ok('C8 nach Verfall einer Bestellung ist das volle Center wieder offen', r == [True, False], str(r))
            ok('C9 keine Fehler im Browser', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    bad = [n for n, c in R if not c]
    print('\n%d/%d bestanden' % (len(R) - len(bad), len(R)), flush=True)
    sys.exit(1 if bad else 0)

asyncio.run(main())
