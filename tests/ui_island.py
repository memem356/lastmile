"""Fulfillment Center in einer fernen Stadt (eigene Insel, ohne Straßenverbindung zur Startregion): Klick auf die Karte weit außerhalb -> Stadt bestimmen
und laden -> Neustart, Kunden und Touren nur auf der Insel, Spielstand, Ansicht, Grenze der Entfernung, zweites Center in der Startstadt, weitere Stadt für das ferne Center.
Die Karten-Server (Overpass, Nominatim) sind durch tests/fakeworld.py ersetzt.
Start: python3 tests/ui_island.py   (Ports 8390 / 9290)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os, math
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
sys.path.insert(0, HERE)
from fakeworld import World, CITIES, START, nlat, nlon
MOCK = 'http://127.0.0.1:9290'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8390/index.html?debug&nobase'
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
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9290'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8390', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            W = World(); await W.install(ctx)
            pg = await ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)) if 'Access is denied' not in str(e) else None)
            pg.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' and 'fonts' not in m.text and 'ERR_' not in m.text and 'Failed to load resource' not in m.text and 'Access is denied' not in m.text and 'Das Laden ist nicht' not in m.text and 'Gewählter Ort' not in m.text else None)
            await pg.add_init_script("window.__LM_PLAN='legacy';localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
            await pg.goto(URL); await pg.wait_for_timeout(1000)
            await pg.evaluate("a=>LMO.register({name:a.name,email:a.email,password:'geheim123',code:a.code})", {'name': 'Tim Insel', 'email': 'insel@example.de', 'code': CODE})
            await wait_for(pg, "document.getElementById('pickMain') && !document.getElementById('pickMain').hidden", 8000)
            await pg.fill('#q', 'Teststadt'); await pg.press('#q', 'Enter')
            await wait_for(pg, "document.querySelectorAll('#results li').length>0", 8000)
            await pg.click('#results li button >> nth=0'); await pg.click('#confirmGo')
            started = await wait_app(pg)
            ok('A0 Spiel startet in Teststadt (Kernkarte ca. 3,6 km breit)', started)
            n0 = await pg.evaluate("__lm.E.N")
            await pg.evaluate("__lm.setCash(300000)")
            hubn = await pg.evaluate("(()=>{const E=__lm.E; return E.hubNode('van', E.HUB.x, E.HUB.y)})()")
            qd = await pg.evaluate("(()=>{const q=__lm.E.proj(%f,%f); return [q.x,q.y]})()" % (nlat(175), nlon(170)))        # Mitte von Weitstadt (Beziehung 444)
            dist_hub = math.hypot(qd[0] - await pg.evaluate("__lm.E.HUB.x"), qd[1] - await pg.evaluate("__lm.E.HUB.y"))
            ok('A1 Weitstadt liegt weit außerhalb der Kernkarte (mehr als 5 km vom Hub)', dist_hub > 5000, round(dist_hub))

            # ================= A: erstes Center in einer fernen Stadt (Klick weit außerhalb der Karte, echter Mausklick) =================
            await pg.evaluate("__lm.cen.startPlacing('cen')")
            ok('A2 Hinweis beim Platzieren nennt andere Städte', 'andere' in await txt(pg, '#placeBan') or 'anderen' in await txt(pg, '#placeBan'), await txt(pg, '#placeBan'))
            await pg.evaluate("a=>__lm.view.look(a[0], a[1], __lm.view.zOfS(0.12))", qd); await pg.wait_for_timeout(500)
            pos = await pg.evaluate("a=>{const r=document.getElementById('map').getBoundingClientRect(); return {x:r.left+__lm.view.toX(a[0]), y:r.top+__lm.view.toY(a[1])}}", qd)
            await pg.mouse.move(pos['x'], pos['y']); await pg.wait_for_timeout(200); await pg.mouse.click(pos['x'], pos['y'])
            okd = await wait_for(pg, "!document.getElementById('dlg').hidden && document.getElementById('dlgT').textContent==='Fulfillment Center in einer anderen Stadt'", 6000)
            ok('A3 Klick auf eine ferne Stadt öffnet den Dialog "in einer anderen Stadt"', okd, await txt(pg, '#dlgT'))
            await wait_for(pg, "document.getElementById('dlgB').textContent.includes('Weitstadt:')", 20000)
            t = await pg.evaluate(DLG)
            ok('A4 Stadt unter dem Klick bestimmt: Weitstadt, 30 000 Einwohner; Hinweis "keine Straßenverbindung"', 'Weitstadt:' in t and '30 000 Einwohner' in t and 'keine Straßenverbindung' in t, t[:380])
            go = await pg.evaluate("[document.querySelector('#dlgB .btn.primary').textContent, document.querySelector('#dlgB .btn.primary').disabled]")
            ok('A5 Knopf "Stadt laden und bauen (5.000,00 €)" frei, noch nichts abgebucht, kein Center', go[0].startswith('Stadt laden und bauen') and '5.000,00' in go[0] and not go[1] and await pg.evaluate("[__lm.cash(), __lm.cen.centers().length].join()") == '300000,0', str(go))
            ok('A6 Bestimmung mit einer Nominatim-Abfrage (reverse)', W.calls['reverse'] == 1, str(W.calls))
            await pg.evaluate("window.__marker = 1")
            await pg.click('#dlgB .btn.primary')
            started = await wait_app(pg, 150000)
            ok('A7 Laden und Neustart', started)
            if not started: print(await pg.evaluate("document.body.innerText.slice(0,500)"))
            print('   Abfragen', W.calls, W.hw)
            cs = await pg.evaluate("(()=>{const c=__lm.cen.centers()[0]; return c&&{n:__lm.cen.centers().length, cities:c.cities.map(r=>r.name+':'+r.rel+':'+(r.isl||'')).join(), x:c.x, y:c.y, node:c.node}})()")
            cash = await pg.evaluate("__lm.cash()")
            ok('A8 Center 1 in Weitstadt als Insel (isl gesetzt), 5.000 € abgebucht', cs and cs['n'] == 1 and cs['cities'] == 'Weitstadt:444:r444' and abs(cash - 295000) < 100, '%s %s' % (cs, cash))
            ok('A9 Center liegt an der geklickten Stelle (unter 80 m) und an einer befahrbaren Straße', cs and math.hypot(cs['x'] - qd[0], cs['y'] - qd[1]) < 80 and await pg.evaluate("a=>__lm.E.nets.car.ok[a]", cs['node']) == 1, str(cs) + str(qd))
            n1 = await pg.evaluate("__lm.E.N")
            ok('A10 Karte um Weitstadt größer (mehr als 3.000 Knoten dazu)', n1 > n0 + 3000, '%s -> %s' % (n0, n1))
            ok('A11 Nur zwei Abfragen-Gruppen für die Stadt: Straßen in Kacheln und Firmen, keine Verbindungsstraßen', 'main' not in W.hw and W.calls['roads'] >= 3 and W.calls['firms'] >= 1, str(W.calls) + str(W.hw))
            ok('A12 Hub bleibt in Teststadt; Liefergebiet unverändert (höchstens Kernradius)', await pg.evaluate("__lm.fx.zr(__lm.hubs()[0])") <= 1800)

            # Kunden: nur in Weitstadt, alle von dort aus erreichbar
            res = await pg.evaluate("""()=>{const E=__lm.E, c=__lm.cen.centers()[0], out=[]; for(let i=0;i<150;i++){const o=__lm.cen.spawn(0); if(o){const g=E.unproj(o.x,o.y); const l=E.returnLeg('van', c.node, o.node, 1); out.push({firm:o.firm, la:g.lat, lo:g.lon, node:o.node, id:o.id, day:o.day, nd:Math.hypot(E.nx[o.node]-o.x,E.ny[o.node]-o.y), leg:l?l.len:-1})}} return out}""")
            inside = lambda o, c: nlat(CITIES[c][1]) - 0.0009 <= o['la'] <= nlat(CITIES[c][2]) + 0.0009 and nlon(CITIES[c][3]) - 0.0013 <= o['lo'] <= nlon(CITIES[c][4]) + 0.0013
            ok('B1 150 Bestellungen, alle Kunden in Weitstadt, jeder an eine Straße angebunden (< 150 m)', len(res) == 150 and all(inside(o, 444) for o in res) and all(o['nd'] < 150 for o in res), str([o for o in res if not inside(o, 444)][:2]))
            ok('B2 Von der Fahrt des Centers aus ist jeder Kunde erreichbar (Weg gefunden)', all(o['leg'] >= 0 for o in res), str([o for o in res if o['leg'] < 0][:2]))
            ok('B3 Firmen- und Privatkunden', sum(1 for o in res if o['firm']) > 20 and sum(1 for o in res if not o['firm']) > 60)
            legs = await pg.evaluate("""()=>{const E=__lm.E, c=__lm.cen.centers()[0], a=E.hubNode('van', E.HUB.x, E.HUB.y); return [E.returnLeg('van', a, c.node, 1), E.returnLeg('van', c.node, a, 1)].map(x=>x===null?null:1)}""")
            ok('B4 Zwischen Startregion und Insel gibt es keine Fahrt (kein Weg, kein Absturz)', legs == [None, None], str(legs))
            # Tour auf der Insel
            await pg.evaluate("__lm.cen.auto(false)")
            vid = await pg.evaluate("(()=>{__lm.cen.buyVan(0); __lm.cen.hire(0); const c=__lm.cen.centers()[0]; return [c.vans[0].id, c.drv[0].id]})()")
            res = await pg.evaluate("""()=>{const out=[]; for(let i=0;i<60;i++){const o=__lm.cen.spawn(0); if(o) out.push({id:o.id, day:o.day})} return out}""")
            planned = None
            for a in res[:30]:
                for bb in res[:30]:
                    if a['id'] == bb['id'] or a['day'] != bb['day']: continue
                    for k in range(5):
                        r = await pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,{k:a.k,day:a.day,van:a.van,drv:a.drv,stops:a.stops}); return r&&{ok:r.ok, err:r.err||null}}", {'k': k, 'day': a['day'], 'van': vid[0], 'drv': vid[1], 'stops': [a['id'], bb['id']]})
                        if r and r['ok']: planned = (k, a['id'], bb['id']); break
                    if planned: break
                if planned: break
            ok('B5 Tour mit zwei Stopps in Weitstadt lässt sich planen', planned is not None, str(planned))
            ok('B6 Tour steht im Center', await pg.evaluate("__lm.cen.tour.list(0).length") >= 1)
            # Ansicht
            await pg.evaluate("__lm.cen.setView('hq')"); await pg.evaluate("__lm.view.fit()"); await pg.wait_for_timeout(500)
            await pg.click('#viewSeg button[data-v="cen"]'); await pg.wait_for_timeout(1500)
            mid = await pg.evaluate("(()=>{const s=__lm.view.size(); const c=__lm.cen.centers()[0]; return Math.hypot(__lm.view.unX(s[0]/2)-c.x, __lm.view.unY(s[1]/2)-c.y)})()")
            ok('B7 Wechsel zur Ansicht Fulfillment fliegt zum fernen Center (Bildmitte höchstens 2,5 km vom Center)', mid < 2500, round(mid))
            await pg.evaluate("__lm.view.fit()"); await pg.wait_for_timeout(500)
            fz = await pg.evaluate("__lm.view.fitTarget().z - __lm.view.zOfS(0.05)")
            ok('B8 Anpassen der Ansicht rahmt Weitstadt ein (Zoom mindestens 0,5 Stufen über dem Weitesten)', fz > 0.5, fz)
            await pg.screenshot(path=OUT + 'island_cen.png')
            await pg.click('#viewSeg button[data-v="hq"]'); await pg.wait_for_timeout(1500)
            mid = await pg.evaluate("(()=>{const s=__lm.view.size(); return Math.hypot(__lm.view.unX(s[0]/2)-__lm.E.HUB.x, __lm.view.unY(s[1]/2)-__lm.E.HUB.y)})()")
            ok('B9 Zurück zum Lieferdienst: Bildmitte wieder bei der Startregion (unter 2,5 km vom Hub)', mid < 2500, round(mid))
            # Spielstand
            snap = await pg.evaluate("JSON.stringify(__lm.save.snapshot().centers[0].cities)")
            ok('B10 Spielstand: Center nennt Weitstadt mit isl, klein', '"isl":"r444"' in snap and len(snap) < 600, snap)
            ok('B11 In die Cloud gesichert', await pg.evaluate("__lm.push()") is True)
            await pg.goto('http://127.0.0.1:8390/nichts-da'); await pg.wait_for_timeout(300)
            await pg.goto(URL)
            started = await wait_app(pg, 150000)
            cs2 = await pg.evaluate("(()=>{const c=__lm.cen.centers()[0]; return c&&{cities:c.cities.map(r=>r.name+':'+(r.isl||'')).join(), x:c.x, y:c.y, node:c.node, tours:c.tours.length}})()")
            ok('B12 Nach Neustart: Center noch in Weitstadt, gleiche Stelle, Tour erhalten, Straße befahrbar', started and cs2 and cs2['cities'] == 'Weitstadt:r444' and math.hypot(cs2['x'] - cs['x'], cs2['y'] - cs['y']) < 60 and cs2['tours'] >= 1 and await pg.evaluate("a=>__lm.E.nets.car.ok[a]", cs2['node']) == 1, str(cs2))
            ok('B13 Neue Bestellungen entstehen auf der Insel', await pg.evaluate("(()=>{let n=0; for(let i=0;i<30;i++) if(__lm.cen.spawn(0)) n++; return n})()") == 30)

            # ================= C: Grenzen =================
            cash0 = await pg.evaluate("__lm.cash()")
            await pg.evaluate("__lm.cen.startPlacing('cen')")
            await pg.evaluate("__lm.cen.build(700000, 0)"); await pg.wait_for_timeout(200)
            ok('C1 Mehr als 600 km vom Startort: Hinweis "Zu weit weg", kein Dialog, nichts abgebucht', 'Zu weit weg' in await txt(pg, '#placeBan') and not await vis(pg, '#dlg') and await pg.evaluate("__lm.cash()") == cash0 and await pg.evaluate("__lm.cen.centers().length") == 1, await txt(pg, '#placeBan'))
            # Klick auf eine Stadt, die schon zu einem Center gehört, aber abseits der Straßen: Hinweis (kein Dialog)
            await pg.evaluate("(()=>{__lm.cen.startPlacing('cen'); __lm.cen.build(%f, %f)})()" % (qd[0], qd[1]))
            await pg.wait_for_timeout(300)
            ok('C2 Klick auf die Stelle von Center 1 (Stadt gehört schon zu Center 1, Straße vorhanden): normale Regeln, Mindestabstand 250 m',
               'Zu nah' in await txt(pg, '#placeBan') and await pg.evaluate("__lm.cen.centers().length") == 1 and not await vis(pg, '#dlg'), await txt(pg, '#placeBan'))
            await pg.evaluate("__lm.setCash(300000)")
            # Ort ohne Straßen (außerhalb des Gitters): Dialog, aber kein Bau
            qn = await pg.evaluate("(()=>{const q=__lm.E.proj(%f,%f); return [q.x,q.y]})()" % (nlat(340), nlon(150)))
            await pg.evaluate("a=>{__lm.cen.startPlacing('cen'); __lm.cen.build(a[0], a[1])}", qn)
            await wait_for(pg, "!document.getElementById('dlg').hidden", 4000)
            await wait_for(pg, "document.querySelector('#dlgB .btn.primary') && !document.querySelector('#dlgB .btn.primary').disabled", 20000)
            t0 = await pg.evaluate(DLG)
            go = await pg.evaluate("!!document.querySelector('#dlgB .btn.primary') && !document.querySelector('#dlgB .btn.primary').disabled")
            if go:
                await pg.click('#dlgB .btn.primary')
                await wait_for(pg, "document.getElementById('dlgB').textContent.includes('keine Straße') || document.getElementById('dlgB').textContent.includes('nicht gelungen') || document.getElementById('dlgB').textContent.includes('nichts abgebucht')", 90000, 400)
            t = await pg.evaluate(DLG)
            ok('C3 Ort ohne Straßen: Meldung, nichts abgebucht, kein neues Center, kein Neustart', ('Straße' in t or 'nicht gelungen' in t) and abs(await pg.evaluate("__lm.cash()") - 300000) < 5 and await pg.evaluate("__lm.cen.centers().length") == 1 and await pg.evaluate("!!window.__lm"), t[-420:])
            await pg.evaluate("document.getElementById('dlgX').click()")

            # ================= D: zweites Center in der Startstadt (Kernkarte) =================
            await pg.evaluate("window.__marker = 1")
            await pg.evaluate("a=>{__lm.cen.startPlacing('cen'); __lm.cen.build(a[0], a[1])}", [await pg.evaluate("__lm.E.HUB.x"), await pg.evaluate("__lm.E.HUB.y")])
            await wait_for(pg, "document.getElementById('dlgB').textContent.includes('Teststadt:')", 20000)
            ok('D1 Klick in der Startstadt (noch zu keinem Center gehörig): Dialog zur Stadt', 'Teststadt:' in await pg.evaluate(DLG) and await pg.evaluate("__lm.cen.centers().length") == 1, (await pg.evaluate(DLG))[:200])
            await pg.click('#dlgB .btn.primary')
            started = await wait_app(pg, 150000)
            cs3 = await pg.evaluate("(()=>({n:__lm.cen.centers().length, a:__lm.cen.centers().map(c=>c.cities.map(r=>r.name).join()).join('|'), hub:[__lm.cen.centers()[1]&&__lm.cen.centers()[1].node]}))()")
            cash = await pg.evaluate("__lm.cash()")
            ok('D2 Neustart: Center 2 in Teststadt, Center 1 weiter in Weitstadt, 5.000 € abgebucht', started and cs3['n'] == 2 and cs3['a'] == 'Weitstadt|Teststadt' and abs(cash - 295000) < 150, '%s %s' % (cs3, cash))
            r2 = await pg.evaluate("""()=>{const E=__lm.E, c0=__lm.cen.centers()[0], c1=__lm.cen.centers()[1], out=[]; for(let i=0;i<80;i++){const o=__lm.cen.spawn(1); if(o){const l=E.returnLeg('van', c1.node, o.node, 1), g=E.unproj(o.x,o.y); out.push({la:g.lat, lo:g.lon, leg:l?l.len:-1})}} const hub=E.hubNode('van',E.HUB.x+600,E.HUB.y); return {out, toHub:!!E.returnLeg('van', c1.node, hub, 1), toIsl:E.returnLeg('van', c1.node, c0.node, 1)===null, ok1:E.nets.car.ok[c1.node], ok0:E.nets.car.ok[c0.node]}}""")
            ok('D3 Kunden von Center 2 liegen in Teststadt und sind erreichbar; Center 2 erreicht Punkte der Startregion, nicht die Insel; beide Standorte befahrbar',
               len(r2['out']) == 80 and all(inside(o, 111) and o['leg'] >= 0 for o in r2['out']) and r2['toHub'] and r2['toIsl'] and r2['ok1'] == 1 and r2['ok0'] == 1, str({k: v for k, v in r2.items() if k != 'out'}) + ' außerhalb/unerreichbar: ' + str([o for o in r2['out'] if not (inside(o, 111) and o['leg'] >= 0)][:3]))

            # ================= E: weitere Stadt für das ferne Center =================
            await pg.click('#dlist .hubup'); await wait_for(pg, "!document.getElementById('win').hidden", 4000)
            await pg.click('#hqTabs button >> text=Center 1'); await pg.wait_for_timeout(300)
            await pg.click('#ceCitAdd')
            await wait_for(pg, "document.querySelectorAll('#dlgB li button').length>0", 15000)
            lst = await pg.evaluate("[...document.querySelectorAll('#dlgB li button')].map(b=>b.textContent)")
            ok('E1 Städte in der Nähe von Weitstadt: Südstadt und Nachbarstadt (Teststadt gehört schon zu Center 2, bleibt aber wählbar oder nicht)', any(x.startswith('Südstadt') for x in lst) and any(x.startswith('Nachbarstadt') for x in lst) and not any(x.startswith('Weitstadt') for x in lst), str(lst))
            idx = [i for i, x in enumerate(lst) if x.startswith('Südstadt')][0]
            await pg.click('#dlgB li button >> nth=%d' % idx)
            await wait_for(pg, "document.getElementById('dlgB').textContent.includes('Südstadt:')", 15000)
            # erst ohne Verbindung in den Kartendaten: die Stadt wird nicht freigeschaltet
            W.no_link = True
            await pg.click('#dlgB .btn.primary')
            okk = await wait_for(pg, "document.getElementById('dlgB').textContent.includes('nicht zu erreichen')", 150000, 500)
            ok('E2 Keine Straßenverbindung zur Insel: Stadt nicht freigeschaltet, nichts abgebucht', okk and 'nichts abgebucht' in await pg.evaluate(DLG) and abs(await pg.evaluate("__lm.cash()") - 295000) < 200, (await pg.evaluate(DLG))[-300:])
            await pg.evaluate("document.getElementById('dlgX').click()")
            W.no_link = False
            await pg.click('#ceCitAdd')
            await wait_for(pg, "document.querySelectorAll('#dlgB li button').length>0", 15000)
            lst = await pg.evaluate("[...document.querySelectorAll('#dlgB li button')].map(b=>b.textContent)")
            idx = [i for i, x in enumerate(lst) if x.startswith('Südstadt')][0]
            await pg.click('#dlgB li button >> nth=%d' % idx)
            await wait_for(pg, "document.getElementById('dlgB').textContent.includes('Südstadt:')", 15000)
            await pg.evaluate("window.__marker = 1")
            await pg.click('#dlgB .btn.primary')
            started = await wait_app(pg, 150000)
            cs4 = await pg.evaluate("(()=>({a:__lm.cen.centers().map(c=>c.cities.map(r=>r.name).join()).join('|'), isl:__lm.cen.centers()[0].cities.map(r=>r.isl||'-').join()}))()")
            kk = await pg.evaluate("async()=>await LM.dbKeys('pack:')")
            ok('E3 Nach dem Kauf: Center 1 bedient Weitstadt und Südstadt, beide auf der Insel; Verbindung Weitstadt-Südstadt gespeichert, keine zur Startregion', started and cs4['a'] == 'Weitstadt,Südstadt|Teststadt' and any('link:' in x and '333' in x and '444' in x for x in kk) and not any('link:' in x and '111' in x for x in kk), '%s %s' % (cs4, kk))
            r4 = await pg.evaluate("""()=>{const E=__lm.E, c0=__lm.cen.centers()[0], out=[]; for(let i=0;i<200;i++){const o=__lm.cen.spawn(0); if(o){const l=E.returnLeg('van', c0.node, o.node, 1), g=E.unproj(o.x,o.y); out.push({la:g.lat, lo:g.lon, leg:l?l.len:-1})}} return out}""")
            sued = [o for o in r4 if inside(o, 333)]
            ok('E4 Kunden in Weitstadt und Südstadt, alle von Center 1 aus erreichbar (Fahrt durch die Lücke)', len(r4) == 200 and len(sued) > 30 and all((inside(o, 333) or inside(o, 444)) and o['leg'] >= 0 for o in r4), '%d %d' % (len(sued), len(r4)))
            ok('E5 keine Fehler im Browser', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
