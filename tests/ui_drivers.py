"""Fahrer kündigen, Fahrer in Pause schicken, Tastenkürzel im Menü.
Start: python3 tests/ui_drivers.py   (Ports 8395 / 9295; das Kartenbild ist mit ?nobase abgeschaltet, damit der Test ohne Kartenanbieter läuft)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9295'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8395/index.html?debug&nobase'
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


DRV = "()=>__lm.drivers().map(d=>({id:d.id,veh:d.veh,rest:d.rest||null,trip:!!d.trip,train:!!d.train,hub:d.hub}))"
txt = lambda pg, sel: pg.evaluate("s=>document.querySelector(s)?document.querySelector(s).textContent:null", sel)


async def hire(pg, veh):
    await pg.select_option('#hireVeh', veh); await pg.click('#hireBtn'); await pg.wait_for_timeout(250)


async def open_drv(pg, nth):
    await pg.click(f'#dlist li:nth-child({nth}) button'); await wait_vis(pg, '#winDrv'); await pg.wait_for_timeout(150)


async def wage_rate(pg, secs=3):
    """gezahlter Lohn je Spielstunde (aus Lohnkonto und Spieluhr); wiederholt, falls zwischendurch abgebucht wurde"""
    for _ in range(5):
        a = await pg.evaluate("()=>[__lm.bill.wage,__lm.sim()]"); await pg.wait_for_timeout(secs * 1000)
        b = await pg.evaluate("()=>[__lm.bill.wage,__lm.sim()]")
        if b[0] >= a[0] and b[1] > a[1]: return (b[0] - a[0]) / ((b[1] - a[1]) / 3600)
    return None


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9295'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8395', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R = []

    def ok(name, cond, info=''):
        R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()

            # ================= A: Kündigen =================
            ctx = await newctx(b); pg, errs, started = await start_game(ctx, 'Tim Kuend', 'ku@example.de')
            ok('A0 Spiel startet', started)
            await pg.evaluate("__lm.setCash(5000)")
            await hire(pg, 'scooter'); await hire(pg, 'van')
            ds = await pg.evaluate(DRV)
            ok('A1 Drei Fahrer mit den Nummern 1, 2, 3', [d['id'] for d in ds] == [1, 2, 3], str(ds))
            await open_drv(pg, 2)
            await pg.screenshot(path=HERE + 'out/dr_window.png')
            ok('A2 Fahrerfenster hat Pause- und Kündigen-Bereich', await vis(pg, '#dwPBtn') and await vis(pg, '#dwFBtn'))
            t = await txt(pg, '#dwFBtn')
            ok('A3 Kündigen-Knopf nennt den Verkaufserlös (Roller: 120 €)', t.startswith('Fahrer kündigen') and '120' in t, t)
            ok('A4 Kündigen ist möglich (Fahrer frei, mehr als einer)', not await pg.evaluate("document.getElementById('dwFBtn').disabled"))
            await pg.click('#dwFBtn'); await pg.wait_for_timeout(200)
            ok('A5 Erster Klick fragt nach, es passiert noch nichts', 'Wirklich' in await txt(pg, '#dwFBtn') and len(await pg.evaluate(DRV)) == 3)
            await pg.wait_for_timeout(6400)
            ok('A6 Die Rückfrage verfällt nach einigen Sekunden', (await txt(pg, '#dwFBtn')).startswith('Fahrer kündigen') and len(await pg.evaluate(DRV)) == 3)
            v0 = await pg.evaluate("__lm.value()"); c0 = await pg.evaluate("__lm.cash()")
            await pg.click('#dwFBtn'); await pg.wait_for_timeout(100); await pg.click('#dwFBtn'); await pg.wait_for_timeout(500)
            ds = await pg.evaluate(DRV); c1 = await pg.evaluate("__lm.cash()"); v1 = await pg.evaluate("__lm.value()")
            ok('A7 Zweiter Klick kündigt Fahrer 2', [d['id'] for d in ds] == [1, 3], str(ds))
            ok('A8 Fahrzeug wurde zum halben Preis verkauft (+120 €)', abs((c1 - c0) - 120) < 1, f'{c1 - c0:.2f}')
            ok('A9 Unternehmenswert sinkt um den Wertverlust (−120 €)', abs((v1 - v0) + 120) < 1, f'{v1 - v0:.2f}')
            ok('A10 Fenster schließt sich, Karte aus der Liste entfernt', not await vis(pg, '#win') and await pg.evaluate("[...document.querySelectorAll('#dlist .dcard strong')].map(e=>e.textContent).join()") == 'Fahrer 1,Fahrer 3')
            ok('A11 Protokoll nennt die Kündigung', 'Fahrer 2 gekündigt' in await pg.evaluate("document.querySelector('#log li span').textContent"))
            ok('A12 Zähler zeigt 2 Fahrer', (await txt(pg, '#dcount')).startswith('2 /'))
            await hire(pg, 'bike')
            ds = await pg.evaluate(DRV)
            ok('A13 Neue Fahrernummer wird nicht neu vergeben (4 statt 2)', [d['id'] for d in ds] == [1, 3, 4], str(ds))
            # während einer Lieferung nicht kündbar
            await pg.evaluate("__lm.setCash(5000)")
            ok('A14 Es gibt offene Bestellungen', await wait_for(pg, "document.querySelectorAll('#olist .ocard').length>0", 15000))
            if not await pg.evaluate("!!document.querySelector('#olist .order.sel')"): await pg.click('#olist .ocard')
            await pg.wait_for_timeout(200)
            await pg.click('#olist .assign button.btn >> nth=0'); await pg.wait_for_timeout(400)
            busy = [d for d in await pg.evaluate(DRV) if d['trip']]
            ok('A15 Ein Fahrer hat jetzt eine Lieferung', len(busy) == 1, str(busy))
            idx = [d['id'] for d in await pg.evaluate(DRV)].index(busy[0]['id']) + 1
            await open_drv(pg, idx)
            ok('A16 Während der Lieferung ist Kündigen gesperrt, mit Erklärung', await pg.evaluate("document.getElementById('dwFBtn').disabled") and 'Lieferung' in await txt(pg, '#dwFInfo'), await txt(pg, '#dwFInfo'))
            # Pause vormerken während der Lieferung
            await pg.click('#dwPBtn'); await pg.wait_for_timeout(300)
            d1 = [d for d in await pg.evaluate(DRV) if d['id'] == busy[0]['id']][0]
            ok('A17 Pause während der Lieferung wird nur vorgemerkt', d1['rest'] == 'wait' and d1['trip'], str(d1))
            ok('A18 Knopf bietet "Pause abbrechen"', await txt(pg, '#dwPBtn') == 'Pause abbrechen')
            ok('A19 Fahrerkarte nennt "danach Pause"', 'danach Pause' in await pg.evaluate("[...document.querySelectorAll('#dlist .d-line')][%d].textContent" % (idx - 1)))
            await pg.click('#dwPBtn'); await pg.wait_for_timeout(300)
            ok('A20 Pause abgebrochen', [d for d in await pg.evaluate(DRV) if d['id'] == busy[0]['id']][0]['rest'] is None)
            await pg.keyboard.press('Escape')
            await pg.close(); await ctx.close()

            # ================= B: Pause =================
            ctx = await newctx(b); pg, errs, started = await start_game(ctx, 'Tim Pause', 'pa@example.de')
            await pg.evaluate("__lm.setCash(5000)"); await hire(pg, 'bike')
            r_full = await wage_rate(pg)
            ok('B1 Lohn für zwei Fahrräder: 16 € je Spielstunde', r_full is not None and abs(r_full - 16) < 0.5, str(r_full))
            await open_drv(pg, 2)
            ok('B2 Knopf heißt "In Pause schicken"', await txt(pg, '#dwPBtn') == 'In Pause schicken')
            await pg.click('#dwPBtn'); await pg.wait_for_timeout(400)
            ds = await pg.evaluate(DRV)
            ok('B3 Freier Fahrer geht sofort in Pause', ds[1]['rest'] == 'on', str(ds))
            ok('B4 Karte und Fenster zeigen "In Pause"', await txt(pg, '#dwPill') == 'In Pause' and 'kein Lohn' in await txt(pg, '#dwLine'), await txt(pg, '#dwLine'))
            ok('B5 Knopf heißt jetzt "Einbestellen", Lohnzeile zeigt 0,00 €', await txt(pg, '#dwPBtn') == 'Einbestellen' and '0,00' in await txt(pg, '#dwWage'), await txt(pg, '#dwWage'))
            r_half = await wage_rate(pg)
            ok('B6 In Pause kostet der Fahrer keinen Lohn (8 € je Spielstunde statt 16 €)', r_half is not None and abs(r_half - 8) < 0.5, str(r_half))
            ok('B7 Fahrer in Pause nimmt keine Schulung an', await pg.evaluate("document.getElementById('dwTBtn').disabled"))
            await pg.keyboard.press('Escape')
            ok('B8 Es gibt Bestellungen', await wait_for(pg, "document.querySelectorAll('#olist .ocard').length>0", 15000))
            if not await pg.evaluate("!!document.querySelector('#olist .order.sel')"): await pg.click('#olist .ocard')
            await pg.wait_for_timeout(300)
            n_opt = await pg.evaluate("document.querySelectorAll('#olist .assign button.btn').length")
            ok('B9 Bestellung wird nur dem Fahrer im Dienst angeboten', n_opt == 1, str(n_opt))
            # automatische Disposition
            await pg.evaluate("__lm.owned.dispatch=true;__lm.auto(true)"); await pg.wait_for_timeout(1500)
            ds = await pg.evaluate(DRV)
            ok('B10 Auto-Disposition überspringt den Fahrer in Pause', ds[0]['trip'] and not ds[1]['trip'] and ds[1]['rest'] == 'on', str(ds))
            await pg.evaluate("__lm.auto(false)")
            # Abwesenheit
            await pg.evaluate("__lm.auto(true)")
            rep = await pg.evaluate("__lm.absence(50)")
            ok('B11 Abwesenheitsmodell: Lohn nur für den Fahrer im Dienst (3,33 €)', rep['worked'] and abs(rep['wages'] - 8 * 1500 / 3600) < 0.05, json.dumps(rep))
            await pg.click('#dlist li:nth-child(2) button'); await wait_vis(pg, '#winDrv')
            await pg.click('#dwPBtn'); await pg.wait_for_timeout(300)
            ds = await pg.evaluate(DRV)
            ok('B12 Einbestellen: Fahrer ist wieder im Dienst', ds[1]['rest'] is None)
            rep = await pg.evaluate("__lm.absence(50)")
            ok('B13 Abwesenheitsmodell: beide im Dienst (6,67 €)', rep['worked'] and abs(rep['wages'] - 16 * 1500 / 3600) < 0.05, json.dumps(rep))
            r_full2 = await wage_rate(pg)
            ok('B14 Nach dem Einbestellen wieder voller Lohn', r_full2 is not None and abs(r_full2 - 16) < 0.5, str(r_full2))
            await pg.keyboard.press('Escape')
            # beide in Pause: kein Lohn, Abwesenheit arbeitet nicht
            for i in (1, 2):
                await pg.click(f'#dlist li:nth-child({i}) button'); await wait_vis(pg, '#winDrv'); await pg.wait_for_timeout(100)
                if await txt(pg, '#dwPBtn') == 'Pause abbrechen': await pg.click('#dwPBtn'); await pg.wait_for_timeout(100)
                await pg.click('#dwPBtn'); await pg.wait_for_timeout(200)
            await pg.keyboard.press('Escape')
            await wait_for(pg, "__lm.drivers().every(d=>d.rest==='on'||d.rest==='wait')", 90000, 500)
            await wait_for(pg, "__lm.drivers().every(d=>d.rest==='on')", 120000, 500)
            ok('B15 Beide Fahrer in Pause (nach Ende ihrer Fahrten)', await pg.evaluate("__lm.drivers().every(d=>d.rest==='on')"))
            r0 = await wage_rate(pg)
            ok('B16 Ohne Fahrer im Dienst fällt kein Lohn an', r0 is not None and r0 < 0.01, str(r0))
            rep = await pg.evaluate("__lm.absence(50)")
            ok('B17 Abwesenheitsmodell: nichts ausgeliefert, kein Lohn', not rep['worked'] and rep['wages'] == 0, json.dumps(rep))
            ok('B18 Keine Skriptfehler', not errs, str(errs[:3]))
            await pg.close(); await ctx.close()

            # ================= C: Speichern und Neuladen =================
            ctx = await newctx(b); pg, errs, started = await start_game(ctx, 'Tim Save', 'sv@example.de')
            await pg.evaluate("__lm.setCash(5000)"); await hire(pg, 'scooter'); await hire(pg, 'bike')
            await open_drv(pg, 2); await pg.click('#dwPBtn'); await pg.wait_for_timeout(300); await pg.keyboard.press('Escape')
            await open_drv(pg, 3); await pg.click('#dwFBtn'); await pg.click('#dwFBtn'); await pg.wait_for_timeout(400)
            ds = await pg.evaluate(DRV)
            ok('C1 Vorher: Fahrer 1 und 2, Nummer 2 in Pause, Nummer 3 gekündigt', [(d['id'], d['rest']) for d in ds] == [(1, None), (2, 'on')], str(ds))
            saved = await pg.evaluate("__lm.push(false)")
            ok('C2 Cloud-Speichern klappt', saved is True or saved)
            await pg.reload(); await pg.wait_for_timeout(1500); ok('C3 Spiel startet nach Neuladen', await wait_app(pg))
            ds = await pg.evaluate(DRV)
            ok('C4 Nachher: Pause bleibt erhalten', [(d['id'], d['rest']) for d in ds] == [(1, None), (2, 'on')], str(ds))
            ok('C5 Fahrerkarte zeigt weiter "In Pause"', 'In Pause' in await pg.evaluate("[...document.querySelectorAll('#dlist .pill')].map(e=>e.textContent).join()"))
            await pg.evaluate("__lm.setCash(5000)"); await hire(pg, 'bike')
            ds = await pg.evaluate(DRV)
            ok('C6 Gekündigte Nummer 3 bleibt vergeben: neuer Fahrer ist Nummer 4', [d['id'] for d in ds] == [1, 2, 4], str(ds))
            ok('C7 Keine Skriptfehler', not errs, str(errs[:3]))
            await pg.close(); await ctx.close()

            # ================= D: letzter Fahrer, Tastenkürzel =================
            ctx = await newctx(b); pg, errs, started = await start_game(ctx, 'Tim Keys', 'ke@example.de')
            await open_drv(pg, 1)
            ok('D1 Der einzige Fahrer kann nicht gekündigt werden', await pg.evaluate("document.getElementById('dwFBtn').disabled") and 'letzter' in await txt(pg, '#dwFInfo'), await txt(pg, '#dwFInfo'))
            await pg.keyboard.press('Escape')
            ok('D2 Unter der rechten Spalte stehen keine Tastenhinweise mehr', await pg.evaluate("!document.querySelector('.keys')") and 'Leertaste' not in await pg.evaluate("document.querySelector('aside').innerText"))
            await pg.click('#menuBtn'); await pg.wait_for_timeout(300)
            names = await pg.evaluate("[...document.querySelectorAll('#dlgB button.btn')].map(b=>b.textContent)")
            ok('D3 Menü hat den Punkt "Tastenkürzel"', 'Tastenkürzel' in names, str(names))
            await pg.click('#dlgB button.btn >> text=Tastenkürzel'); await pg.wait_for_timeout(300)
            ok('D4 Dialog "Tastenkürzel" ist offen', await vis(pg, '#dlg') and await txt(pg, '#dlgT') == 'Tastenkürzel')
            keys = await pg.evaluate("[...document.querySelectorAll('#dlgB kbd')].map(k=>k.textContent)")
            ok('D5 Alle Kürzel sind aufgeführt', all(k in keys for k in ['A', '↑', '↓', 'F', 'W', 'H', 'T', 'K', 'Esc', '+', '−']), str(keys))
            ok('D6 Online gibt es keine Leertasten-Pause im Dialog', 'Leertaste' not in keys)
            await pg.screenshot(path=HERE + 'out/dr_keys.png')
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
            ok('D7 Esc schließt den Dialog', not await vis(pg, '#dlg'))
            # Kürzel funktionieren weiter
            await pg.keyboard.press('k'); await pg.wait_for_timeout(200)
            ok('D8 Taste K öffnet Finanzen und Statistik', await vis(pg, '#winSt'))
            await pg.keyboard.press('k'); await pg.wait_for_timeout(200)
            ok('D9 Taste K schließt sie wieder', not await vis(pg, '#win'))
            before = await pg.evaluate("document.getElementById('heatBtn').getAttribute('aria-pressed')")
            await pg.keyboard.press('h'); await pg.wait_for_timeout(150)
            ok('D10 Taste H schaltet die Nachfragekarte um', before != await pg.evaluate("document.getElementById('heatBtn').getAttribute('aria-pressed')"))
            await pg.keyboard.press('h')
            ok('D11 Es gibt Bestellungen', await wait_for(pg, "document.querySelectorAll('#olist .ocard').length>0", 15000))
            await pg.keyboard.press('a'); await pg.wait_for_timeout(400)
            ok('D12 Taste A weist den schnellsten Fahrer zu', any(d['trip'] for d in await pg.evaluate(DRV)))
            ok('D13 Keine Skriptfehler', not errs, str(errs[:3]))
            await pg.close(); await ctx.close()
            # ================= E: Handy =================
            ctx = await newctx(b, vw=(390, 780)); pg, errs, started = await start_game(ctx, 'Tim Handy', 'hd@example.de')
            await pg.evaluate("__lm.setCash(5000)")
            await pg.evaluate("()=>{const b=document.querySelector('#tabbar [data-t=\"drivers\"]')||[...document.querySelectorAll('#tabbar button')].find(x=>/Fahrer/.test(x.textContent)); if (b) b.click()}"); await pg.wait_for_timeout(500)
            await hire(pg, 'bike')
            await pg.click('#dlist li:nth-child(2) button'); await wait_vis(pg, '#winDrv'); await pg.wait_for_timeout(400)
            await pg.evaluate("document.getElementById('dwFBtn').scrollIntoView()"); await pg.wait_for_timeout(200)
            await pg.screenshot(path=HERE + 'out/dr_mobile.png')
            ok('E1 Handy: Fahrerfenster ohne seitliches Scrollen', await pg.evaluate("document.documentElement.scrollWidth<=document.documentElement.clientWidth+1"))
            ok('E2 Handy: Kündigen-Knopf erreichbar', await vis(pg, '#dwFBtn'))
            await pg.close(); await ctx.close()
            await b.close()
        failed = [n for n, c in R if not c]
        print('\n%d/%d bestanden' % (len(R) - len(failed), len(R)))
        for n in failed: print('FEHLER:', n)
        return 1 if failed else 0
    finally:
        srv.terminate(); web.terminate()

sys.exit(asyncio.run(main()))
