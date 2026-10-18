"""Fulfillment Center mit mehreren Städten auf einer echten (künstlichen) Karte, Phase 15: erstes Center -> Stadt bestimmen und laden -> Neustart,
Kunden nur innerhalb der Stadtgrenzen, weitere Stadt kaufen (mit Verbindung über große Straßen), Fehler- und Abbruchwege, Altstand ohne Städte.
Die Karten-Server (Overpass, Nominatim) sind durch tests/fakeworld.py ersetzt.
Start: python3 tests/ui_cities.py   (Ports 8399 / 9299)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os, math
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
sys.path.insert(0, HERE)
from fakeworld import World, CITIES, START, nlat, nlon
MOCK = 'http://127.0.0.1:9299'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8399/index.html?debug&nobase'
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
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9299'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8399', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            pg.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' and 'fonts' not in m.text and 'ERR_' not in m.text and 'Failed to load resource' not in m.text and 'Access is denied' not in m.text and 'Das Laden ist nicht' not in m.text and 'Kartenserver' not in m.text and 'Kartendaten konnten' not in m.text else None)
            await pg.add_init_script("localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
            await pg.goto(URL); await pg.wait_for_timeout(1000)

            # ================= A: Start auf der Karte, erstes Center =================
            await pg.evaluate("a=>LMO.register({name:a.name,email:a.email,password:'geheim123',code:a.code})", {'name': 'Tim Stadt', 'email': 'stadt@example.de', 'code': CODE})
            await wait_for(pg, "document.getElementById('pickMain') && !document.getElementById('pickMain').hidden", 8000)
            await pg.fill('#q', 'Teststadt'); await pg.press('#q', 'Enter')
            await wait_for(pg, "document.querySelectorAll('#results li').length>0", 8000)
            await pg.click('#results li button >> nth=0'); await pg.click('#confirmGo')
            started = await wait_app(pg)
            ok('A0 Spiel startet auf der künstlichen Karte (Kernkarte aus den Kartenservern)', started and W.calls['roads'] >= 1 and W.calls['places'] >= 1, str(W.calls))
            n0 = await pg.evaluate("__lm.E.N")
            ok('A1 Kernkarte: Straßennetz da, noch keine Stadt, kein Center', n0 > 2000 and await pg.evaluate("[__lm.cen.cities().length, __lm.cen.centers().length].join()") == '0,0', n0)
            await pg.evaluate("__lm.setCash(300000)")
            ext0 = await pg.evaluate("(()=>{const E=__lm.E; let a=1e9,b=-1e9; for(let i=0;i<E.N;i++){a=Math.min(a,E.nx[i]);b=Math.max(b,E.nx[i]);} return b-a})()")
            ok('A2 Kernkarte ist ca. 3,6 km breit', 3400 < ext0 < 3900, ext0)
            r = await pg.evaluate("()=>{const E=__lm.E; __lm.cen.build(E.HUB.x, E.HUB.y); return __lm.cen.centers().length}")
            ok('A3 Erstes Center auf der echten Karte: noch nicht gebaut, Dialog zur Stadt', r == 0 and await wait_for(pg, "!document.getElementById('dlg').hidden && document.getElementById('dlgT').textContent==='Erstes Fulfillment Center'", 4000))
            await wait_for(pg, "document.getElementById('dlgB').textContent.includes('Teststadt:')", 15000)
            t = await pg.evaluate(DLG)
            ok('A4 Stadt bestimmt: Name, Fläche, Einwohner, Bestellungen pro Tag', 'Teststadt:' in t and re.search(r'1[78],\d km²', t) and '120 000 Einwohner' in t and 'ca. 40 Bestellungen pro Tag' in t, t[:300])
            ok('A5 Grenze mit einer einzigen Nominatim-Abfrage (reverse) geholt, ohne Overpass-is_in (nicht der Ersatzkreis)', W.calls['reverse'] == 1 and W.calls['isin'] == 0 and 'keine genaue Stadtgrenze' not in t, str(W.calls))
            go = await pg.evaluate("[document.querySelector('#dlgB .btn.primary').textContent, document.querySelector('#dlgB .btn.primary').disabled]")
            ok('A6 Knopf "Stadt laden und bauen (5.000,00 €)" ist frei', go[0].startswith('Stadt laden und bauen') and '5.000,00' in go[0] and not go[1], str(go))
            ok('A7 noch nichts abgebucht, Center nicht gebaut', await pg.evaluate("[__lm.cash(), __lm.cen.centers().length].join()") == '300000,0')
            # Laden und Neustart
            await pg.evaluate("window.__marker = 1")
            await pg.click('#dlgB .btn.primary')
            await wait_for(pg, "(document.getElementById('dlgB')||{}).textContent.includes('Straßen') || window.__marker !== 1", 4000)
            ok('A8 beim Laden: Fortschrittsbalken und Text zu den Straßen', await pg.evaluate("window.__marker") == 1 and await pg.evaluate("!document.querySelector('#dlgB .bar2').hidden"))
            started = await wait_app(pg, 120000)
            ok('A9 Spiel startet neu', started)
            if not started:
                print(await pg.evaluate("document.body.innerText.slice(0,500)"))
            roads_calls = W.calls['roads']; print('   Abfragen', W.calls, W.hw)
            ok('A10 Städtische Straßen kamen in Kacheln (mehr als eine Abfrage), Firmen einmal je Kachel', roads_calls >= 5 and W.calls['firms'] >= 1, str(W.calls))
            cash = await pg.evaluate("__lm.cash()")
            ok('A11 Center 1 gebaut in Teststadt, 5.000 € abgebucht', await pg.evaluate("[__lm.cen.centers().length, __lm.cen.centers()[0].cities.map(c=>c.name+':'+c.rel).join()].join()") == '1,Teststadt:111' and abs(cash - 295000) < 80, cash)
            ct = await pg.evaluate("(()=>{const c=__lm.cen.cities()[0]; return {id:c.id,name:c.name,dem:c.dem,core:c.core,approx:c.approx,unl:c.unlinked,area:c.area}})()")
            ok('A12 Stadt im Spiel: Nachfrage 40 pro Tag, nicht die Kernkarte, mit Grenze', ct['dem'] == 40 and not ct['core'] and not ct['approx'] and not ct['unl'] and 17 < ct['area'] < 20, str(ct))
            n1 = await pg.evaluate("__lm.E.N")
            ext1 = await pg.evaluate("(()=>{const E=__lm.E; let a=1e9,b=-1e9,c=1e9,d=-1e9; for(let i=0;i<E.N;i++){a=Math.min(a,E.nx[i]);b=Math.max(b,E.nx[i]);c=Math.min(c,E.ny[i]);d=Math.max(d,E.ny[i]);} return [b-a,d-c]})()")
            ok('A13 Karte ist größer: alle Straßen der Stadt (ca. 4,2 x 4,5 km), mehr Knoten', n1 > n0 + 3000 and ext1[0] > 4000 and ext1[1] > 4200, '%s -> %s %s' % (n0, n1, ext1))
            ok('A14 Hub und Hauptquartier bleiben auf der Kernkarte (Liefergebiet höchstens Kernradius)', await pg.evaluate("__lm.fx.zr(__lm.hubs()[0])") <= 1800)
            ok('A15 Fahrer-Netz verbunden: Hub kommt zu einem Punkt weit außerhalb der Kernkarte', await pg.evaluate("""()=>{const E=__lm.E; const q=E.proj(%f, %f); const a=E.hubNode('van', E.HUB.x, E.HUB.y), z=E.hubNode('van', q.x, q.y); const l=E.returnLeg('van', a, z, 1); return !!l && l.len > 1500 && l.len < 4000}""" % (nlat(95), nlon(95))))

            # ================= B: Kunden nur in der Stadt =================
            res = await pg.evaluate("""()=>{const E=__lm.E, out=[]; for(let i=0;i<150;i++){const o=__lm.cen.spawn(0); if(o){const g=E.unproj(o.x,o.y); out.push({firm:o.firm, name:o.name, street:o.street, la:g.lat, lo:g.lon, node:o.node, d:Math.hypot(o.x-E.HUB.x,o.y-E.HUB.y), nd:Math.hypot(E.nx[o.node]-o.x,E.ny[o.node]-o.y)})}} return out}""")
            inside = lambda o, c: nlat(CITIES[c][1]) - 0.0009 <= o['la'] <= nlat(CITIES[c][2]) + 0.0009 and nlon(CITIES[c][3]) - 0.0013 <= o['lo'] <= nlon(CITIES[c][4]) + 0.0013
            ok('B1 150 Bestellungen entstehen', len(res) == 150)
            ok('B2 alle Kunden liegen innerhalb der Stadtgrenze von Teststadt', all(inside(o, 111) for o in res), str([o for o in res if not inside(o, 111)][:2]))
            far = [o for o in res if o['d'] > 1900]
            ok('B3 viele Kunden liegen außerhalb der Kernkarte (über 1,9 km vom Hub)', len(far) > 25, '%d von %d' % (len(far), len(res)))
            fi, pr = [o for o in res if o['firm']], [o for o in res if not o['firm']]
            ok('B4 Firmen- und Privatkunden, Firmen aus den Kartendaten', len(fi) > 20 and len(pr) > 60 and all(o['name'].startswith('Firma') for o in fi), '%d/%d %s' % (len(fi), len(pr), [o['name'] for o in fi[:3]]))
            ok('B5 fast alle Privatkunden haben eine Straße, jeder Kunde ist an eine Straße angebunden (< 150 m)', sum(1 for o in pr if o['street']) >= 0.9 * len(pr) and all(o['nd'] < 150 for o in res), str(max(o['nd'] for o in res)))
            ok('B6 Nachfrage des Centers = Nachfrage der Stadt (40)', await pg.evaluate("__lm.cen.demand(0)") == 40)
            # Städte-Block
            await pg.click('#dlist .hubup'); await wait_for(pg, "!document.getElementById('win').hidden", 4000)
            await pg.click('#hqTabs button >> text=Center 1'); await pg.wait_for_timeout(300)
            cit = await pg.evaluate("({n: document.getElementById('ceCitN').textContent, li: [...document.querySelectorAll('#ceCitList li')].map(e => e.textContent), btn: document.getElementById('ceCitAdd').textContent, dis: document.getElementById('ceCitAdd').disabled})")
            ok('B7 Städte-Block: 1 von 6, Teststadt mit Fläche, Einwohnern, Bestellungen, Firmen; Knopf 3.000 €', cit['n'] == '1 von 6' and len(cit['li']) == 1 and 'Teststadt' in cit['li'][0] and 'km²' in cit['li'][0] and 'Bestellungen/Tag' in cit['li'][0] and 'Firmen' in cit['li'][0] and '3.000,00' in cit['btn'] and not cit['dis'], str(cit))

            # ================= C: weitere Stadt (Südstadt liegt nicht an Teststadt: 660 m Lücke) =================
            await pg.click('#ceCitAdd')
            await wait_for(pg, "document.querySelectorAll('#dlgB li button').length>0", 12000)
            lst = await pg.evaluate("[...document.querySelectorAll('#dlgB li button')].map(b=>b.textContent+(b.disabled?' [gesperrt]':''))")
            ok('C1 Städte in der Nähe: Nachbarstadt, Südstadt, Weitstadt (nach Entfernung), je 3.000 €, nicht die eigene Stadt', len(lst) == 3 and lst[0].startswith('Nachbarstadt') and lst[1].startswith('Südstadt') and lst[2].startswith('Weitstadt') and all('3.000,00' in x and 'km' in x and 'Fahrt' in x for x in lst) and not any('gesperrt' in x for x in lst), str(lst))
            t = await pg.evaluate(DLG)
            ok('C2 Dialog nennt Titel und Preis', 'Stadt zu Center 1 hinzufügen' in await txt(pg, '#dlgT') and '3.000,00' in t)
            await pg.click('#dlgB li button >> nth=1')                                  # Südstadt
            await wait_for(pg, "document.getElementById('dlgB').textContent.includes('Südstadt:')", 15000)
            t = await pg.evaluate(DLG)
            ok('C3 Bestätigung: Südstadt freischalten, 80 000 Einwohner, ca. 28 Bestellungen', 'Südstadt freischalten' in await txt(pg, '#dlgT') and '80 000 Einwohner' in t and 'ca. 28 Bestellungen pro Tag' in t, t[:300])
            hw0 = len(W.hw)
            # erster Versuch: Server überlastet -> Fehler, nichts abgebucht, Knopf "Erneut versuchen"
            W.fail_roads = 40
            await pg.evaluate("window.__marker = 1")
            await pg.click('#dlgB .btn.primary')
            okk = await wait_for(pg, "document.querySelector('#dlgB .btn.primary') && document.querySelector('#dlgB .btn.primary').textContent==='Erneut versuchen'", 150000, 500)
            t = await pg.evaluate(DLG)
            ok('C4 Server überlastet: Hinweis "nicht gelungen", Knopf "Erneut versuchen", nichts abgebucht, kein Neustart', okk and 'Das Laden ist nicht gelungen' in t and await pg.evaluate("window.__marker") == 1 and abs(await pg.evaluate("__lm.cash()") - 295000) < 80 and await pg.evaluate("__lm.cen.centers()[0].cities.length") == 1, t[-300:])
            # zweiter Versuch: Verbindung ohne große Straßen -> Stadt nicht erreichbar, nichts abgebucht
            W.fail_roads = 0; W.no_link = True
            await pg.click('#dlgB .btn.primary')
            okk = await wait_for(pg, "document.getElementById('dlgB').textContent.includes('nicht zu erreichen')", 150000, 500)
            t = await pg.evaluate(DLG)
            ok('C5 Keine Straßenverbindung in den Kartendaten: Stadt wird nicht freigeschaltet, nichts abgebucht', okk and 'nichts abgebucht' in t and await pg.evaluate("document.querySelector('#dlgB .btn.primary').disabled") and await pg.evaluate("window.__marker") == 1 and abs(await pg.evaluate("__lm.cash()") - 295000) < 80, t[-300:])
            kk = await pg.evaluate("async()=>await LM.dbKeys('pack:')")
            ok('C5b die leere Verbindung wird nicht gemerkt', not any('link' in x for x in kk), str(kk))
            await pg.click('#dlgB .btn:not(.primary)') if await vis(pg, '#dlgB .btn:not(.primary)') else None
            await pg.evaluate("document.getElementById('dlgX').click()")
            # dritter Versuch: alles in Ordnung
            W.no_link = False
            await pg.click('#ceCitAdd')
            await wait_for(pg, "document.querySelectorAll('#dlgB li button').length>0", 12000)
            await pg.click('#dlgB li button >> nth=1')
            await wait_for(pg, "document.getElementById('dlgB').textContent.includes('Südstadt:')", 15000)
            await pg.evaluate("window.__marker = 1")
            await pg.click('#dlgB .btn.primary')
            started = await wait_app(pg, 150000)
            ok('C6 Neustart nach dem Kauf', started)
            cs = await pg.evaluate("[__lm.cen.centers()[0].cities.map(c=>c.name).join(), __lm.cen.cities().length].join()"); cash = await pg.evaluate("__lm.cash()")
            ok('C7 Center 1 bedient Teststadt und Südstadt, 3.000 € abgebucht', cs == 'Teststadt,Südstadt,2' and abs(cash - 292000) < 150, '%s %s' % (cs, cash))
            ok('C8 Verbindung aus großen Straßen wurde geladen (Abfragen nach "main")', 'main' in W.hw[hw0:], str(W.hw[hw0:]))
            n2 = await pg.evaluate("__lm.E.N")
            ok('C9 noch mehr Knoten, Karte reicht jetzt auch nach Süden', n2 > n1 + 3000, '%d -> %d' % (n1, n2))
            ok('C10 Nachfrage 40 + 28 = 68 pro Tag', await pg.evaluate("__lm.cen.demand(0)") == 68)
            res = await pg.evaluate("""()=>{const E=__lm.E, out=[]; for(let i=0;i<400;i++){const o=__lm.cen.spawn(0); if(o){const g=E.unproj(o.x,o.y); out.push({firm:o.firm, la:g.lat, lo:g.lon, node:o.node, id:o.id, day:o.day, wh:o.wh})}} return out}""")
            sued = [o for o in res if inside(o, 333)]; test = [o for o in res if inside(o, 111)]
            ok('C11 jeder Kunde liegt in Teststadt oder Südstadt', len(sued) + len(test) == len(res) == 400, '%d %d' % (len(sued), len(test)))
            share = len(sued) / 400
            ok('C12 Verteilung nach Nachfrage: ca. 41 % der Bestellungen aus Südstadt', 0.31 < share < 0.51, share)
            # Fahrt über die Lücke: Straße von Teststadt nach Südstadt ist durchgehend befahrbar
            if not sued or not test: raise SystemExit('keine Kunden in beiden Städten: ' + str(len(sued)) + ' ' + str(len(test)))
            leg = await pg.evaluate("""a=>{const E=__lm.E; const l=E.returnLeg('van', a[0], a[1], 1); return l?{len:l.len, time:l.time}:null}""", [test[0]['node'], sued[0]['node']])
            ok('C13 Fahrt von Teststadt nach Südstadt möglich (1 bis 16 km)', leg and 600 < leg['len'] < 16000, str(leg))
            # Tour mit Stopps in beiden Städten
            await pg.evaluate("__lm.cen.auto(false)")
            vid = await pg.evaluate("(()=>{__lm.cen.buyVan(0); __lm.cen.hire(0); const c=__lm.cen.centers()[0]; return [c.vans[0].id, c.drv[0].id]})()")
            planned = None
            for a in sued[:25]:
                for bb in test[:25]:
                    if a['day'] != bb['day']: continue
                    for k in range(5):
                        r = await pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,{k:a.k,day:a.day,van:a.van,drv:a.drv,stops:a.stops}); return r&&{ok:r.ok, err:r.err||null}}", {'k': k, 'day': a['day'], 'van': vid[0], 'drv': vid[1], 'stops': [bb['id'], a['id']]})
                        if r and r['ok']: planned = (k, a['id'], bb['id'], r); break
                    if planned: break
                if planned: break
            ok('C14 Tour mit einem Stopp in Teststadt und einem in Südstadt lässt sich planen', planned is not None, str(planned))
            tl = await pg.evaluate("__lm.cen.tour.list(0).map(t=>({st:t.st, n:t.stops.length}))")
            ok('C15 Tour steht im Center (zwei Stopps)', tl and tl[0]['n'] == 2, str(tl))
            await pg.evaluate("__lm.cen.setView('cen'); __lm.view.fit()"); await pg.wait_for_timeout(1200)
            await pg.screenshot(path=OUT + 'cities_cen.png')
            await pg.evaluate("__lm.cen.setView('hq')")
            # Preisstaffel: dritte Stadt kostet 6.000 €
            await pg.click('#dlist .hubup'); await wait_for(pg, "!document.getElementById('win').hidden", 4000)
            await pg.click('#hqTabs button >> text=Center 1'); await pg.wait_for_timeout(300)
            cit = await pg.evaluate("({n: document.getElementById('ceCitN').textContent, li: [...document.querySelectorAll('#ceCitList li')].map(e => e.textContent), btn: document.getElementById('ceCitAdd').textContent})")
            ok('C16 Städte-Block: 2 von 6, beide Städte, nächste Stadt 6.000 €', cit['n'] == '2 von 6' and len(cit['li']) == 2 and '6.000,00' in cit['btn'], str(cit))
            await pg.click('#ceCitAdd')
            await wait_for(pg, "document.querySelectorAll('#dlgB li button').length>0", 12000)
            lst = await pg.evaluate("[...document.querySelectorAll('#dlgB li button')].map(b=>b.textContent)")
            ok('C17 Liste ohne bereits gebuchte Städte: Nachbarstadt und Weitstadt zu 6.000 €', len(lst) == 2 and lst[0].startswith('Nachbarstadt') and lst[1].startswith('Weitstadt') and all('6.000,00' in x for x in lst), str(lst))
            await pg.evaluate("document.getElementById('dlgX').click()")
            await pg.screenshot(path=OUT + 'cities_ui.png')

            # ================= D: zu wenig Geld =================
            await pg.evaluate("__lm.setCash(4000)"); await pg.wait_for_timeout(600)
            await pg.click('#ceCitAdd') if not await pg.evaluate("document.getElementById('ceCitAdd').disabled") else None
            ok('D1 Zu wenig Geld (4.000 € < 6.000 €): Knopf "Stadt hinzufügen" gesperrt', await pg.evaluate("document.getElementById('ceCitAdd').disabled"))
            await pg.evaluate("__lm.setCash(300000)")

            # ================= E: Spielstand v5, Altstand ohne Städte =================
            snap = await pg.evaluate("(()=>{const s=__lm.save.snapshot(); return {v:s.v, cities:s.centers[0].cities, keys:Object.keys(s.centers[0].cities[0])}})()")
            ok('E1 Spielstand v5: Center nennt seine Städte (Kennung, Name, Lage, Relation, Einwohner)', snap['v'] == 5 and [c['name'] for c in snap['cities']] == ['Teststadt', 'Südstadt'] and set(snap['keys']) >= {'id', 'name', 'lat', 'lon', 'rel', 'pop', 'ap'}, str(snap))
            ok('E2 Center im Spielstand klein (keine Polygone, Straßen oder Kunden): unter 3.000 Zeichen', await pg.evaluate("JSON.stringify(__lm.save.snapshot().centers).length") < 3000, await pg.evaluate("JSON.stringify(__lm.save.snapshot().centers).length"))
            # Stand in der Cloud ohne Städte (Version 4), Kopie auf dem Gerät mit Städten (Version 5, neuer): beide Städte werden geladen
            PATCH = """()=>{const orig = LMO.company.push; LMO.company.push = (slot, sess, raw, ...rest) => { const o = JSON.parse(raw); o.v = 4; o.centers.forEach(c => { delete c.cities; }); return orig(slot, sess, JSON.stringify(o), ...rest); }}"""
            await pg.evaluate(PATCH)
            ok('E2b Umwandlung liegt an (Push-Funktion ersetzt)', await pg.evaluate("LMO.company.push.toString().includes('delete c.cities')"))
            ok('E2c Altstand in die Cloud geschrieben', await pg.evaluate("__lm.push()") is True)
            await pg.goto('http://127.0.0.1:8399/nichts-da'); await pg.wait_for_timeout(500)
            await pg.evaluate("window.__marker = 1")
            await pg.goto(URL)
            started = await wait_app(pg, 150000)
            ok('E3 Cloud-Stand ohne Städte, Kopie mit Städten: Spiel startet', started)
            old = await pg.evaluate("[__lm.cen.centers().length, __lm.cen.centers()[0].cities.map(c=>c.name+':'+c.rel).join(), __lm.cen.cities().length].join()")
            ok('E4a Städte beider Stände sind geladen: jede Stadt des Centers läuft im Spiel (Cloud-Stand oder Kopie gewählt, beides ist erlaubt)', old in ('1,Teststadt:111,Südstadt:333,2', '1,Teststadt:111,2') and await pg.evaluate("__lm.cen.centers()[0].cities.every(r => __lm.cen.cities().some(c => c.id === r.id))"), old)
            # Nur der Altstand (Kopie auf dem Gerät gelöscht): das Center bekommt die Stadt der Kernkarte
            await pg.evaluate(PATCH)
            ok('E4b Altstand erneut in die Cloud geschrieben', await pg.evaluate("__lm.push()") is True)
            await pg.goto('http://127.0.0.1:8399/nichts-da'); await pg.wait_for_timeout(500)
            await pg.evaluate("Object.keys(localStorage).filter(k => k.startsWith('lm.osave.')).forEach(k => localStorage.removeItem(k))")
            await pg.evaluate("window.__marker = 1")
            await pg.goto(URL)
            started = await wait_app(pg, 150000)
            ok('E5 Altstand (v4, Center ohne Städte, keine Kopie) startet', started)
            old = await pg.evaluate("[__lm.cen.centers().length, __lm.cen.centers()[0].cities.map(c=>c.name+':'+c.rel).join(), __lm.cen.cities().length].join()")
            ok('E6 Altstand: das Center bekommt die Stadt der Kernkarte (Teststadt), aus dem Zwischenspeicher', old == '1,Teststadt:111,1', old)
            await pg.screenshot(path=OUT + 'cities_map.png')
            ok('E7 keine Fehler im Browser', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
