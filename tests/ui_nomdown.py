"""Nominatim ist von der Seite aus gar nicht zu erreichen (so war es beim Stadt-Test des Nutzers): Suche, Stadtbestimmung und Grenze kommen vom Overpass-Server.
Start: python3 tests/ui_nomdown.py   (Ports 8391 / 9291)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os, math
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
sys.path.insert(0, HERE)
from fakeworld import World, CITIES, START, nlat, nlon
MOCK = 'http://127.0.0.1:9291'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8391/index.html?debug&nobase'
CODE = re.search(r"'(LM-[A-Z0-9-]+)'", open(HERE + '../firebase-rules.json').read()).group(1)
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE,PATCH,OPTIONS'}
FB = re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*')
OUT = HERE + 'out/'; os.makedirs(OUT, exist_ok=True)


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


async def vis(pg, sel): return await pg.evaluate("s=>{const e=document.querySelector(s);return !!e&&!e.hidden&&(e.offsetParent!==null||getComputedStyle(e).position==='fixed')}", sel)


async def wait_for(pg, expr, ms=20000, step=200):
    for _ in range(ms // step):
        try:
            if await pg.evaluate(expr): return True
        except Exception: pass
        await pg.wait_for_timeout(step)
    return False


async def wait_app(pg, ms=90000): return await wait_for(pg, "!document.getElementById('app').hidden && !!window.__lm && window.__marker !== 1", ms, 250)
txt = lambda pg, sel: pg.evaluate("s=>document.querySelector(s)?document.querySelector(s).textContent:null", sel)
DLG = "document.getElementById('dlg').hidden ? '' : document.getElementById('dlg').textContent"


def dist(la1, lo1, la2, lo2): return math.hypot((la2 - la1) * 110574, (lo2 - lo1) * 111320 * math.cos(math.radians((la1 + la2) / 2)))


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9291'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8391', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R = []

    def ok(name, cond, info=''):
        R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await b.new_context(viewport={'width': 1100, 'height': 900})
            await ctx.route(FB, fbhandler)
            W = World(); W.nom_down = True; await W.install(ctx)
            pg = await ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)) if 'Access is denied' not in str(e) else None)
            await pg.add_init_script("localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
            await pg.goto(URL); await pg.wait_for_timeout(1000)
            await pg.evaluate("a=>LMO.register({name:a.name,email:a.email,password:'geheim123',code:a.code})", {'name': 'Tim Stadt', 'email': 'nomdown@example.de', 'code': CODE})
            await wait_for(pg, "document.getElementById('pickMain') && !document.getElementById('pickMain').hidden", 8000)

            # ---- Suche
            await pg.fill('#q', 'teststadt'); await pg.press('#q', 'Enter')
            found = await wait_for(pg, "document.querySelectorAll('#results li').length>0", 15000)
            lis = await pg.evaluate("[...document.querySelectorAll('#results li')].map(l=>l.textContent)")
            ok('N1 Suche ohne Nominatim: Treffer vom Overpass-Server (Name klein getippt, Teststadt gefunden)', found and len(lis) == 1 and 'Teststadt' in lis[0] and 'Einwohner' in lis[0], str(lis))
            ok('N2 genau eine Overpass-Namensabfrage, Nominatim nie erreicht (nichts gezählt)', W.calls['namesearch'] == 1 and W.calls['search'] == 0, str(W.calls))
            msg = await txt(pg, '#pickMsg') if await pg.evaluate("!!document.getElementById('pickMsg')") else ''
            ok('N3 keine Fehlermeldung zur Suche', 'nicht erreichbar' not in (msg or '') and 'nicht erreichbar' not in await pg.evaluate("document.body.innerText"))
            await pg.click('#results li button >> nth=0'); await pg.click('#confirmGo')
            started = await wait_app(pg)
            ok('N4 Spiel startet auf der Karte', started and W.calls['roads'] >= 1, str(W.calls))

            # ---- Stadt des ersten Centers: reverse gescheitert -> is_in -> Grenze über Overpass
            await pg.evaluate("__lm.setCash(300000)")
            await pg.evaluate("()=>{const E=__lm.E; __lm.cen.build(E.HUB.x, E.HUB.y); return 1}")
            await wait_for(pg, "document.getElementById('dlgB').textContent.includes('Teststadt:')", 40000)
            t = await pg.evaluate(DLG)
            ok('N5 Stadt bestimmt: Name, Fläche, Einwohner (Grenze über Overpass, nicht der Ersatzkreis)', 'Teststadt:' in t and re.search(r'1[78],\d km²', t) and '120 000 Einwohner' in t and 'keine genaue Stadtgrenze' not in t, t[:300])
            ok('N6 Grenze über is_in und Overpass-Geometrie', W.calls['isin'] == 1 and W.calls['relgeom'] == 1 and W.calls['lookup'] == 0 and W.calls['reverse'] == 0, str(W.calls))
            await pg.evaluate("window.__marker = 1")
            await pg.click('#dlgB .btn.primary')
            started = await wait_app(pg, 150000)
            ok('N7 Stadt geladen, Spiel startet neu', started)
            info = await pg.evaluate("[__lm.cen.centers().length, __lm.cen.centers()[0].cities.map(c=>c.name+':'+c.rel).join(), __lm.cen.cities().length, __lm.cen.cities()[0].approx].join()")
            ok('N8 Center 1 bedient Teststadt (echte Grenze, kein Kreis)', info == '1,Teststadt:111,1,false', info)
            ok('N9 keine Fehler im Browser', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
