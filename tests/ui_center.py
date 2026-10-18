"""Fulfillment Center (Phase 14a): Bau, Ausbauten, Transporter, Fahrer, Firmen aus OSM, Bestellungen mit Zeitfenstern, Ansicht, Speicherstand.
Start: python3 tests/ui_center.py   (Ports 8397 / 9297; Kartenbild mit ?nobase abgeschaltet)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9297'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8397/index.html?debug&nobase'
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

    # Wie im echten Spiel: eine geladene Stadt reicht 1800 m weit (die eingebaute Demo-Karte nur 750 m)
    async def wide(route, request):
        body = open(REPO + '/index.html', encoding='utf-8').read().replace('"radius":750', '"radius":1800', 1)
        await route.fulfill(status=200, headers={'content-type': 'text/html; charset=utf-8'}, body=body)
    await ctx.route(re.compile(r'http://127\.0\.0\.1:8397/index\.html.*'), wide)
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



OUT = HERE + 'out/'; os.makedirs(OUT, exist_ok=True)
txt = lambda pg, sel: pg.evaluate("s=>document.querySelector(s)?document.querySelector(s).textContent:null", sel)
# Gefälschte Overpass-Antwort für die Firmenabfrage: gültige Firmen, Ausschlüsse, Duplikat, außerhalb der Karte
FAKE = {"elements": [
    {"type": "node", "id": 1, "lat": 51.4512, "lon": 7.0120, "tags": {"name": "Muster GmbH", "office": "company"}},
    {"type": "way", "id": 2, "center": {"lat": 51.4520, "lon": 7.0160}, "tags": {"name": "Schmidt Elektro", "craft": "electrician"}},
    {"type": "node", "id": 3, "lat": 51.4505, "lon": 7.0170, "tags": {"name": "Apotheke am Markt", "amenity": "pharmacy"}},
    {"type": "node", "id": 4, "lat": 51.4530, "lon": 7.0100, "tags": {"name": "Buchladen", "shop": "books"}},
    {"type": "node", "id": 5, "lat": 51.4515, "lon": 7.0135, "tags": {"name": "Bäckerei Korn", "shop": "bakery"}},
    {"type": "node", "id": 6, "lat": 51.4516, "lon": 7.0136, "tags": {"name": "Café X", "amenity": "cafe"}},
    {"type": "node", "id": 7, "lat": 51.4518, "lon": 7.0137, "tags": {"office": "company"}},
    {"type": "node", "id": 8, "lat": 52.5000, "lon": 7.0140, "tags": {"name": "Weit weg GmbH", "office": "company"}},
    {"type": "node", "id": 9, "lat": 51.4512, "lon": 7.0120, "tags": {"name": "Muster GmbH", "office": "company"}},
    {"type": "node", "id": 10, "lat": 51.4498, "lon": 7.0152, "tags": {"name": "Sparkasse", "amenity": "bank"}},
    {"type": "way", "id": 11, "center": {"lat": 51.4535, "lon": 7.0190}, "tags": {"name": "Lager Nord", "building": "warehouse"}},
    {"type": "node", "id": 12, "lat": 51.4500, "lon": 7.0105, "tags": {"name": "Coworking Hub", "amenity": "coworking_space"}},
]}
EXPECT_FIRMS = {'Muster GmbH', 'Schmidt Elektro', 'Apotheke am Markt', 'Buchladen', 'Sparkasse', 'Lager Nord', 'Coworking Hub'}
POI_BUILD = """()=>{const E=__lm.E; const c=__lm.cen.centers().length; __lm.setCash(Math.max(__lm.cash(), 200000)); __lm.cen.build(E.HUB.x, E.HUB.y); return __lm.cen.centers().length-c}"""
ROWS = """(sel)=>[...document.querySelectorAll(sel+' .upg')].map(r=>{const q=s=>r.querySelector(s), bar=q('.lvbar');
  return {name:q('strong').textContent, label:q('.u-lv').textContent, fill:bar?bar.querySelectorAll('i.on').length:-1, total:bar?bar.querySelectorAll('i').length:-1, max:bar?bar.classList.contains('max'):false,
    now:q('.u-now')?q('.u-now').textContent:'', nxt:q('.u-next')&&!q('.u-next').hidden?q('.u-next').textContent:'', btn:q('button').textContent, disabled:q('button').disabled}})"""
TABS = "()=>[...document.querySelectorAll('#hqTabs button')].map(b=>b.textContent+(b.getAttribute('aria-selected')==='true'?'*':''))"
by = lambda rows, name: next((r for r in rows if r['name'].startswith(name)), None)
# Prüfung der Fensterregeln für eine Bestellung o (Erzeugungszeit: Tag cd, Stunde ch)
RULES = """(a)=>{const o=a.o, cd=a.cd, ch=a.ch, DEP=[6+35/60,9+35/60,12,14+35/60,17], cut=k=>DEP[k]-1.5, bad=[];
  const len=o.wh[1]-o.wh[0], wd=o.day%7;
  if (len!==2&&len!==4) bad.push('Länge '+len);
  if (o.wh[0]<7||o.wh[1]>22||!Number.isInteger(o.wh[0])||!Number.isInteger(o.wh[1])) bad.push('Grenzen');
  if (wd===2) bad.push('Sonntag');
  if (o.firm&&(wd===1||wd===2)) bad.push('Firma am Wochenende');
  if (o.day<cd) bad.push('Vergangenheit');
  if (o.day===cd){ let ok=false; for(let k=0;k<5;k++) if (cut(k)>=ch-1e-9 && o.wh[1]>=DEP[k]+0.5-1e-9) ok=true; if(!ok) bad.push('heute nicht erreichbar'); }
  const START=__lm.cen.absT()-__lm.sim();
  if (Math.abs(o.ws-(o.day*86400+o.wh[0]*3600-START))>1e-6||Math.abs(o.we-(o.day*86400+o.wh[1]*3600-START))>1e-6) bad.push('Sekunden');
  return bad}"""


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9297'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8397', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            ovp = {'n': 0, 'bodies': [], 'fail': False}

            async def overpass(route, request):
                ovp['n'] += 1; ovp['bodies'].append(request.post_data or '')
                if ovp['fail']: return await route.abort()
                await route.fulfill(status=200, headers={'content-type': 'application/json', 'access-control-allow-origin': '*'}, body=json.dumps(FAKE))
            await ctx.route(re.compile(r'https://(overpass-api\.de|overpass\.kumi\.systems|maps\.mail\.ru)/.*'), overpass)
            pg, errs, started = await start_game(ctx, 'Tim Center', 'ce@example.de')
            ok('A0 Spiel startet', started)
            ok('A1 Ohne Center: keine Ansicht-Umschaltung, Lieferdienst-Ansicht', await pg.evaluate("document.getElementById('viewSeg').hidden") and await vis(pg, '#hqOrders') and not await vis(pg, '#cenOrders') and not await vis(pg, '#cenSide'))
            ok('A2 Ohne Center: keine Firmenabfrage', ovp['n'] == 0)

            # ================= B: Bau =================
            await pg.click('#dlist .hubup'); await wait_vis(pg, '#win')
            tabs = await pg.evaluate(TABS)
            ok('B1 Reiter ohne Center: Hub 1, Spiel, Partner', tabs == ['Hub 1*', 'Spiel', 'Partner'], str(tabs))
            await pg.click('#hqTabs button >> text=Spiel'); await pg.wait_for_timeout(250)
            ok('B2 Spiel-Reiter zeigt den Bau eines Fulfillment Centers für 5.000 €', await vis(pg, '#cenBuild') and await txt(pg, '#cbBtn') == '5.000,00 €' and '0 gebaut' in await txt(pg, '#cbLv'), await txt(pg, '#cbBtn'))
            ok('B3 Zu wenig Geld: Knopf gesperrt', await pg.evaluate("document.getElementById('cbBtn').disabled"))
            await pg.evaluate("__lm.setCash(30000)"); await pg.wait_for_timeout(500)
            ok('B4 Mit 30.000 €: Knopf frei', not await pg.evaluate("document.getElementById('cbBtn').disabled"))
            ok('B5 "Hubs"-Zeile zählt keine Center (1 von 3)', 'Hubs' in await pg.evaluate("document.querySelector('#glist').textContent") and '1 von 3 Hubs' in await pg.evaluate("document.querySelector('#glist').textContent"))
            await pg.click('#cbBtn'); await pg.wait_for_timeout(300)
            ok('B6 Klick: Platzieren beginnt, Hinweis nennt das Center, Fenster zu', await pg.evaluate("__lm.cen.view()") == 'cen' and 'Fulfillment Center' in await txt(pg, '#placeBan') and await vis(pg, '#placeBan') and not await vis(pg, '#win'), await txt(pg, '#placeBan'))
            ok('B7 Beim Platzieren des ersten Centers zeigt die Karte die Center-Ansicht', await pg.evaluate("__lm.cen.view()") == 'cen')
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
            c1 = await pg.evaluate("__lm.cash()")
            ok('B8 Esc bricht ab: kein Center, nichts bezahlt, wieder Lieferdienst-Ansicht', await pg.evaluate("__lm.cen.centers().length") == 0 and c1 > 29900 and await pg.evaluate("__lm.cen.view()") == 'hq' and not await vis(pg, '#placeBan'), str(c1))
            # außerhalb der Karte und abseits der Straßen
            await pg.evaluate("__lm.cen.startPlacing('cen')")
            await pg.evaluate("__lm.cen.build(5000, 5000)"); await pg.wait_for_timeout(100)
            ok('B9 Außerhalb der Karte: Hinweis, kein Bau', await pg.evaluate("__lm.cen.centers().length") == 0 and ('Straße' in await txt(pg, '#placeBan') or 'außerhalb' in await txt(pg, '#placeBan')), await txt(pg, '#placeBan'))
            # Bau per Klick auf die Karte
            await pg.evaluate("__lm.view.fit()"); await pg.wait_for_timeout(400)
            pos = await pg.evaluate("""()=>{const E=__lm.E; let best=-1,bd=1e18; for(let i=0;i<E.N;i++){const d=Math.hypot(E.nx[i]-E.HUB.x,E.ny[i]-E.HUB.y); if(d<bd){bd=d;best=i}} const p=__lm.view.px(best), r=document.getElementById('map').getBoundingClientRect(); return {x:r.left+p[0], y:r.top+p[1], nx:E.nx[best], ny:E.ny[best]}}""")
            await pg.mouse.move(pos['x'], pos['y']); await pg.wait_for_timeout(150)
            await pg.mouse.click(pos['x'], pos['y']); await pg.wait_for_timeout(500)
            c2 = await pg.evaluate("__lm.cash()")
            ok('B10 Klick auf eine Straße baut das Center für 5.000 €', await pg.evaluate("__lm.cen.centers().length") == 1 and abs(c1 - 5000 - c2) < 8, '%s -> %s' % (c1, c2))
            ok('B11 Nach dem Bau: Ansicht Fulfillment, Umschalter sichtbar, Hinweis weg', await pg.evaluate("__lm.cen.view()") == 'cen' and not await pg.evaluate("document.getElementById('viewSeg').hidden") and not await vis(pg, '#placeBan'))
            ok('B12 Bau zählt nicht zu den Hubs: weiterhin 1 Hub', await pg.evaluate("__lm.hubs().length") == 1)
            ok('B13 Kosten stehen im Protokoll und in den Ausgaben', 'Neues Fulfillment Center 1' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')"))
            ok('B14 Zweites Center direkt daneben wird abgelehnt (Mindestabstand 250 m)', await pg.evaluate("(()=>{const E=__lm.E; __lm.cen.startPlacing('cen'); __lm.cen.build(__lm.cen.centers()[0].x+60, __lm.cen.centers()[0].y); return __lm.cen.centers().length})()") == 1 and 'Zu nah' in await txt(pg, '#placeBan'))
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
            ok('B15 Eine Firmenabfrage an Overpass wurde gesendet', ovp['n'] == 1 and 'office' in ovp['bodies'][0] and 'craft' in ovp['bodies'][0] and 'pharmacy' in ovp['bodies'][0], str(ovp['n']))
            await pg.wait_for_timeout(500)
            fs = await pg.evaluate("({st:__lm.cen.firmState(), names:__lm.cen.firms().map(f=>f.name).sort(), kinds:Object.fromEntries(__lm.cen.firms().map(f=>[f.name,f.kind]))})")
            ok('B16 Firmen geladen: nur echte Firmen mit Namen (7), ohne Bäckerei, Café, Namenlose, außerhalb, Duplikate', fs['st'] == 'ok' and set(fs['names']) == EXPECT_FIRMS and len(fs['names']) == 7, str(fs))
            ok('B17 Arten: Büro 0, Betrieb 1, Geschäft 2, Praxis 3, Bank 4', fs['kinds'].get('Muster GmbH') == 0 and fs['kinds'].get('Schmidt Elektro') == 1 and fs['kinds'].get('Lager Nord') == 1 and fs['kinds'].get('Buchladen') == 2 and fs['kinds'].get('Apotheke am Markt') == 3 and fs['kinds'].get('Sparkasse') == 4 and fs['kinds'].get('Coworking Hub') == 0, str(fs['kinds']))
            await pg.screenshot(path=OUT + 'cen_built.png')

            # ================= C: Ausbauten des Centers =================
            await pg.evaluate("__lm.setCash(200000)")
            await pg.click('#cashBtn'); await pg.wait_for_timeout(200); await pg.keyboard.press('Escape')
            await pg.evaluate("""()=>{const t=document.querySelector('#cenOrders'); }""")
            await pg.evaluate("window.scrollTo(0,0)")
            await pg.click('#dlist .hubup') if await vis(pg, '#dlist .hubup') else await pg.evaluate("document.querySelector('#clist .hubup').click()")
            await wait_vis(pg, '#win'); await pg.wait_for_timeout(300)
            tabs = await pg.evaluate(TABS)
            ok('C1 Reiter: Hub 1, Center 1 (gewählt), Spiel, Partner', tabs == ['Hub 1', 'Center 1*', 'Spiel', 'Partner'], str(tabs))
            rows = await pg.evaluate(ROWS, '#tab-ce')
            ok('C2 Fünf Verbesserungen des Centers (das Liefergebiet ersetzen die Städte)', [r['name'] for r in rows] == ['Stellplätze', 'Stopps je Transporter', 'Navigation', 'Wartungsvertrag', 'Schnellbeladung'], str([r['name'] for r in rows]))
            sl, st = by(rows, 'Stellplätze'), by(rows, 'Stopps')
            ok('C3 Stellplätze: 9 Segmente (4 bis 20), Stufe 1, 4 Plätze und 6 Fahrer', (sl['total'], sl['fill'], sl['label']) == (9, 1, 'Stufe 1 von 9') and '4 Stellplätze' in sl['now'] and 'bis zu 6 Fahrer' in sl['now'], str(sl))
            ok('C4 Stopps: 11 Segmente (10 bis 30), Stufe 1, bis zu 10 Stopps', (st['total'], st['fill'], st['label']) == (11, 1, 'Stufe 1 von 11') and 'bis zu 10 Stopps' in st['now'], str(st))
            cit = await pg.evaluate("({n: document.getElementById('ceCitN').textContent, li: [...document.querySelectorAll('#ceCitList li')].map(e => e.textContent), btn: document.getElementById('ceCitAdd').textContent, dis: document.getElementById('ceCitAdd').disabled})")
            ok('C5 Städte-Block: 1 von 6, die Stadt der Karte mit Nachfrage, Knopf zum Hinzufügen (3.000 €)', cit['n'] == '1 von 6' and len(cit['li']) == 1 and 'Essen' in cit['li'][0] and 'Bestellungen/Tag' in cit['li'][0] and '3.000,00' in cit['btn'] and not cit['dis'], str(cit))
            ok('C6 Kosten am Knopf: 800 € und 300 €', (sl['btn'], st['btn']) == ('800,00 €', '300,00 €'), '%s %s' % (sl['btn'], st['btn']))
            ok('C7 Kopf nennt Plätze, Fahrer, Gebiet', '0 von 4 Stellplätzen' in await txt(pg, '#ceInfo') and '0 von 6 Fahrern' in await txt(pg, '#ceInfo') and 'Essen' in await txt(pg, '#ceInfo'), await txt(pg, '#ceInfo'))
            ok('C7b Ein Center hat Städte statt eines Radius; der Hub behält sein Liefergebiet (600 m)', await pg.evaluate("[__lm.cen.centers()[0].cities.map(r => r.id).join(), __lm.fx.zr(__lm.hubs()[0]), __lm.cen.centers()[0].up.zone === undefined].join('|')") == 'demo|600|true')
            c0 = await pg.evaluate("__lm.cash()"); v0 = await pg.evaluate("__lm.value()")
            for k in range(8): await pg.evaluate("__lm.cen.upg('slots', 0)")
            await pg.wait_for_timeout(500)
            sl = by(await pg.evaluate(ROWS, '#tab-ce'), 'Stellplätze')
            ok('C8 Acht Ausbauten: 20 Stellplätze, Max., Knopf "Fertig"', (sl['fill'], sl['max'], sl['btn'], sl['label']) == (9, True, 'Fertig', 'Stufe 9 von 9 · Max.') and await pg.evaluate("[__lm.cen.cSlots(__lm.cen.centers()[0]), __lm.cen.cPool(__lm.cen.centers()[0])]") == [20, 22], str(sl))
            ok('C9 Kosten 800+1100+1500+2000+2600+3300+4100+5000 = 20.400 €', abs(c0 - 20400 - await pg.evaluate("__lm.cash()")) < 8, str(c0 - await pg.evaluate("__lm.cash()")))
            c0 = await pg.evaluate("__lm.cash()")
            for k in range(10): await pg.evaluate("__lm.cen.upg('stops', 0)")
            await pg.wait_for_timeout(400)
            st = by(await pg.evaluate(ROWS, '#tab-ce'), 'Stopps')
            ok('C10 Zehn Ausbauten: 30 Stopps, Max.', (st['fill'], st['max']) == (11, True) and await pg.evaluate("__lm.cen.cStops(__lm.cen.centers()[0])") == 30, str(st))
            ok('C11 Kosten 300 bis 1200 in 100er-Schritten = 7.500 €', abs(c0 - 7500 - await pg.evaluate("__lm.cash()")) < 8, str(c0 - await pg.evaluate("__lm.cash()")))
            await pg.click('#ceCitAdd'); await pg.wait_for_timeout(300)
            ok('C11b In der Demo-Karte gibt es keine weitere Stadt (Hinweis im Fenster)', 'Demo-Karte' in await txt(pg, '#dlg') and await vis(pg, '#dlg'), await txt(pg, '#dlg'))
            await pg.keyboard.press('Escape'); await pg.evaluate("document.getElementById('dlgX').click()")
            await pg.evaluate("""()=>{ for (const id of ['nav','nav','nav','service','quick']) __lm.cen.upg(id, 0); }""")
            ok('C12 Alle Ausbauten gekauft, nichts davon im ersten Hub', await pg.evaluate("JSON.stringify(Object.keys(__lm.hubs()[0].up).sort())") == '[]' and await pg.evaluate("Object.keys(__lm.cen.centers()[0].up).sort().join()") == 'nav,quick,service,slots,stops', await pg.evaluate("Object.keys(__lm.cen.centers()[0].up).sort().join()"))
            await pg.screenshot(path=OUT + 'cen_upg.png')
            # Zurücksetzen für die weiteren Tests: neues Center zum Vergleich daneben
            ok('C13 Unternehmenswert zählt Bau, Ausbauten (Kasse sinkt, Wert bleibt)', abs(await pg.evaluate("__lm.value()") - v0) < 8, '%s %s' % (v0, await pg.evaluate("__lm.value()")))
            await pg.keyboard.press('Escape')

            # ================= D: Transporter und Fahrer (Center 2: Grundausbau) =================
            r = await pg.evaluate("""()=>{const E=__lm.E; const n0=__lm.cen.centers().length; for(let i=0;i<E.N&&__lm.cen.centers().length===n0;i++){const d=Math.hypot(E.nx[i]-E.HUB.x,E.ny[i]-E.HUB.y); if(d>330&&d<600) __lm.cen.build(E.nx[i],E.ny[i]);} return __lm.cen.centers().length}""")
            ok('D0 Zweites Center gebaut (Center 1 bleibt voll ausgebaut)', r == 2 and await pg.evaluate("__lm.cen.cSlots(__lm.cen.centers()[1])") == 4 and await pg.evaluate("__lm.cen.cSlots(__lm.cen.centers()[0])") == 20)
            await pg.wait_for_timeout(500)
            ok('D1 Rechte Spalte: zwei Center-Gruppen, Kopf "x / Stellplätze"', await pg.evaluate("[...document.querySelectorAll('#clist .cbox .hubhead')].map(h=>h.querySelector('.hname').textContent+' '+h.querySelector('.hcount').textContent).join('|')") == 'Center 1Fulfillment 0 / 20|Center 2Fulfillment 0 / 4', await pg.evaluate("[...document.querySelectorAll('#clist .cbox .hubhead')].map(h=>h.querySelector('.hname').textContent+' '+h.querySelector('.hcount').textContent).join('|')"))
            B2 = "#clist .cbox:nth-child(2)"
            c0 = await pg.evaluate("__lm.cash()")
            await pg.click(B2 + " button[data-act=buyVan]"); await pg.wait_for_timeout(300)
            ok('D2 Knopf "Transporter kaufen" kauft einen für 600 €', await pg.evaluate("__lm.cen.centers()[1].vans.length") == 1 and abs(c0 - 600 - await pg.evaluate("__lm.cash()")) < 8)
            for k in range(3): await pg.evaluate("__lm.cen.buyVan(1)")
            ok('D3 4 Stellplätze: der fünfte Transporter wird abgelehnt', await pg.evaluate("__lm.cen.buyVan(1)") is False and await pg.evaluate("__lm.cen.centers()[1].vans.length") == 4)
            await pg.wait_for_timeout(400)
            ok('D4 Knopf zeigt "Alle Stellplätze belegt" und ist gesperrt', await txt(pg, B2 + " button[data-act=buyVan]") == 'Alle Stellplätze belegt' and await pg.evaluate("document.querySelector(%r).disabled" % (B2 + " button[data-act=buyVan]")))
            ok('D5 Transporter-Liste: vier Einträge "frei im Center"', await pg.evaluate("[...document.querySelectorAll(%r)].map(l=>l.textContent).join('|')" % (B2 + " .van small")) == 'frei im Center|frei im Center|frei im Center|frei im Center')
            c0 = await pg.evaluate("__lm.cash()")
            await pg.click(B2 + " .van button >> nth=0"); await pg.wait_for_timeout(300)
            ok('D6 Verkaufen bringt 300 € (50 %) und gibt einen Stellplatz frei', await pg.evaluate("__lm.cen.centers()[1].vans.length") == 3 and abs(await pg.evaluate("__lm.cash()") - c0 - 300) < 8)
            await pg.evaluate("__lm.cen.buyVan(1)")
            # Fahrer
            hq_ids = await pg.evaluate("__lm.drivers().map(d=>d.id)")
            c0 = await pg.evaluate("__lm.cash()")
            await pg.click(B2 + " button[data-act=hire]"); await pg.wait_for_timeout(300)
            ok('D7 Fahrer einstellen kostet 40 €', await pg.evaluate("__lm.cen.centers()[1].drv.length") == 1 and abs(c0 - 40 - await pg.evaluate("__lm.cash()")) < 8)
            for k in range(5): await pg.evaluate("__lm.cen.hire(1)")
            ok('D8 Fahrerpool = Stellplätze + 2 = 6; der siebte wird abgelehnt', await pg.evaluate("__lm.cen.centers()[1].drv.length") == 6 and await pg.evaluate("__lm.cen.hire(1)") is None and await pg.evaluate("__lm.cen.cPool(__lm.cen.centers()[1])") == 6)
            await pg.wait_for_timeout(400)
            ok('D9 Knopf zeigt "Fahrerpool voll"', await txt(pg, B2 + " button[data-act=hire]") == 'Fahrerpool voll')
            ids = await pg.evaluate("__lm.cen.centers()[1].drv.map(d=>d.id)")
            ok('D10 Fahrernummern sind eindeutig und mit denen der Hubs nicht doppelt', len(set(ids)) == 6 and not (set(ids) & set(hq_ids)), str(ids) + str(hq_ids))
            ok('D11 Fahrer ohne Transporter-Bindung: Liste zeigt Stufe und Zustand "Frei"', await pg.evaluate("[...document.querySelectorAll(%r)].every(l=>/Stufe 1/.test(l.textContent)&&/Frei/.test(l.textContent))" % (B2 + " .cdr")))
            # Kündigen mit Rückfrage
            fid = ids[5]
            await pg.click(B2 + " .cdr:nth-child(6) button[data-act=fire]"); await pg.wait_for_timeout(200)
            ok('D12 Kündigen fragt nach (erster Klick kündigt nicht)', await pg.evaluate("__lm.cen.centers()[1].drv.length") == 6 and 'Wirklich' in await txt(pg, B2 + " .cdr:nth-child(6) button[data-act=fire]"))
            await pg.click(B2 + " .cdr:nth-child(6) button[data-act=fire]"); await pg.wait_for_timeout(300)
            ok('D13 Zweiter Klick kündigt', await pg.evaluate("__lm.cen.centers()[1].drv.length") == 5 and fid not in await pg.evaluate("__lm.cen.centers()[1].drv.map(d=>d.id)"))
            nd = await pg.evaluate("__lm.cen.hire(1).id")
            ok('D14 Nummern werden nie neu vergeben', nd > max(ids), '%s %s' % (nd, max(ids)))
            await pg.select_option('#hireVeh', 'bike') if await vis(pg, '#hireVeh') else None
            await pg.evaluate("__lm.cen.setView('hq')"); await pg.wait_for_timeout(300)
            await pg.click('#hireBtn'); await pg.wait_for_timeout(300)
            hd = await pg.evaluate("__lm.drivers().map(d=>d.id)")
            ok('D15 Neuer Hub-Fahrer bekommt eine Nummer über allen Center-Fahrern', max(hd) > nd and len(hd) == len(hq_ids) + 1, str(hd))
            await pg.evaluate("__lm.cen.setView('cen')"); await pg.wait_for_timeout(300)
            # Schulung
            did = await pg.evaluate("__lm.cen.centers()[1].drv[0].id")
            c0 = await pg.evaluate("__lm.cash()")
            await pg.click(B2 + " .cdr:nth-child(1) button[data-act=train]"); await pg.wait_for_timeout(300)
            ok('D16 Schulung kostet 80 € und der Fahrer ist "In Schulung"', 'In Schulung' in await txt(pg, B2 + " .cdr:nth-child(1) .pill") and abs(c0 - 80 - await pg.evaluate("__lm.cash()")) < 8)
            ok('D17 Während der Schulung: kein Kündigen, keine zweite Schulung', await pg.evaluate("document.querySelector(%r).disabled && document.querySelector(%r).disabled" % (B2 + " .cdr:nth-child(1) button[data-act=fire]", B2 + " .cdr:nth-child(1) button[data-act=train]")))
            await pg.evaluate("__lm.cen.tick(600)"); await pg.wait_for_timeout(300)
            ok('D18 Nach 10 von 20 Minuten läuft sie noch', await pg.evaluate("__lm.cen.centers()[1].drv[0].lvl") == 1 and 'noch' in await txt(pg, B2 + " .cdr:nth-child(1) .d-line"), await txt(pg, B2 + " .cdr:nth-child(1) .d-line"))
            await pg.evaluate("__lm.cen.tick(700)"); await pg.wait_for_timeout(300)
            ok('D19 Danach Stufe 2, wieder frei', await pg.evaluate("__lm.cen.centers()[1].drv[0].lvl") == 2 and 'Stufe 2' in await txt(pg, B2 + " .cdr:nth-child(1) .d-veh"))
            # Krankheit
            await pg.evaluate("__lm.cen.centers()[1].drv[1].sick = {left: 100}"); await pg.evaluate("__lm.cen.tick(1)"); await pg.wait_for_timeout(300)
            ok('D20 Kranker Fahrer: Anzeige "Krank", keine Schulung möglich', 'Krank' in await txt(pg, B2 + " .cdr:nth-child(2) .pill") and await pg.evaluate("document.querySelector(%r).disabled" % (B2 + " .cdr:nth-child(2) button[data-act=train]")))
            await pg.evaluate("__lm.cen.tick(120)"); await pg.wait_for_timeout(300)
            ok('D21 Nach der Krankheitszeit wieder gesund', await pg.evaluate("__lm.cen.centers()[1].drv[1].sick") is None and 'Frei' in await txt(pg, B2 + " .cdr:nth-child(2) .pill"))
            ok('D22 Center 1 ist unberührt (keine Transporter, keine Fahrer)', await pg.evaluate("__lm.cen.centers()[0].vans.length + __lm.cen.centers()[0].drv.length") == 0)
            await pg.screenshot(path=OUT + 'cen_side.png')

            # ================= E: Bestellungen =================
            await pg.evaluate("__lm.cen.orders().length = 0")
            for k in range(200): await pg.evaluate("__lm.cen.tick(6)") if k < 3 else None
            ok('E1 Center ohne Transporter und Fahrer bekommt keine Bestellungen', await pg.evaluate("__lm.cen.orders().filter(o=>o.c===0).length") == 0)
            run = lambda vans: """()=>{ const o=__lm.cen.orders(); o.length=0; let hrs=[]; for (let h=0; h<24; h++){ __lm.world.setHour(h, 3); const n0=o.length; for(let i=0;i<600;i++) __lm.cen.tick(6); hrs.push(o.length-n0);} const r={all:hrs.reduce((a,b)=>a+b,0), night:hrs.slice(0,6).reduce((a,b)=>a+b,0), day:hrs.slice(9,21).reduce((a,b)=>a+b,0), cs:[...new Set(o.map(x=>x.c))]}; o.length=0; return r}"""
            r4 = await pg.evaluate(run(4))
            ok('E2 24 Stunden mit 4 Transportern: etwa 14 × 4 × 1,01 ≈ 57 Bestellungen', 30 <= r4['all'] <= 90, str(r4))
            ok('E3 Nur das Center mit Transportern und Fahrern bekommt welche', r4['cs'] == [1], str(r4))
            ok('E4 Tagsüber (9–21 Uhr) deutlich mehr als nachts (0–6 Uhr)', r4['day'] > 2 * r4['night'], str(r4))
            await pg.evaluate("[0,1,2].forEach(()=>__lm.cen.sellVan(1, __lm.cen.centers()[1].vans[0].id))")
            r1 = await pg.evaluate(run(1))
            ok('E5 Mit einem Transporter nur ein Viertel (etwa 14)', 4 <= r1['all'] <= 32 and r4['all'] > 2 * r1['all'], '%s vs %s' % (r1['all'], r4['all']))
            await pg.evaluate("__lm.cen.buyVan(1); __lm.cen.buyVan(1); __lm.cen.buyVan(1)")
            # Regeln für Fenster und Kunden
            res = await pg.evaluate("""(RULES)=>{ const rules=eval(RULES), bad=[], out=[]; const o=__lm.cen.orders(); o.length=0;
              for (let di=0; di<7; di++) for (const h of [1,5,6,8,10,11,13,14,16,20,23]) { __lm.world.setHour(h, di);
                for (let k=0;k<4;k++) for (const want of ['private','firm']) { const x=__lm.cen.spawn(1, want); if(!x) {bad.push('kein Auftrag '+want); continue}
                  const b=rules({o:x, cd:Math.floor(__lm.cen.absT()/86400), ch:(__lm.cen.absT()/3600)%24}); if (b.length) bad.push(di+'/'+h+': '+b.join(',')); out.push({firm:x.firm, len:x.wh[1]-x.wh[0], today:x.day===Math.floor(__lm.cen.absT()/86400)}); } }
              return {bad:bad.slice(0,8), nbad:bad.length, n:out.length, l2:out.filter(x=>x.len===2).length, today:out.filter(x=>x.today).length}}""", RULES)
            ok('E6 Alle %d Bestellungen halten die Regeln (2/4 h, 7–22 Uhr, nie So, Firmen nur Mo–Fr, heute nur erreichbar)' % res['n'], res['nbad'] == 0 and res['n'] > 400, str(res))
            ok('E7 2-Stunden- und 4-Stunden-Fenster kommen beide vor', 0.3 < res['l2'] / res['n'] < 0.7, str(res))
            ok('E8 Es gibt Bestellungen für heute und für spätere Tage', 0.05 < res['today'] / res['n'] < 0.95, str(res))
            chk = await pg.evaluate("""(FIRMS)=>{ const c=__lm.cen.centers()[1], r=1800+80+150, o=__lm.cen.orders(), bad=[]; const F=new Set(FIRMS);
              for (const x of o) { const d=Math.hypot(x.x-c.x, x.y-c.y); if (Math.hypot(x.x, x.y)>r||d<119) bad.push('Abstand '+Math.round(d)+' bei '+Math.round(x.x)+'/'+Math.round(x.y)+(x.firm?' Firma '+x.name:' privat')); if (x.firm&&!F.has(x.name)) bad.push('Firma '+x.name); if(!x.firm&&x.name!=='') bad.push('Privat mit Namen');
                if (x.firm&&(x.n<2||x.n>12)) bad.push('Menge Firma '+x.n); if(!x.firm&&(x.n<1||x.n>4)) bad.push('Menge Privat '+x.n);
                const exp=Math.round(LMC.pay(x.n,x.firm)*1.1*10)/10; if (Math.abs(x.pay-exp)>1e-9) bad.push('Lohn '+x.pay+' '+exp); if (!Number.isInteger(x.node)||x.node<0) bad.push('Knoten'); }
              return {bad:bad.slice(0,6), nbad:bad.length, firms:o.filter(x=>x.firm).length, priv:o.filter(x=>!x.firm).length, avgF:o.filter(x=>x.firm).reduce((a,x)=>a+x.pay,0)/Math.max(1,o.filter(x=>x.firm).length), avgP:o.filter(x=>!x.firm).reduce((a,x)=>a+x.pay,0)/Math.max(1,o.filter(x=>!x.firm).length)}}""", sorted(EXPECT_FIRMS))
            ok('E9 Kunden liegen in der Stadt der Karte (mindestens 120 m vom Center), Firmen sind echte Firmen, Menge und Lohn stimmen', chk['nbad'] == 0, str(chk))
            ok('E10 Firmen zahlen im Schnitt mehr als Privatkunden', chk['avgF'] > 1.5 * chk['avgP'], '%.1f vs %.1f' % (chk['avgF'], chk['avgP']))
            ok('E11 Hub-Bestellungen bleiben getrennt (keine Center-Bestellung im HQ-System)', await pg.evaluate("__lm.orders()") < 20 and await pg.evaluate("document.querySelectorAll('#olist li').length") == await pg.evaluate("__lm.orders()"))
            # Verfall
            await pg.evaluate("__lm.cen.orders().length = 0; __lm.world.setHour(12, 3)")
            e = await pg.evaluate("""()=>{ const a=__lm.cen.spawn(1,'private'), b=__lm.cen.spawn(1,'private'); const t=__lm.sim();
              a.ws=t-5*3600; a.we=t-3*3600; b.ws=t-3*3600; b.we=t-3600; const cen=__lm.cen.centers()[1], rep0=cen.rep, cash0=__lm.cash(), ex0=__lm.cen.stats.expired;
              __lm.cen.expire(); const o=__lm.cen.orders(); return {left:o.map(x=>x.id), a:a.id, b:b.id, rep0, rep1:cen.rep, ex:__lm.cen.stats.expired-ex0, dc:__lm.cash()-cash0, log:[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')} }""")
            ok('E12 2 h nach Fensterende verfällt die Bestellung, 1 h danach noch nicht', e['left'] == [e['b']] and e['ex'] == 1, str(e)[:200])
            ok('E13 Verfall: eigener Ruf des Centers sinkt, Kasse unberührt, Protokoll nennt es', e['rep1'] < e['rep0'] and abs(e['dc']) < 8 and 'verfallen' in e['log'] and 'Center 2' in e['log'], str(e)[:200])
            ok('E14 Ruf von Center 1 und das globale Ruf-System bleiben unverändert', await pg.evaluate("__lm.cen.centers()[0].rep") == 3)
            # Abwesenheit
            await pg.evaluate("__lm.absence(0)")                        # Uhr wieder an die echte Weltzeit hängen (die Tests davor setzen eine falsche Uhrzeit)
            ab = await pg.evaluate("""()=>{ const o=__lm.cen.orders(); o.length=0; __lm.cen.centers()[1].drv[0].sick={left:500}; __lm.cen.spawn(1); __lm.cen.spawn(1);
              const x=__lm.cen.spawn(1); x.wh=[8,10]; x.day=Math.floor(__lm.cen.absT()/86400)-1; x.ws=__lm.cen.simOf(x.day,8); x.we=__lm.cen.simOf(x.day,10);
              const rep0=__lm.cen.centers()[1].rep, ex0=__lm.cen.stats.expired, oid=x.id; __lm.absence(60);
              const o2=__lm.cen.orders(); return {n:o2.length, fit:o2.map(q=>Math.abs(q.ws-__lm.cen.simOf(q.day,q.wh[0]))<1e-6&&Math.abs(q.we-__lm.cen.simOf(q.day,q.wh[1]))<1e-6), gone:!o2.some(q=>q.id===oid), rep:__lm.cen.centers()[1].rep-rep0, ex:__lm.cen.stats.expired-ex0} }""")
            ok('E15 Kurze Abwesenheit (1 Minute): Bestellungen bleiben, Fenster bleiben an ihrer Uhrzeit', ab['n'] == 2 and all(ab['fit']), str(ab))
            ok('E15b Was in der Abwesenheit verfallen wäre, entfällt ohne Abzug (Ruf und Verfälle unverändert)', ab['gone'] and ab['rep'] == 0 and ab['ex'] == 0, str(ab))
            rep0 = await pg.evaluate("__lm.cen.centers()[1].rep")
            await pg.evaluate("__lm.absence(300)")
            ok('E16 Längere Abwesenheit: offene Center-Bestellungen entfallen ohne Abzug, Kranke sind gesund', await pg.evaluate("__lm.cen.orders().length") == 0 and await pg.evaluate("__lm.cen.centers()[1].rep") == rep0 and await pg.evaluate("__lm.cen.centers()[1].drv.every(d=>!d.sick)"))
            ok('E17 Ruf wurde auch durch die Abwesenheit nicht verändert, keine Verfälle', await pg.evaluate("__lm.cen.stats.expired") == 1)
            await pg.evaluate("__lm.cen.setView('cen'); __lm.world.setHour(10, 3)")
            ok('Z2 Keine Skriptfehler bis hier', not errs, str(errs[:3]))

            # ================= F: Ansicht, Liste und Karte =================
            await pg.evaluate("__lm.world.setHour(10, 3); __lm.cen.auto(false)")
            mk = await pg.evaluate("""()=>{ const o=__lm.cen.orders(); o.length=0; const t=Math.floor(__lm.cen.absT()/86400), S=__lm.cen.simOf;
              const mk=(c,day,a,b,want)=>{const x=__lm.cen.spawn(c,want); x.day=day; x.wh=[a,b]; x.ws=S(day,a); x.we=S(day,b); return x.id};
              return {t, A:mk(1,t,14,16,'private'), B:mk(1,t,9,11,'firm'), C:mk(0,t+1,7,9,'private'), D:mk(1,t+1,10,14,'firm'), E:mk(1,t+3,8,10,'private')}}""")
            await pg.evaluate("__lm.cen.setView('cen')"); await pg.wait_for_timeout(500)
            ok('F1 Center-Ansicht: Umschalter zeigt "Fulfillment" gedrückt, Center-Liste sichtbar, Lieferdienst-Liste weg', await pg.evaluate("[...document.querySelectorAll('#viewSeg button')].map(b=>b.dataset.v+':'+b.getAttribute('aria-pressed')).join(',')") == 'hq:false,cen:true' and await vis(pg, '#cenOrders') and not await vis(pg, '#hqOrders') and await vis(pg, '#cenSide') and not await vis(pg, '#hubsBlock'))
            lst = await pg.evaluate("[...document.querySelectorAll('#colist li')].map(l=>l.classList.contains('dayhdr')?'#'+l.textContent:l.dataset.id)")
            ok('F2 Liste nach Tag und Fensterbeginn sortiert, mit Tagesüberschriften', lst == ['#Heute · Montag', str(mk['B']), str(mk['A']), '#Morgen · Dienstag', str(mk['C']), str(mk['D']), '#Donnerstag', str(mk['E'])], str(lst))
            ok('F3 Zähler und Reiter nennen 5 offene Bestellungen', await txt(pg, '#cocount') == '5' and '(5)' in await txt(pg, '#tabO'), await txt(pg, '#cocount') + await txt(pg, '#tabO'))
            st = await pg.evaluate("Object.fromEntries([...document.querySelectorAll('#colist li.order')].map(l=>[l.dataset.id, l.querySelector('.o-st').textContent+'|'+l.querySelector('.o-st').className]))")
            ok('F4 Status: Fenster läuft (grün), in 4 h, in 21 h', st[str(mk['B'])] == 'Fenster läuft|o-st run' and re.match(r'in (3:59|4:00) h', st[str(mk['A'])]) and re.match(r'in (20:59|21:00) h', st[str(mk['C'])]), str(st))
            sub = await pg.evaluate("[...document.querySelectorAll('#colist li.order')].map(l=>l.querySelector('.o-sub').textContent)")
            ok('F5 Bei mehreren Centern steht "C1"/"C2" in jeder Zeile, Firmen mit Art', all(re.match(r'C[12] · #\d+ · (Privat|Büro|Betrieb|Geschäft|Praxis|Bank)', t) for t in sub) and any(t.startswith('C1') for t in sub), str(sub))
            ok('F6 Firmen tragen den Firmennamen, Privatkunden die Straße oder "Privatkunde"', await pg.evaluate("(()=>{const o=__lm.cen.orders(); return [...document.querySelectorAll('#colist li.order')].every(l=>{const x=o.find(q=>String(q.id)===l.dataset.id); const t=l.querySelector('strong').textContent; return x.firm? t===x.name : t===(x.street||'Privatkunde')})})()"))
            ok('F7 Firmen-Zeilen sind markiert (Rand), Privatkunden nicht', await pg.evaluate("(()=>{const o=__lm.cen.orders(); return [...document.querySelectorAll('#colist li.order')].every(l=>l.classList.contains('firm')===o.find(q=>String(q.id)===l.dataset.id).firm)})()"))
            # Filter
            ok('F8 Auswahl "Center" erscheint bei zwei Centern', await vis(pg, '#cenSel') and await pg.evaluate("[...document.querySelectorAll('#cenSel option')].map(o=>o.textContent).join('|')") == 'Alle Center|Center 1|Center 2')
            await pg.select_option('#cenSel', '0'); await pg.wait_for_timeout(400)
            ok('F9 Filter Center 1: nur die eine Bestellung dieses Centers', await pg.evaluate("[...document.querySelectorAll('#colist li.order')].map(l=>l.dataset.id)") == [str(mk['C'])] and await txt(pg, '#cocount') == '1')
            await pg.select_option('#cenSel', 'all'); await pg.wait_for_timeout(400)
            # Auswahl per Karte in der Liste
            await pg.click('#colist li[data-id="%d"] .ocard' % mk['A']); await pg.wait_for_timeout(300)
            ok('F10 Klick auf eine Zeile wählt sie (Markierung, aria-pressed, Auswahl im Spiel)', await pg.evaluate("__lm.cen.sel.order") == mk['A'] and await pg.evaluate("document.querySelector('#colist li[data-id=\"%d\"]').classList.contains('sel')" % mk['A']) and await pg.evaluate("document.querySelector('#colist li[data-id=\"%d\"] .ocard').getAttribute('aria-pressed')" % mk['A']) == 'true')
            await pg.click('#colist li[data-id="%d"] .ocard' % mk['A']); await pg.wait_for_timeout(300)
            ok('F11 Zweiter Klick hebt die Auswahl auf', await pg.evaluate("__lm.cen.sel.order") is None)
            await pg.evaluate("document.activeElement && document.activeElement.blur()")
            await pg.keyboard.press('ArrowDown'); await pg.wait_for_timeout(200)
            a1 = await pg.evaluate("__lm.cen.sel.order")
            await pg.keyboard.press('ArrowDown'); await pg.wait_for_timeout(200)
            a2 = await pg.evaluate("__lm.cen.sel.order")
            await pg.keyboard.press('ArrowUp'); await pg.keyboard.press('ArrowUp'); await pg.wait_for_timeout(200)
            a3 = await pg.evaluate("__lm.cen.sel.order")
            ok('F12 Pfeiltasten wandern durch die sortierte Liste und springen am Anfang nach hinten', a1 == mk['B'] and a2 == mk['A'] and a3 == mk['E'], str([a1, a2, a3]))
            # Karte: Hover und Klick auf eine Bestellung
            await pg.evaluate("__lm.cen.sel.order = null")
            tgt = [o for o in await pg.evaluate("__lm.cen.orders().map(o=>({id:o.id,x:o.x,y:o.y,firm:o.firm,name:o.name,street:o.street,n:o.n,wh:o.wh}))") if o['id'] == mk['D']][0]
            # zufällig entstandene Bestellungen derselben Firma am selben Ort würden den Treffer verdecken: weg damit
            # die fünf festen Bestellungen A–E bleiben erhalten (sie werden weiter unten gebraucht): liegt eine zu nah, wird sie 400 m verschoben
            await pg.evaluate("a=>{const L=__lm.cen.orders(), keep=new Set(Object.values(a.mk)); for(let i=L.length-1;i>=0;i--) if(L[i].id!==a.id&&Math.hypot(L[i].x-a.x,L[i].y-a.y)<30){ if(keep.has(L[i].id)) L[i].x+=400; else L.splice(i,1); }}", dict(tgt, mk={k: v for k, v in mk.items() if k != 't'}))
            await pg.evaluate("window.scrollTo(0,0)")
            await pg.evaluate("a=>{const c=__lm.view.cam; __lm.view.look(a.x,a.y,Math.max(c.z,1))}", tgt); await pg.wait_for_timeout(500)
            xy = await pg.evaluate("a=>{const r=document.getElementById('map').getBoundingClientRect(); return [r.left+__lm.view.toX(a.x), r.top+__lm.view.toY(a.y)]}", tgt)
            await pg.mouse.move(xy[0] + 40, xy[1] + 40); await pg.mouse.move(xy[0], xy[1]); await pg.wait_for_timeout(250)
            tip = await txt(pg, '#tip')
            dbg = await pg.evaluate("a=>{const r=document.getElementById('map').getBoundingClientRect(); const e=document.elementFromPoint(a[0],a[1]); return {el:e?e.id+'/'+e.tagName+'/'+e.className:null, z:__lm.view.cam.z, view:__lm.cen.view(), rect:[r.left,r.top,r.width,r.height], win:!document.getElementById('win').hidden, sh:document.documentElement.scrollHeight, ih:innerHeight, sy:scrollY}}", xy)
            ok('F13 Zeigen auf eine Bestellung nennt Nummer, Firma, Menge, Fenster und Lohn', await vis(pg, '#tip') and ('#%d' % mk['D']) in tip and tgt['name'] in tip and '10–14 Uhr' in tip and '€' in tip, tip + str(xy) + str(dbg))
            await pg.mouse.click(xy[0], xy[1]); await pg.wait_for_timeout(400)
            ok('F14 Klick auf die Bestellung in der Karte wählt sie in der Liste', await pg.evaluate("__lm.cen.sel.order") == mk['D'] and await pg.evaluate("document.querySelector('#colist li[data-id=\"%d\"]').classList.contains('sel')" % mk['D']))
            await pg.screenshot(path=OUT + 'cen_view.png')
            # Center in der Karte: Klick öffnet den Ausbau, Zeigen nennt Gebiet und Transporter
            cc = await pg.evaluate("(()=>{const c=__lm.cen.centers()[1]; return {x:c.x,y:c.y}})()")
            await pg.evaluate("window.scrollTo(0,0)")
            await pg.evaluate("a=>{const c=__lm.view.cam; __lm.view.look(a.x,a.y,Math.max(c.z,1))}", cc); await pg.wait_for_timeout(500)
            xy = await pg.evaluate("a=>{const r=document.getElementById('map').getBoundingClientRect(); return [r.left+__lm.view.toX(a.x), r.top+__lm.view.toY(a.y)]}", cc)
            await pg.mouse.move(xy[0] + 50, xy[1] + 50); await pg.mouse.move(xy[0], xy[1]); await pg.wait_for_timeout(250)
            tip = await txt(pg, '#tip')
            ok('F15 Zeigen auf ein Center: Name, Liefergebiet, Transporter, Fahrer', 'Center 2' in tip and 'Essen' in tip and '4 / 4 Transporter' in tip and 'Fahrer' in tip, tip)
            await pg.mouse.click(xy[0], xy[1]); await wait_vis(pg, '#win'); await pg.wait_for_timeout(300)
            ok('F16 Klick auf das Center öffnet dessen Verbesserungen (Reiter "Center 2")', (await pg.evaluate(TABS))[2] == 'Center 2*', str(await pg.evaluate(TABS)))
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
            await pg.click('#clist .cbox:nth-child(2) .hubhead'); await pg.wait_for_timeout(200)
            ok('F17 Gruppe zuklappen versteckt Transporter und Fahrer', not await vis(pg, '#clist .cbox:nth-child(2) .hubbody') and await vis(pg, '#clist .cbox:nth-child(2) .hubup'))
            await pg.click('#clist .cbox:nth-child(2) .hubhead'); await pg.wait_for_timeout(200)
            ok('F18 ... und wieder aufklappen', await vis(pg, '#clist .cbox:nth-child(2) .hubbody'))
            # Taste V und Umschalter
            await pg.evaluate("document.activeElement && document.activeElement.blur()")
            await pg.keyboard.press('v'); await pg.wait_for_timeout(300)
            ok('F19 Taste V wechselt zur Lieferdienst-Ansicht (HQ-Liste zurück, Center-Bestellungen weg)', await pg.evaluate("__lm.cen.view()") == 'hq' and await vis(pg, '#hqOrders') and not await vis(pg, '#cenOrders') and await vis(pg, '#hubsBlock'))
            ok('F20 In der Lieferdienst-Ansicht zählt der Reiter nur Hub-Aufträge', '(5)' not in await txt(pg, '#tabO'))
            await pg.keyboard.press('v'); await pg.wait_for_timeout(300)
            ok('F21 V nochmal: zurück zu Fulfillment', await pg.evaluate("__lm.cen.view()") == 'cen')
            await pg.click('#viewSeg button[data-v=hq]'); await pg.wait_for_timeout(300)
            ok('F22 Umschalter-Knopf "Lieferdienst" wirkt ebenso', await pg.evaluate("__lm.cen.view()") == 'hq')
            await pg.click('#viewSeg button[data-v=cen]'); await pg.wait_for_timeout(300)
            # Verfall wird sofort aus der Liste genommen
            await pg.evaluate("(()=>{const x=__lm.cen.orders().find(o=>o.id===%d); x.we=__lm.sim()-7300; x.ws=x.we-7200; })()" % mk['B']); await pg.evaluate("__lm.cen.expire()"); await pg.wait_for_timeout(500)
            ok('F23 Verfallene Bestellung verschwindet aus Liste und Zähler (4 offen)', await txt(pg, '#cocount') == '4' and not await pg.evaluate("!!document.querySelector('#colist li[data-id=\"%d\"]')" % mk['B']))
            # Tageswechsel: Überschriften wandern (Heute/Morgen)
            await pg.evaluate("__lm.world.setHour(10, 4)"); await pg.wait_for_timeout(1200)
            lst = await pg.evaluate("[...document.querySelectorAll('#colist li.dayhdr')].map(l=>l.textContent)")
            ok('F24 Am nächsten Tag heißt der alte "Morgen"-Tag "Heute", ältere Tage tragen nur den Namen', 'Heute · Dienstag' in lst and 'Morgen · Dienstag' not in lst and lst[0] == 'Montag', str(lst))
            await pg.evaluate("__lm.world.setHour(10, 3)")
            ok('Z3 Keine Skriptfehler bis hier', not errs, str(errs[:3]))

            # ================= G: Speichern, Neuladen, Umwandlung =================
            await pg.evaluate("__lm.absence(0); __lm.cen.auto(false)")
            await pg.evaluate("__lm.cen.orders().length = 0; for (let i=0;i<6;i++) __lm.cen.spawn(1); __lm.cen.spawn(0); __lm.cen.centers()[1].drv[2].train = {t:300, dur:1200, to:3, cost:80}; __lm.cen.centers()[1].drv[3].sick = {left:900}; __lm.cen.centers()[1].rep = 3.7; __lm.cen.stats.n = 11; __lm.cen.stats.ontime = 7; __lm.cen.stats.late = 4;")
            await pg.evaluate("__lm.push(false)"); await pg.wait_for_timeout(700)
            SNAP = """JSON.stringify({cs:__lm.cen.centers().map(c=>({x:Math.round(c.x),y:Math.round(c.y),up:Object.fromEntries(Object.entries(c.up).sort()),rep:c.rep,vans:c.vans.map(v=>v.id),drv:c.drv.map(d=>[d.id,d.lvl,!!d.train&&d.train.to,d.done]) })),
              os:__lm.cen.orders().map(o=>[o.id,o.c,o.firm,o.name,o.n,o.pay,o.day,o.wh.join('-'),Math.abs(o.ws-__lm.cen.simOf(o.day,o.wh[0]))<1,Math.abs(o.we-__lm.cen.simOf(o.day,o.wh[1]))<1,o.state]).sort(), vs:__lm.cen.vanSeq(), st:{n:__lm.cen.stats.n,o:__lm.cen.stats.ontime,l:__lm.cen.stats.late,e:__lm.cen.stats.expired}, hd:__lm.drivers().map(d=>d.id), v:Math.round(__lm.value())})"""
            before = await pg.evaluate(SNAP)
            nov = ovp['n']
            await pg.reload(); ok('G0 Neu geladen', await wait_app(pg))
            await pg.evaluate("__lm.cen.auto(false)")
            await pg.wait_for_timeout(1500)
            after = await pg.evaluate(SNAP)
            bj, aj = json.loads(before), json.loads(after)
            ok('G1 Center, Ausbauten, Transporter, Fahrer, Bestellungen und Zähler überstehen das Neuladen', bj['cs'] == aj['cs'] and bj['os'] == aj['os'] and bj['vs'] == aj['vs'] and bj['st'] == aj['st'] and bj['hd'] == aj['hd'], before[:300] + '\n' + after[:300])
            ok('G2 Fensterzeiten der Bestellungen passen nach dem Laden zu Tag und Stunde (Zeitverschiebung stimmt)', all(o[8] and o[9] for o in aj['os']) and len(aj['os']) == 7, str(aj['os'])[:300])
            ok('G3 Firmen kommen beim Neuladen aus dem Zwischenspeicher (keine neue Abfrage), Gebiet kennt sie', ovp['n'] == nov and await wait_for(pg, "__lm.cen.firmState()==='ok'", 5000) and await pg.evaluate("__lm.cen.firms().length") == 7, '%s %s' % (ovp['n'], nov))
            ok('G4 Unternehmenswert unverändert', abs(bj['v'] - aj['v']) < 20, '%s %s' % (bj['v'], aj['v']))
            ok('G5 Ansicht und Umschalter nach dem Laden: Umschalter da', not await pg.evaluate("document.getElementById('viewSeg').hidden"))
            s5 = await pg.evaluate("(()=>{const s=__lm.save.snapshot(); return {v:s.v, c:s.centers.length, keys:Object.keys(s.centers[1]).sort().join(','), ko:s.corders.length, st:s.cstats}})()")
            ok('G6 Spielstand hat Version 5 mit Centern (samt Städten), Center-Bestellungen und Zählern', s5['v'] == 5 and 'cities' in s5['keys'] and s5['c'] == 2 and s5['ko'] == 7 and s5['st']['n'] == 11, str(s5))
            # Alter Stand (v3) ohne Center
            mig = await pg.evaluate("""()=>{ const sv=__lm.save.snapshot(); sv.v=3; delete sv.centers; delete sv.corders; delete sv.vanSeq; delete sv.cstats;
              const n=__lm.save.normalizeSave(JSON.parse(JSON.stringify(sv))); return {v:n.v, from:n.from, c:n.centers.length, o:n.corders.length, vs:n.vanSeq, st:n.cstats, hubs:n.hubs.length, drivers:n.drivers.length} }""")
            ok('G7 Alter Stand v3: wird zu v5 mit null Centern, Hubs und Fahrer bleiben', mig['v'] == 5 and mig['from'] == 3 and mig['c'] == 0 and mig['o'] == 0 and mig['vs'] == 1 and mig['st'] == {'n': 0, 'ontime': 0, 'late': 0, 'expired': 0, 'pay': 0} and mig['hubs'] >= 1 and mig['drivers'] >= 1, str(mig))
            fut = await pg.evaluate("""()=>{ const sv=__lm.save.snapshot(); sv.v=6; try { __lm.save.normalizeSave(sv); return 'angenommen'; } catch(e) { return e.future ? 'future' : 'fehler'; } }""")
            ok('G8 Version 6 wird als zu neu abgelehnt', fut == 'future', fut)
            # Beschädigte Center-Daten
            bad = await pg.evaluate("""()=>{ const sv=JSON.parse(JSON.stringify(__lm.save.snapshot())), hd=sv.drivers.map(d=>d.id);
              const c1=sv.centers[1]; c1.up={slots:99, stops:-4, zone:'x', nav:2.7, junk:5}; c1.rep=99;
              c1.vans=[]; for (let i=0;i<40;i++) c1.vans.push({id:(i%5)+1}); c1.vans.push({id:'a'}, null, {id:-3});
              c1.drv=[{id:hd[0],lvl:9}, {id:500,lvl:-5,done:'x',sick:{left:'x'}}, {id:500}, {id:501,lvl:3,train:{t:'x',dur:1,to:2}}, null, {id:0}]; for (let i=0;i<40;i++) c1.drv.push({id:600+i});
              sv.centers.push({x:NaN,y:3}, {x:'a',y:1}, null, 5);
              const o0=sv.corders[0]; sv.corders.push(Object.assign({}, o0, {id:9001, c:7}), Object.assign({}, o0, {id:9002, ws:NaN}), Object.assign({}, o0, {id:9003, wh:[1]}), Object.assign({}, o0, {id:9004, state:'seltsam'}), Object.assign({}, o0, {id:9005, n:99, name:'x'.repeat(500), kind:99}), Object.assign({}, o0, {id:9006, day:1.5}), null, 'x');
              const n=__lm.save.normalizeSave(sv), c=n.centers[1], all=[...n.drivers.map(d=>d.id), ...n.centers.flatMap(c=>c.drv.map(d=>d.id))];
              const o5=n.corders.find(o=>o.id===9005);
              return {nc:n.centers.length, up:c.up, rep:c.rep, vans:c.vans.length, vanIds:new Set(c.vans.map(v=>v.id)).size, drv:c.drv.length, uniq:new Set(all).size===all.length, hdKept:n.drivers.map(d=>d.id).join()===hd.join(), d500:c.drv.find(d=>d.id===500), d501:c.drv.find(d=>d.id===501), seq:n.driverSeq>Math.max(...all), vanSeq:n.vanSeq>Math.max(...c.vans.map(v=>v.id)),
                dropped:[9001,9002,9003,9004,9006].filter(i=>n.corders.some(o=>o.id===i)), o5:o5&&{n:o5.n,name:o5.name.length,kind:o5.kind}, orderSeq:n.orderSeq>Math.max(...n.corders.map(o=>o.id))} }""")
            ok('G9 Defekte Center-Daten: ungültige Center fliegen raus, Ausbaustufen begrenzt, Ruf ≤ 5', bad['nc'] == 2 and bad['up'].get('slots') == 8 and bad['up'].get('stops', 0) == 0 and bad['up'].get('zone', 0) == 0 and bad['rep'] == 5 and 'junk' not in bad['up'], str(bad))
            ok('G10 Transporter: Nummern eindeutig, höchstens so viele wie Stellplätze', bad['vans'] == 5 and bad['vanIds'] == 5, str(bad))
            ok('G11 Fahrer: Pool begrenzt (Stellplätze + 2), Nummern nie doppelt (auch nicht mit Hub-Fahrern)', bad['drv'] <= 20 + 2 and bad['uniq'] and bad['hdKept'], str(bad))
            ok('G12 Fahrerwerte begrenzt: Stufe 1–5, kaputte Krankheit/Schulung werden zu 0/null', bad['d500'] and bad['d500']['lvl'] == 1 and bad['d500']['done'] == 0 and bad['d501'] and bad['d501']['train'] is None or bad['d501']['train']['t'] == 0, str(bad['d500']) + str(bad['d501']))
            ok('G13 Kaputte Bestellungen entfallen, Menge/Name/Art begrenzt, Nummernzähler liegen über allen Nummern', bad['dropped'] == [] and bad['o5'] == {'n': 30, 'name': 80, 'kind': 4} and bad['seq'] and bad['vanSeq'] and bad['orderSeq'], str(bad))
            # v3 anwenden: neues Konto
            ctx3 = await newctx(b)
            await ctx3.route(re.compile(r'https://(overpass-api\.de|overpass\.kumi\.systems|maps\.mail\.ru)/.*'), overpass)
            pg3, errs3, st3 = await start_game(ctx3, 'Tim Alt', 'alt@example.de'); ok('G14 Zweites Konto startet', st3)
            ap = await pg3.evaluate("""()=>{ const sv=__lm.save.snapshot(); sv.v=3; delete sv.centers; delete sv.corders; delete sv.vanSeq; delete sv.cstats;
              __lm.save.applySave(__lm.save.normalizeSave(JSON.parse(JSON.stringify(sv)))); return {c:__lm.cen.centers().length, view:__lm.cen.view(), seg:document.getElementById('viewSeg').hidden} }""")
            await pg3.wait_for_timeout(600)
            ok('G15 Alter Stand angewendet: keine Center, Lieferdienst-Ansicht, Umschalter versteckt', ap == {'c': 0, 'view': 'hq', 'seg': True}, str(ap))
            await pg3.evaluate(POI_BUILD); await pg3.wait_for_timeout(600)
            ok('G16 Danach lässt sich ein Center bauen, Firmenabfrage startet', await pg3.evaluate("__lm.cen.centers().length") == 1 and await wait_for(pg3, "__lm.cen.firmState()==='ok'", 5000))
            ok('G17 Keine Skriptfehler im zweiten Konto', not errs3, str(errs3[:3]))
            await ctx3.close()
            ok('Z4 Keine Skriptfehler bis hier', not errs, str(errs[:3]))

            # ================= H: Firmen nicht erreichbar =================
            ctx4 = await newctx(b)
            ovp2 = {'n': 0, 'fail': True}

            async def overpass2(route, request):
                ovp2['n'] += 1
                if ovp2['fail']: return await route.abort()
                await route.fulfill(status=200, headers={'content-type': 'application/json', 'access-control-allow-origin': '*'}, body=json.dumps(FAKE))
            await ctx4.route(re.compile(r'https://(overpass-api\.de|overpass\.kumi\.systems|maps\.mail\.ru)/.*'), overpass2)
            pg4, errs4, st4 = await start_game(ctx4, 'Tim Offline', 'off@example.de'); ok('H0 Konto ohne Firmendaten startet', st4)
            await pg4.evaluate(POI_BUILD)
            await wait_for(pg4, "__lm.cen.firmState()!=='loading'", 30000)
            ok('H1 Abfrage scheitert: Zustand "none", Hinweis im Center-Kasten, Spiel läuft weiter', await pg4.evaluate("__lm.cen.firmState()") == 'none' and ovp2['n'] >= 1, str(ovp2))
            await pg4.evaluate("__lm.cen.buyVan(0); __lm.cen.hire(0)"); await pg4.wait_for_timeout(500)
            ok('H2 Kasten nennt "nur Privatkunden"', 'nur Privatkunden' in await txt(pg4, '#clist .cbox .cinfo'), await txt(pg4, '#clist .cbox .cinfo'))
            r = await pg4.evaluate("""()=>{ const o=__lm.cen.orders(); o.length=0; for (let i=0;i<60;i++) __lm.cen.spawn(0); return {n:o.length, firms:o.filter(x=>x.firm).length} }""")
            ok('H3 Ohne Firmendaten: nur Privatkunden', r['n'] == 60 and r['firms'] == 0, str(r))
            ok('H4 Auch eine ausdrückliche Firmenbestellung wird zur Privatbestellung oder abgelehnt, nie ohne Firma', await pg4.evaluate("(()=>{const x=__lm.cen.spawn(0,'firm'); return !x || !x.firm || x.name!==''})()"))
            ovp2['fail'] = False
            await pg4.evaluate("__lm.cen.startFirms()")
            ok('H5 Erneuter Versuch klappt: 7 Firmen, Zustand "ok"', await wait_for(pg4, "__lm.cen.firmState()==='ok'", 8000) and await pg4.evaluate("__lm.cen.firms().length") == 7)
            await pg4.wait_for_timeout(400)
            ok('H6 Gebiet kennt jetzt Firmen (Kasten nennt sie), neue Bestellungen können Firmen sein', ' Firm' in await txt(pg4, '#clist .cbox .cinfo') and await pg4.evaluate("(()=>{let f=0; for(let i=0;i<80;i++){const x=__lm.cen.spawn(0); if(x&&x.firm) f++} return f})()") > 5)
            ok('H7 Keine Skriptfehler (Offline-Konto)', not errs4, str(errs4[:3]))
            await ctx4.close()

            # ================= I: Handy =================
            ctx5 = await newctx(b, (390, 780))
            await ctx5.route(re.compile(r'https://(overpass-api\.de|overpass\.kumi\.systems|maps\.mail\.ru)/.*'), overpass)
            pg5, errs5, st5 = await start_game(ctx5, 'Tim Handy', 'hy2@example.de'); ok('I0 Spiel am Handy startet', st5)
            await pg5.evaluate(POI_BUILD)
            await pg5.evaluate("__lm.absence(0); __lm.cen.buyVan(0); __lm.cen.buyVan(0); __lm.cen.hire(0); __lm.cen.hire(0); __lm.cen.hire(0); for (let i=0;i<10;i++) __lm.cen.spawn(0)")
            await wait_for(pg5, "__lm.cen.firmState()==='ok'", 8000)
            await pg5.wait_for_timeout(500)
            g = await pg5.evaluate("""()=>{const r=document.getElementById('viewSeg').getBoundingClientRect(); return {l:r.left, r:r.right, vis:!document.getElementById('viewSeg').hidden, vw:innerWidth, docW:document.documentElement.scrollWidth}}""")
            ok('I1 Umschalter Lieferdienst/Fulfillment liegt am Handy im Bild', g['vis'] and g['l'] >= 0 and g['r'] <= g['vw'] and g['docW'] <= g['vw'], str(g))
            await pg5.click('#viewSeg button[data-v=cen]'); await pg5.wait_for_timeout(300)
            await pg5.evaluate("()=>{const b=[...document.querySelectorAll('#tabbar button')].find(x=>/Aufträge/.test(x.textContent)); if (b) b.click()}"); await pg5.wait_for_timeout(500)
            go = await pg5.evaluate("""()=>{const vw=innerWidth, rows=[...document.querySelectorAll('#colist li.order')]; return {n:rows.length, vis:!!document.getElementById('cenOrders').offsetParent, hqVis:!!document.getElementById('hqOrders').offsetParent, over:rows.filter(l=>l.getBoundingClientRect().right>vw+1||l.scrollWidth>l.clientWidth+1).length, docW:document.documentElement.scrollWidth, vw}}""")
            ok('I2 Aufträge-Reiter am Handy: Center-Liste mit 10 Zeilen, nichts läuft über', go['n'] == 10 and go['vis'] and not go['hqVis'] and go['over'] == 0 and go['docW'] <= go['vw'], str(go))
            await pg5.click('#colist li.order >> nth=0 >> .ocard'); await pg5.wait_for_timeout(300)
            ok('I3 Auswahl per Tippen funktioniert am Handy', await pg5.evaluate("__lm.cen.sel.order") is not None)
            await pg5.screenshot(path=OUT + 'cen_mobile_orders.png')
            await pg5.evaluate("()=>{const b=[...document.querySelectorAll('#tabbar button')].find(x=>/Fahrer/.test(x.textContent)); if (b) b.click()}"); await pg5.wait_for_timeout(500)
            gd = await pg5.evaluate("""()=>{const vw=innerWidth, bx=document.querySelector('#clist .cbox'); const btns=[...bx.querySelectorAll('button')]; return {vis:!!document.getElementById('cenSide').offsetParent, hubs:!!document.getElementById('hubsBlock').offsetParent, nb:btns.length, over:btns.filter(b=>b.getBoundingClientRect().right>vw+1||b.getBoundingClientRect().left<-1).length, docW:document.documentElement.scrollWidth, vw, rows:[...bx.querySelectorAll('.van,.cdr')].filter(l=>l.scrollWidth>l.clientWidth+1).length}}""")
            ok('I4 Fahrer-Reiter am Handy: Center-Gruppe statt Hubs, Knöpfe und Zeilen laufen nicht über', gd['vis'] and not gd['hubs'] and gd['nb'] >= 8 and gd['over'] == 0 and gd['rows'] == 0 and gd['docW'] <= gd['vw'], str(gd))
            await pg5.screenshot(path=OUT + 'cen_mobile_side.png')
            await pg5.click('#clist .cbox .hubup'); await wait_vis(pg5, '#win'); await pg5.wait_for_timeout(300)
            geo = await pg5.evaluate("""()=>{const w=document.getElementById('win').getBoundingClientRect(); const rows=[...document.querySelectorAll('#tab-ce .upg')].map(r=>{const b=r.querySelector('button').getBoundingClientRect(); return b.right<=w.right+1 && r.scrollWidth<=r.clientWidth+1}); return {docW:document.documentElement.scrollWidth, vw:innerWidth, winL:w.left, winR:w.right, rows}}""")
            ok('I5 Ausbau-Fenster des Centers liegt am Handy im Bild, fünf Zeilen laufen nicht über', geo['docW'] <= geo['vw'] and geo['winL'] >= 0 and geo['winR'] <= geo['vw'] and len(geo['rows']) == 5 and all(geo['rows']), str(geo))
            ok('I6 Reiter erreichbar: Hub 1, Center 1, Spiel, Partner', len(await pg5.evaluate(TABS)) == 4, str(await pg5.evaluate(TABS)))
            await pg5.screenshot(path=OUT + 'cen_mobile_upg.png')
            ok('I7 Keine Skriptfehler am Handy', not errs5, str(errs5[:3]))
            await ctx5.close()
            ok('Z1 Keine Skriptfehler bis hier', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
