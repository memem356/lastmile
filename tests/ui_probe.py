"""Stadt-Test auf der Startseite (?probe=Name): lädt Stichproben einer Stadt aus einer künstlichen Welt und zeigt Zahlen.
Start: python3 tests/ui_probe.py   (Port 8395)"""
import asyncio, json, re, subprocess, os, time
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8395/index.html?probe=Teststadt'
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
J = {'content-type': 'application/json', **CORS}
LA0, LO0 = 51.40, 6.95
poly = [[LO0, LA0], [LO0 + 0.09, LA0], [LO0 + 0.09, LA0 + 0.05], [LO0, LA0 + 0.05], [LO0, LA0]]     # ca. 6,3 x 5,5 km
calls = {'roads': 0, 'firms': 0, 'isin': 0, 'lookup': 0}


def bbox(q):
    m = re.search(r'\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)', q); return [float(x) for x in m.groups()]


def roads(b):
    s, w, n, e = b; els = []; k = 0; nid = 1000000
    lat = s + 0.0003
    while lat < n:
        ids = []
        lon = w + 0.0003
        while lon < e:
            nid += 1; els.append({'type': 'node', 'id': nid, 'lat': lat, 'lon': lon}); ids.append(nid); lon += 0.0008
        if len(ids) > 1: k += 1; els.append({'type': 'way', 'id': 5000000 + int(lat * 1e5), 'nodes': ids, 'tags': {'highway': 'residential', 'name': 'Weg %d' % k}})
        lat += 0.0008
    return {'elements': els}


async def overpass(route, request):
    q = request.post_data or ''
    from urllib.parse import unquote
    q = unquote(q.replace('data=', '', 1))
    if 'is_in(' in q: calls['isin'] += 1; return await route.fulfill(status=200, headers=J, body=json.dumps({'elements': [{'type': 'relation', 'id': 4242, 'tags': {'boundary': 'administrative', 'admin_level': '8', 'name': 'Teststadt'}}]}))
    if '["highway"' in q: calls['roads'] += 1; return await route.fulfill(status=200, headers=J, body=json.dumps(roads(bbox(q))))
    if '["office"]' in q:
        calls['firms'] += 1; b = bbox(q); return await route.fulfill(status=200, headers=J, body=json.dumps({'elements': [{'type': 'node', 'id': 9000000 + i, 'lat': (b[0] + b[2]) / 2 + i * 0.0005, 'lon': (b[1] + b[3]) / 2, 'tags': {'name': 'Firma %d' % i, 'office': 'company'}} for i in range(12)]}))
    await route.fulfill(status=200, headers=J, body='{"elements":[]}')


async def nominatim(route, request):
    u = request.url
    if 'lookup' in u: calls['lookup'] += 1; return await route.fulfill(status=200, headers=J, body=json.dumps([{'name': 'Teststadt', 'lat': str(LA0 + 0.025), 'lon': str(LO0 + 0.045), 'geojson': {'type': 'Polygon', 'coordinates': [poly]}}]))
    await route.fulfill(status=200, headers=J, body=json.dumps([{'name': 'Teststadt', 'display_name': 'Teststadt, Testland', 'lat': str(LA0 + 0.025), 'lon': str(LO0 + 0.045), 'address': {'city': 'Teststadt', 'country': 'Testland'}}]))


async def main():
    ok = bad = 0
    def check(n, c, info=''):
        nonlocal ok, bad
        if c: ok += 1
        else: bad += 1; print('FAIL', n, info)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8395', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1000, 'height': 900})
            await ctx.route(re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*'), lambda r, q: r.abort())
            await ctx.route(re.compile(r'https://nominatim\.openstreetmap\.org/.*'), nominatim)
            await ctx.route(re.compile(r'https://([^/]*overpass[^/]*|maps\.mail\.ru)/.*'), overpass)
            pg = await ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.add_init_script("localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
            await pg.goto(URL); await pg.wait_for_timeout(1500)
            check('P1 Test-Knopf sichtbar', await pg.evaluate("!!document.getElementById('probeGo') && document.getElementById('probeGo').offsetParent!==null"))
            check('P2 Knopf trägt den Namen', 'Teststadt' in await pg.inner_text('#probeGo'))
            check('P2b Im Stadt-Test-Modus keine Anmeldung und kein Startort-Auswahlfenster (Spielstand startet nicht von selbst)', await pg.evaluate("document.getElementById('authBox').hidden && document.getElementById('pickBox').hidden && document.getElementById('app').hidden"))
            check('P2c Link "Zum Spiel" führt auf die Seite ohne ?probe=', await pg.evaluate("(()=>{const a=document.getElementById('probeBack'); return !!a && !a.search && a.pathname===location.pathname})()"))
            await pg.click('#probeGo')
            for _ in range(80):
                t = await pg.inner_text('#probeOut')
                if 'Fertig' in t or 'Fehler' in t: break
                await pg.wait_for_timeout(250)
            t = await pg.inner_text('#probeOut'); print(t)
            check('P3 Bericht ist fertig ohne Fehler', 'Fertig' in t and 'Fehler' not in t)
            check('P4 Stadtgrenze und Fläche', 'Stadtgrenze' in t and re.search(r'Fläche (\d+(\.\d)?) km²', t) is not None and 25 < float(re.search(r'Fläche ([\d.]+) km²', t).group(1)) < 45, t[:200])
            check('P5 Schätzung für die ganze Stadt', 'Schätzung' in t and 'Knoten' in t)
            check('P6 Firmen in einer Kachel', re.search(r'Firmen in einer Kachel .*: (\d+)', t) is not None and int(re.search(r'Firmen in einer Kachel .*: (\d+)', t).group(1)) > 0)
            check('P7 Server wurden angefragt: Grenze, Straßen, Firmen', calls['isin'] == 1 and calls['lookup'] == 1 and calls['roads'] >= 3 and calls['firms'] == 1, str(calls))
            check('P8 Knopf wieder frei', not await pg.evaluate("document.getElementById('probeGo').disabled"))
            await pg.goto('http://127.0.0.1:8395/index.html'); await pg.wait_for_timeout(800)
            check('P9 ohne ?probe= kein Test-Fenster', await pg.evaluate("!document.getElementById('probeBox')"))
            check('P10 keine Skriptfehler', not [e for e in errs if 'Access is denied' not in e], errs)
            await b.close()
    finally:
        web.terminate()
    print('\n%d bestanden, %d fehlgeschlagen' % (ok, bad)); raise SystemExit(1 if bad else 0)

asyncio.run(main())
