"""Fulfillment Center, Tourenplaner (Phase 14b/c): Oberfläche in Liste, Planer und Karte.
Start: python3 tests/ui_tours_ui.py   (Ports 8399 / 9299)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9299'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8399/index.html?debug&nobase'
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


async def add(pg, oid):
    await pg.click('#colist li[data-id="%d"] button[data-act=tourToggle]' % oid); await pg.wait_for_timeout(250)


STOPS = """[...document.querySelectorAll('#plStops .pstop')].map(li=>({n:li.querySelector('.pn').textContent, name:li.querySelector('strong').textContent, eta:(li.querySelector('.peta')||{}).textContent||'', cls:(li.querySelector('.peta')||{}).className||''}))"""
TXT = lambda sel: "(()=>{const e=document.querySelector('%s'); return e?e.textContent:null})()" % sel
CLR = "(()=>{const c=__lm.cen.centers()[0]; c.tours.filter(t=>t.st==='plan').forEach(t=>__lm.cen.tour.cancel(0,t.id)); const a=__lm.cen.orders(); a.splice(0,a.length)})()"


async def map_xy(pg, o):
    await pg.evaluate("window.scrollTo(0,0)")
    await pg.evaluate("a=>{const c=__lm.view.cam; __lm.view.look(a.x,a.y,Math.max(c.z,1))}", o); await pg.wait_for_timeout(500)
    return await pg.evaluate("a=>{const r=document.getElementById('map').getBoundingClientRect(); return [r.left+__lm.view.toX(a.x), r.top+__lm.view.toY(a.y)]}", o)


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
            ctx = await newctx(b)

            async def overpass(route, request):
                await route.fulfill(status=200, headers={'content-type': 'application/json', 'access-control-allow-origin': '*'}, body=json.dumps(FAKE))
            await ctx.route(re.compile(r'https://(overpass-api\.de|overpass\.private\.coffee|overpass\.kumi\.systems|maps\.mail\.ru)/.*'), overpass)
            pg, errs, started = await start_game(ctx, 'Tim Tour', 'tourui@example.de')
            ok('T0 Spiel startet', started)
            await pg.evaluate("Math.random = () => 0.5; __lm.cen.auto(false); __lm.drivers().forEach(d => { d.rest = 'on'; }); __lm.setCash(500000)")
            ok('U0 Ohne Center ist der Tourenblock unsichtbar', not await vis(pg, '#tourBlock'))
            await pg.evaluate(POI_BUILD); await pg.evaluate("__lm.cen.setView('cen')"); await pg.wait_for_timeout(500)
            ok('U1 Center-Ansicht zeigt den Tourenblock; ohne Transporter und Fahrer ist "Tour planen" gesperrt', await vis(pg, '#tourBlock') and await vis(pg, '#tourNew') and await pg.evaluate("document.getElementById('tourNew').disabled") and 'Ohne Transporter und Fahrer' in await txt(pg, '#thint'), await txt(pg, '#thint'))
            await pg.evaluate("for (let i=0;i<3;i++) __lm.cen.buyVan(0); for (let i=0;i<3;i++) __lm.cen.hire(0)"); await pg.wait_for_timeout(500)
            hint = await txt(pg, '#thint')
            ok('U2 Mit Transporter und Fahrer ist der Knopf aktiv; der Hinweis nennt Abfahrten, Beladen und die 8 Stunden', not await pg.evaluate("document.getElementById('tourNew').disabled") and all(x in hint for x in ['6:35', '9:35', '12:00', '14:35', '17:00', 'halbe Stunde', '8 Stunden']), hint)
            await pg.evaluate("__lm.cen.setView('hq')"); await pg.wait_for_timeout(300)
            ok('U3 In der Lieferdienst-Ansicht ist der Tourenblock weg', not await vis(pg, '#tourBlock'))
            await pg.evaluate("__lm.cen.setView('cen')"); await pg.wait_for_timeout(300)
            vans = await pg.evaluate("__lm.cen.centers()[0].vans.map(v=>v.id)"); drvs = await pg.evaluate("__lm.cen.centers()[0].drv.map(d=>d.id)"); ci = 0

            # ================= Planer öffnen =================
            await setT(pg, 5.0, 3)
            A = [await mk(pg, ci, False, 3, 10, 12, 2, i) for i in range(3)]
            Rr = [await mk(pg, ci, False, 3, 7, 9, 2, 3 + i) for i in range(2)]
            Bo = await mk(pg, ci, False, 3, 14, 16, 2, 5); Co = await mk(pg, ci, False, 4, 10, 12, 2, 6)
            await pg.wait_for_timeout(400)
            await pg.click('#tourNew'); await wait_vis(pg, '#planner')
            ok('U4 Planer öffnet sich, der Knopf "Tour planen" verschwindet', await vis(pg, '#planner') and not await vis(pg, '#tourNew'))
            slot = await pg.evaluate("document.getElementById('plSlot').value")
            slots_t = await pg.evaluate("[...document.getElementById('plSlot').options].map(o=>o.textContent)")
            ok('U5 Vorbelegung: die Abfahrt 9:35, zu der die meisten Bestellungen zeitlich passen; Liste mit Tag, Uhrzeit, Annahmeschluss', slot == '3:1' and 'Heute · Montag · 9:35 Uhr · Annahmeschluss 8:05' in slots_t and len(slots_t) >= 8, '%s %s' % (slot, slots_t[:3]))
            van_v = await pg.evaluate("document.getElementById('plVan').value"); drv_v = await pg.evaluate("document.getElementById('plDrv').value")
            ok('U6 Transporter und Fahrer sind mit freien vorbelegt', van_v == str(vans[0]) and drv_v == str(drvs[0]), '%s %s' % (van_v, drv_v))
            ok('U7 Ohne Stopps ist "Tour speichern" gesperrt, Hinweis erklärt das Vorgehen', await pg.evaluate("document.getElementById('plSave').disabled") and 'Noch keine Stopps' in await txt(pg, '#plSum'))
            cnt = await pg.evaluate("document.querySelectorAll('#colist li.order').length")
            ok('U8 Die Liste zeigt nur Bestellungen, die zu dieser Abfahrt passen (gleicher Tag): 6 von 7', cnt == 6 and await pg.evaluate("a=>!document.querySelector('#colist li[data-id=\"'+a+'\"]')", Co) and 'nur Bestellungen' in await txt(pg, '#cohint'), '%s %s' % (cnt, await txt(pg, '#cohint')))

            # ================= Stopps hinzufügen =================
            await add(pg, A[0])
            st = await pg.evaluate(STOPS)
            ok('U9 Knopf "In die Tour": Stopp 1 mit Ankunftszeit, Zeile in der Liste zeigt Stopp 1', len(st) == 1 and st[0]['n'] == '1' and 'Ankunft' in st[0]['eta'] and 'Aus der Tour nehmen' in await pg.evaluate("a=>document.querySelector('#colist li[data-id=\"'+a+'\"] button[data-act=tourToggle]').textContent", A[0]) and 'Stopp 1' in await pg.evaluate("a=>document.querySelector('#colist li[data-id=\"'+a+'\"]').textContent", A[0]), str(st))
            sm = await txt(pg, '#plSum')
            ok('U10 Zusammenfassung: Beladen ab 9:05, Abfahrt 9:35, Rückkehr, Stopps, Dauer, Lohn', all(x in sm for x in ['Beladen ab 9:05', 'Abfahrt 9:35', 'zurück etwa', '1 von 10 Stopps', 'Dauer', 'Lohn der Bestellungen', 'Fahrerlohn']), sm)
            o1 = await pg.evaluate("a=>__lm.cen.orders().find(o=>o.id===a)", A[1])
            xy = await map_xy(pg, o1)
            await pg.mouse.move(xy[0] + 40, xy[1] + 40); await pg.mouse.move(xy[0], xy[1]); await pg.wait_for_timeout(250)
            await pg.mouse.click(xy[0], xy[1]); await pg.wait_for_timeout(400)
            ok('U11 Klick auf die Bestellung in der Karte nimmt sie in die Tour', len(await pg.evaluate(STOPS)) == 2 and A[1] in await pg.evaluate("[...document.querySelectorAll('#colist li.intour')].map(l=>Number(l.dataset.id))"), str(await pg.evaluate(STOPS)))
            await pg.mouse.click(xy[0], xy[1]); await pg.wait_for_timeout(400)
            ok('U12 Nochmal klicken nimmt sie wieder heraus', len(await pg.evaluate(STOPS)) == 1)
            await add(pg, A[1]); await add(pg, A[2])
            names = [s['name'] for s in await pg.evaluate(STOPS)]
            await pg.locator('#plStops .pstop').nth(1).locator('button[aria-label="Nach oben"]').click(); await pg.wait_for_timeout(300)
            names2 = [s['name'] for s in await pg.evaluate(STOPS)]
            ok('U13 Pfeil nach oben tauscht die Reihenfolge', names2[0] == names[1] and names2[1] == names[0] and names2[2] == names[2], '%s %s' % (names, names2))
            await pg.locator('#plStops .pstop').nth(0).locator('button[aria-label="Nach unten"]').click(); await pg.wait_for_timeout(300)
            ok('U14 Pfeil nach unten tauscht zurück', [s['name'] for s in await pg.evaluate(STOPS)] == names)
            await pg.locator('#plStops .pstop').nth(1).locator('button[aria-label="Aus der Tour nehmen"]').click(); await pg.wait_for_timeout(300)
            ok('U15 Kreuz nimmt den Stopp heraus, die Nummern rücken nach', [s['n'] for s in await pg.evaluate(STOPS)] == ['1', '2'] and len(await pg.evaluate(STOPS)) == 2)
            miss = await pg.evaluate("ids=>ids.filter(i=>!document.querySelector('#colist li[data-id=\"'+i+'\"]').classList.contains('intour'))", A)   # je nach Lage ist es die zweite oder dritte, die der Stopp-Kreuz entfernt hat
            await add(pg, miss[0])
            await pg.click('#plOpt'); await pg.wait_for_timeout(400)
            ok('U16 "Reihenfolge optimieren" meldet das Ergebnis', 'Reihenfolge' in await txt(pg, '#plInfo'), await txt(pg, '#plInfo'))
            await add(pg, Rr[0]); await pg.wait_for_timeout(200)
            st = await pg.evaluate(STOPS); late_rows = [s for s in st if 'late' in s['cls']]
            ok('U17 Ein Fenster, das vor der Abfahrt endet (7–9 Uhr), wird rot markiert; Zusammenfassung warnt', len(late_rows) == 1 and 'nach Fensterende' in late_rows[0]['eta'] and 'zu spät' in await txt(pg, '#plSum'), str(st))
            await pg.click('#plClr'); await pg.wait_for_timeout(300)
            ok('U18 "Leeren" entfernt alle Stopps', len(await pg.evaluate(STOPS)) == 0 and await pg.evaluate("document.getElementById('plSave').disabled"))
            await pg.screenshot(path=OUT + 'tpui_empty.png')

            # ================= Vorschlag =================
            await pg.click('#plSug'); await pg.wait_for_timeout(600)
            st = await pg.evaluate(STOPS); ids = await pg.evaluate("[...document.querySelectorAll('#colist li.intour')].map(l=>Number(l.dataset.id)).sort()")
            ok('U19 Vorschlag füllt die Tour mit den drei passenden Bestellungen (10–12 Uhr), nicht mit den zu späten (7–9) und nicht mit der 14–16-Bestellung', ids == sorted(A) and len(st) == 3 and 'Vorschlag: 3 Bestellungen' in await txt(pg, '#plInfo'), '%s %s' % (ids, await txt(pg, '#plInfo')))
            ok('U20 Alle Ankünfte im Fenster (keine Verspätung)', all('late' not in s['cls'] for s in st) and 'zu spät' not in await txt(pg, '#plSum'))
            await pg.click('#plSug'); await pg.wait_for_timeout(500)
            ok('U21 Nochmal "Vorschlag": nichts passt mehr dazu, Hinweis statt Änderung', len(await pg.evaluate(STOPS)) == 3 and 'passt' in await txt(pg, '#plInfo'), await txt(pg, '#plInfo'))
            await pg.screenshot(path=OUT + 'tpui_filled.png')

            # ================= Speichern, Ändern, Stornieren =================
            await pg.click('#plSave'); await pg.wait_for_timeout(500)
            tl = await pg.evaluate("[...document.querySelectorAll('#tlist li.tour')].map(l=>l.textContent)")
            ok('U22 Speichern: Planer schließt, die Tour steht in der Liste mit Zeiten', not await vis(pg, '#planner') and await vis(pg, '#tourNew') and len(tl) == 1 and 'Mo 9:35' in tl[0] and 'Geplant' in tl[0] and 'Beladen ab 9:05' in tl[0] and '3 Stopps' in tl[0], str(tl))
            ok('U23 Bestellungen der Tour sind aus der Liste verschwunden (stehen bei der Tour), Transporter in der rechten Spalte als eingeplant', await pg.evaluate("[...document.querySelectorAll('#colist li.order')].filter(l=>l.textContent.includes('in Tour')).length") == 0 and await pg.evaluate("__lm.cen.orders().filter(o=>o.state==='tour').every(o=>!document.querySelector('#colist li[data-id=\"'+o.id+'\"]'))") and await pg.evaluate("__lm.cen.orders().filter(o=>o.state==='tour').length") == 3 and 'für Tour eingeplant' in await pg.evaluate("document.getElementById('clist').textContent"))
            ok('U23b Zähler der Liste zählt nur die freien Bestellungen', await txt(pg, '#cocount') == str(await pg.evaluate("__lm.cen.orders().filter(o=>o.state==='open').length")), await txt(pg, '#cocount'))
            ok('U24 Protokoll nennt die geplante Tour', 'Tour Mo 9:35 geplant: 3 Stopps' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')"))
            await pg.click('#tlist button[data-act=tourEdit]'); await wait_vis(pg, '#planner')
            ok('U25 "Ändern" öffnet den Planer mit den Stopps der Tour; Abfahrt ist fest', await txt(pg, '#plTitle') == 'Tour ändern' and len(await pg.evaluate(STOPS)) == 3 and await pg.evaluate("document.getElementById('plSlot').disabled") and await pg.evaluate("document.getElementById('plSlot').value") == '3:1')
            await pg.locator('#plStops .pstop').nth(2).locator('button[aria-label="Aus der Tour nehmen"]').click(); await pg.wait_for_timeout(300)
            await add(pg, Bo)
            ok('U26 Beim Ändern lassen sich Stopps tauschen (9:35-Tour mit 14–16-Fenster: wartet bis 14:00)', 'wartet bis 14:00' in ' '.join(s['eta'] for s in await pg.evaluate(STOPS)), str(await pg.evaluate(STOPS)))
            await pg.click('#plSave'); await pg.wait_for_timeout(500)
            T1 = await pg.evaluate("__lm.cen.tour.list(0).map(t=>({id:t.id,stops:t.stops.length,st:t.st}))")
            ok('U27 Änderung gespeichert: weiterhin eine Tour mit 3 Stopps, die entfernte Bestellung ist wieder frei', len(T1) == 1 and T1[0]['stops'] == 3 and await pg.evaluate("__lm.cen.orders().filter(o=>o.state==='open').length") == 4 and 'geändert' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')"), str(T1))
            await pg.click('#tlist button[data-act=tourCancel]'); await pg.wait_for_timeout(400)
            ok('U28 "Stornieren": Tour weg, alle Bestellungen wieder frei, Protokoll', await pg.evaluate("__lm.cen.tour.list(0).length") == 0 and await pg.evaluate("__lm.cen.orders().every(o=>o.state==='open')") and 'abgesagt' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')") and await pg.evaluate("document.querySelectorAll('#tlist li').length") == 0)

            # ================= Fehler und Grenzen =================
            await pg.click('#tourNew'); await wait_vis(pg, '#planner')
            await pg.select_option('#plSlot', '4:1'); await pg.wait_for_timeout(500)
            cnt = await pg.evaluate("[...document.querySelectorAll('#colist li.order')].map(l=>Number(l.dataset.id))")
            ok('U29 Andere Abfahrt (Dienstag 9:35): die Liste wechselt auf die Bestellungen dieses Tages', cnt == [Co], str(cnt))
            u29 = await pg.evaluate("a=>{__lm.cen.sel.order = null; const t=Math.floor(__lm.cen.absT()/86400), L=__lm.cen.orders(); return {t, co:L.find(o=>o.id===a).day, coMap:__lm.cen.onMap(L.find(o=>o.id===a)), today:L.filter(o=>o.day===t).map(o=>[o.id,o.state,__lm.cen.onMap(o)]), all:L.map(o=>[o.id,o.day,o.state,__lm.cen.onMap(o)])}}", Co)
            ok('U29b Die Karte folgt der Abfahrt: Kunden des Dienstags stehen auf der Karte, die von heute (Montag) nicht', u29['coMap'] and len(u29['today']) > 0 and all(not x[2] for x in u29['today']), str(u29))
            await pg.select_option('#plSlot', '3:3'); await pg.wait_for_timeout(500)
            await pg.click('#plSug'); await pg.wait_for_timeout(500)
            st = await pg.evaluate(STOPS)
            ok('U30 Vorschlag für Montag 14:35: nur die 14–16-Bestellung passt noch', len(st) == 1 and st[0]['name'] and '14–16' in await pg.evaluate("document.querySelector('#plStops .pstop small').textContent"), str(st))
            await pg.click('#plClr'); await pg.select_option('#plSlot', '3:1'); await pg.wait_for_timeout(400)
            L = [await mk(pg, ci, False, 3, 20, 22, 2, 20 + i) for i in range(3)]
            await pg.wait_for_timeout(300)
            for i in L: await add(pg, i)
            ok('U31 Tour über 8 Stunden: Fehlermeldung, Speichern gesperrt', 'länger als 8 Stunden' in await txt(pg, '#plErr') and await pg.evaluate("document.getElementById('plSave').disabled"), await txt(pg, '#plErr'))
            await pg.click('#plClr'); await pg.wait_for_timeout(300)
            # Obergrenze der Stopps
            many = [await mk(pg, ci, False, 3, 10, 14, 1, 30 + i) for i in range(12)]
            await pg.wait_for_timeout(300)
            await pg.click('#plSug'); await pg.wait_for_timeout(1500)
            cnt = len(await pg.evaluate(STOPS))
            ok('U32 Vorschlag hält die Stopp-Grenze ein (10 zu Beginn)', cnt == 10, str(cnt))
            dis = await pg.evaluate("[...document.querySelectorAll('#colist li:not(.intour) button[data-act=tourToggle]')].every(b=>b.disabled)")
            ok('U33 Bei voller Tour sind die übrigen "In die Tour"-Knöpfe gesperrt', dis)
            await pg.click('#plClr'); await pg.wait_for_timeout(200)

            # ================= Zeit läuft: Abfahrt verstreicht =================
            await setT(pg, 9.2, 3); await pg.wait_for_timeout(2800)
            ok('U34 Beginnt das Beladen der gewählten Abfahrt (9:05), springt der Planer auf die nächste und sagt es', await pg.evaluate("document.getElementById('plSlot').value") == '3:2' and 'Beladen' in await txt(pg, '#plErr'), '%s %s' % (await pg.evaluate("document.getElementById('plSlot').value"), await txt(pg, '#plErr')))
            await pg.click('#plX'); await pg.wait_for_timeout(300)
            ok('U35 Abbrechen schließt den Planer ohne Tour', not await vis(pg, '#planner') and await vis(pg, '#tourNew') and await pg.evaluate("__lm.cen.tour.list(0).length") == 0)

            # ================= Laufende Tour in Liste und Karte =================
            await pg.evaluate(CLR)
            await setT(pg, 11.0, 3)
            E1 = await mk(pg, ci, False, 3, 12, 14, 2, 70); E2 = await mk(pg, ci, False, 3, 12, 14, 2, 71)
            tid = await pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,{k:2,day:3,van:a.v,drv:a.d,stops:[a.o,a.p]}); return r.ok?r.tour.id:r.err}", {'v': vans[0], 'd': drvs[0], 'o': E1, 'p': E2})
            await pg.wait_for_timeout(500)
            await setT(pg, 11.55, 3); await pg.evaluate("__lm.adv(60, 10)"); await pg.wait_for_timeout(700)
            li = await pg.evaluate("document.querySelector('#tlist li.tour').textContent")
            ok('U36 Beladene Tour: Status "Beladen", Abfahrt 12:00, keine Knöpfe zum Ändern/Stornieren', 'Beladen' in li and 'wird beladen' in li and 'Abfahrt 12:00' in li and not await pg.evaluate("document.querySelector('#tlist button')"), li)
            st, seen = await run_until(pg, tid, lambda s: s['st'] == 'drive', step=10)
            await pg.evaluate("window.__fz = LMO.world.gameNow(); LMO.world.gameNow = () => window.__fz")      # Spielzeit anhalten, damit der Transporter beim Zeigen und Klicken still steht
            await pg.wait_for_timeout(800)
            li = await pg.evaluate("document.querySelector('#tlist li.tour').textContent")
            ok('U37 Unterwegs: Status nennt den nächsten Stopp (Stopp 1 von 2)', 'Unterwegs' in li and 'unterwegs nach' in li and 'Stopp 1 von 2' in li, li)
            tpos = await pg.evaluate("a=>{const T=__lm.cen.tour.list(0).find(t=>t.id===a), p=__lm.cen.tour.pos(T); return {x:p.x,y:p.y}}", tid)
            xy = await map_xy(pg, tpos)
            await pg.mouse.move(xy[0] + 60, xy[1] + 60); await pg.mouse.move(xy[0], xy[1]); await pg.wait_for_timeout(300)
            tip = await txt(pg, '#tip')
            ok('U38 Zeigen auf den Transporter in der Karte: Nummer, Tour, Fahrer, Status', await vis(pg, '#tip') and 'Transporter %d' % vans[0] in tip and 'Mo 12:00' in tip and 'Fahrer %d' % drvs[0] in tip and 'unterwegs' in tip, tip)
            await pg.mouse.click(xy[0], xy[1]); await pg.wait_for_timeout(400)
            ok('U39 Klick auf den Transporter wählt die Tour in der Liste', await pg.evaluate("document.querySelector('#tlist li.tour').classList.contains('sel')"))
            await pg.screenshot(path=OUT + 'tpui_run.png')
            st, seen = await run_until(pg, tid, lambda s: s['st'] == 'door')
            await pg.wait_for_timeout(700)
            li = await pg.evaluate("document.querySelector('#tlist li.tour').textContent")
            ok('U40 Bei der Übergabe: Status "Übergabe bei …"', 'Übergabe bei' in li, li)
            st, seen = await run_until(pg, tid, lambda s: False)
            await pg.wait_for_timeout(700)
            ok('U41 Nach der Rückkehr verschwindet die Tour aus der Liste; Hinweis wieder da', await pg.evaluate("document.querySelectorAll('#tlist li').length") == 0 and '6:35' in await txt(pg, '#thint'))

            # ================= Mehrere Center =================
            n_c = await pg.evaluate("""()=>{const E=__lm.E; const n0=__lm.cen.centers().length; for(let i=0;i<E.N&&__lm.cen.centers().length===n0;i++){const d=Math.hypot(E.nx[i]-E.HUB.x,E.ny[i]-E.HUB.y); if(d>330&&d<600) __lm.cen.build(E.nx[i],E.ny[i]);} return __lm.cen.centers().length}""")
            await pg.evaluate("__lm.cen.setView('cen')"); await pg.wait_for_timeout(500)
            await pg.click('#tourNew'); await wait_vis(pg, '#planner')
            ok('U42 Bei mehreren Centern erscheint die Center-Auswahl im Planer', n_c == 2 and await vis(pg, '#plCen') and await pg.evaluate("document.getElementById('plCen').options.length") == 2)
            await pg.select_option('#plCen', '1'); await pg.wait_for_timeout(500)
            ok('U43 Center 2 hat noch keinen Transporter/Fahrer: Meldung, Speichern gesperrt; Liste leer', 'keinen Transporter' in await txt(pg, '#plErr') and await pg.evaluate("document.getElementById('plSave').disabled") and await pg.evaluate("document.querySelectorAll('#colist li.order').length") == 0, await txt(pg, '#plErr'))
            await pg.click('#plX')

            # ================= Esc und Handy =================
            await pg.evaluate("__lm.cen.setView('cen')"); await pg.click('#tourNew'); await wait_vis(pg, '#planner')
            await pg.evaluate("document.activeElement && document.activeElement.blur()")
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
            ok('U44 Esc schließt den Planer', not await vis(pg, '#planner') and await vis(pg, '#tourNew'))

            ctx2 = await newctx(b, (390, 800))
            await ctx2.route(re.compile(r'https://(overpass-api\.de|overpass\.private\.coffee|overpass\.kumi\.systems|maps\.mail\.ru)/.*'), overpass)
            pm, errs_m, started_m = await start_game(ctx2, 'Tim Handy', 'tourui2@example.de')
            ok('M0 Handy: Spiel startet', started_m)
            await pm.evaluate("Math.random = () => 0.5; __lm.cen.auto(false); __lm.drivers().forEach(d => { d.rest = 'on'; }); __lm.setCash(500000)")
            await pm.evaluate(POI_BUILD)
            await pm.evaluate("for (let i=0;i<2;i++) __lm.cen.buyVan(0); for (let i=0;i<2;i++) __lm.cen.hire(0); __lm.cen.setView('cen')")
            await setT(pm, 5.0, 3)
            MA = [await mk(pm, 0, False, 3, 10, 12, 2, i) for i in range(3)]
            await pm.click('#tabbar button[data-t=orders]'); await pm.wait_for_timeout(500)
            ok('M1 Handy: Tab "Aufträge" zeigt Tourenblock und "Tour planen"', await vis(pm, '#tourBlock') and await vis(pm, '#tourNew'))
            await pm.click('#tourNew'); await wait_vis(pm, '#planner')
            await pm.click('#plSug'); await pm.wait_for_timeout(700)
            n_st = len(await pm.evaluate(STOPS))
            ov = await pm.evaluate("({sw: document.documentElement.scrollWidth, iw: innerWidth, pr: document.getElementById('planner').getBoundingClientRect().right, pl: document.getElementById('planner').getBoundingClientRect().left})")
            ok('M2 Handy: Vorschlag füllt die Tour, der Planer läuft nicht über den Rand', n_st == 3 and ov['sw'] <= ov['iw'] + 1 and ov['pr'] <= ov['iw'] and ov['pl'] >= 0, str(ov))
            btn_ok = await pm.evaluate("[...document.querySelectorAll('#planner button')].filter(b=>b.offsetParent).every(b=>{const r=b.getBoundingClientRect(); return r.right<=innerWidth+1 && r.left>=-1})")
            ok('M3 Handy: alle Knöpfe des Planers liegen im Bild', btn_ok)
            await pm.screenshot(path=OUT + 'tpui_mobile.png')
            await pm.click('#plSave'); await pm.wait_for_timeout(500)
            await pm.click('#tabbar button[data-t=map]'); await pm.wait_for_timeout(500)
            ok('M4 Handy: Karte ist sichtbar, Tour gespeichert', await vis(pm, '#map') and await pm.evaluate("__lm.cen.tour.list(0).length") == 1)
            ok('M5 Handy: keine Skriptfehler', not errs_m, str(errs_m[:3]))

            ok('Z Keine Skriptfehler', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
