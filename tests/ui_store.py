"""Gemeinsamer Kartenspeicher im Browser: Spieler 1 lädt Startkarte und Stadt live (künstliche Kartenserver) und legt sie im Speicher ab;
Spieler 2 (frisches Gerät, anderes Konto) startet und baut ein Center ohne eine einzige Kartenabfrage; ein kaputter Eintrag wird ignoriert;
ohne eingetragene Regeln läuft alles wie bisher. Die Karten-Server (Overpass, Nominatim) sind durch tests/fakeworld.py ersetzt.
Start: python3 tests/ui_store.py   (Ports 8383 / 9283)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os, math
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
sys.path.insert(0, HERE)
from fakeworld import World, CITIES, START, nlat, nlon
MOCK = 'http://127.0.0.1:9283'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8383/index.html?debug&nobase'
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


async def new_player(b, W, name, email):
    ctx = await b.new_context(viewport={'width': 1100, 'height': 900})
    await ctx.route(FB, fbhandler)
    await W.install(ctx)
    pg = await ctx.new_page(); errs = []; pg.warns = []
    pg.on('pageerror', lambda e: errs.append(str(e)) if 'Access is denied' not in str(e) else None)
    pg.on('console', lambda m: pg.warns.append(m.text) if m.type == 'warning' else None)
    await pg.add_init_script("window.__LM_PLAN='legacy';localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
    await pg.goto(URL); await pg.wait_for_timeout(800)
    await pg.evaluate("a=>LMO.register({name:a.name,email:a.email,password:'geheim123',code:a.code})", {'name': name, 'email': email, 'code': CODE})
    await wait_for(pg, "document.getElementById('pickMain') && !document.getElementById('pickMain').hidden", 8000)
    return ctx, pg, errs


async def pick_start(pg):
    await pg.fill('#q', 'Teststadt'); await pg.press('#q', 'Enter')
    await wait_for(pg, "document.querySelectorAll('#results li').length>0", 8000)
    await pg.click('#results li button >> nth=0'); await pg.click('#confirmGo')


async def build_center(pg):
    await pg.evaluate("__lm.setCash(300000)")
    await pg.evaluate("()=>{const E=__lm.E; __lm.cen.build(E.HUB.x, E.HUB.y)}")
    await wait_for(pg, "document.getElementById('dlgB').textContent.includes('Teststadt:')", 20000)
    await pg.evaluate("window.__marker = 1")
    await pg.click('#dlgB .btn.primary')
    return await wait_app(pg, 150000)


def store_keys():
    st = json.loads(mockreq('POST', '/ctl/state')[1])
    cs = (st['DB'] or {}).get('citystore') or {}
    return sorted(k + '/' + n for k, v in cs.items() for n in v), st


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9283'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8383', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R = []

    def ok(name, cond, info=''):
        R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            W = World()
            # ================= A: Spieler 1 lädt live und legt ab =================
            ctx1, pg1, errs1 = await new_player(b, W, 'Eins Eins', 'eins@example.de')
            await pick_start(pg1)
            started = await wait_app(pg1)
            ok('A1 Spieler 1: Start auf der Karte, live von den Kartenservern', started and W.calls['roads'] >= 1 and W.calls['places'] >= 1, str(W.calls))
            n_start1 = await pg1.evaluate("__lm.E.N")
            for _ in range(60):
                keys, _st = store_keys()
                if any(k.startswith('s/') for k in keys): break
                await pg1.wait_for_timeout(250)
            ok('A2 Startkarte liegt im gemeinsamen Speicher (Art s, Koordinatenschlüssel)', any(re.match(r's/-?\d+_\d{3}_-?\d+_\d{3}$', k) for k in keys), str(keys))
            sraw = json.loads(mockreq('POST', '/ctl/state')[1])['DB']['citystore']['s']
            srec = list(sraw.values())[0]
            ok('A3 Eintrag: Format 1, Serverzeit, Name, nur die vier Felder', srec['v'] == 1 and isinstance(srec['t'], (int, float)) and srec['t'] > 1e12 and srec['n'] and sorted(srec) == ['d', 'n', 't', 'v'], str({k: (v if k != 'd' else len(v)) for k, v in srec.items()}))
            ok('A4 Paket ist klein (komprimiert, Text)', isinstance(srec['d'], str) and 1000 < len(srec['d']) < 400000, len(srec['d']))
            built = await build_center(pg1)
            ok('A5 Spieler 1: Center in Teststadt gebaut (Neustart)', built and await pg1.evaluate("__lm.cen.centers().length") == 1)
            calls_a = dict(W.calls)
            for _ in range(80):
                keys, _st = store_keys()
                if all(any(k == x for k in keys) for x in ('p/r111', 'f/r111', 'c/r111')): break
                await pg1.wait_for_timeout(250)
            ok('A6 Stadtgrenze, Straßenpaket und Firmen von Teststadt im Speicher', all(k in keys for k in ('c/r111', 'p/r111', 'f/r111')), str(keys))
            ok('A7 Ortsschlüssel der Stadtgrenze ebenfalls (für Städte ohne bekannte Beziehungsnummer)', any(k.startswith('c/pt_') for k in keys), str(keys))
            N1 = await pg1.evaluate("__lm.E.N"); roads1 = W.calls['roads']
            ok('A8 Spieler 1 hat live geladen (Straßen in mehreren Kacheln)', roads1 >= 5, str(W.calls))
            fl = await pg1.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('lm.cs.')).length")
            ok('A9 Das Gerät merkt sich, was schon im Speicher liegt', fl >= 3, fl)
            ok('A10 keine Fehler im Browser (Spieler 1)', not errs1, str(errs1[:3]))

            # ================= B: Spieler 2, frisches Gerät =================
            ctx2, pg2, errs2 = await new_player(b, W, 'Zwei Zwei', 'zwei@example.de')
            before = dict(W.calls); t0 = time.time()
            await pick_start(pg2)
            started = await wait_app(pg2)
            dt = time.time() - t0
            d = {k: W.calls[k] - before[k] for k in W.calls}
            ok('B1 Spieler 2: Start ohne Straßen- und Ortsabfrage (Karte kommt aus dem Speicher)', started and d['roads'] == 0 and d['places'] == 0, str(d))
            ok('B2 Spieler 2: Start geht schnell (%.1f s)' % dt, started and dt < 25, dt)
            n_start2 = await pg2.evaluate("__lm.E.N")
            ok('B3 Startkarte gleich: gleiche Knotenzahl wie bei Spieler 1', n_start2 == n_start1 and n_start2 > 2000, '%s %s' % (n_start1, n_start2))
            stt = await pg2.evaluate("LMStore.stats()")
            ok('B4 Zähler: ein Treffer, nichts hochgeladen', stt['hit'] == 1 and stt['up'] == 0, str(stt))
            before = dict(W.calls); t0 = time.time()
            built = await build_center(pg2)
            dt = time.time() - t0
            d = {k: W.calls[k] - before[k] for k in W.calls}
            ok('B5 Spieler 2: Center in Teststadt gebaut', built and await pg2.evaluate("[__lm.cen.centers().length, __lm.cen.centers()[0].cities.map(c=>c.name+':'+c.rel).join()].join()") == '1,Teststadt:111')
            ok('B6 Stadt komplett aus dem Speicher: keine Kachel-, Firmen-, Grenz- oder Is-in-Abfrage', d['roads'] == 0 and d['firms'] == 0 and d['reverse'] == 0 and d['isin'] == 0 and d['lookup'] == 0, str(d))
            ok('B7 Das dauert nur wenige Sekunden (%.1f s)' % dt, dt < 40, dt)
            N2 = await pg2.evaluate("__lm.E.N")
            ok('B8 Dieselbe Karte wie bei Spieler 1 (Knotenzahl)', N2 == N1, '%s %s' % (N1, N2))
            ct = await pg2.evaluate("(()=>{const c=__lm.cen.cities()[0]; return {name:c.name,dem:c.dem,approx:c.approx,area:c.area}})()")
            ok('B9 Stadt im Spiel: Nachfrage 40, Grenze, nicht genähert', ct['dem'] == 40 and not ct['approx'] and 17 < ct['area'] < 20, str(ct))
            res = await pg2.evaluate("""()=>{const out=[]; for(let i=0;i<60;i++){const o=__lm.cen.spawn(0); if(o) out.push({firm:o.firm,d:o.d||0});} return out}""")
            ok('B10 Kunden entstehen (auch Firmenkunden aus dem Speicher)', len(res) == 60 and sum(1 for o in res if o['firm']) > 5, '%d' % sum(1 for o in res if o['firm']))
            ok('B11 Spieler 2 hat nichts neu abgelegt', (await pg2.evaluate("LMStore.stats()"))['up'] == 0)
            ok('B12 keine Fehler im Browser (Spieler 2)', not errs2, str(errs2[:3]))

            # ================= C: kaputter und fremder Eintrag =================
            keys, st = store_keys()
            good = st['DB']['citystore']['p']['r111']
            ctl('put', {'path': 'citystore/p/r111', 'value': {'v': 2, 't': good['t'], 'd': good['d'][:200] + 'AAAAAAAA' + good['d'][208:], 'n': 'Teststadt'}})
            ctx3, pg3, errs3 = await new_player(b, W, 'Drei Drei', 'drei@example.de')
            await pick_start(pg3); started = await wait_app(pg3)
            before = dict(W.calls)
            built = await build_center(pg3)
            d = {k: W.calls[k] - before[k] for k in W.calls}
            ok('C1 Kaputtes Straßenpaket im Speicher: wird erkannt, Spieler 3 lädt live und das Spiel läuft', built and d['roads'] >= 4 and any('p/r111' in w and 'unbrauchbar' in w for w in pg3.warns), str(d) + str(pg3.warns[:3]))
            ok('C2 Spieler 3: gleiche Karte trotzdem', await pg3.evaluate("__lm.E.N") == N1)
            keys, st = store_keys()
            ok('C3 Der kaputte Eintrag bleibt unverändert (einmal beschreibbar), die übrigen Pakete sind unberührt', st['DB']['citystore']['p']['r111']['d'][200:208] == 'AAAAAAAA' and 'f/r111' in keys)
            ok('C4 keine Fehler im Browser (Spieler 3)', not errs3, str(errs3[:3]))
            # Betreiber löscht den kaputten Eintrag: der nächste Spieler legt ein neues ab
            ctl('put', {'path': 'citystore/p/r111', 'value': None})

            # ================= D: Regeln noch nicht eingetragen =================
            rules = json.load(open(HERE + '../firebase-rules.json', encoding='utf-8')); del rules['rules']['citystore']
            ctl('rules', rules); ctl('put', {'path': 'citystore', 'value': None})
            ctx4, pg4, errs4 = await new_player(b, W, 'Vier Vier', 'vier@example.de')
            before = dict(W.calls)
            await pick_start(pg4); started = await wait_app(pg4)
            d = {k: W.calls[k] - before[k] for k in W.calls}
            stt = await pg4.evaluate("LMStore.stats()")
            ok('D1 Ohne Regeln für den Speicher: Spiel startet live wie bisher, Speicher schaltet sich ab', started and d['roads'] >= 1 and stt['off'] is True, str(d) + str(stt))
            built = await build_center(pg4)
            ok('D2 Auch das Center lässt sich bauen', built and await pg4.evaluate("__lm.cen.centers().length") == 1)
            keys, st = store_keys()
            ok('D3 Nichts wurde abgelegt, keine Fehler im Browser', keys == [] and not errs4, str(keys) + str(errs4[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
