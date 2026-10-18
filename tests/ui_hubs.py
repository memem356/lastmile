"""Rechte Spalte: Hauptquartiere als aufklappbare Gruppen mit ihren Fahrern.
Start: python3 tests/ui_hubs.py   (Ports 8394 / 9294; Kartenbild mit ?nobase abgeschaltet)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9294'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8394/index.html?debug&nobase'
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


# Ausgabe der Hub-Gruppen als einfache Daten: [{name, open, count, sum, cards:[Nummer…], visibleCards, add}]
BOXES = """()=>[...document.querySelectorAll('#dlist .hubbox')].map(b=>{
  const q=s=>b.querySelector(s), vis=e=>!!e&&e.offsetParent!==null;
  return {name:q('.hname').textContent, open:q('.hubhead').getAttribute('aria-expanded')==='true', count:q('.hcount').textContent, sum:q('.hsum').textContent,
    cards:[...b.querySelectorAll('.dcard strong')].map(e=>e.textContent), visibleCards:[...b.querySelectorAll('.dcard')].filter(vis).length,
    add:vis(q('.hadd'))?q('.hadd').textContent:null, empty:vis(q('.hubbody > p.note')), bodyHidden:q('.hubbody').hidden}})"""


async def place_second_hub(pg):
    """setzt genau einen weiteren Hub (Knoten 650 bis 900 m vom Hauptquartier, der Karte und Straße zulässt)"""
    await pg.evaluate("""()=>{const E=__lm.E; __lm.setCash(5000); const n0=__lm.hubs().length;
      for (let i=0;i<E.N&&__lm.hubs().length===n0;i++){const d=Math.hypot(E.nx[i]-E.HUB.x,E.ny[i]-E.HUB.y); if (d>650&&d<900) __lm.placeHub(E.nx[i],E.ny[i]);}}""")
    return await pg.evaluate("__lm.hubs().length")


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9294'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8394', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R = []

    def ok(name, cond, info=''):
        R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()

            # ================= A: ein Hauptquartier =================
            ctx = await newctx(b); pg, errs, started = await start_game(ctx, 'Tim Hubs', 'hb@example.de')
            ok('A0 Spiel startet', started)
            ok('A1 Überschrift "Hauptquartiere"', 'Hauptquartiere' in await pg.evaluate("document.querySelector('#dcount').parentElement.textContent"))
            bx = await pg.evaluate(BOXES)
            ok('A2 Genau eine Gruppe: Hub 1 mit Zusatz Hauptquartier', len(bx) == 1 and bx[0]['name'].startswith('Hub 1') and 'Hauptquartier' in bx[0]['name'], str(bx))
            ok('A3 Gruppe ist offen, Fahrer 1 sichtbar', bx[0]['open'] and bx[0]['cards'] == ['Fahrer 1'] and bx[0]['visibleCards'] == 1, str(bx))
            ok('A4 Kopf zeigt Belegung und Lage (1 / 4, 1 frei)', bx[0]['count'] == '1 / 4' and bx[0]['sum'] == '1 frei', str(bx))
            ok('A5 Gesamtzähler bleibt "1 / 4"', await txt(pg, '#dcount') == '1 / 4')
            ok('A6 Kopf ist ein Knopf mit aria-controls auf den Inhalt', await pg.evaluate("(()=>{const h=document.querySelector('.hubhead');return h.tagName==='BUTTON'&&document.getElementById(h.getAttribute('aria-controls'))===document.querySelector('.hubbody')})()"))
            ok('A7 Einstellen-Knopf in der Gruppe nennt freie Plätze', bx[0]['add'] == 'Hier Fahrer einstellen (3 Plätze frei)', str(bx[0]['add']))
            await pg.screenshot(path=OUT + 'hub_one.png')
            # zuklappen
            await pg.click('.hubhead'); await pg.wait_for_timeout(200)
            bx = await pg.evaluate(BOXES)
            ok('A8 Zuklappen blendet die Fahrer aus', not bx[0]['open'] and bx[0]['visibleCards'] == 0 and bx[0]['bodyHidden'], str(bx))
            ok('A9 Zusammenfassung im Kopf bleibt sichtbar', bx[0]['count'] == '1 / 4' and bx[0]['sum'] == '1 frei')
            ok('A10 Wahl wird gemerkt', await pg.evaluate("localStorage.getItem('lm-hubopen')") == '{"0":false}')
            await pg.evaluate("__lm.push(false)")
            await pg.reload(); await pg.wait_for_timeout(1500); await wait_app(pg)
            bx = await pg.evaluate(BOXES)
            ok('A11 Nach Neuladen bleibt die Gruppe zu', len(bx) == 1 and not bx[0]['open'] and bx[0]['visibleCards'] == 0, str(bx))
            await pg.focus('.hubhead'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
            ok('A12 Mit Tastatur (Enter) aufklappbar', (await pg.evaluate(BOXES))[0]['open'])
            # Lage im Kopf
            await pg.evaluate("__lm.setCash(5000)"); await hire(pg, 'scooter'); await hire(pg, 'bike')
            bx = await pg.evaluate(BOXES)
            ok('A13 Drei Fahrer in Hub 1, nach Nummer sortiert', bx[0]['cards'] == ['Fahrer 1', 'Fahrer 2', 'Fahrer 3'] and bx[0]['count'] == '3 / 4' and bx[0]['sum'] == '3 frei', str(bx))
            await pg.click('#dlist .dcard >> nth=1'); await wait_vis(pg, '#winDrv'); await pg.click('#dwPBtn'); await pg.wait_for_timeout(300); await pg.keyboard.press('Escape')
            bx = await pg.evaluate(BOXES)
            ok('A14 Pause erscheint im Kopf (2 frei · 1 in Pause)', bx[0]['sum'] == '2 frei · 1 in Pause', bx[0]['sum'])
            ok('A15 Es gibt Bestellungen', await wait_for(pg, "document.querySelectorAll('#olist .ocard').length>0", 15000))
            await pg.keyboard.press('a'); await pg.wait_for_timeout(500)
            bx = await pg.evaluate(BOXES)
            ok('A16 Lieferung erscheint im Kopf (1 frei · 1 unterwegs · 1 in Pause)', bx[0]['sum'] == '1 frei · 1 unterwegs · 1 in Pause', bx[0]['sum'])
            await hire(pg, 'bike')
            bx = await pg.evaluate(BOXES)
            ok('A17 Hub voll: kein Einstellen-Knopf mehr in der Gruppe', bx[0]['count'] == '4 / 4' and bx[0]['add'] is None, str(bx[0]))

            # ================= B: zweites Hauptquartier =================
            ok('B0 Zweiter Hub wird gebaut', await place_second_hub(pg) == 2); await pg.wait_for_timeout(500)
            bx = await pg.evaluate(BOXES)
            ok('B1 Zweite Gruppe "Hub 2" ohne Zusatz', len(bx) == 2 and bx[1]['name'] == 'Hub 2', str(bx))
            ok('B2 Leerer neuer Hub ist offen und zeigt Hinweis und Einstellen-Knopf', bx[1]['open'] and bx[1]['empty'] and bx[1]['add'] == 'Hier Fahrer einstellen (4 Plätze frei)' and bx[1]['count'] == '0 / 4' and bx[1]['sum'] == 'Keine Fahrer', str(bx[1]))
            ok('B3 Gesamtzähler zählt beide Hubs (4 / 8)', await txt(pg, '#dcount') == '4 / 8')
            ok('B4 Hub 1 bleibt, wie er war (offen, 4 Fahrer)', bx[0]['open'] and len(bx[0]['cards']) == 4)
            await pg.click('#dlist .hubbox:nth-child(2) .hadd'); await pg.wait_for_timeout(300)
            ok('B5 "Hier einstellen" wählt Hub 2 im Einstellen-Block', await pg.evaluate("document.getElementById('hireHub').value") == '1')
            await pg.select_option('#hireVeh', 'bike'); await pg.click('#hireBtn'); await pg.wait_for_timeout(400)
            bx = await pg.evaluate(BOXES)
            ok('B6 Neuer Fahrer steht in Hub 2', bx[1]['cards'] == ['Fahrer 5'] and bx[1]['count'] == '1 / 4' and len(bx[0]['cards']) == 4, str([x['cards'] for x in bx]))
            ok('B7 Der neue Fahrer ist gewählt (Rahmen)', await pg.evaluate("document.querySelector('#dlist .hubbox:nth-child(2) li.driver.sel')!==null"))
            await pg.screenshot(path=OUT + 'hub_two.png')
            # Fahrer wechselt den Hub
            await pg.evaluate("__lm.drivers()[0].hub=1"); await hire(pg, 'bike')
            bx = await pg.evaluate(BOXES)
            ok('B8 Wechselt ein Fahrer den Hub, zieht seine Karte um (sortiert)', bx[1]['cards'][:2] == ['Fahrer 1', 'Fahrer 5'] and 'Fahrer 1' not in bx[0]['cards'], str([x['cards'] for x in bx]))
            # Auswahl auf der Karte klappt den Hub auf
            await pg.click('#dlist .hubbox:nth-child(2) .hubhead'); await pg.wait_for_timeout(200)
            ok('B9 Hub 2 lässt sich zuklappen, Hub 1 bleibt offen', (await pg.evaluate(BOXES))[1]['visibleCards'] == 0 and (await pg.evaluate(BOXES))[0]['open'])
            await pg.evaluate("__lm.view.fit(); document.getElementById('mapwrap').scrollIntoView()"); await pg.wait_for_timeout(900)
            pos = await pg.evaluate("()=>{const d=__lm.drivers().find(x=>x.id===5); const p=__lm.view.px(d.node); const r=document.getElementById('map').getBoundingClientRect(); return [r.left+p[0], r.top+p[1]]}")
            await pg.mouse.click(pos[0], pos[1]); await wait_vis(pg, '#winDrv')
            ok('B10 Klick auf einen Fahrer von Hub 2 auf der Karte öffnet sein Fenster', await vis(pg, '#winDrv') and (await txt(pg, '#winT')).startswith('Fahrer '), f"pos={pos} win={await txt(pg, '#winT')} cam={await pg.evaluate('JSON.stringify([__lm.view.cam.s,__lm.view.size()])')}")
            ok('B11 ... und klappt seinen Hub auf', (await pg.evaluate(BOXES))[1]['open'])
            await pg.keyboard.press('Escape')
            # Kündigen: Gruppe aktualisiert sich
            # ein Fahrer mit Fahrt kann nicht gekündigt werden (Knopf gesperrt): die erste Karte eines freien Fahrers nehmen
            for k in range(6):
                await pg.click('#dlist .hubbox:nth-child(2) .dcard >> nth=%d' % k); await wait_vis(pg, '#winDrv')
                if await pg.evaluate("!document.getElementById('dwFBtn').disabled"): break
                await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
            fired = (await txt(pg, '#winT')).split(' · ')[0]
            await pg.click('#dwFBtn'); await pg.click('#dwFBtn'); await pg.wait_for_timeout(400)
            bx = await pg.evaluate(BOXES)
            ok('B12 Kündigung nimmt den Fahrer aus seiner Gruppe', fired.startswith('Fahrer ') and not any(fired in x['cards'] for x in bx) and len(bx[1]['cards']) == 2, fired + str([x['cards'] for x in bx]))
            ok('B13 Keine Skriptfehler', not errs, str(errs[:3]))
            await pg.close(); await ctx.close()

            # ================= C: Handy =================
            ctx = await newctx(b, vw=(390, 780)); pg, errs, started = await start_game(ctx, 'Tim Handy', 'hh@example.de')
            await pg.evaluate("__lm.setCash(5000)")
            await pg.evaluate("()=>{const b=[...document.querySelectorAll('#tabbar button')].find(x=>/Fahrer/.test(x.textContent)); if (b) b.click()}"); await pg.wait_for_timeout(500)
            await hire(pg, 'bike'); await place_second_hub(pg); await pg.wait_for_timeout(400)
            ok('C1 Handy: zwei Gruppen sichtbar', len(await pg.evaluate(BOXES)) == 2 and await vis(pg, '#dlist .hubhead'))
            await pg.screenshot(path=OUT + 'hub_mobile.png')
            ok('C2 Handy: kein seitliches Scrollen', await pg.evaluate("document.documentElement.scrollWidth<=document.documentElement.clientWidth+1"))
            await pg.click('#dlist .hubhead >> nth=0'); await pg.wait_for_timeout(200)
            ok('C3 Handy: Zuklappen funktioniert', not (await pg.evaluate(BOXES))[0]['open'])
            ok('C4 Handy: keine Skriptfehler', not errs, str(errs[:3]))
            await pg.close(); await ctx.close()
            await b.close()
        failed = [n for n, c in R if not c]
        print('\n%d/%d bestanden' % (len(R) - len(failed), len(R)))
        for n in failed: print('FEHLER:', n)
        return 1 if failed else 0
    finally:
        srv.terminate(); web.terminate()

sys.exit(asyncio.run(main()))
