"""Fulfillment Center, Abwesenheit und Kundenbestand: Vergütung, Schnellvorlauf (Zulauf, Touren laufen mit, Verfall ohne Abzug), Mindestbestand, Neuladen.
Start: python3 tests/ui_absence.py   (Ports 8380 / 9280)"""
import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MOCK = 'http://127.0.0.1:9280'
REPO = os.path.abspath(HERE + '..')
URL = 'http://127.0.0.1:8380/index.html?debug&nobase'
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

SETUP_FAKE = "a=>{window.__gP = performance.now(); LMO.world.gameNow = () => a.day * 86400 + a.h * 3600 + (performance.now() - window.__gP) / 1000 * LMO.world.speed}"
OPEN = "__lm.cen.orders().filter(o=>o.state==='open')"


async def main():
    srv = subprocess.Popen(['node', HERE + 'fbmock.js', '9280'], stdout=subprocess.DEVNULL)
    web = subprocess.Popen(['python3', '-m', 'http.server', '8380', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            pg, errs, started = await start_game(ctx, 'Tim Abwesend', 'abs@example.de')
            ok('T0 Spiel startet', started)
            await pg.evaluate("window.__rnd = Math.random; Math.random = () => 0.5; __lm.cen.auto(false); __lm.drivers().forEach(d => { d.rest = 'on'; })")
            await pg.evaluate("__lm.setCash(500000)")
            await pg.evaluate(POI_BUILD)
            ci = 0
            await pg.evaluate("__lm.cen.startFirms()"); await wait_for(pg, "__lm.cen.firmState()==='ok'", 8000)
            await pg.evaluate("for (let i=0;i<4;i++) __lm.cen.buyVan(0); for (let i=0;i<5;i++) __lm.cen.hire(0)")
            ok('T1 Center mit 4 Transportern und 5 Fahrern', await pg.evaluate("[__lm.cen.centers()[0].vans.length, __lm.cen.centers()[0].drv.length]") == [4, 5])
            vans = await pg.evaluate("__lm.cen.centers()[0].vans.map(v=>v.id)"); drvs = await pg.evaluate("__lm.cen.centers()[0].drv.map(d=>d.id)")
            ENDALL = "(()=>{const c=__lm.cen.centers()[0]; c.tours.filter(t=>t.st==='plan').forEach(t=>__lm.cen.tour.cancel(0,t.id)); const a=__lm.cen.orders(); a.splice(0,a.length)})()"
            PLAN = "a=>{const r=__lm.cen.tour.plan(0,a); return r.ok?r.tour.id:r.err}"
            FAKENOW = lambda day, h: pg.evaluate(SETUP_FAKE, {'day': day, 'h': h})
            logs = lambda: pg.evaluate("[...document.querySelectorAll('#log li')].map(l=>l.textContent).join('|')")

            # ================= P: Vergütung =================
            pays = await pg.evaluate("[LMC.pay(1,false), LMC.pay(2,false), LMC.pay(4,false), LMC.pay(2,true), LMC.pay(7,true)]")
            ok('P1 Vergütung: Privat 5,50 + 1,60 je Paket, Firma 8,50 + 1,90 je Paket', pays == [7.1, 8.7, 11.9, 12.3, 21.8], str(pays))
            o1 = await pg.evaluate("(()=>{const x=__lm.cen.spawn(0,'private'); return {n:x.n, pay:x.pay}})()")
            ok('P2 Neue Bestellung: Lohn = Formel mal Online-Faktor 1,1', abs(o1['pay'] - round(await pg.evaluate("LMC.pay(%d,false)" % o1['n']) * 1.1, 1)) < 1e-9, str(o1))
            mig = await pg.evaluate("""()=>{ const x=__lm.cen.spawn(0,'firm'); const sv=__lm.save.snapshot(); const pay=sv.corders.find(o=>o.id===x.id).pay;
              const v5=JSON.parse(JSON.stringify(sv)); v5.v=5; const a=__lm.save.normalizeSave(v5).corders.find(o=>o.id===x.id).pay;
              const v6=JSON.parse(JSON.stringify(sv)); const c=__lm.save.normalizeSave(v6).corders.find(o=>o.id===x.id).pay; return {pay, a, c} }""")
            ok('P3 Alter Spielstand (Version 5): offene Bestellungen bekommen einmal +1,50 € (mal 1,1), neuer Stand bleibt unverändert',
               abs(mig['a'] - (mig['pay'] + 1.65)) < 0.06 and mig['c'] == mig['pay'], str(mig))
            await pg.evaluate(ENDALL)

            # ================= A: Touren laufen in der Abwesenheit =================
            await FAKENOW(7, 15.0)
            await setT(pg, 10.0, 7)
            a = [await mk(pg, ci, False, 7, 12, 15, 2, 200 + i) for i in range(3)]
            bb = [await mk(pg, ci, False, 7, 16, 19, 2, 210 + i) for i in range(2)]
            cc = await mk(pg, ci, False, 7, 18, 20, 2, 220)
            d1 = await mk(pg, ci, False, 7, 9, 11, 2, 230)              # Fenster vorbei: verfällt um 13:00
            f1 = await mk(pg, ci, False, 6, 10, 12, 2, 231)             # von gestern
            e1 = await mk(pg, ci, False, 7, 20, 22, 2, 232)             # bleibt offen
            t1 = await pg.evaluate(PLAN, {'k': 2, 'day': 7, 'van': vans[0], 'drv': drvs[0], 'stops': a})
            t2 = await pg.evaluate(PLAN, {'k': 3, 'day': 7, 'van': vans[1], 'drv': drvs[1], 'stops': bb})
            t3 = await pg.evaluate(PLAN, {'k': 4, 'day': 7, 'van': vans[2], 'drv': drvs[2], 'stops': [cc]})
            ok('A1 Drei Touren für Freitag geplant (12:00, 14:35, 17:00)', all(isinstance(x, int) for x in (t1, t2, t3)), str([t1, t2, t3]))
            pays_a = await pg.evaluate("ids=>__lm.cen.orders().filter(o=>ids.includes(o.id)).reduce((s,o)=>s+o.pay,0)", a)
            n0 = await pg.evaluate("__lm.cen.stats.n"); cash0 = await pg.evaluate("__lm.cash()"); ex0 = await pg.evaluate("__lm.cen.stats.expired"); rep0 = await pg.evaluate("__lm.cen.centers()[0].rep")
            await pg.evaluate("__lm.absence(600)")                       # 10 Minuten = 5 Spielstunden: 10:00 bis 15:00
            rep = await pg.evaluate("__lm.cen.rep()")
            ok('A2 Tour 12:00 ist in der Abwesenheit gefahren und beendet, Transporter und Fahrer sind frei', await pg.evaluate(TOUR, t1) is None and await pg.evaluate("a=>!__lm.cen.centers()[0].vans.find(v=>v.id===a.v).tour && !__lm.cen.centers()[0].drv.find(d=>d.id===a.d).tour", {'v': vans[0], 'd': drvs[0]}), str(rep))
            n1 = await pg.evaluate("__lm.cen.stats.n")
            ok('A3 Alle drei Stopps wurden zugestellt, Lohn der Bestellungen stimmt', n1 - n0 == 3 and abs(rep['pay'] - pays_a) < 0.01 and rep['deliv'] == 3 and rep['tours'] >= 1, '%s %s %s' % (n1 - n0, rep['pay'], pays_a))
            st2 = await pg.evaluate(TOUR, t2)
            ok('A4 Tour 14:35 läuft um 15:00 noch (zwei Stopps, Beladen, Fahrt oder Warten) und fährt in Echtzeit weiter', st2 and st2['st'] in ('load', 'drive', 'wait', 'door') and st2['stops'] == 2, str(st2))
            ok('A5 Tour 17:00 bleibt geplant', (await pg.evaluate(TOUR, t3))['st'] == 'plan')
            cash1 = await pg.evaluate("__lm.cash()")
            ok('A6 Kasse: Lohn der Lieferungen minus Fahrerlohn (Fahrerlohn gibt es nur für die Tourzeit)', 0 < cash1 - cash0 <= pays_a + 0.01 and cash1 - cash0 >= pays_a - 11.0 * 5 - 1, '%.2f vs %.2f, Kosten %.2f' % (cash1 - cash0, pays_a, rep['cost']))
            ok('A7 Kosten: Fahrerlohn für die Tour, kein Wert für Leerlauf', 0 < rep['cost'] < 11.0 * 5 + 5, str(rep['cost']))
            ok('A8 Verfallene Bestellung (Fenster 9–11) und die von gestern sind weg, ohne Abzug (Zähler unverändert)', await pg.evaluate("a=>a.every(i=>!__lm.cen.orders().some(o=>o.id===i))", [d1, f1]) and await pg.evaluate("__lm.cen.stats.expired") == ex0 and rep['expired'] >= 2, str(rep))
            ok('A9 Offene Bestellung für 20–22 Uhr bleibt', await pg.evaluate("a=>__lm.cen.orders().some(o=>o.id===a&&o.state==='open')", e1))
            ok('A10 Ansehen des Centers sinkt nicht (pünktliche Lieferungen)', await pg.evaluate("__lm.cen.centers()[0].rep") >= rep0 - 1e-9)
            ok('A11 Keine Einzelmeldungen im Protokoll (stiller Vorlauf), aber eine Zusammenfassung in der Auswertung', 'zugestellt (' not in await logs() and len(rep['lines']) >= 1 and 'Tour 12:00' in rep['lines'][0], str(rep['lines'])[:200])
            ok('A12 Uhr steht wieder bei der Weltzeit (Freitag 15:00)', abs(await pg.evaluate("__lm.cen.absT()") - (7 * 86400 + 15.0 * 3600)) < 400, HM(await pg.evaluate("__lm.cen.absT()")))
            st, seen = await run_until(pg, t2, lambda s: False)
            ok('A13 Die Tour 14:35 läuft nach der Rückkehr normal zu Ende', st is None and await pg.evaluate("__lm.cen.stats.n") == n1 + 2, str(seen))
            await pg.evaluate(ENDALL)

            # ================= B: Zulauf in der Abwesenheit =================
            await pg.evaluate("Math.random = window.__rnd; __lm.cen.auto(true); __lm.cen.cities().forEach(c => { c.dem = 4000; })")
            await FAKENOW(7, 21.0)
            await setT(pg, 6.0, 7)
            await pg.evaluate(ENDALL)
            id0 = await pg.evaluate("__lm.cen.stock.seq()")
            ex0 = await pg.evaluate("__lm.cen.stats.expired"); rep0 = await pg.evaluate("__lm.cen.centers()[0].rep")
            await pg.evaluate("__lm.absence(1800)")                      # 30 Minuten = 15 Spielstunden: 6:00 bis 21:00
            rep = await pg.evaluate("__lm.cen.rep()")
            per_day = await pg.evaluate("__lm.cen.stock.perDay(0)")
            exp_n = per_day * 13.95 / 17.7
            ok('B1 Neue Bestellungen kamen während der Abwesenheit (etwa Zulauf mal Dauer)', rep['orders'] >= 0.6 * exp_n and rep['orders'] <= 1.5 * exp_n + 3, '%s erwartet %.1f (%.1f pro Tag)' % (rep['orders'], exp_n, per_day))
            info = await pg.evaluate("""()=>{ const sim=__lm.sim(), now=__lm.cen.absT(), os=__lm.cen.orders().filter(o=>o.id>=%d&&o.id<%d); const cr=os.map(o=>o.created);
              return {n:os.length, minc:Math.min(...cr), maxc:Math.max(...cr), mono:os.every((o,i)=>i===0||os[i-1].created<=o.created), spread:new Set(os.map(o=>Math.round(o.created/3600))).size,
                days:os.every(o=>o.day-Math.floor(o.created/86400)>=0&&o.day-Math.floor(o.created/86400)<=5), fit:os.every(o=>Math.abs(o.ws-__lm.cen.simOf(o.day,o.wh[0]))<1e-6), live:__lm.cen.orders().every(o=>o.we+LMC.EXPIRE>sim), now} }""" % (id0, id0 + rep['orders']))
            w0, w1 = 7 * 86400 + 6 * 3600, 7 * 86400 + 21 * 3600
            ok('B2 Erstellzeiten liegen in der Abwesenheit, steigen und sind über viele Stunden verteilt', info['minc'] >= w0 - 1 and info['maxc'] <= w1 + 1 and info['mono'] and info['spread'] >= 5, str(info))
            ok('B3 Fenster wurden zum Erstellzeitpunkt geplant (die nächsten drei Liefertage), passen zur Uhr; nichts Verfallenes bleibt', info['days'] and info['fit'] and info['live'], str(info))
            ok('B4 Verfall in der Abwesenheit ohne Abzug (Zähler und Ansehen unverändert)', await pg.evaluate("__lm.cen.stats.expired") == ex0 and await pg.evaluate("__lm.cen.centers()[0].rep") == rep0 and rep['expired'] >= 1, 'expired %s' % rep['expired'])
            ok('B5 Danach mindestens der Mindestbestand an offenen Bestellungen', await pg.evaluate("__lm.cen.stock.have(0)") >= await pg.evaluate("__lm.cen.stock.target(0)"))
            ok('B6 Obergrenze je Center wird nicht überschritten', await pg.evaluate("__lm.cen.orders().length") <= await pg.evaluate("__lm.cen.cap(0)"))

            # ================= C: Mindestbestand =================
            await pg.evaluate(ENDALL)
            await FAKENOW(7, 8.0); await setT(pg, 8.0, 7)
            tg = await pg.evaluate("__lm.cen.stock.target(0)"); per_day = await pg.evaluate("__lm.cen.stock.perDay(0)"); cap = await pg.evaluate("__lm.cen.cap(0)")
            ok('C1 Soll = etwa 1,5 Tage Zulauf, mindestens 12, höchstens das Limit', tg == max(12, min(cap, int(1.5 * per_day + 0.5))) and tg > 12, '%s (%.1f pro Tag, Limit %s)' % (tg, per_day, cap))
            made = await pg.evaluate("__lm.cen.stock.all()")
            have = await pg.evaluate("__lm.cen.stock.have(0)")
            ok('C2 Leeres Center wird bis zum Soll aufgefüllt', made == tg and have == tg, '%s %s %s' % (made, have, tg))
            sp = await pg.evaluate("""()=>{ const now=__lm.cen.absT(), os=__lm.cen.orders(); return {age:os.every(o=>o.created<=now&&o.created>=now-5*3600-1), days:[...new Set(os.map(o=>o.day))].sort(), d0:Math.floor(now/86400),
              fit:os.every(o=>Math.abs(o.we-__lm.cen.simOf(o.day,o.wh[1]))<1e-6)} }""")
            ok('C3 Bestellungen liegen seit höchstens 5 Stunden vor, Fenster heute bis übermorgen (mehrere Tage)',
               sp['age'] and len(sp['days']) >= 2 and sp['days'][0] >= sp['d0'] and sp['days'][-1] <= sp['d0'] + 4 and sp['fit'], str(sp))
            ok('C4 Noch einmal aufrufen (wie Neuladen) bringt nichts dazu', await pg.evaluate("__lm.cen.stock.all()") == 0 and await pg.evaluate("__lm.cen.orders().length") == tg)
            await pg.evaluate("a=>{const o=__lm.cen.orders(); o.splice(0, a)}", 7)
            ok('C5 Fehlen Bestellungen, wird nur der Rest aufgefüllt', await pg.evaluate("__lm.cen.stock.all()") == 7 and await pg.evaluate("__lm.cen.stock.have(0)") == tg)
            await pg.evaluate("__lm.cen.cities().forEach(c => { c.dem = 1; })")
            tg2 = await pg.evaluate("__lm.cen.stock.target(0)")
            ok('C6 Kleine Nachfrage: Soll bleibt bei mindestens 12', tg2 == 12, str(tg2))
            await pg.evaluate("__lm.cen.cities().forEach(c => { c.dem = 4000; })")
            await pg.evaluate(ENDALL)
            ok('C7 Ohne Fahrer kommen keine Bestellungen (auch nicht als Bestand)', await pg.evaluate("(()=>{const c=__lm.cen.centers()[0], d=c.drv; c.drv=[]; const r=__lm.cen.stock.top(0); c.drv=d; return r})()") == 0)
            hired = await pg.evaluate("!!__lm.cen.hire(0)")
            ok('C8 Ein neu eingestellter Fahrer füllt den Bestand des Centers auf', hired and await pg.evaluate("__lm.cen.stock.have(0)") >= await pg.evaluate("__lm.cen.stock.target(0)") >= 12, '%s %s' % (hired, await pg.evaluate("__lm.cen.stock.have(0)")))

            # ================= D: lange Abwesenheit (Uhr springt) =================
            await pg.evaluate("Math.random = () => 0.5; __lm.cen.auto(false)")
            await pg.evaluate(ENDALL)
            await FAKENOW(7, 12.1)                                       # 2 Stunden echte Zeit = 60 Spielstunden, angerechnet 30: Fenster Mittwoch 0:06 bis Donnerstag 6:06
            await setT(pg, 0.1, 5)
            e1 = [await mk(pg, ci, False, 5, 10, 13, 2, 300 + i) for i in range(2)]
            e2 = [await mk(pg, ci, False, 6, 7, 10, 2, 310 + i) for i in range(2)]
            e3 = [await mk(pg, ci, False, 7, 12, 15, 2, 320 + i) for i in range(2)]
            q1 = await pg.evaluate(PLAN, {'k': 1, 'day': 5, 'van': vans[0], 'drv': drvs[0], 'stops': e1})
            q2 = await pg.evaluate(PLAN, {'k': 0, 'day': 6, 'van': vans[1], 'drv': drvs[1], 'stops': e2})
            q3 = await pg.evaluate(PLAN, {'k': 2, 'day': 7, 'van': vans[2], 'drv': drvs[2], 'stops': e3})
            ok('D1 Drei Touren geplant: Mittwoch 9:35, Donnerstag 6:35 (Beladen beginnt kurz vor Fensterende), Freitag 12:00 (nach dem angerechneten Fenster)', all(isinstance(x, int) for x in (q1, q2, q3)), str([q1, q2, q3]))
            n0 = await pg.evaluate("__lm.cen.stats.n")
            await pg.evaluate("__lm.absence(7200)")
            rep = await pg.evaluate("__lm.cen.rep()")
            ok('D2 Mittwochstour gefahren und beendet', await pg.evaluate(TOUR, q1) is None and rep['deliv'] == 4, str(rep))
            ok('D3 Donnerstagstour wurde im Nachlauf zu Ende gefahren (keine Tour hängt in der Luft), alle vier Lieferungen', await pg.evaluate(TOUR, q2) is None and await pg.evaluate("__lm.cen.stats.n") - n0 == 4 and await pg.evaluate("__lm.cen.centers()[0].tours.every(t=>t.st==='plan')"), '%s' % (await pg.evaluate("__lm.cen.stats.n") - n0))
            ok('D4 Freitagstour (nicht angerechnete Zeit) fällt aus, Bestellungen sind wieder frei', await pg.evaluate(TOUR, q3) is None and rep['cancelled'] >= 1 and await pg.evaluate("a=>a.every(i=>__lm.cen.orders().find(o=>o.id===i)&&__lm.cen.orders().find(o=>o.id===i).state==='open')", e3), str(rep))
            ok('D5 Uhr steht bei der Weltzeit (Freitag 12:06), Transporter und Fahrer sind frei', abs(await pg.evaluate("__lm.cen.absT()") - (7 * 86400 + 12.1 * 3600)) < 400 and await pg.evaluate("__lm.cen.centers()[0].vans.every(v=>!v.tour) && __lm.cen.centers()[0].drv.every(d=>!d.tour)"))
            ok('D6 Keine geplante Tour liegt in der Vergangenheit', await pg.evaluate("__lm.cen.centers()[0].tours.every(t=>LMC.loadA(t.day,t.k)>=__lm.cen.absT())"))
            ok('D7 Protokoll nennt den Ausfall', 'du warst nicht da' in await logs())

            # ================= E: echtes Neuladen (Serveruhr vorgestellt) =================
            await pg.evaluate("Math.random = window.__rnd; __lm.cen.auto(true); __lm.push(false)"); await pg.wait_for_timeout(500)
            await pg.reload(); ok('E0 Neu geladen', await wait_app(pg)); await pg.wait_for_timeout(500)
            if await vis(pg, '#dlg'): await pg.keyboard.press('Escape')
            # Weltuhr auf Dienstag 8:00 stellen: Serveruhr vorstellen
            g = await pg.evaluate("LMO.world.gameNow()")
            delta = ((4 * 86400 + 8 * 3600) - (g % 604800)) % 604800
            S0 = int(delta / 30 * 1000)
            await pg.goto('about:blank'); await pg.wait_for_timeout(800)
            ctl('skew', {'ms': S0}); await pg.goto(URL)
            ok('E1 Nach dem Vorstellen der Uhr startet das Spiel wieder', await wait_app(pg)); await pg.wait_for_timeout(600)
            if await vis(pg, '#dlg'): await pg.keyboard.press('Escape')
            hh = (await pg.evaluate("__lm.cen.absT()") % 86400) / 3600; dd = int(await pg.evaluate("__lm.cen.absT()") // 86400) % 7
            ok('E2 Weltzeit ist Dienstag gegen 8 Uhr', dd == 4 and 7.8 < hh < 8.5, '%s %.2f' % (dd, hh))
            await pg.evaluate("__lm.cen.cities().forEach(c => { c.dem = 4000; }); __lm.drivers().forEach(d => { d.rest = 'on'; })")
            await pg.evaluate("__lm.cen.centers()[0].drv.forEach(d=>{d.sick=null}); (()=>{const c=__lm.cen.centers()[0]; c.tours.filter(t=>t.st==='plan').forEach(t=>__lm.cen.tour.cancel(0,t.id));})()")
            await pg.evaluate("__lm.cen.orders().splice(0, __lm.cen.orders().length)")
            ok('E3 Bestand wird aufgefüllt, wenn er fehlt', await pg.evaluate("__lm.cen.stock.all()") >= 12)
            day = await pg.evaluate("Math.floor(__lm.cen.absT()/86400)")
            m1 = await mk(pg, ci, False, day, 13, 16, 2, 400); m2 = await mk(pg, ci, False, day, 13, 16, 2, 401)
            tt = await pg.evaluate(PLAN, {'k': 2, 'day': day, 'van': vans[0], 'drv': drvs[0], 'stops': [m1, m2]})
            ok('E4 Tour um 12:00 geplant', isinstance(tt, int), str(tt))
            n0 = await pg.evaluate("__lm.cen.stats.n"); cash0 = await pg.evaluate("__lm.cash()")
            keep = await pg.evaluate("(()=>{const s=__lm.sim(); return __lm.cen.orders().filter(o=>o.state==='open'&&o.we+LMC.EXPIRE>s+9*3600).map(o=>o.id)})()")
            # erst ein schneller Neustart ohne Zeitsprung: alles bleibt
            ids0 = await pg.evaluate("__lm.cen.orders().map(o=>o.id).sort((a,b)=>a-b)")
            await pg.evaluate("__lm.push(false)"); await pg.wait_for_timeout(400)
            await pg.goto('about:blank'); await pg.wait_for_timeout(800)
            await pg.goto(URL); ok('E5 Schnell neu geladen', await wait_app(pg)); await pg.wait_for_timeout(500)
            ids1 = await pg.evaluate("__lm.cen.orders().map(o=>o.id).sort((a,b)=>a-b)")
            ok('E6 Alle Bestellungen sind nach dem Neuladen noch da (keine wird verworfen), die Tour ebenfalls', set(ids0) <= set(ids1) and (await pg.evaluate(TOUR, tt)) is not None and len(ids1) >= len(ids0), '%s -> %s' % (len(ids0), len(ids1)))
            ok('E6b Kein Willkommens-Dialog bei kurzer Pause', not await vis(pg, '#dlg'))
            # dann 8 Stunden Spielzeit (16 Minuten echte Zeit) weg
            await pg.evaluate("__lm.push(false)"); await pg.wait_for_timeout(400)
            await pg.goto('about:blank'); await pg.wait_for_timeout(800)
            ctl('skew', {'ms': S0 + int(8 * 3600 / 30 * 1000)}); await pg.goto(URL)
            ok('E7 Nach 8 Spielstunden Abwesenheit startet das Spiel', await wait_app(pg)); await pg.wait_for_timeout(600)
            dl = await pg.inner_text('#dlgB') if await vis(pg, '#dlg') else ''
            ok('E8 Willkommen-Dialog nennt Fulfillment: neue Bestellungen, Tour und Lieferungen', 'Willkommen' in await pg.inner_text('#dlgT') and 'Fulfillment:' in dl and 'neue Bestellungen' in dl and 'Lieferungen' in dl and 'Tour 12:00' in dl, dl[:420].replace('\n', ' | '))
            ok('E9 Dialog meldet nicht "Betrieb hat geruht"', 'geruht' not in dl)
            rep = await pg.evaluate("__lm.cen.rep()")
            ok('E10 Tour wurde gefahren: zwei Lieferungen, Kasse gestiegen', await pg.evaluate(TOUR, tt) is None and await pg.evaluate("__lm.cen.stats.n") == n0 + 2 and rep['deliv'] == 2, str(rep)[:240])
            ok('E11 Neue Bestellungen kamen herein (8 Stunden, 5 Transporter)', rep['orders'] >= 5, str(rep['orders']))
            ids2 = await pg.evaluate("__lm.cen.orders().map(o=>o.id)")
            ok('E12 Bestellungen, die noch nicht verfallen können, sind alle noch da', all(i in ids2 for i in keep), '%s von %s' % (sum(1 for i in keep if i in ids2), len(keep)))
            ok('E13 Mindestbestand nach der Rückkehr', await pg.evaluate("__lm.cen.stock.have(0)") >= await pg.evaluate("__lm.cen.stock.target(0)"))
            ok('E14 Weltuhr wieder an der Serverzeit', abs(await pg.evaluate("LMO.world.gameNow()-__lm.worldT()")) < 6)
            lg = await logs()
            ok('E15 Keine Einzelmeldungen für die Zwischenzeit im Protokoll (keine Lieferzeile der beiden Stopps)', ('#%d ' % m1) not in lg and ('#%d ' % m2) not in lg)
            if await vis(pg, '#dlg'): await pg.keyboard.press('Escape')

            ok('Z1 Keine Skriptfehler bis hier', not errs, str(errs[:3]))
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    good = sum(1 for _, c in R if c)
    print('\n%d/%d bestanden' % (good, len(R)))
    sys.exit(0 if good == len(R) else 1)

asyncio.run(main())
