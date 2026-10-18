"""Fulfillment Center, Touren (Phase 14b): Planen, Fahrplan, Abfahrten, Beladen, Fahrt, Warten, Übergabe, Lohn, Ruf, Abbruch, Abwesenheit, Speichern.
Start: python3 tests/ui_tours.py   (Ports 8398 / 9298)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9298'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8398/index.html?debug&nobase'
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


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9298'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8398', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            await ctx.route(re.compile(r'https://(overpass-api\.de|overpass\.kumi\.systems|maps\.mail\.ru)/.*'), overpass)
            pg, errs, started = await start_game(ctx, 'Tim Tour', 'tour@example.de')
            ok('T0 Spiel startet', started)
            # Zufall festlegen: nichts entsteht von allein, keine Pannen; Fahrer des Lieferdienstes ruhen (kein Lohn aus dieser Quelle)
            await pg.evaluate("Math.random = () => 0.5; __lm.cen.auto(false); __lm.drivers().forEach(d => { d.rest = 'on'; })")
            await pg.evaluate("__lm.setCash(500000)")
            await pg.evaluate(POI_BUILD)
            ci = 0
            await pg.evaluate("__lm.cen.startFirms()"); await wait_for(pg, "__lm.cen.firmState()==='ok'", 8000)
            await pg.evaluate("for (let i=0;i<4;i++) __lm.cen.buyVan(0); for (let i=0;i<5;i++) __lm.cen.hire(0); for (const id of ['stops','stops','stops','stops','stops','stops','stops','stops','stops','stops']) __lm.cen.upg(id, 0)")
            ok('T1 Center mit 4 Transportern, 5 Fahrern, 30 Stopps', await pg.evaluate("[__lm.cen.centers()[0].vans.length, __lm.cen.centers()[0].drv.length, __lm.cen.cStops(__lm.cen.centers()[0])]") == [4, 5, 30])
            vans = await pg.evaluate("__lm.cen.centers()[0].vans.map(v=>v.id)"); drvs = await pg.evaluate("__lm.cen.centers()[0].drv.map(d=>d.id)")

            # ================= A: Abfahrten =================
            await setT(pg, 5.0, 3)
            sl = await pg.evaluate("__lm.cen.tour.slots(6).map(s=>[s.day,s.k])")
            ok('A1 Montag 5:00: nächste Abfahrten 6:35, 9:35, 12:00, 14:35, 17:00, dann Dienstag 6:35', sl == [[3, 0], [3, 1], [3, 2], [3, 3], [3, 4], [4, 0]], str(sl))
            await setT(pg, 6.2, 3)
            ok('A2 Montag 6:12: Beladen der 6:35-Tour läuft schon, nächste ist 9:35', (await pg.evaluate("__lm.cen.tour.slots(2).map(s=>[s.day,s.k])")) == [[3, 1], [3, 2]])
            await setT(pg, 17.0, 3)
            ok('A3 Montag 17:00: heute keine Abfahrt mehr, weiter Dienstag 6:35', (await pg.evaluate("__lm.cen.tour.slots(1).map(s=>[s.day,s.k])")) == [[4, 0]])
            await setT(pg, 19.0, 8)
            ok('A4 Samstag abends: Sonntag fällt aus, weiter Montag 6:35', (await pg.evaluate("__lm.cen.tour.slots(1).map(s=>[s.day,s.k])")) == [[10, 0]])

            # ================= B: Planen und Ablehnen =================
            await setT(pg, 5.0, 3)
            o = [await mk(pg, ci, False, 3, 10, 12, 2, i) for i in range(4)]
            pl = await pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,{k:1,day:3,van:a.v,drv:a.d,stops:a.s}); return {ok:r.ok, err:r.err, id:r.tour&&r.tour.id}}", {'v': vans[0], 'd': drvs[0], 's': o})
            ok('B1 Gültige Tour (4 Stopps, 9:35) wird angelegt', pl['ok'], str(pl))
            tid = pl['id']
            ok('B2 Bestellungen gehören der Tour (Status "tour"), Tour ist "plan"', await pg.evaluate("__lm.cen.orders().filter(o=>o.state==='tour'&&o.tour===%d).length" % tid) == 4 and (await pg.evaluate(TOUR, tid))['st'] == 'plan')
            calc = await pg.evaluate("a=>{const c=__lm.cen.centers()[0], r=__lm.cen.tour.calc(0, c.drv[0], 3, 1, a); return {dep:r.dep, load:r.load, rows:r.sc.rows.map(x=>[x.arr,x.start,x.wait,x.late]), end:r.sc.end, ok:r.ok}}", o)
            dA = 3 * 86400 + 9.5833333333 * 3600
            ok('B3 Abfahrt 9:35 (Beladen dauert unter 30 Minuten)', abs(calc['dep'] - dA) < 1 and calc['load'] < 1800, '%s %s' % (HM(calc['dep']), calc['load']))
            ok('B4 Ankünfte steigen, zu frühe Ankunft wartet bis 10:00', all(calc['rows'][i][0] < calc['rows'][i + 1][0] for i in range(3)) and abs(calc['rows'][0][1] - (3 * 86400 + 36000)) < 1 and calc['rows'][0][2] > 0, str(calc['rows']))
            ok('B5 Rückkehr nach der letzten Übergabe, Gesamtdauer unter 8 Stunden', calc['end'] > calc['rows'][-1][1] + 300 and calc['end'] - calc['dep'] < 8 * 3600 and calc['ok'])
            r = await pg.evaluate("""a=>({sell:__lm.cen.sellVan(0,a.v), fire:__lm.cen.fire(0,a.d), train:__lm.cen.train(0,a.d), res:__lm.cen.tour.reserved(__lm.cen.centers()[0], a.v)})""", {'v': vans[0], 'd': drvs[0]})
            ok('B6 Eingeplanter Transporter und Fahrer: kein Verkaufen, Kündigen, Schulen', r == {'sell': False, 'fire': False, 'train': False, 'res': True}, str(r))
            plan = lambda **k: pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,a); return r.ok?'ok':r.err}", k)
            more = [await mk(pg, ci, False, 3, 14, 16, 2, 10 + i) for i in range(2)]
            ok('B7 Derselbe Transporter zur selben Zeit wird abgelehnt', 'schon eingeplant' in await plan(k=1, day=3, van=vans[0], drv=drvs[1], stops=more[:1]))
            ok('B8 Derselbe Fahrer zur selben Zeit wird abgelehnt', 'schon eingeplant' in await plan(k=1, day=3, van=vans[1], drv=drvs[0], stops=more[:1]))
            ok('B9 Bestellung, die schon in einer Tour ist, wird abgelehnt', 'nicht mehr frei' in await plan(k=2, day=3, van=vans[1], drv=drvs[1], stops=[o[0]]))
            late = await mk(pg, ci, False, 3, 14, 16, 2, 20, ca=3 * 86400 + 9 * 3600)
            ok('B10 Bestellung nach Annahmeschluss (8:05) für 9:35 wird abgelehnt', 'rechtzeitig' in await plan(k=1, day=3, van=vans[1], drv=drvs[1], stops=[late]))
            ok('B11 Dieselbe Bestellung geht auf die 12:00-Tour (Schluss 10:30)', await plan(k=2, day=3, van=vans[1], drv=drvs[1], stops=[late]) == 'ok')
            other = await mk(pg, ci, False, 4, 10, 12, 2, 21)
            ok('B12 Bestellung eines anderen Tages wird abgelehnt', 'anderen Tag' in await plan(k=2, day=3, van=vans[2], drv=drvs[2], stops=[other]))
            ok('B13 Leere Tour, unbekannter Transporter, Sonntag, Vergangenheit werden abgelehnt', 'mindestens eine' in await plan(k=2, day=3, van=vans[2], drv=drvs[2], stops=[]) and 'Transporter' in await plan(k=2, day=3, van=999, drv=drvs[2], stops=more[:1]) and 'gibt es nicht' in await plan(k=2, day=5 + 4, van=vans[2], drv=drvs[2], stops=more[:1]) and 'schon begonnen' in await plan(k=0, day=0, van=vans[2], drv=drvs[2], stops=more[:1]), '')
            big = [await mk(pg, ci, False, 3, 10, 14, 1, 30 + i) for i in range(31)]
            ok('B14 Mehr als 30 Stopps werden abgelehnt', 'höchstens 30' in await plan(k=3, day=3, van=vans[2], drv=drvs[2], stops=big))
            ok('B15 Tour über 8 Stunden (alle Fenster erst 20–22 Uhr) wird abgelehnt', 'länger als 8 Stunden' in await plan(k=1, day=3, van=vans[2], drv=drvs[2], stops=[await mk(pg, ci, False, 3, 20, 22, 2, 70 + i) for i in range(3)]))
            await pg.evaluate("__lm.cen.orders().splice(0, __lm.cen.orders().length, ...__lm.cen.orders().filter(o=>o.state==='tour'))")

            # ================= C: Ablauf einer Tour (9:35, vier Stopps, Kunden nicht da) =================
            WAGE = "(__lm.stats.wage + __lm.bill.wage)"; COST = "(__lm.stats.cost + __lm.bill.veh)"
            await setT(pg, 9.0, 3)
            await pg.evaluate("__lm.cen.orders().forEach(o => { o.pres = false; })")
            w0 = await pg.evaluate(WAGE); c0 = await pg.evaluate(COST); n0 = await pg.evaluate("__lm.cen.stats.n"); rep0 = await pg.evaluate("__lm.cen.centers()[0].rep"); cash0 = await pg.evaluate("__lm.cash()")
            pay_exp = await pg.evaluate("__lm.cen.orders().filter(o=>o.tour===%d).reduce((a,o)=>a+o.pay,0)" % tid); pay0 = await pg.evaluate("__lm.cen.stats.pay")
            await pg.evaluate("__lm.adv(240, 10)")
            w1 = await pg.evaluate(WAGE)
            ok('C1 Vor Beladebeginn (9:04) kein Fahrerlohn', abs(w1 - w0) < 0.002 and (await pg.evaluate(TOUR, tid))['st'] == 'plan', '%.4f' % (w1 - w0))
            await pg.evaluate("__lm.adv(120, 10)")
            st = await pg.evaluate(TOUR, tid); w2 = await pg.evaluate(WAGE)
            ok('C2 9:06: Tour belädt, Transporter und Fahrer sind belegt', st['st'] == 'load' and await pg.evaluate("a=>__lm.cen.centers()[0].vans.find(v=>v.id===a.v).tour===a.t && __lm.cen.centers()[0].drv.find(d=>d.id===a.d).tour===a.t", {'v': vans[0], 'd': drvs[0], 't': tid}), str(st))
            ok('C3 Lohn läuft ab Beladebeginn (11 €/h, etwa 1 Minute; die Echtzeit zwischen den Aufrufen zählt mit)', 0.12 < w2 - w1 < 0.40, '%.3f' % (w2 - w1))
            await pg.evaluate("__lm.adv(1620, 10)")
            ok('C4 9:33: noch im Beladen, keine vorzeitige Abfahrt', (await pg.evaluate(TOUR, tid))['st'] == 'load')
            await pg.evaluate("__lm.adv(180, 10)")
            st = await pg.evaluate(TOUR, tid); ab = await pg.evaluate("__lm.cen.absT()")
            ok('C5 9:36: unterwegs, Abfahrt um 9:35', st['st'] == 'drive' and abs(st['dep'] - dA) < 12, '%s %s' % (st['st'], HM(st['dep'])))
            p0 = await pg.evaluate("a=>{const p=__lm.cen.tour.pos(__lm.cen.tour.list(0).find(t=>t.id===a)); return [p.x,p.y]}", tid)
            await pg.evaluate("__lm.adv(60, 10)")
            p1 = await pg.evaluate("a=>{const p=__lm.cen.tour.pos(__lm.cen.tour.list(0).find(t=>t.id===a)); return [p.x,p.y]}", tid)
            ok('C6 Der Transporter bewegt sich über Straßen (Position ändert sich)', abs(p0[0] - p1[0]) + abs(p0[1] - p1[1]) > 20, str([p0, p1]))
            kmmax = 0; seen = []; last = None; rep_seq = []
            while True:
                await pg.evaluate("__lm.adv(30, 10)")
                st = await pg.evaluate(TOUR, tid)
                if st is None: break
                kmmax = max(kmmax, st['km']); last = st
                if not seen or seen[-1] != st['st']: seen.append(st['st'])
                if (await pg.evaluate("__lm.cen.absT()")) > 3 * 86400 + 15 * 3600: break
            end = await pg.evaluate("__lm.cen.absT()")
            ok('C7 Tour ist zu Ende, Transporter und Fahrer sind frei', st is None and await pg.evaluate("a=>!__lm.cen.centers()[0].vans.find(v=>v.id===a.v).tour && !__lm.cen.centers()[0].drv.find(d=>d.id===a.d).tour", {'v': vans[0], 'd': drvs[0]}), '%s end %s' % (seen, HM(end)))
            ok('C8 Phasen: Fahrt, Warten auf Fensterbeginn, Übergabe, Rückfahrt, Übergabe im Center', all(x in seen for x in ['drive', 'wait', 'door', 'back', 'unload']), str(seen))
            n1 = await pg.evaluate("__lm.cen.stats.n"); pay1 = await pg.evaluate("__lm.cen.stats.pay")
            ok('C9 Vier Lieferungen gezählt, alle im Fenster, kein Verfall', n1 - n0 == 4 and await pg.evaluate("__lm.cen.stats.ontime") >= 4 and await pg.evaluate("__lm.cen.orders().filter(o=>o.tour===%d).length" % tid) == 0, str(n1 - n0))
            ok('C10 Lohn der Bestellungen gutgeschrieben (Summe stimmt)', abs((pay1 - pay0) - pay_exp) < 0.01 and await pg.evaluate("__lm.cash()") > cash0 - 100, '%s %s' % (pay1 - pay0, pay_exp))
            w3 = await pg.evaluate(WAGE); c3 = await pg.evaluate(COST)
            exp_w = 11.0 * (end - (3 * 86400 + 9 * 3600 + 5 * 60)) / 3600
            ok('C11 Fahrerlohn nur von 9:05 bis zur Rückkehr (11 €/h), nicht länger', abs((w3 - w0) - exp_w) < 0.25, '%.2f erwartet %.2f' % (w3 - w0, exp_w))
            ok('C12 Fahrzeugkosten pro km (0,35 €) wurden vorgemerkt', kmmax > 1 and abs((c3 - c0) - kmmax * 0.35) < 0.4, 'km %.2f kosten %.2f' % (kmmax, c3 - c0))
            ok('C13 Pünktliche Lieferungen heben den Ruf des Centers', await pg.evaluate("__lm.cen.centers()[0].rep") > rep0, '%s -> %s' % (rep0, await pg.evaluate("__lm.cen.centers()[0].rep")))
            ok('C14 Fahrer hat vier Stopps und Erfahrung gesammelt', await pg.evaluate("a=>__lm.cen.centers()[0].drv.find(d=>d.id===a).done", drvs[0]) == 4)
            logt = await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')")
            ok('C15 Protokoll nennt Beginn, Zustellungen und Rückkehr', all(t_ in logt for t_ in ['Tour 9:35 beginnt', 'zugestellt (im Fenster)', 'Tour 9:35 zurück im Center']), logt[-300:])

            # ================= D: zu früh (Kunde da / nicht da), zu spät =================
            CLR = "(()=>{const a=__lm.cen.orders(); a.splice(0,a.length)})()"
            await pg.evaluate(CLR)
            await setT(pg, 5.0, 4)
            wait_o = await mk(pg, ci, False, 4, 14, 16, 2, 40)
            pres_o = await mk(pg, ci, False, 4, 17, 19, 3, 41, pres=True)
            lat_o = await mk(pg, ci, False, 4, 14, 16, 2, 42)
            rd = []
            for k, van_i, o_ in ((2, 0, wait_o), (3, 1, pres_o), (4, 2, lat_o)):
                rd.append(await pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,{k:a.k,day:4,van:a.v,drv:a.d,stops:[a.o]}); return r.ok?r.tour.id:r.err}", {'k': k, 'v': vans[van_i], 'd': drvs[van_i], 'o': o_}))
            ok('D1 Drei Touren (12:00, 14:35, 17:00) geplant', all(isinstance(x, int) for x in rd), str(rd))
            rep_a = await pg.evaluate("__lm.cen.centers()[0].rep")
            st, seen = await run_until(pg, rd[0], lambda s: s['res'] >= 1)
            t_del = await pg.evaluate("__lm.cen.absT()")
            ok('D2 Kunde nicht da, Fenster ab 14:00: Fahrer wartet und liefert erst ab 14:00', 'wait' in seen and 4 * 86400 + 14 * 3600 - 1 <= t_del < 4 * 86400 + 14.3 * 3600, '%s %s' % (seen, HM(t_del)))
            st3, seen3 = await run_until(pg, rd[1], lambda s: s['res'] >= 1)
            t_del3 = await pg.evaluate("__lm.cen.absT()")
            ok('D3 Kunde schon da: sofortige Übergabe ohne Warten, lange vor Fensterbeginn 17:00', 'wait' not in seen3 and t_del3 < 4 * 86400 + 16.5 * 3600, '%s %s' % (seen3, HM(t_del3)))
            st, seen = await run_until(pg, rd[0], lambda s: False)
            ok('D4 Rückfahrt und Ende der ersten Tour; kein Ruf-Abzug im Fenster', st is None and await pg.evaluate("__lm.cen.centers()[0].rep") >= rep_a - 1e-9, str(seen))
            st, seen = await run_until(pg, rd[1], lambda s: False)
            rep_b = await pg.evaluate("__lm.cen.centers()[0].rep"); late0 = await pg.evaluate("__lm.cen.stats.late"); pay_b = await pg.evaluate("__lm.cen.stats.pay"); expd0 = await pg.evaluate("__lm.cen.stats.expired")
            lat_pay = await pg.evaluate("a=>__lm.cen.orders().find(o=>o.id===a).pay", lat_o)
            st, seen = await run_until(pg, rd[2], lambda s: False)
            ok('D5 Verspätet (17:xx statt 14–16): wird zugestellt, voller Lohn, kein Verfall', await pg.evaluate("__lm.cen.stats.late") == late0 + 1 and abs(await pg.evaluate("__lm.cen.stats.pay") - pay_b - lat_pay) < 0.01 and await pg.evaluate("__lm.cen.stats.expired") == expd0, '%s' % (await pg.evaluate("__lm.cen.stats.late") - late0))
            ok('D6 Die Verspätung senkt den Ruf des Centers', await pg.evaluate("__lm.cen.centers()[0].rep") < rep_b - 0.03, '%s -> %s' % (rep_b, await pg.evaluate("__lm.cen.centers()[0].rep")))

            # ================= E: Verfall während der Planung =================
            await pg.evaluate(CLR)
            await setT(pg, 5.0, 5)
            ea = await mk(pg, ci, False, 5, 7, 9, 2, 50); eb = await mk(pg, ci, False, 5, 12, 14, 2, 51); ec = await mk(pg, ci, False, 5, 7, 9, 2, 52)
            pe = await pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,{k:2,day:5,van:a.v,drv:a.d,stops:[a.a,a.b]}); return r.ok?r.tour.id:r.err}", {'v': vans[0], 'd': drvs[0], 'a': ea, 'b': eb})
            pe2 = await pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,{k:3,day:5,van:a.v,drv:a.d,stops:[a.a]}); return r.ok?r.tour.id:r.err}", {'v': vans[1], 'd': drvs[1], 'a': ec})
            ok('E1 Zwei Touren geplant (Fenster 7–9 und 12–14; nur Fenster 7–9)', isinstance(pe, int) and isinstance(pe2, int), '%s %s' % (pe, pe2))
            ex0 = await pg.evaluate("__lm.cen.stats.expired"); rp = await pg.evaluate("__lm.cen.centers()[0].rep"); n_e0 = await pg.evaluate("__lm.cen.stats.n")
            await setT(pg, 10.9, 5); await pg.evaluate("__lm.adv(10, 10)")
            ok('E2 Um 10:54 ist nichts verfallen (Frist 11:00)', await pg.evaluate("__lm.cen.stats.expired") == ex0)
            await pg.evaluate("__lm.adv(400, 10)")
            ok('E3 Nach 11:00 sind beide 7–9-Bestellungen verfallen: Ruf sinkt, aus der Tour entfernt', await pg.evaluate("__lm.cen.stats.expired") == ex0 + 2 and await pg.evaluate("__lm.cen.centers()[0].rep") < rp - 0.05 and (await pg.evaluate(TOUR, pe))['stops'] == 1, '%s' % await pg.evaluate("__lm.cen.stats.expired - %d" % ex0))
            ok('E4 Tour, deren Bestellungen alle verfallen, entfällt samt Reservierung', await pg.evaluate(TOUR, pe2) is None and not await pg.evaluate("__lm.cen.tour.reserved(__lm.cen.centers()[0], %d)" % vans[1]))
            st, seen = await run_until(pg, pe, lambda s: False)
            ok('E5 Die Restbestellung der ersten Tour wird trotzdem geliefert', st is None and await pg.evaluate("__lm.cen.stats.n") == n_e0 + 1 and await pg.evaluate("__lm.cen.orders().length") == 0, str(seen))

            # ================= F: höchstens 8 Stunden ab Abfahrt =================
            await pg.evaluate(CLR)
            await setT(pg, 5.0, 6)
            fo = [await mk(pg, ci, False, 6, 8, 12, 2, 60 + i) for i in range(3)]
            fr = await pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,{k:0,day:6,van:a.v,drv:a.d,stops:a.s}); return r.ok?r.tour.id:r.err}", {'v': vans[0], 'd': drvs[0], 's': fo})
            st, seen = await run_until(pg, fr, lambda s: s['st'] == 'drive')
            await pg.evaluate("__lm.adv(240, 10)")
            n_before = await pg.evaluate("__lm.cen.stats.n")
            await pg.evaluate("a=>{const T=__lm.cen.tour.list(0).find(t=>t.id===a); T.dep -= 8*3600 - 20;}", fr)
            await pg.evaluate("__lm.adv(30, 10)")
            st = await pg.evaluate(TOUR, fr)
            ok('F1 Nach 8 Stunden ab Abfahrt wird die Tour abgebrochen (Rückfahrt)', st and st['st'] == 'back', str(st))
            ok('F2 Restliche Bestellungen bleiben liegen: wieder "open", nicht geliefert', await pg.evaluate("__lm.cen.orders().filter(o=>o.state==='open').length") == 3 and await pg.evaluate("__lm.cen.stats.n") == n_before)
            ok('F3 Protokoll nennt den Abbruch', 'nach 8 Stunden abgebrochen' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')"))
            st, seen = await run_until(pg, fr, lambda s: False)
            ok('F4 Der Transporter kommt zurück und ist wieder frei', st is None and await pg.evaluate("a=>!__lm.cen.centers()[0].vans.find(v=>v.id===a).tour", vans[0]))
            await pg.evaluate(CLR)
            # ================= G: Abwesenheit =================
            ENDALL = "(()=>{const c=__lm.cen.centers()[0]; c.tours.filter(t=>t.st==='plan').forEach(t=>__lm.cen.tour.cancel(0,t.id)); const a=__lm.cen.orders(); a.splice(0,a.length)})()"
            PLAN = "a=>{const r=__lm.cen.tour.plan(0,a); return r.ok?r.tour.id:r.err}"
            await pg.evaluate(ENDALL)
            await setT(pg, 5.0, 7)
            g1 = await mk(pg, ci, False, 7, 10, 12, 2, 80); g2 = await mk(pg, ci, False, 7, 11, 13, 3, 81)
            g3 = await mk(pg, ci, False, 7, 14, 16, 2, 82); g4 = await mk(pg, ci, False, 7, 17, 19, 2, 83)
            gt = [await pg.evaluate(PLAN, {'k': 1, 'day': 7, 'van': vans[0], 'drv': drvs[0], 'stops': [g1, g2]}),
                  await pg.evaluate(PLAN, {'k': 2, 'day': 7, 'van': vans[1], 'drv': drvs[1], 'stops': [g3]}),
                  await pg.evaluate(PLAN, {'k': 4, 'day': 7, 'van': vans[2], 'drv': drvs[2], 'stops': [g4]})]
            ok('G1 Drei Touren für Freitag geplant', all(isinstance(x, int) for x in gt), str(gt))
            await setT(pg, 10.0, 7); await pg.evaluate("__lm.adv(420, 10)")
            st = await pg.evaluate(TOUR, gt[0])
            ok('G2 Die 9:35-Tour läuft um 10:07 (zwei Stopps, noch keiner geliefert oder einer)', st and st['st'] in ('drive', 'wait', 'door') and st['stops'] == 2 and st['res'] <= 1, str(st))
            a0 = await pg.evaluate("__lm.cen.absT()")
            pend = await pg.evaluate("t=>__lm.cen.orders().filter(o=>o.tour===t&&o.state==='tour')", gt[0])
            pay_rest = sum(o['pay'] for o in pend); n_rest = len(pend)
            n0 = await pg.evaluate("__lm.cen.stats.n"); cash0 = await pg.evaluate("__lm.cash()"); rep0 = await pg.evaluate("__lm.cen.centers()[0].rep"); ex0 = await pg.evaluate("__lm.cen.stats.expired"); wg0 = await pg.evaluate("__lm.stats.wage")
            await pg.evaluate("window.__gP = performance.now(); LMO.world.gameNow = () => 7 * 86400 + 12.1 * 3600 + (performance.now() - window.__gP) / 1000 * LMO.world.speed")
            eff = await pg.evaluate("Math.min(240, LMO.world.maxAway) * LMO.world.speed")
            await pg.evaluate("__lm.absence(240)")
            ok('G3 Laufende Tour wurde in der Abwesenheit zu Ende geführt, Transporter und Fahrer sind frei', await pg.evaluate(TOUR, gt[0]) is None and await pg.evaluate("a=>!__lm.cen.centers()[0].vans.find(v=>v.id===a.v).tour && !__lm.cen.centers()[0].drv.find(d=>d.id===a.d).tour", {'v': vans[0], 'd': drvs[0]}))
            ok('G4 Alle noch offenen Stopps der Tour gelten als zugestellt (Zähler und Lohn der Bestellungen)', await pg.evaluate("__lm.cen.stats.n") == n0 + n_rest and n_rest >= 1, '%s %s' % (n_rest, await pg.evaluate("__lm.cen.stats.n") - n0))
            wg1 = await pg.evaluate("__lm.stats.wage"); cash1 = await pg.evaluate("__lm.cash()")
            exp_w = 11.0 * min(eff, max(0, st['est'] - a0)) / 3600
            ok('G5 Fahrerlohn für die Abwesenheit nur bis zum Ende der Tour (nicht für die ganzen 2 Stunden)', exp_w * 0.5 < wg1 - wg0 < exp_w * 1.6 + 0.01 and wg1 - wg0 < 11.0 * eff / 3600, '%.2f erwartet %.2f' % (wg1 - wg0, exp_w))
            ok('G6 Kasse: Bestellungslohn minus Fahrerlohn', abs((cash1 - cash0) - (pay_rest - (wg1 - wg0))) < 0.5, '%.2f %.2f' % (cash1 - cash0, pay_rest - (wg1 - wg0)))
            ok('G7 Keine Abzüge: Ruf und Verfall unverändert', await pg.evaluate("__lm.cen.centers()[0].rep") == rep0 and await pg.evaluate("__lm.cen.stats.expired") == ex0)
            ok('G8 Geplante 12:00-Tour fällt aus (Bestellung entfällt ohne Abzug), die 17:00-Tour bleibt geplant', await pg.evaluate(TOUR, gt[1]) is None and (await pg.evaluate(TOUR, gt[2]))['st'] == 'plan' and await pg.evaluate("a=>__lm.cen.orders().find(o=>o.id===a).state", g4) == 'tour')
            logt = await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')")
            ok('G9 Protokoll: Tour in Abwesenheit beendet / ausgefallen', 'in deiner Abwesenheit zu Ende gegangen' in logt and 'du warst nicht da' in logt)
            ok('G10 Weltuhr steht nach der Rückkehr bei 12:06', abs(await pg.evaluate("__lm.cen.absT()") - (7 * 86400 + 12.1 * 3600)) < 400)

            # ================= H: Speichern und Laden mit laufender Tour =================
            await pg.evaluate(ENDALL)
            await setT(pg, 5.0, 8)
            hs = [await mk(pg, ci, False, 8, 7, 12, 2, 100 + i) for i in range(3)]
            ht = await pg.evaluate(PLAN, {'k': 0, 'day': 8, 'van': vans[0], 'drv': drvs[0], 'stops': hs})
            hu = await mk(pg, ci, False, 8, 17, 19, 2, 110)
            hp = await pg.evaluate(PLAN, {'k': 4, 'day': 8, 'van': vans[1], 'drv': drvs[1], 'stops': [hu]})
            ok('H1 Zwei Touren für Samstag (6:35 mit drei Stopps, 17:00)', isinstance(ht, int) and isinstance(hp, int), '%s %s' % (ht, hp))
            await setT(pg, 6.0, 8)
            st, seen = await run_until(pg, ht, lambda s: s['res'] >= 1 and s['st'] == 'drive')
            ok('H2 Unterwegs nach der ersten Lieferung', st and st['st'] == 'drive' and st['res'] == 1, str(st))
            await pg.evaluate("__lm.world.WORLD.t0 = __lm.cen.absT() - __lm.sim()")
            SIG = """JSON.stringify({t:__lm.cen.tour.list(0).map(t=>[t.id,t.k,t.day,t.van,t.drv,t.stops.slice(t.i).join(),t.st,Math.round(t.t0),Math.round(t.dep),!!t.hold,Math.round(t.km*100),t.res.map(r=>r.join(':')).join(),t.lost||0,Math.round(t.est)]),
              v:__lm.cen.centers()[0].vans.map(v=>[v.id,v.tour]), d:__lm.cen.centers()[0].drv.map(d=>[d.id,d.tour,d.done]), o:__lm.cen.orders().map(o=>[o.id,o.state,o.tour||0]).sort(), s:[__lm.cen.stats.n,__lm.cen.stats.pay,__lm.cen.centers()[0].rep], ts:__lm.cen.tour.seq()})"""
            before = await pg.evaluate(SIG)
            pos0 = await pg.evaluate("a=>{const p=__lm.cen.tour.pos(__lm.cen.tour.list(0).find(t=>t.id===a)); return [p.x,p.y]}", ht)
            await pg.evaluate("""()=>{ const sv=__lm.save.snapshot(); const n=__lm.save.normalizeSave(JSON.parse(JSON.stringify(sv))); __lm.save.applySave(n); }""")
            after = await pg.evaluate(SIG)
            pos1 = await pg.evaluate("a=>{const p=__lm.cen.tour.pos(__lm.cen.tour.list(0).find(t=>t.id===a)); return [p.x,p.y]}", ht)
            ok('H3 Touren, Zuordnungen, Bestellungen und Zähler überstehen Speichern und Laden', before == after, before[:260] + '\n' + after[:260])
            ok('H4 Der Transporter steht danach in der Nähe (Straßenknoten)', abs(pos0[0] - pos1[0]) + abs(pos0[1] - pos1[1]) < 250, str([pos0, pos1]))
            n0 = await pg.evaluate("__lm.cen.stats.n")
            st, seen = await run_until(pg, ht, lambda s: False)
            ok('H5 Die Tour läuft nach dem Laden normal zu Ende (drei Lieferungen insgesamt)', st is None and await pg.evaluate("__lm.cen.stats.n") == n0 + 2 and 'back' in seen, '%s %s' % (seen, await pg.evaluate("__lm.cen.stats.n") - n0))
            ok('H6 Die geplante 17:00-Tour ist noch da', (await pg.evaluate(TOUR, hp))['st'] == 'plan')
            old = await pg.evaluate("""()=>{ const sv=__lm.save.snapshot(); delete sv.tourSeq; sv.centers.forEach(c=>{ delete c.tours; }); const n=__lm.save.normalizeSave(JSON.parse(JSON.stringify(sv))); return {c:n.centers.length, t:n.centers[0].tours.length, seq:n.tourSeq} }""")
            ok('H7 Altes Speicherformat ohne Touren lädt (leere Tourenliste)', old['c'] == 1 and old['t'] == 0 and old['seq'] >= 1, str(old))

            # ================= I: Fahrerausfall =================
            await pg.evaluate(ENDALL)
            await setT(pg, 5.0, 10)
            i1 = await mk(pg, ci, False, 10, 10, 12, 2, 120)
            it = await pg.evaluate(PLAN, {'k': 1, 'day': 10, 'van': vans[0], 'drv': drvs[0], 'stops': [i1]})
            await pg.evaluate("a=>{__lm.cen.centers()[0].drv.find(d=>d.id===a).sick={left:5*3600}}", drvs[0]); dn0 = await pg.evaluate("a=>__lm.cen.centers()[0].drv.find(d=>d.id===a).done", drvs[0])
            await setT(pg, 9.0, 10); await pg.evaluate("__lm.adv(400, 10)")
            st = await pg.evaluate(TOUR, it)
            ok('I1 Fahrer 1 ist krank: ein gesunder, freier Fahrer springt ein', st and st['st'] == 'load' and st['drv'] != drvs[0] and await pg.evaluate("a=>__lm.cen.centers()[0].drv.find(d=>d.id===a).tour", st['drv']) == it, str(st))
            ok('I2 Protokoll nennt den Einspringer', 'springt Fahrer' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')"))
            st, seen = await run_until(pg, it, lambda s: False)
            ok('I3 Tour läuft zu Ende, der kranke Fahrer bleibt unberührt', st is None and await pg.evaluate("a=>__lm.cen.centers()[0].drv.find(d=>d.id===a)", drvs[0]) is not None and await pg.evaluate("a=>__lm.cen.centers()[0].drv.find(d=>d.id===a).done", drvs[0]) == dn0)
            await pg.evaluate("__lm.cen.centers()[0].drv.forEach(d=>{d.sick=null})")

            await pg.evaluate(ENDALL)
            await setT(pg, 5.0, 11)
            i2 = await mk(pg, ci, False, 11, 10, 12, 2, 121); i3 = await mk(pg, ci, False, 11, 11, 13, 2, 122)
            it2 = await pg.evaluate(PLAN, {'k': 1, 'day': 11, 'van': vans[0], 'drv': drvs[0], 'stops': [i2]})
            await pg.evaluate("__lm.cen.centers()[0].drv.forEach(d=>{d.sick={left:6*3600}})")
            await setT(pg, 9.0, 11); await pg.evaluate("__lm.adv(400, 10)")
            st = await pg.evaluate(TOUR, it2)
            ok('I4 Alle Fahrer krank: Tour wartet ("hold"), nichts wird beladen', st and st['st'] == 'plan' and st['hold'] and await pg.evaluate("a=>!__lm.cen.centers()[0].vans.find(v=>v.id===a).tour", vans[0]), str(st))
            await pg.evaluate("__lm.adv(3900, 10)")
            ok('I5 Nach 30 Minuten Verzug (nach 10:05) fällt die Tour aus, Bestellung wieder frei, ohne Abzug', await pg.evaluate(TOUR, it2) is None and await pg.evaluate("a=>__lm.cen.orders().find(o=>o.id===a).state", i2) == 'open' and 'kein gesunder Fahrer' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')"))
            await pg.evaluate("__lm.cen.centers()[0].drv.forEach(d=>{d.sick=null})")
            await pg.evaluate(ENDALL)
            await setT(pg, 5.0, 12)
            i4 = await mk(pg, ci, False, 12, 10, 12, 2, 123)
            it3 = await pg.evaluate(PLAN, {'k': 1, 'day': 12, 'van': vans[0], 'drv': drvs[0], 'stops': [i4]})
            await pg.evaluate("__lm.cen.centers()[0].drv.forEach(d=>{d.sick={left:1500}})")
            await setT(pg, 9.0, 12); await pg.evaluate("__lm.adv(540, 10)")
            ok('I6 Alle krank, aber bald gesund: Tour wartet um 9:14', (await pg.evaluate(TOUR, it3))['hold'] and (await pg.evaluate(TOUR, it3))['st'] == 'plan')
            await pg.evaluate("__lm.adv(1200, 10)")
            st = await pg.evaluate(TOUR, it3)
            ok('I7 Fahrer wieder gesund (9:34): die Tour beginnt mit dem eingeplanten Fahrer, keine Abfahrt vor 9:35', st and st['st'] in ('load', 'drive') and st['drv'] == drvs[0] and st['dep'] >= 12 * 86400 + 9.5833 * 3600 - 5 or (st and st['st'] == 'load'), str(st))
            st, seen = await run_until(pg, it3, lambda s: False)
            ok('I8 Tour endet regulär', st is None)
            await pg.evaluate("__lm.cen.centers()[0].drv.forEach(d=>{d.sick=null})")

            # ================= J: ändern und absagen =================
            await pg.evaluate(ENDALL)
            await setT(pg, 5.0, 13)
            j1 = await mk(pg, ci, False, 13, 12, 14, 2, 130); j2 = await mk(pg, ci, False, 13, 12, 14, 2, 131); j3 = await mk(pg, ci, False, 13, 12, 14, 2, 132)
            jt = await pg.evaluate(PLAN, {'k': 2, 'day': 13, 'van': vans[0], 'drv': drvs[0], 'stops': [j1, j2]})
            jn = await pg.evaluate(PLAN, {'k': 2, 'day': 13, 'van': vans[1], 'drv': drvs[1], 'stops': [j2, j3], 'edit': jt})
            states = await pg.evaluate("a=>a.map(i=>__lm.cen.orders().find(o=>o.id===i).state)", [j1, j2, j3])
            ok('J1 Tour ändern: neue Stopps, anderer Transporter/Fahrer; Bestellung 1 ist wieder frei', isinstance(jn, int) and states == ['open', 'tour', 'tour'] and await pg.evaluate(TOUR, jt) is None and (await pg.evaluate(TOUR, jn))['stops'] == 2, '%s %s' % (jn, states))
            ok('J2 Der frühere Transporter ist wieder frei (keine Reservierung)', not await pg.evaluate("__lm.cen.tour.reserved(__lm.cen.centers()[0], %d)" % vans[0]) and await pg.evaluate("__lm.cen.tour.reserved(__lm.cen.centers()[0], %d)" % vans[1]))
            ok('J3 Absagen: Tour weg, Bestellungen wieder frei', await pg.evaluate("__lm.cen.tour.cancel(0, %d)" % jn) and await pg.evaluate("a=>a.every(i=>__lm.cen.orders().find(o=>o.id===i).state==='open')", [j1, j2, j3]) and await pg.evaluate(TOUR, jn) is None)
            jr = await pg.evaluate(PLAN, {'k': 2, 'day': 13, 'van': vans[0], 'drv': drvs[0], 'stops': [j1, j2]})
            await setT(pg, 11.6, 13); await pg.evaluate("__lm.adv(120, 10)")
            ok('J4 Beladene Tour lässt sich nicht mehr absagen oder ändern', (await pg.evaluate(TOUR, jr))['st'] == 'load' and not await pg.evaluate("__lm.cen.tour.cancel(0, %d)" % jr) and 'nicht mehr ändern' in await pg.evaluate("a=>{const r=__lm.cen.tour.plan(0,a); return r.ok?'ok':r.err}", {'k': 3, 'day': 13, 'van': vans[0], 'drv': drvs[0], 'stops': [j1], 'edit': jr}))
            st, seen = await run_until(pg, jr, lambda s: False)
            ok('J5 Die Tour läuft zu Ende', st is None)

            # ================= K: Panne =================
            await pg.evaluate(ENDALL)
            await setT(pg, 5.0, 14)
            k1 = await mk(pg, ci, False, 14, 10, 12, 2, 140)
            kt = await pg.evaluate(PLAN, {'k': 1, 'day': 14, 'van': vans[0], 'drv': drvs[0], 'stops': [k1]})
            st, seen = await run_until(pg, kt, lambda s: s['st'] == 'drive')
            await pg.evaluate("__lm.adv(60, 10)")
            await pg.evaluate("Math.random = () => 0"); await pg.evaluate("__lm.adv(10, 10)"); await pg.evaluate("Math.random = () => 0.5")
            st = await pg.evaluate(TOUR, kt)
            ok('K1 Panne: Tour steht (Panne mit Pause von mindestens 15 Minuten)', st and st['stall'], str(st))
            pa = await pg.evaluate("a=>{const p=__lm.cen.tour.pos(__lm.cen.tour.list(0).find(t=>t.id===a)); return [p.x,p.y]}", kt)
            await pg.evaluate("__lm.adv(300, 10)")
            pb = await pg.evaluate("a=>{const p=__lm.cen.tour.pos(__lm.cen.tour.list(0).find(t=>t.id===a)); return [p.x,p.y]}", kt)
            ok('K2 Während der Panne bewegt sich der Transporter nicht', abs(pa[0] - pb[0]) + abs(pa[1] - pb[1]) < 0.01)
            ok('K3 Protokoll nennt die Panne', 'Panne bei Transporter' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')"))
            st, seen = await run_until(pg, kt, lambda s: False)
            ok('K4 Nach der Panne geht es weiter, Tour endet, Lieferung gezählt', st is None and 'behoben' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')"))

            # ================= L: Verfall unterwegs =================
            await pg.evaluate(ENDALL)
            await setT(pg, 5.0, 15)
            la = await mk(pg, ci, False, 15, 10, 14, 2, 150); lb = await mk(pg, ci, False, 15, 10, 14, 2, 151); lc_ = await mk(pg, ci, False, 15, 10, 14, 2, 152)
            lt = await pg.evaluate(PLAN, {'k': 1, 'day': 15, 'van': vans[0], 'drv': drvs[0], 'stops': [la, lb, lc_]})
            st, seen = await run_until(pg, lt, lambda s: s['st'] == 'drive')
            ex0 = await pg.evaluate("__lm.cen.stats.expired"); rp = await pg.evaluate("__lm.cen.centers()[0].rep")
            await pg.evaluate("a=>{const o=__lm.cen.orders().find(o=>o.id===a); o.we = __lm.sim() - LMC.EXPIRE + 5; o.ws = o.we - 7200}", la)
            await pg.evaluate("__lm.adv(20, 10)")
            st = await pg.evaluate(TOUR, lt)
            ok('L1 Verfällt der angefahrene Stopp, fährt der Transporter zum nächsten weiter', st and st['stops'] == 2 and st['st'] == 'drive' and await pg.evaluate("__lm.cen.stats.expired") == ex0 + 1 and await pg.evaluate("__lm.cen.centers()[0].rep") < rp - 0.05, str(st))
            await pg.evaluate("a=>{const o=__lm.cen.orders().find(o=>o.id===a); o.we = __lm.sim() - LMC.EXPIRE + 5; o.ws = o.we - 7200}", lc_)
            await pg.evaluate("__lm.adv(20, 10)")
            st = await pg.evaluate(TOUR, lt)
            ok('L2 Verfällt ein späterer Stopp, wird er aus der Reihe genommen', st and st['stops'] == 1 and await pg.evaluate("__lm.cen.stats.expired") == ex0 + 2, str(st))
            n0 = await pg.evaluate("__lm.cen.stats.n")
            st, seen = await run_until(pg, lt, lambda s: False)
            ok('L3 Letzter Stopp wird geliefert, Tour endet; Protokoll "1 von 3"', st is None and await pg.evaluate("__lm.cen.stats.n") == n0 + 1 and '1 von 3 zugestellt' in await pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')"))
            await pg.evaluate(ENDALL)

            ok('Z Keine Skriptfehler', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
