"""Verbesserungen je Hauptquartier: Reiter, Stufenbalken, Wirkung nur im eigenen Hub, Spielstand und Umwandlung alter Stände.
Start: python3 tests/ui_upgrades.py   (Ports 8392 / 9292; Kartenbild mit ?nobase abgeschaltet)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9292'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8392/index.html?debug&nobase'
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


DRV = "()=>__lm.drivers().map(d=>({id:d.id,veh:d.veh,rest:d.rest||null,trip:!!d.trip,hub:d.hub}))"
txt = lambda pg, sel: pg.evaluate("s=>document.querySelector(s)?document.querySelector(s).textContent:null", sel)
OUT = HERE + 'out/'; os.makedirs(OUT, exist_ok=True)


async def hire(pg, veh):
    await pg.select_option('#hireVeh', veh); await pg.click('#hireBtn'); await pg.wait_for_timeout(300)



OUT = HERE + 'out/'; os.makedirs(OUT, exist_ok=True)
place_hub_js = """()=>{const E=__lm.E; __lm.setCash(50000); const n0=__lm.hubs().length;
  for (let i=0;i<E.N&&__lm.hubs().length===n0;i++){const d=Math.hypot(E.nx[i]-E.HUB.x,E.ny[i]-E.HUB.y); if (d>650&&d<900) __lm.placeHub(E.nx[i],E.ny[i]);}
  return __lm.hubs().length}"""
# Zeilen des Hub-Reiters: [{name, label, fill, total, now, next, btn, disabled, own, aria}]
ROWS = """(sel)=>[...document.querySelectorAll(sel+' .upg')].map(r=>{const q=s=>r.querySelector(s), bar=q('.lvbar');
  return {name:q('strong').textContent, label:q('.u-lv').textContent, fill:bar.querySelectorAll('i.on').length, total:bar.querySelectorAll('i').length,
    next:bar.querySelectorAll('i.next').length, max:bar.classList.contains('max'), now:q('.u-now').textContent, nxt:q('.u-next').hidden?'':q('.u-next').textContent, btn:q('button').textContent, disabled:q('button').disabled,
    own:r.classList.contains('own'), role:bar.getAttribute('role'), vmax:+bar.getAttribute('aria-valuemax'), vnow:+bar.getAttribute('aria-valuenow'), aria:bar.getAttribute('aria-label')}})"""
TABS = "()=>[...document.querySelectorAll('#hqTabs button')].map(b=>b.textContent+(b.getAttribute('aria-selected')==='true'?'*':''))"
by = lambda rows, name: next((r for r in rows if r['name'].startswith(name)), None)


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9292'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8392', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R = []

    def ok(name, cond, info=''):
        R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await newctx(b); pg, errs, started = await start_game(ctx, 'Tim Ausbau', 'ub@example.de')
            ok('A0 Spiel startet', started)
            ZMAX = await pg.evaluate("__lm.fx.ZMAX")

            # ================= A: Einstieg und Aufbau =================
            ok('A1 Der Knopf "Hauptquartier" in der Kopfzeile ist weg', not await pg.evaluate("!!document.getElementById('hqBtn')") and 'Hauptquartier' not in await pg.evaluate("document.querySelector('header').textContent.replace('Hauptquartiere','')"))
            ok('A2 Fenster ist zu Beginn geschlossen', not await vis(pg, '#win'))
            ok('A3 Jeder Hub hat einen Knopf "Ausbau"', await pg.evaluate("[...document.querySelectorAll('#dlist .hubbox')].every(b=>b.querySelector('.hubup')&&b.querySelector('.hubup').textContent==='Ausbau')"))
            await pg.click('#dlist .hubup'); await wait_vis(pg, '#win')
            ok('A4 "Ausbau" öffnet das Verbesserungsfenster', await vis(pg, '#win') and await txt(pg, '#winT') == 'Verbesserungen')
            tabs = await pg.evaluate(TABS)
            ok('A5 Reiter: Hub 1 (gewählt), Spiel, Partner', tabs == ['Hub 1*', 'Spiel', 'Partner'], str(tabs))
            ok('A6 Kopf nennt Hub 1 als Hauptquartier mit Plätzen und Liefergebiet', 'Hub 1' in await txt(pg, '#huName') and 'Hauptquartier' in await txt(pg, '#huName') and '1 von 4 Plätzen' in await txt(pg, '#huInfo') and 'Liefergebiet' in await txt(pg, '#huInfo'), await txt(pg, '#huInfo'))
            rows = await pg.evaluate(ROWS, '#tab-up')
            ok('A7 Sieben Verbesserungen für den Hub', [r['name'] for r in rows] == ['Plätze im Hub', 'Liefergebiet', 'Navigation', 'E-Bike-Motoren', 'Schnellabholung', 'Isolierte Boxen', 'Wartungsvertrag'], str([r['name'] for r in rows]))
            ok('A8 Jede Verbesserung hat einen Balken (role=meter) mit passenden Werten', all(r['role'] == 'meter' and r['vmax'] == r['total'] and r['vnow'] == r['fill'] and r['name'] in r['aria'] and r['label'] in r['aria'] for r in rows), str(rows[0]))
            cap, zone, nav, motor = by(rows, 'Plätze'), by(rows, 'Liefergebiet'), by(rows, 'Navigation'), by(rows, 'E-Bike')
            ok('A9 Plätze: Balken mit 3 Segmenten, erste gefüllt, nächste markiert, "Stufe 1 von 3"', (cap['total'], cap['fill'], cap['next'], cap['label']) == (3, 1, 1, 'Stufe 1 von 3'), str(cap))
            ok('A10 Liefergebiet: Balken passend zur Kartengröße (ZMAX+1 Segmente), erste gefüllt', (zone['total'], zone['fill']) == (ZMAX + 1, 1), str(zone))
            ok('A11 Navigation: 3 Segmente, nichts gefüllt, "Nicht gekauft"', (nav['total'], nav['fill'], nav['label']) == (3, 0, 'Nicht gekauft'), str(nav))
            ok('A12 Einstufige Ausbauten: ein Segment, "Nicht gekauft"', (motor['total'], motor['fill'], motor['label']) == (1, 0, 'Nicht gekauft'), str(motor))
            ok('A13 Kosten stehen am Knopf (Plätze 400 €, Navigation 250 €, Motoren 280 €)', cap['btn'] == '400,00 €' and nav['btn'] == '250,00 €' and motor['btn'] == '280,00 €', '%s %s %s' % (cap['btn'], nav['btn'], motor['btn']))
            ok('A14 Zu wenig Geld: Knöpfe gesperrt (Start 150 €)', all(r['disabled'] for r in rows), str([r['disabled'] for r in rows]))
            ok('A15 "Jetzt" und "Nächste Stufe" bei mehrstufigen', 'Platz für 4' in cap['now'] and 'Platz für 8' in cap['nxt'] and 'Verkehrsfunk' in nav['nxt'], '%s | %s' % (cap['now'], nav['nxt']))
            await pg.screenshot(path=OUT + 'upg_hub1.png')
            await pg.click('#hqTabs button >> text=Spiel'); await pg.wait_for_timeout(250)
            g = await pg.evaluate(ROWS, '#tab-gm')
            ok('B1 Spiel-Reiter: Disposition, Werbekampagne, Hubs', [r['name'] for r in g] == ['Dispositions-Software', 'Werbekampagne', 'Hubs'], str([r['name'] for r in g]))
            ok('B2 Hubs: Balken 1 von 3', (g[2]['total'], g[2]['fill'], g[2]['label']) == (3, 1, '1 von 3 Hubs'), str(g[2]))
            ok('B3 Disposition und Werbung: einstufig, 300 € und 250 €', (g[0]['total'], g[0]['btn'], g[1]['total'], g[1]['btn']) == (1, '300,00 €', 1, '250,00 €'), str(g[:2]))
            ok('B4 Spiel-Reiter enthält keine Hub-Ausbauten (kein Motor, keine Navigation)', not any(r['name'] in ('Navigation', 'E-Bike-Motoren') for r in g))
            await pg.click('#hqTabs button >> text=Partner'); await pg.wait_for_timeout(250)
            ok('B5 Partner-Reiter zeigt die Partnerliste', await vis(pg, '#tab-pa') and not await vis(pg, '#tab-up') and not await vis(pg, '#tab-gm'))
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150)
            ok('B6 Esc schließt das Fenster', not await vis(pg, '#win'))
            await pg.click('#dlist .hubup'); await pg.wait_for_timeout(200); await pg.click('#dlist .hubup'); await pg.wait_for_timeout(200)
            ok('B7 Zweiter Klick auf "Ausbau" desselben Hubs schließt das Fenster', not await vis(pg, '#win'))

            # ================= C: Kauf, ein Hub =================
            await pg.evaluate("__lm.setCash(5000)")
            await pg.click('#dlist .hubup'); await wait_vis(pg, '#win'); await pg.wait_for_timeout(300)
            c0 = await pg.evaluate("__lm.cash()"); v0 = await pg.evaluate("__lm.value()")
            await pg.evaluate("""()=>{const r=[...document.querySelectorAll('#tab-up .upg')].find(x=>x.querySelector('strong').textContent.startsWith('E-Bike')); r.querySelector('button').click();}""")
            await pg.wait_for_timeout(500)
            rows = await pg.evaluate(ROWS, '#tab-up'); motor = by(rows, 'E-Bike')
            ok('C1 Kauf der E-Bike-Motoren zieht 280 € ab', abs(c0 - await pg.evaluate("__lm.cash()") - 280) < 5, str(c0))   # Toleranz: Löhne und Lieferungen laufen in Echtzeit mit
            ok('C2 Balken zeigt "Gekauft", voll und grün, Knopf "Fertig"', (motor['label'], motor['fill'], motor['max'], motor['btn'], motor['disabled'], motor['own']) == ('Gekauft', 1, True, 'Fertig', True, True), str(motor))
            ok('C3 Stufe liegt im Hub: hubs[0].up.motor = 1', await pg.evaluate("__lm.hubs()[0].up.motor") == 1 and not await pg.evaluate("'motor' in __lm.owned"))
            ok('C4 Unternehmenswert bleibt gleich (Kasse sinkt, Ausbau zählt mit)', abs(await pg.evaluate("__lm.value()") - v0) < 5, '%s -> %s' % (v0, await pg.evaluate("__lm.value()")))
            log = await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')")
            ok('C5 Protokoll nennt Ausbau und Hub', 'E-Bike-Motoren (Hub 1) gekauft' in log, log[:200])
            # Navigation in drei Stufen
            for k in (1, 2, 3):
                await pg.evaluate("""()=>{const r=[...document.querySelectorAll('#tab-up .upg')].find(x=>x.querySelector('strong').textContent==='Navigation'); r.querySelector('button').click();}""")
                await pg.wait_for_timeout(250)
                nav = by(await pg.evaluate(ROWS, '#tab-up'), 'Navigation')
                ok('C6.%d Navigation Stufe %d: Balken %d/3' % (k, k, k), (nav['fill'], nav['total']) == (k, 3) and nav['label'].startswith('Stufe %d von 3' % k), str(nav))
            ok('C7 Navigation Stufe 3: Max., grün, Knopf "Fertig"', (nav['max'], nav['btn'], nav['label']) == (True, 'Fertig', 'Stufe 3 von 3 · Max.'), str(nav))
            ok('C8 Kosten der Navigation (250 + 600 + 1200 €) abgebucht', abs(c0 - 280 - 2050 - await pg.evaluate("__lm.cash()")) < 5, str(await pg.evaluate("__lm.cash()")))
            # Plätze
            await pg.evaluate("""()=>{const r=[...document.querySelectorAll('#tab-up .upg')].find(x=>x.querySelector('strong').textContent.startsWith('Plätze')); r.querySelector('button').click();}""")
            await pg.wait_for_timeout(400)
            cap = by(await pg.evaluate(ROWS, '#tab-up'), 'Plätze')
            ok('C9 Plätze Stufe 2: 8 Fahrer, Balken 2/3', (cap['fill'], cap['label']) == (2, 'Stufe 2 von 3') and 'Platz für 8' in cap['now'], str(cap))
            hub_count = await pg.evaluate("document.querySelector('#dlist .hubbox .hcount').textContent")
            ok('C11 Hub-Kopf rechts zeigt "1 / 8"', hub_count == '1 / 8', hub_count)
            await pg.keyboard.press('Escape')

            # ================= D: zweiter Hub, Wirkung nur im eigenen Hub =================
            n = await pg.evaluate(place_hub_js)
            ok('D0 Zweiter Hub gebaut', n == 2)
            await pg.evaluate("__lm.setCash(50000)")
            tabs2 = None
            await pg.click('#dlist .hubbox:nth-child(2) .hubup'); await wait_vis(pg, '#win'); await pg.wait_for_timeout(300)
            tabs2 = await pg.evaluate(TABS)
            ok('D1 Reiter nun Hub 1, Hub 2 (gewählt), Spiel, Partner', tabs2 == ['Hub 1', 'Hub 2*', 'Spiel', 'Partner'], str(tabs2))
            ok('D2 Hub 2 ist ohne Ausbauten: Name "Hub 2", 0 von 4 Plätzen', await txt(pg, '#huName') == 'Hub 2' and '0 von 4 Plätzen' in await txt(pg, '#huInfo'), await txt(pg, '#huInfo'))
            rows2 = await pg.evaluate(ROWS, '#tab-up')
            ok('D3 Hub 2 startet auf Stufe 1: Plätze 1/3, alles andere nicht gekauft', by(rows2, 'Plätze')['fill'] == 1 and all(r['fill'] == 0 for r in rows2 if r['name'] not in ('Plätze im Hub', 'Liefergebiet')), str([(r['name'], r['fill']) for r in rows2]))
            ok('D4 Hub 1 hat seine Käufe behalten (Motor, Navigation 3, Plätze 2)', await pg.evaluate("JSON.stringify(__lm.hubs()[0].up)") == '{"motor":1,"nav":3,"cap":1}', await pg.evaluate("JSON.stringify(__lm.hubs()[0].up)"))
            # Fahrer in beiden Hubs
            await pg.evaluate("""()=>{ document.getElementById('hireHub').value='1'; }""")
            await pg.select_option('#hireVeh', 'bike'); await pg.select_option('#hireHub', '1'); await pg.click('#hireBtn'); await pg.wait_for_timeout(400)
            fx = await pg.evaluate("""()=>{const F=__lm.fx, ds=__lm.drivers(), a=ds.find(d=>d.hub===0), b=ds.find(d=>d.hub===1);
              return {a:{avoid:F.avoidQ(a), lm:F.levelMult(a), tip:F.tipMax(a), km:F.kmCostOf('scooter',a)}, b:{avoid:F.avoidQ(b), lm:F.levelMult(b), tip:F.tipMax(b), km:F.kmCostOf('scooter',b)}, caps:[F.capOf(0),F.capOf(1)], zr:[F.zr(__lm.hubs()[0]),F.zr(__lm.hubs()[1])]}}""")
            ok('D5 Navigation wirkt nur im Hub 1 (0,9 gegen 0)', fx['a']['avoid'] == 0.9 and fx['b']['avoid'] == 0, str(fx))
            ok('D6 E-Bike-Motoren: Fahrrad in Hub 1 schneller (×1,15), in Hub 2 nicht', abs(fx['a']['lm'] / fx['b']['lm'] - 1.15) < 0.001, str(fx))
            ok('D7 Plätze je Hub: 8 und 4', fx['caps'] == [8, 4], str(fx['caps']))
            # weitere Käufe nur in Hub 2
            await pg.evaluate("""()=>{for (const id of ['boxes','service','quick']) __lm.buy(id, 1);}""")
            await pg.wait_for_timeout(300)
            fx = await pg.evaluate("""()=>{const F=__lm.fx, ds=__lm.drivers(), a=ds.find(d=>d.hub===0), b=ds.find(d=>d.hub===1);
              return {a:{tip:F.tipMax(a), km:F.kmCostOf('scooter',a)}, b:{tip:F.tipMax(b), km:F.kmCostOf('scooter',b)}, up:__lm.hubs().map(h=>JSON.stringify(h.up))}}""")
            ok('D8 Isolierte Boxen nur in Hub 2 (Trinkgeld bis 40 % gegen 25 %)', fx['b']['tip'] > fx['a']['tip'] and abs(fx['b']['tip'] / fx['a']['tip'] - 1.6) < 0.01, str(fx))
            ok('D9 Wartungsvertrag nur in Hub 2 (Kosten ×0,6)', abs(fx['b']['km'] / fx['a']['km'] - 0.6) < 0.001, str(fx))
            ok('D10 Spielstand der Hubs getrennt', fx['up'][1] == '{"boxes":1,"service":1,"quick":1}' and fx['up'][0] == '{"motor":1,"nav":3,"cap":1}', str(fx['up']))
            # Fahrer wechselt den Hub: Wirkung folgt ihm
            sw = await pg.evaluate("""()=>{const F=__lm.fx, d=__lm.drivers().find(x=>x.hub===1); const t1=F.tipMax(d); d.hub=0; const t0=F.tipMax(d), av=F.avoidQ(d); d.hub=1; return {t1,t0,av}}""")
            ok('D11 Wirkung folgt dem Hub des Fahrers (Nav 0,9 nur in Hub 1)', sw['av'] == 0.9 and sw['t1'] > sw['t0'], str(sw))
            # Liefergebiet je Hub
            await pg.evaluate("__lm.buy('zone', 1)")
            await pg.wait_for_timeout(300)
            z = await pg.evaluate("""()=>{const F=__lm.fx, H=__lm.hubs(); return [F.zr(H[0]),F.zr(H[1]), H[1].up.zone||0]}""")
            ok('D12 Liefergebiet nur von Hub 2 größer als das von Hub 1', z[1] > z[0] and z[2] == 1 and z[0] == 600, str(z))
            zin = await pg.evaluate("""()=>{const E=__lm.E,H=__lm.hubs(); const R0=__lm.fx.zr(H[0]), R1=__lm.fx.zr(H[1]);
              // Punkt zwischen Radius 600 und dem größeren Radius von Hub 2, aber weit weg vom Hauptquartier
              const a=Math.atan2(H[1].y-H[0].y, H[1].x-H[0].x); const px=H[1].x+Math.cos(a)*(R0+30), py=H[1].y+Math.sin(a)*(R0+30);
              return {R0,R1,farFromHub1:Math.hypot(px-H[0].x,py-H[0].y)}}""")
            ok('D13 Gebietsgröße ist je Hub verschieden gespeichert', zin['R0'] == 600 and zin['R1'] > 600, str(zin))
            heads = await pg.evaluate("[...document.querySelectorAll('#dlist .hubbox .hcount')].map(e=>e.textContent)")
            ok('D15 Hub-Köpfe zeigen 1 / 8 und 1 / 4', heads == ['1 / 8', '1 / 4'], str(heads))
            sel_opts = await pg.evaluate("[...document.querySelectorAll('#hireHub option')].map(o=>o.textContent)")
            ok('D16 Einstellen-Auswahl nennt freie Plätze je Hub (7 und 3)', sel_opts == ['Hub 1 · 7 frei', 'Hub 2 · 3 frei'], str(sel_opts))
            await pg.screenshot(path=OUT + 'upg_hub2.png')
            # Spiel-Reiter nach dem zweiten Hub
            await pg.click('#hqTabs button >> text=Spiel'); await pg.wait_for_timeout(250)
            g = await pg.evaluate(ROWS, '#tab-gm')
            ok('D17 Hubs-Balken 2 von 3, Knopf mit 1.400 €', (g[2]['fill'], g[2]['label'], g[2]['btn']) == (2, '2 von 3 Hubs', '1.400,00 €'), str(g[2]))
            await pg.evaluate("__lm.buy('dispatch'); __lm.buy('ads')"); await pg.wait_for_timeout(300)
            g = await pg.evaluate(ROWS, '#tab-gm')
            ok('D18 Spiel-Käufe gelten für alle: gekauft, Balken voll', g[0]['label'] == 'Gekauft' and g[1]['label'] == 'Gekauft' and g[0]['max'] and 'dispatch' in await pg.evaluate("Object.keys(__lm.owned).join()") and 'ads' in await pg.evaluate("Object.keys(__lm.owned).join()"))
            ok('D19 Auto-Disposition-Knopf erscheint', await vis(pg, '#autoBtn'))
            await pg.keyboard.press('Escape')

            # ================= E: Einstiege über die Karte =================
            await pg.evaluate("document.getElementById('mapwrap').scrollIntoView({block:'center'})"); await pg.wait_for_timeout(300)
            await pg.evaluate("__lm.view.fit()"); await pg.wait_for_timeout(500)
            hp = await pg.evaluate("()=>{const h=__lm.hubs()[1]; const r=document.getElementById('map').getBoundingClientRect(); return [r.left+__lm.view.toX(h.x), r.top+__lm.view.toY(h.y)]}")
            await pg.mouse.click(hp[0], hp[1]); await wait_vis(pg, '#win'); await pg.wait_for_timeout(300)
            ok('E1 Klick auf Hub 2 auf der Karte öffnet dessen Reiter', await txt(pg, '#winT') == 'Verbesserungen' and (await pg.evaluate(TABS))[1] == 'Hub 2*', f"{hp} {await pg.evaluate(TABS)}")
            await pg.keyboard.press('Escape')
            hp = await pg.evaluate("()=>{const h=__lm.hubs()[0]; const r=document.getElementById('map').getBoundingClientRect(); return [r.left+__lm.view.toX(h.x), r.top+__lm.view.toY(h.y)]}")
            await pg.mouse.click(hp[0], hp[1]); await wait_vis(pg, '#win'); await pg.wait_for_timeout(300)
            ok('E2 Klick auf Hub 1 öffnet Hub 1', (await pg.evaluate(TABS))[0] == 'Hub 1*', str(await pg.evaluate(TABS)))
            await pg.keyboard.press('Escape')
            await pg.click('#dlist .hubbox:nth-child(2) .hubhead'); await pg.wait_for_timeout(150)
            ok('E3 Zuklappen der Gruppe lässt den Ausbau-Knopf sichtbar', await vis(pg, '#dlist .hubbox:nth-child(2) .hubup'))
            await pg.click('#dlist .hubbox:nth-child(2) .hubup'); await wait_vis(pg, '#win')
            ok('E4 ... und der Knopf öffnet den Reiter trotzdem', (await pg.evaluate(TABS))[1] == 'Hub 2*')
            await pg.keyboard.press('Escape')

            # ================= F: Speichern, Neuladen, Umwandlung =================
            await pg.evaluate("__lm.push(false)"); await pg.wait_for_timeout(600)
            SNAP = "JSON.stringify({u:__lm.hubs().map(h=>Object.fromEntries(Object.entries(h.up).sort())), o:Object.keys(__lm.owned).sort(), v:Math.round(__lm.value())})"
            before = await pg.evaluate(SNAP)
            await pg.reload(); ok('F0 Neu geladen', await wait_app(pg))
            await pg.wait_for_timeout(800)
            after = await pg.evaluate(SNAP)
            ok('F1 Stufen je Hub und Spiel-Käufe überstehen das Neuladen', before == after, before + ' | ' + after)
            ok('F2 Spielstand hat Version 6 mit Stufen je Hub', await pg.evaluate("(()=>{const s=__lm.save.snapshot(); return s.v===6 && !('hubLevel' in s) && !('zoneLevel' in s) && s.hubs.every(h=>h.up&&typeof h.up==='object') })()"))
            mig = await pg.evaluate("""()=>{
              const sv=__lm.save.snapshot(); sv.v=2; sv.hubLevel=1; sv.zoneLevel=1; sv.owned={dispatch:true, boxes:true, nav1:true, nav2:true, motor:true}; for (const h of sv.hubs) delete h.up;
              const n=__lm.save.normalizeSave(JSON.parse(JSON.stringify(sv)));
              return {hubs:n.hubs.map(h=>h.up), owned:Object.keys(n.owned).sort(), v:n.v, from:n.from}}""")
            ok('F3 Alter Stand (v2): Plätze, Gebiet und Ausstattung gelten danach in allen Hubs', mig['hubs'] == [{'cap': 1, 'zone': 1, 'nav': 2, 'motor': 1, 'boxes': 1}] * 2 and mig['v'] == 6 and mig['from'] == 2, str(mig))
            ok('F4 Alter Stand: nur Disposition bleibt im Spiel-Bestand', mig['owned'] == ['dispatch'], str(mig['owned']))
            mig2 = await pg.evaluate("""()=>{ const sv=__lm.save.snapshot(); sv.hubs[0].up={cap:9,nav:7,zone:-3,motor:2,boxes:'x',zzz:1};
              return __lm.save.normalizeSave(JSON.parse(JSON.stringify(sv))).hubs[0].up }""")
            ok('F5 Ungültige Stufen werden begrenzt (cap 2, nav 3, motor 1)', mig2 == {'cap': 2, 'nav': 3, 'motor': 1}, str(mig2))
            fut = await pg.evaluate("""()=>{ const sv=__lm.save.snapshot(); sv.v=7; try { __lm.save.normalizeSave(sv); return 'angenommen'; } catch(e) { return e.future ? 'future' : 'fehler'; } }""")
            ok('F6 Spielstand einer neueren Version wird abgelehnt', fut == 'future', fut)
            # Umgewandelten alten Stand wirklich anwenden
            app = await pg.evaluate("""()=>{
              const sv=__lm.save.snapshot(); sv.v=2; sv.hubLevel=2; sv.zoneLevel=1; sv.owned={service:true, nav3:true}; for (const h of sv.hubs) delete h.up;
              __lm.save.applySave(__lm.save.normalizeSave(JSON.parse(JSON.stringify(sv))));
              const F=__lm.fx, d=__lm.drivers()[0]; return {caps:[F.capOf(0),F.capOf(1)], ups:__lm.hubs().map(h=>h.up), av:F.avoidQ(d), km:F.kmCostOf('scooter',d)}}""")
            ok('F7 Angewendet: 12 Plätze und Navigation 3 in beiden Hubs, Wartungsvertrag wirkt', app['caps'] == [12, 12] and app['av'] == 0.9 and abs(app['km'] - 0.12 * 0.6) < 1e-9, str(app))

            # ================= G: Erfolg =================
            await pg.evaluate("__lm.setCash(100000)")
            await pg.evaluate("""()=>{for (const id of ['cap','cap','zone','zone','zone','zone','nav','nav','nav','motor','quick','boxes','service','dispatch','ads']) __lm.buy(id, 0);}""")
            await pg.wait_for_timeout(900)
            ach = await pg.evaluate("document.body.innerText.includes('Voll ausgestattet')")
            ok('G1 Erfolg "Voll ausgestattet" nach allen Käufen eines Hubs und des Spiels', ach)
            ok('G2 Alle sieben Verbesserungen in Hub 1 auf der höchsten Stufe', await pg.evaluate("(()=>{const F=__lm.fx,h=__lm.hubs()[0]; return F.hl(h,'cap')===2&&F.hl(h,'zone')>=F.ZMAX&&F.hl(h,'nav')===3&&F.hl(h,'motor')&&F.hl(h,'quick')&&F.hl(h,'boxes')&&F.hl(h,'service')})()"))

            # ================= H: Handy =================
            ctxm = await newctx(b, (390, 780))
            pgm, errsm, st2 = await start_game(ctxm, 'Tim Handy', 'hy@example.de'); ok('H0 Spiel am Handy startet', st2)
            await pgm.evaluate("__lm.setCash(5000)"); await pgm.evaluate(place_hub_js)
            await pgm.evaluate("()=>{const b=[...document.querySelectorAll('#tabbar button')].find(x=>/Fahrer/.test(x.textContent)); if (b) b.click()}"); await pgm.wait_for_timeout(500)
            await pgm.click('#dlist .hubup >> nth=0'); await wait_vis(pgm, '#win'); await pgm.wait_for_timeout(300)
            geo = await pgm.evaluate("""()=>{const w=document.getElementById('win').getBoundingClientRect(), t=document.getElementById('hqTabs'); return {docW:document.documentElement.scrollWidth, vw:innerWidth, winL:w.left, winR:w.right, tabsFit:t.scrollWidth<=t.clientWidth+1, tabsW:t.scrollWidth, tabsC:t.clientWidth}}""")
            ok('H1 Fenster liegt am Handy im Bild, kein Seitwärts-Scrollen', geo['docW'] <= geo['vw'] and geo['winL'] >= 0 and geo['winR'] <= geo['vw'], str(geo))
            ok('H2 Alle vier Reiter erreichbar (passen oder scrollen)', len(await pgm.evaluate(TABS)) == 4, str(geo))
            rowsm = await pgm.evaluate("""()=>[...document.querySelectorAll('#tab-up .upg')].map(r=>{const b=r.querySelector('button').getBoundingClientRect(), w=document.getElementById('win').getBoundingClientRect(); return b.right<=w.right+1 && r.scrollWidth<=r.clientWidth+1})""")
            ok('H3 Zeilen und Knöpfe laufen am Handy nicht über', all(rowsm), str(rowsm))
            await pgm.screenshot(path=OUT + 'upg_mobile.png')
            ok('H4 Keine Skriptfehler am Handy', not errsm, str(errsm[:3]))
            ok('Z Keine Skriptfehler', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
