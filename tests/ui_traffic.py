"""Verkehr: Rushhour muss spürbar anders aussehen und wirken als Mittag/Nacht (Phase 12).
Start: python3 tests/ui_traffic.py   (Ports 8393 / 9293; Kartenbild mit ?nobase abgeschaltet)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9293'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8393/index.html?debug&nobase'
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


txt = lambda pg, sel: pg.evaluate("s=>document.querySelector(s)?document.querySelector(s).textContent:null", sel)

# Kennzahlen je Last: mittlere Stauwerte, Straßen je Farbstufe und der schlechteste Autofaktor
CURVE = """()=>{const E=__lm.E, out={};
  for (const [k,load,bias] of [['night',0.05,0],['mid',0.5,0],['rush',1,0.6],['storm',1.2,0.6]]) {
    const avg=E.updateTraffic(load,bias,null); const cnt=[0,0,0,0]; let maxV=0, n=0;
    for (let id=0;id<E.EN;id++){const c=E.eC[id]; if(c>4) continue; const v=E.cong[id], b=v<0.25?0:v<0.5?1:v<0.75?2:3;
      if(b===0&&c>2) continue; if(c===4&&v<0.3) continue; cnt[b]++; n++; if(v>maxV) maxV=v;}
    out[k]={avg:+avg.toFixed(3),cnt,n,minCar:+Math.max(0.15,1-maxV).toFixed(2)};
  } return out;}"""

# mittlere Fahrzeit (s) echter Auftragsfahrten im Umkreis von 600 m ums Hauptquartier, je Fahrzeug und Tageslast
TRIPS = """()=>{const E=__lm.E, out={}; let seed=5; const rnd=()=>{seed=(seed*16807)%2147483647; return seed/2147483647;};
  const P=E.pois, H=E.homes, pairs=[]; let g=0;
  while (pairs.length<60&&g<20000){g++; const p=P[Math.floor(rnd()*P.length)], h=H[Math.floor(rnd()*H.length)]; const d=Math.hypot(p.x-h.x,p.y-h.y); if(d<300||d>2000) continue;
    if(Math.hypot(p.x-E.HUB.x,p.y-E.HUB.y)>600||Math.hypot(h.x-E.HUB.x,h.y-E.HUB.y)>600) continue; pairs.push([p,h]);}
  for (const veh of ['bike','scooter','van']) { const start=E.hubNode(veh,E.HUB.x,E.HUB.y), r={n:pairs.length};
    for (const [name,load,bias] of [['night',0.05,0],['mid',0.5,0],['rush',1,0.6]]) { E.updateTraffic(load,bias,null); let sum=0,n=0;
      for (const [p,h] of pairs){let pl=null; try{pl=E.planTrip(veh,start,p.i,h.i,0);}catch(e){} if(pl){sum+=pl.legs[0].time+pl.legs[1].time; n++;}}
      r[name]=sum/Math.max(1,n);} out[veh]=r;}
  return out;}"""

# Farbige Verkehrslinien auf der Karte zählen (Hintergrund ohne Kartenbild: nur Straßen, Verkehr und Spielfiguren)
PIXELS = """()=>{const cv=[...document.querySelectorAll('#mapwrap canvas')].sort((a,b)=>b.width*b.height-a.width*a.height)[0];
  const x=cv.getContext('2d'); const d=x.getImageData(0,0,cv.width,cv.height).data; let red=0, dark=0, orange=0, green=0;
  for (let i=0;i<d.length;i+=4){const r=d[i],g=d[i+1],b=d[i+2];
    if(r>200&&g<110&&b<90) red++; else if(r>110&&r<165&&g<50&&b<50) dark++; else if(r>215&&g>140&&g<195&&b<70) orange++; else if(g>130&&r<100&&b<120&&g-r>50) green++;}
  return {red,dark,orange,green,w:cv.width,h:cv.height};}"""


async def hour(pg, h, di):
    await pg.evaluate("([h,di])=>__lm.world.setHour(h,di)", [h, di]); await pg.wait_for_timeout(500)


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9293'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8393', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R = []

    def ok(name, cond, info=''):
        R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await newctx(b); pg, errs, started = await start_game(ctx, 'Tim Verkehr', 'vk@example.de')
            ok('A0 Spiel startet', started)

            # ---------- A: Engine-Kurve ----------
            c = await pg.evaluate(CURVE)
            print('   Kurve', json.dumps(c))
            ok('A1 Nachts ist es frei (Mittel < 0,15, keine roten Straßen)', c['night']['avg'] < 0.15 and c['night']['cnt'][2] + c['night']['cnt'][3] == 0, str(c['night']))
            ok('A2 Mittag ist nicht mehr "Stau": Mittel unter 0,28', c['mid']['avg'] < 0.28, str(c['mid']))
            ok('A3 Rushhour zählt mindestens dicht (Mittel ≥ 0,28)', c['rush']['avg'] >= 0.28, str(c['rush']))
            ok('A4 Rushhour hat deutlich höheren Mittelwert als Mittag (mind. ×1,8)', c['rush']['avg'] >= 1.8 * c['mid']['avg'], '%.3f / %.3f' % (c['rush']['avg'], c['mid']['avg']))
            red = lambda k: c[k]['cnt'][2] + c[k]['cnt'][3]
            ok('A5 Rushhour hat mindestens 3× so viele rote Straßen wie Mittag', red('rush') >= 3 * max(1, red('mid')), '%d / %d' % (red('rush'), red('mid')))
            ok('A6 Rushhour hat mindestens 150 rote Straßenstücke', red('rush') >= 150, str(red('rush')))
            ok('A7 Staustärke: Autos kommen im Stau auf höchstens 55 % Tempo', c['rush']['minCar'] <= 0.55, str(c['rush']['minCar']))
            ok('A8 Starkregen-Rushhour ist nicht milder als normale Rushhour', c['storm']['avg'] >= c['rush']['avg'], '%.3f / %.3f' % (c['storm']['avg'], c['rush']['avg']))

            # ---------- B: Fahrzeiten ----------
            t = await pg.evaluate(TRIPS)
            print('   Fahrzeiten', json.dumps({k: {a: round(v) for a, v in r.items()} for k, r in t.items()}))
            ok('B0 Genug Testfahrten', all(r['n'] >= 30 for r in t.values()), str({k: r['n'] for k, r in t.items()}))
            for veh in ('scooter', 'van'):
                r = t[veh]
                ok('B1 %s: Rushhour mind. 25 %% länger als Mittag' % veh, r['rush'] >= 1.25 * r['mid'], '%.0f / %.0f s' % (r['rush'], r['mid']))
                ok('B2 %s: Mittag nicht schneller als nachts' % veh, r['mid'] >= r['night'] - 0.5, '%.0f / %.0f' % (r['mid'], r['night']))
            r = t['bike']
            ok('B3 Fahrrad bleibt fast unberührt (Rushhour höchstens 10 % länger als Mittag)', r['rush'] <= 1.10 * r['mid'], '%.0f / %.0f s' % (r['rush'], r['mid']))
            ok('B4 Fahrrad ist in der Rushhour nicht langsamer als der Roller im Verkehr mal 1,3', t['bike']['rush'] / t['bike']['mid'] < t['scooter']['rush'] / t['scooter']['mid'])

            # ---------- C: Anzeige über die echte Spielzeit ----------
            await hour(pg, 3, 4)
            n1 = await txt(pg, '#trW'); l1 = await txt(pg, '#trT')
            await hour(pg, 12, 4)
            n2 = await txt(pg, '#trW'); l2 = await txt(pg, '#trT')
            await hour(pg, 7.9, 4)
            n3 = await txt(pg, '#trW'); l3 = await txt(pg, '#trT')
            await hour(pg, 17, 4)
            n4 = await txt(pg, '#trW'); l4 = await txt(pg, '#trT')
            await hour(pg, 11, 1)
            n5 = await txt(pg, '#trW'); l5 = await txt(pg, '#trT')
            print('   Chips', [n1, n2, n3, n4, n5], [l1, l2, l3, l4, l5])
            ok('C1 Nachts: "frei" ohne Rushhour', n1 == 'frei' and not l1.strip(), '%s%s' % (n1, l1))
            ok('C2 Mittags (Di 12 Uhr): kein Stau und keine Rushhour', n2 in ('frei', 'zähfließend') and not l2.strip(), '%s%s' % (n2, l2))
            ok('C3 Morgens (Di 7:54): mindestens "dicht" und Rushhour', n3 in ('dicht', 'Stau') and 'Rushhour' in l3, '%s%s' % (n3, l3))
            ok('C4 Abends (Di 17 Uhr): mindestens "dicht" und Rushhour', n4 in ('dicht', 'Stau') and 'Rushhour' in l4, '%s%s' % (n4, l4))
            ok('C5 Samstag 11 Uhr: keine Rushhour', 'Rushhour' not in l5, '%s%s' % (n5, l5))

            # ---------- D: Bild auf der Karte ----------
            await pg.evaluate("__lm.view.fit()"); await pg.wait_for_timeout(500)
            shots = {}
            for name, h, di in (('night', 3, 4), ('mid', 12, 4), ('rush', 7.9, 4)):
                await hour(pg, h, di); await pg.wait_for_timeout(500)
                shots[name] = await pg.evaluate(PIXELS)
            print('   Pixel', json.dumps(shots))
            wr = lambda k: shots[k]['red'] + shots[k]['dark']
            ok('D1 Rushhour zeigt deutlich mehr rote Linien als Mittag (mind. ×2)', wr('rush') >= 2 * max(1, wr('mid')), '%d / %d' % (wr('rush'), wr('mid')))
            ok('D2 Rushhour zeigt mehr als 800 rote Pixel', wr('rush') > 800, str(wr('rush')))
            ok('D3 Nachts ist kaum Rot zu sehen', wr('night') < 0.15 * max(1, wr('rush')), '%d / %d' % (wr('night'), wr('rush')))
            ok('D4 Mittag ist überwiegend grün/orange, Rushhour überwiegend orange/rot',
               shots['mid']['green'] > shots['rush']['green'] and (shots['rush']['orange'] + wr('rush')) > (shots['mid']['orange'] + wr('mid')), str(shots))
            await hour(pg, 7.9, 4)
            el = await pg.query_selector('#mapwrap'); os.makedirs(HERE + 'out', exist_ok=True)
            await el.screenshot(path=HERE + 'out/traffic_rush.png')
            await hour(pg, 12, 4); await el.screenshot(path=HERE + 'out/traffic_mid.png')

            # ---------- E: Konsole ----------
            ok('E1 Keine Fehler in der Konsole', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
