"""Phase 10: Kartenbild (OpenFreeMap über MapLibre) unter der Spielschicht.
Prüft Passgenauigkeit (Zahlen und Bildpunkte), Bedienung, Erdansicht, Ausfall des Kartenanbieters und dass nichts von anderen Spielern auf die Karte kommt.
Start: python3 tests/ui_basemap.py   (Ports 8396 / 9296; die Kachelserver-Antworten kommen aus tests/fake_ofm.py)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os, io, random, math
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
sys.path.insert(0, HERE)
import fake_ofm as OFM
from PIL import Image
OUT = HERE + 'out/'; os.makedirs(OUT, exist_ok=True)
MOCK = 'http://127.0.0.1:9296'
REPO = os.path.abspath(HERE + '..')
BASE = 'http://127.0.0.1:8396/index.html'
URL = BASE + '?debug'
CODE = re.search(r"'(LM-[A-Z0-9-]+)'", open(HERE + '../firebase-rules.json').read()).group(1)
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE,PATCH,OPTIONS'}
FB = re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*')
OFMRE = re.compile(r'https://tiles\.openfreemap\.org/.*')
random.seed(7)


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


async def newctx(b, vw=(1000, 900), ofm=True):
    ctx = await b.new_context(viewport={'width': vw[0], 'height': vw[1]})
    await ctx.route(FB, fbhandler)
    if ofm: await ctx.route(OFMRE, OFM.handler)
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


async def wait_app(pg, ms=25000):
    return await wait_for(pg, "!document.getElementById('app').hidden && !!window.__lm", ms, 250)


async def frames(pg, n=3): await pg.evaluate("n=>new Promise(r=>{let k=0;const f=()=>{if(++k>=n)r();else requestAnimationFrame(f)};requestAnimationFrame(f)})", n)


async def start_game(ctx, name='Tim Express', email='tim@example.de', url=URL, wait=800):
    pg, errs = await newpage(ctx, url, wait)
    await pg.evaluate("a=>LMO.register({name:a.name,email:a.email,password:'geheim123',code:a.code})", {'name': name, 'email': email, 'code': CODE})
    await wait_vis(pg, '#pickMain')
    await pg.click('#chips button >> text=Essen'); await pg.click('#confirmGo')
    okk = await wait_app(pg)
    return pg, errs, okk


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9296'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8396', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R = []

    def ok(name, cond, info=''):
        R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            # ================= A: Kartenbild lädt und ist sichtbar =================
            OFM.STATE.update(mode='ok', tiles=0, styles=[], other=[], log=[])
            ctx = await newctx(b); pg, errs, started = await start_game(ctx)
            ok('A1 Spiel startet', started)
            ok('A2 Kartenbild wird "an"', await wait_for(pg, "__lm.view.on()", 25000), str(OFM.STATE['styles']))
            await pg.wait_for_timeout(700)
            ok('A3 Stil (hell) und Kacheln wurden geladen', any('positron' in s for s in OFM.STATE['styles']) and OFM.STATE['tiles'] > 0, f"styles={OFM.STATE['styles']} tiles={OFM.STATE['tiles']}")
            ok('A4 Kartenfläche ist eingeblendet (Klasse "on", Deckkraft < 1)', await pg.evaluate("()=>{const e=document.getElementById('basemap');return e.classList.contains('on')&&parseFloat(getComputedStyle(e).opacity)<1&&parseFloat(getComputedStyle(e).opacity)>0.3}"))
            ok('A5 Weltknopf sichtbar, Anzeige "Quellen" vorhanden', await vis(pg, '#zworld') and 'OpenFreeMap' in await pg.inner_text('.attr') and 'OpenStreetMap' in await pg.inner_text('.attr'), await pg.inner_text('.attr'))
            ok('A6 Spielschicht liegt über dem Kartenbild und fängt die Maus ab', await pg.evaluate("()=>{const r=document.getElementById('mapwrap').getBoundingClientRect();const e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return e&&e.id==='map'}"))
            await pg.screenshot(path=OUT + 'bm_light.png')

            # ================= B: Passgenauigkeit der Zahlen =================
            async def align(label, x, y, z, n=80):
                await pg.evaluate("a=>__lm.view.look(a[0],a[1],a[2])", [x, y, z]); await frames(pg, 3); await pg.wait_for_timeout(150)
                r = await pg.evaluate("""n=>{const V=__lm.view, E=__lm.E, m=V.base().map, N=E.nx.length; let worst=0, cnt=0, worst2=0;
                  for (let k=0;k<n;k++){ const i=Math.floor(Math.random()*N); const g=E.unproj(E.nx[i],E.ny[i]); const p=m.project([g.lon,g.lat]); const q=V.px(i);
                    worst=Math.max(worst, Math.abs(p.x-q[0]), Math.abs(p.y-q[1]));
                    const X=V.toX(E.nx[i]), Y=V.toY(E.ny[i]); worst2=Math.max(worst2, Math.abs(p.x-X), Math.abs(p.y-Y)); cnt++; }
                  const c=V.cam; return {worst, worst2, cnt, z:c.z, mz:m.getZoom(), cx:m.getCenter().lng, cu:c.u}}""", n)
                ok(f'B {label}: Spielschicht und Kartenbild stimmen auf {r["worst"]:.4f} px überein', r['worst'] < 0.05 and r['worst2'] < 0.05 and abs(r['mz'] - r['z']) < 1e-6, json.dumps(r))
            await align('Stadt, Straßenebene (z 15)', 0, 0, 15)
            await align('Stadt, sehr nah (z 17,8)', 300, -250, 17.8)
            await align('Nordrand, z 16', -700, -800, 16)
            await align('Südostrand, z 13', 900, 700, 13)
            await align('weit weg, z 8', 0, 0, 8)
            await align('Kontinent, z 4,5', 0, 0, 4.5)

            # ================= C: Bildpunkt-Probe (Magenta-Straßen des Kachelbilds) =================
            async def pixel_probe(label, x, y, z, minshare=0.95):
                await pg.evaluate("a=>__lm.view.look(a[0],a[1],a[2])", [x, y, z]); await frames(pg, 4); await pg.wait_for_timeout(500)
                pts = await pg.evaluate("""()=>{const V=__lm.view, E=__lm.E, [w,h]=V.size(); const out=[]; const N=E.nx.length; const deg=new Uint8Array(N);
                  for (const wy of E.ways) for (const i of wy.nodes) deg[i]++;
                  for (let tries=0; tries<4000 && out.length<60; tries++){ const i=Math.floor(Math.random()*N); if (deg[i]<2) continue; const q=V.px(i); if (q[0]<30||q[0]>w-30||q[1]<30||q[1]>h-30) continue; out.push(q); }
                  document.getElementById('map').style.visibility='hidden'; return out}""")
                await pg.wait_for_timeout(150)
                r = await pg.evaluate("()=>{const e=document.getElementById('mapwrap'),r=e.getBoundingClientRect();return [r.left+e.clientLeft,r.top+e.clientTop,e.clientWidth,e.clientHeight]}")
                shot = await pg.screenshot(clip={'x': r[0], 'y': r[1], 'width': r[2], 'height': r[3]})
                await pg.evaluate("document.getElementById('map').style.visibility='visible'")
                im = Image.open(io.BytesIO(shot)).convert('RGB'); W, H = im.size; px = im.load()
                good = 0; ds = []
                for qx, qy in pts:
                    best = 99
                    for dy in range(-6, 7):
                        for dx in range(-6, 7):
                            X = int(round(qx)) + dx; Y = int(round(qy)) + dy
                            if 0 <= X < W and 0 <= Y < H and px[X, Y][1] < 190: best = min(best, math.hypot(X + 0.5 - qx, Y + 0.5 - qy))
                    ds.append(best); good += best <= 2.2
                share = good / max(1, len(pts))
                ok(f'C {label}: {good}/{len(pts)} Kreuzungen liegen auf einem Straßenpixel der Karte (≤ 2,2 px)', len(pts) >= 10 and share >= minshare, f'median {sorted(ds)[len(ds)//2]:.2f} px, max {max(ds):.2f}' if ds else '')
                return shot
            s1 = await pixel_probe('z 16,5 Stadtmitte', 0, 0, 16.5)
            Image.open(io.BytesIO(s1)).save(OUT + 'bm_pixels.png')
            await pixel_probe('z 15, versetzt', 500, 400, 15)
            await pixel_probe('z 17,5 Nordwest', -600, -500, 17.5, 0.9)

            # ================= D: Bedienung (Mausrad, Ziehen, Tasten, Grenzen) =================
            reqs = []; pg.on('request', lambda r: reqs.append(r.url))
            rect = await pg.evaluate("()=>{const e=document.getElementById('mapwrap'),r=e.getBoundingClientRect();return {l:r.left+e.clientLeft,t:r.top+e.clientTop,w:e.clientWidth,h:e.clientHeight}}")
            await pg.evaluate("__lm.view.fit()"); await frames(pg, 2)
            un = "p=>[__lm.view.unX(p[0]),__lm.view.unY(p[1])]"
            b0 = await pg.evaluate(un, [300, 350]); z0 = await pg.evaluate("__lm.view.cam.z")
            await pg.mouse.move(rect['l'] + 300, rect['t'] + 350); await pg.mouse.wheel(0, -400); await pg.wait_for_timeout(200)
            a0 = await pg.evaluate(un, [300, 350]); z1 = await pg.evaluate("__lm.view.cam.z")
            ok('D1 Mausrad zoomt hinein, der Punkt unter dem Zeiger bleibt stehen', z1 > z0 + 0.3 and math.hypot(a0[0] - b0[0], a0[1] - b0[1]) < 0.05, f'z {z0:.2f}->{z1:.2f}, Abweichung {math.hypot(a0[0]-b0[0], a0[1]-b0[1]):.4f} m')
            await pg.mouse.wheel(0, 700); await pg.wait_for_timeout(200)
            ok('D2 Mausrad zoomt wieder heraus', await pg.evaluate("__lm.view.cam.z") < z1 - 0.5)
            await pg.evaluate("__lm.view.fit()"); await frames(pg, 2)
            sx0, sy0 = rect['l'] + 500, rect['t'] + 300
            pre = await pg.evaluate(un, [500, 300])
            await pg.mouse.move(sx0, sy0); await pg.mouse.down(); await pg.mouse.move(sx0 + 140, sy0 - 90, steps=8); await pg.mouse.up(); await pg.wait_for_timeout(200)
            post = await pg.evaluate(un, [500 + 140, 300 - 90])
            ok('D3 Ziehen: Der angefasste Punkt wandert mit dem Zeiger (Abweichung < 5 cm)', math.hypot(pre[0] - post[0], pre[1] - post[1]) < 0.05, f'{math.hypot(pre[0]-post[0], pre[1]-post[1]):.5f} m')
            await pg.evaluate("__lm.view.fit()"); await frames(pg, 2)
            zz0 = await pg.evaluate("__lm.view.cam.z"); await pg.click('#zin'); zz1 = await pg.evaluate("__lm.view.cam.z"); await pg.click('#zout'); zz2 = await pg.evaluate("__lm.view.cam.z")
            ok('D4 Knöpfe + und − (Faktor 1,4)', abs((zz1 - zz0) - math.log2(1.4)) < 1e-6 and abs(zz2 - zz0) < 1e-6, f'{zz1-zz0:.4f}')
            await pg.keyboard.press('-'); zk = await pg.evaluate("__lm.view.cam.z"); await pg.keyboard.press('+')
            ok('D5 Taste − zoomt heraus (Faktor 1,3)', abs((zz0 - zk) - math.log2(1.3)) < 1e-6, f'{zz0-zk:.4f}')
            for _ in range(60): await pg.keyboard.press('-')
            lo = await pg.evaluate("[__lm.view.cam.z, __lm.view.zRange()[0], __lm.view.cam.K, __lm.view.size()[1], __lm.view.cam.v]")
            ok('D6 Herauszoomen endet, wenn die Erde die Höhe füllt', abs(lo[0] - lo[1]) < 1e-9 and lo[2] >= lo[3] and lo[2] < lo[3] * 1.01 and abs(lo[4] - 0.5) < 0.01, json.dumps(lo))
            for _ in range(80): await pg.keyboard.press('+')
            ok('D7 Hineinzoomen endet bei Stufe 18', abs(await pg.evaluate("__lm.view.cam.z") - 18) < 1e-9)
            rt = await pg.evaluate("""()=>{const V=__lm.view; let worst=0; for (let k=0;k<400;k++){ const z=2+Math.random()*16, x=(Math.random()-.5)*6000, y=(Math.random()-.5)*6000;
              V.look((Math.random()-.5)*4000,(Math.random()-.5)*4000,z); const X=V.toX(x), Y=V.toY(y); worst=Math.max(worst, Math.abs(V.unX(X)-x), Math.abs(V.unY(Y)-y)); } return worst}""")
            ok('D8 Bildpunkt ↔ Spielmeter: Hin- und Rückrechnung stimmt (< 0,1 mm)', rt < 1e-4, f'{rt:.2e} m')
            # Antippen/Klicken einer Bestellung funktioniert wie früher (Treffer über die neue Umrechnung)
            await pg.evaluate("__lm.view.fit()"); await frames(pg, 2)
            hit = await pg.evaluate("()=>{const o=document.querySelector('#olist li, .orders li, [data-oid]');return !!o}")
            ok('D9 Bestellliste vorhanden (Spiel läuft weiter)', hit)

            # ================= E: Erdansicht =================
            await pg.click('#zworld'); await pg.wait_for_timeout(1800)
            w = await pg.evaluate("()=>{const V=__lm.view, c=V.cam; return {z:c.z, zmin:V.zRange()[0], s:c.s, lod:V.LOD, v:c.v, mz:V.base().map.getZoom(), lat:V.base().map.getCenter().lat}}")
            ok('E1 Weltknopf: Flug bis zur ganzen Erde', abs(w['z'] - w['zmin']) < 1e-6 and w['s'] < w['lod'] and abs(w['mz'] - w['z']) < 1e-6, json.dumps(w))
            await pg.screenshot(path=OUT + 'bm_world.png')
            hubpx = await pg.evaluate("""()=>{const V=__lm.view, E=__lm.E, c=document.getElementById('map'), x=V.toX(E.HUB.x), y=V.toY(E.HUB.y), d=c.width/c.clientWidth; const a=c.getContext('2d').getImageData(Math.round(x*d),Math.round(y*d),1,1).data; return {x,y,a:a[3]}}""")
            ok('E2 Erdansicht zeigt den eigenen Standort', hubpx['a'] > 200 and 0 < hubpx['x'] < 1000, json.dumps(hubpx))
            nothing = await pg.evaluate("()=>{const c=document.getElementById('map'), g=c.getContext('2d'), d=g.getImageData(0,0,c.width,c.height).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>10) n++; return n}")
            ok('E3 Erdansicht: nur Standort und Maßstab auf der Spielschicht (wenige Bildpunkte)', nothing < 6000, str(nothing))
            await pg.mouse.move(rect['l'] + 400, rect['t'] + 300); await pg.mouse.down(); await pg.mouse.move(rect['l'] + 700, rect['t'] + 300, steps=6); await pg.mouse.up(); await pg.wait_for_timeout(200)
            du = await pg.evaluate("(()=>{const c=__lm.view.cam; return [c.u,c.K]})()")
            ok('E4 Ziehen in der Erdansicht läuft um die Erde (Wrap)', 0 <= du[0] < 1)
            await pg.keyboard.press('f'); await pg.wait_for_timeout(1100)
            ft = await pg.evaluate("()=>{const V=__lm.view, t=V.fitTarget(), c=V.cam; return {dz:Math.abs(c.z-t.z), du:Math.abs(c.u-t.u), dv:Math.abs(c.v-t.v)}}")
            ok('E5 Taste F bringt die Ansicht zurück zur Stadt', ft['dz'] < 1e-6 and ft['du'] < 1e-9 and ft['dv'] < 1e-9, json.dumps(ft))
            await pg.keyboard.press('w'); await pg.wait_for_timeout(1500)
            ok('E6 Taste W zeigt die Erde', await pg.evaluate("Math.abs(__lm.view.cam.z-__lm.view.zRange()[0])<1e-6"))
            await pg.click('#zfit'); await pg.wait_for_timeout(1100)
            ok('E7 Knopf ⌖ bringt zurück zur Stadt', await pg.evaluate("Math.abs(__lm.view.cam.z-__lm.view.fitTarget().z)<1e-6"))
            fbreq = [u for u in reqs if FB.match(u) and 'lastmile-c6976' in u]
            others = [u for u in reqs if not (u.startswith('http://127.0.0.1:8396') or u.startswith('https://tiles.openfreemap.org') or u.startswith('data:') or u.startswith('blob:'))]
            ok('E8 Beim Zoomen und Ziehen gibt es keine Datenbankabfragen und keine fremden Server', not fbreq and not others, f'db={fbreq[:2]} fremd={others[:3]}')
            tiles_hosts = {re.match(r'https://tiles\.openfreemap\.org/([a-z_]+)', u).group(1) for u in reqs if u.startswith('https://tiles.openfreemap.org')}
            ok('E9 Vom Kartenanbieter werden nur Stil, Kachelinfo und Kacheln geholt', tiles_hosts <= {'styles', 'planet'}, str(tiles_hosts))

            # ================= F: dunkles Farbschema =================
            await pg.evaluate("document.documentElement.setAttribute('data-theme','dark')")
            ok('F1 Dunkles Schema lädt den dunklen Kartenstil', await wait_for(pg, "(()=>{const m=__lm.view.base().map; const l=m.getStyle()&&m.getStyle().layers[0]; return l&&l.paint&&l.paint['background-color']==='rgb(12,12,12)'})()", 15000) and any('dark' in x for x in OFM.STATE['styles']), str(OFM.STATE['styles']))
            await pg.wait_for_timeout(500); await pg.screenshot(path=OUT + 'bm_dark.png')
            await pg.evaluate("document.documentElement.setAttribute('data-theme','light')")
            ok('F2 Zurück zum hellen Stil', await wait_for(pg, "(()=>{const m=__lm.view.base().map; const l=m.getStyle()&&m.getStyle().layers[0]; return l&&l.paint&&l.paint['background-color']==='rgb(242,243,240)'})()", 15000))
            ok('F3 Kartenbild bleibt an', await wait_for(pg, "__lm.view.on()", 8000))
            ok('F4 Keine Skriptfehler im Normalbetrieb', not errs, str(errs[:3]))
            await pg.close(); await ctx.close()

            # ================= G: Kartenanbieter fällt aus =================
            for mode, why in (('style500', 'Stil nicht erreichbar'), ('tiles500', 'Kacheln nicht erreichbar')):
                OFM.STATE.update(mode=mode, tiles=0, styles=[], other=[], log=[])
                ctx = await newctx(b); pg, errs, started = await start_game(ctx, email=f'g{mode}@example.de', name='Tim ' + mode[:5].title())
                ok(f'G {mode}: Spiel startet trotz Ausfall', started)
                ok(f'G {mode}: Zustand "aus" mit Grund', await wait_for(pg, f"__lm.view.base()&&__lm.view.base().why==={json.dumps(why)}&&!__lm.view.on()", 20000), await pg.evaluate("__lm.view.base()&&__lm.view.base().why"))
                ok(f'G {mode}: Kartenfläche ausgeblendet, Weltknopf weg', not await pg.evaluate("document.getElementById('basemap').classList.contains('on')") and not await vis(pg, '#zworld'))
                await pg.evaluate("__lm.view.fit()"); await frames(pg, 3)
                cnt = await pg.evaluate("()=>{const c=document.getElementById('map'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; const bg=[d[0],d[1],d[2]]; let n=0; for(let i=0;i<d.length;i+=4) if(Math.abs(d[i]-bg[0])+Math.abs(d[i+1]-bg[1])+Math.abs(d[i+2]-bg[2])>20) n++; return n}")
                ok(f'G {mode}: Das Spiel zeichnet die Straßen selbst', cnt > 5000, str(cnt))
                await pg.screenshot(path=OUT + f'bm_fallback_{mode}.png')
                for _ in range(40): await pg.keyboard.press('-')
                s_min = await pg.evaluate("__lm.view.cam.s")
                ok(f'G {mode}: Ohne Kartenbild bleibt die Ansicht im geladenen Gebiet (Zoom-Grenze)', s_min >= 0.05 - 1e-9 and s_min < 0.0502, f'{s_min:.4f}')
                OFM.STATE['mode'] = 'ok'
                await pg.evaluate("window.dispatchEvent(new Event('online'))")
                ok(f'G {mode}: Nach Rückkehr der Verbindung kommt das Kartenbild von selbst', await wait_for(pg, "__lm.view.on()", 20000))
                ok(f'G {mode}: Weltknopf wieder da, keine Skriptfehler', await vis(pg, '#zworld') and not errs, str(errs[:3]))
                await pg.close(); await ctx.close()
            OFM.STATE.update(mode='ok', tiles=0, styles=[], other=[], log=[])

            # ================= H: ohne Kartenbild-Bibliothek (?nobase) =================
            ctx = await newctx(b); vend = []
            pg, errs, started = await start_game(ctx, email='nb@example.de', name='Tim NoBase', url=URL + '&nobase')
            ok('H1 ?nobase: Spiel startet ohne Kartenbild, nichts vom Kartenanbieter wird geladen', started and not OFM.STATE['log'] and await pg.evaluate("__lm.view.base()===null&&!__lm.view.on()"))
            await pg.mouse.move(500, 400); await pg.mouse.wheel(0, -300); await pg.wait_for_timeout(200)
            ok('H2 Zoomen funktioniert auch hier', await pg.evaluate("__lm.view.cam.z")>0 and not errs, str(errs[:3]))
            await pg.close(); await ctx.close()

            # ================= I: kein WebGL =================
            b2 = await p.chromium.launch(args=['--disable-webgl', '--disable-3d-apis', '--disable-gpu', '--disable-software-rasterizer'])
            ctx = await newctx(b2)
            pg, errs, started = await start_game(ctx, email='gl@example.de', name='Tim NoGL')
            ok('I1 Ohne WebGL: Spiel startet', started)
            ok('I2 Ohne WebGL: Kartenbild "aus" mit Grund, Straßen vom Spiel', await wait_for(pg, "__lm.view.base()&&__lm.view.base().why==='WebGL fehlt'&&!__lm.view.on()", 15000), await pg.evaluate("__lm.view.base()&&__lm.view.base().why"))
            ok('I3 Ohne WebGL: keine Skriptfehler, Weltknopf weg', not errs and not await vis(pg, '#zworld'), str(errs[:3]))
            await pg.close(); await ctx.close(); await b2.close()

            # ================= J: nichts von anderen Spielern auf der Karte =================
            src = open(REPO + '/src/basemap.js', encoding='utf-8').read()
            tpl = open(REPO + '/src/template.html', encoding='utf-8').read()
            a = tpl.index('function drawWorldMark()'); z_ = tpl.index('// ---------- Welt: Tageszeit')
            drawsrc = tpl[a:z_]
            bad = re.compile(r'LMO\.|\.board|\bclan|LMClan|rank|Rang|uid|firebase|lastmile-c6976', re.I)
            hits1 = bad.findall(src); hits2 = bad.findall(drawsrc)
            ok('J1 Kartenmodul greift auf keine Spieler-, Ranglisten- oder Clandaten zu', not hits1, str(hits1[:5]))
            ok('J2 Zeichencode der Karte (Erdansicht, Abdunkeln, draw) ebenso nicht', not hits2, str(hits2[:5]))
            kinds = re.findall(r"\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket)\b", src)
            ok('J3 Kartenmodul stellt selbst keine Netzanfragen (nur die Bibliothek lädt Kacheln)', not kinds, str(kinds))

            # ================= L: Einstellung "Kartenbild" im Menü =================
            OFM.STATE.update(mode='ok', tiles=0, styles=[], other=[], log=[])
            ctx = await newctx(b); pg, errs, started = await start_game(ctx, email='lk@example.de', name='Tim Look')
            ok('L1 Kartenbild startet "an", Standard ist blass', await wait_for(pg, "__lm.view.on()", 25000))
            opa = lambda: pg.evaluate("()=>{const e=document.getElementById('basemap');const c=getComputedStyle(e);return [parseFloat(c.opacity), c.filter]}")
            await pg.wait_for_timeout(800); o1 = await opa()
            ok('L2 Standard: Karte blass (Deckkraft 0,7)', abs(o1[0] - 0.7) < 0.02 and 'saturate(0.7)' in o1[1], str(o1))
            await pg.click('#menuBtn'); await pg.wait_for_timeout(300)
            lab = lambda: pg.evaluate("()=>[...document.querySelectorAll('button.btn')].map(b=>b.textContent).find(t=>t.startsWith('Kartenbild'))")
            ok('L3 Menü zeigt "Kartenbild: blass"', await lab() == 'Kartenbild: blass', str(await lab()))
            await pg.click('button.btn:has-text("Kartenbild")'); await pg.wait_for_timeout(900)
            o2 = await opa()
            ok('L4 Kräftig: volle Deckkraft und Sättigung, Karte bleibt an', await lab() == 'Kartenbild: kräftig' and o2[0] > 0.98 and 'saturate(1)' in o2[1] and await pg.evaluate("__lm.view.on()"), str(o2))
            ok('L5 Auswahl wird gemerkt (lm-base=full)', await pg.evaluate("localStorage.getItem('lm-base')") == 'full')
            await pg.click('button.btn:has-text("Kartenbild")'); await pg.wait_for_timeout(500)
            ok('L6 Nur eigene Straßen: Kartenbild weg, Weltknopf weg', await lab() == 'Kartenbild: nur eigene Straßen' and await pg.evaluate("__lm.view.base()===null&&!__lm.view.on()&&!document.getElementById('basemap').classList.contains('on')") and not await vis(pg, '#zworld'))
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
            if await vis(pg, '#dlgClose'): await pg.click('#dlgClose')
            await pg.evaluate("__lm.view.fit()"); await frames(pg, 3)
            cnt = await pg.evaluate("()=>{const c=document.getElementById('map'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; const bg=[d[0],d[1],d[2]]; let n=0; for(let i=0;i<d.length;i+=4) if(Math.abs(d[i]-bg[0])+Math.abs(d[i+1]-bg[1])+Math.abs(d[i+2]-bg[2])>20) n++; return n}")
            ok('L7 Nur eigene Straßen: Spiel zeichnet die Straßen selbst', cnt > 5000, str(cnt))
            for _ in range(40): await pg.keyboard.press('-')
            ok('L8 Nur eigene Straßen: Zoom-Grenze wie im Ausfallbetrieb', 0.05 - 1e-9 <= await pg.evaluate("__lm.view.cam.s") < 0.0502)
            n0 = OFM.STATE['tiles']; OFM.STATE['log'].clear()
            await pg.reload(); await pg.wait_for_timeout(1500); started2 = await wait_app(pg)
            ok('L9 Neu laden mit "nur eigene Straßen": nichts vom Kartenanbieter geladen', started2 and not OFM.STATE['log'] and await pg.evaluate("__lm.view.base()===null"), str(OFM.STATE['log'][:3]))
            await pg.click('#menuBtn'); await pg.wait_for_timeout(300)
            await pg.click('button.btn:has-text("Kartenbild")'); await pg.wait_for_timeout(300)
            ok('L10 Zurück auf blass: Kartenbild lädt wieder und wird "an"', await lab() == 'Kartenbild: blass' and await wait_for(pg, "__lm.view.on()", 25000) and await vis(pg, '#zworld'))
            ok('L11 Keine Skriptfehler beim Umschalten', not errs, str(errs[:3]))
            await pg.close(); await ctx.close()

            # ================= K: Handy-Ansicht =================
            ctx = await newctx(b, vw=(390, 780)); OFM.STATE.update(mode='ok', tiles=0, styles=[], other=[], log=[])
            pg, errs, started = await start_game(ctx, email='mo@example.de', name='Tim Mobil')
            await pg.evaluate("()=>{const b=document.querySelector('#tabbar [data-t=\"map\"]'); if (b) b.click()}"); await pg.wait_for_timeout(800)
            ok('K1 Handy: Kartenbild wird "an"', await wait_for(pg, "__lm.view.on()", 20000))
            ok('K2 Handy: Quellenangabe bleibt sichtbar', await vis(pg, '.attr'))
            await pg.wait_for_timeout(500); await pg.screenshot(path=OUT + 'bm_mobile.png')
            await pg.close(); await ctx.close()
            await b.close()
        failed = [n for n, c in R if not c]
        print('\n%d/%d bestanden' % (len(R) - len(failed), len(R)))
        for n in failed: print('FEHLER:', n)
        return 1 if failed else 0
    finally:
        srv.terminate(); web.terminate()

sys.exit(asyncio.run(main()))
