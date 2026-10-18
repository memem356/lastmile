import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
OUT=HERE+'out/'; os.makedirs(OUT, exist_ok=True)
MOCK='http://127.0.0.1:9297'
REPO=os.path.abspath(HERE+'..')
BASE='http://127.0.0.1:8397/index.html'
URL=BASE+'?debug'
CODE=re.search(r"'(LM-[A-Z0-9-]+)'", open(HERE+'../firebase-rules.json').read()).group(1)
CORS={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,PUT,POST,DELETE,PATCH,OPTIONS'}
CK='51_451_7_014'  # Essen-Demo
def mockreq(method, path, body=None, headers=None):
    req=urllib.request.Request(MOCK+path, data=body, method=method, headers=headers or {})
    try:
        r=urllib.request.urlopen(req, timeout=20); return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
def ctl(p, b=None): return json.loads(mockreq('POST','/ctl/'+p, json.dumps(b or {}).encode())[1])
async def handler(route, request):
    u=request.url
    if request.method=='OPTIONS': return await route.fulfill(status=204, headers=CORS)
    m=re.match(r'https://identitytoolkit\.googleapis\.com/v1/accounts:(\w+)\?(.*)$', u)
    if m: mu='/auth/%s?%s'%m.groups()
    elif (m:=re.match(r'https://securetoken\.googleapis\.com/v1/token\?(.*)$', u)): mu='/token?'+m.group(1)
    elif (m:=re.match(r'https://([^/]+)/(.*)$', u)): mu='/db/%s/%s'%m.groups()
    else: return await route.abort()
    h={k:v for k,v in request.headers.items() if k.lower() in ('content-type','x-firebase-locale')}
    st,body=await asyncio.to_thread(mockreq, request.method, mu, request.post_data_buffer, h)
    await route.fulfill(status=st, headers=dict(CORS,**{'content-type':'application/json'}), body=body)
async def newctx(b, vw=(1000,900)):
    ctx = await b.new_context(viewport={'width':vw[0],'height':vw[1]})
    await ctx.route(re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*'), handler)
    return ctx
async def newpage(ctx, url=URL, wait=1200):
    pg = await ctx.new_page(); errs=[]
    pg.on('pageerror', lambda e: errs.append(str(e)) if 'Access is denied' not in str(e) else None)
    pg.on('console', lambda m: errs.append('console:'+m.text) if m.type=='error' and 'fonts' not in m.text and 'ERR_' not in m.text and 'Failed to load resource' not in m.text and 'Access is denied' not in m.text else None)
    await pg.add_init_script("localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
    await pg.goto(url); await pg.wait_for_timeout(wait)
    return pg, errs
async def vis(pg, sel): return await pg.evaluate("s=>{const e=document.querySelector(s);return !!e&&!e.hidden&&(e.offsetParent!==null||getComputedStyle(e).position==='fixed')}", sel)
async def wait_vis(pg, sel, ms=8000):
    for _ in range(ms//100):
        try:
            if await vis(pg, sel): return True
        except Exception: pass
        await pg.wait_for_timeout(100)
    return False
async def wait_app(pg, ms=25000):
    for _ in range(ms//250):
        if await pg.evaluate("!document.getElementById('app').hidden && !!window.__lm"): return True
        await pg.wait_for_timeout(250)
    return False
def dbstate(): return ctl('state')['DB']
async def away(pg, skew_ms):
    # Seite verlassen (dabei wird zuletzt gespeichert), Serveruhr vorstellen, Seite wieder öffnen
    await pg.goto('about:blank'); await pg.wait_for_timeout(1000)
    ctl('skew', {'ms': skew_ms})
    await pg.goto(URL); await pg.wait_for_timeout(500)
async def main():
    srv=subprocess.Popen(['node',HERE+'fbmock.js','9297'], stdout=subprocess.DEVNULL)
    web=subprocess.Popen(['python3','-m','http.server','8397','--bind','127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R=[]
    def ok(name, cond, info=''): R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            # ---------- Startseite ohne Konto
            ctx = await newctx(b); pg, errs = await newpage(ctx)
            ok('Ohne Konto: nur die Anmeldung, keine Spielart, keine Suche', await vis(pg,'#authBox') and not await vis(pg,'#pickBox') and await pg.evaluate("['playBox','gateBox','onlineBox','modeSec','searchBox','chipBox'].every(i=>!document.getElementById(i))"))
            # ---------- Konto anlegen: danach Startort wählen
            await pg.evaluate("code=>LMO.register({name:'Tim Express',email:'tim@example.de',password:'geheim123',code})", CODE)
            uid=await pg.evaluate("LMO.state().uid")
            ok('Nach der Registrierung: Startort-Wahl, keine Unternehmen-Liste', await wait_vis(pg,'#pickMain') and not await vis(pg,'#authBox') and await pg.locator('#onlineList').count()==0)
            await pg.screenshot(path=OUT+'on_start.png')
            await pg.click('#chips button >> text=Essen'); await pg.click('#confirmGo')
            ok('Online-Spiel startet', await wait_app(pg))
            await pg.wait_for_timeout(800)
            ok('Kopfzeile: Online-Chip statt Tempo/Pause', await vis(pg,'#onChip') and not await vis(pg,'#speedSeg') and not await vis(pg,'#pauseBtn') and 'online' in (await pg.inner_text('#scope')).lower(), await pg.inner_text('#scope'))
            ok('Adresse bleibt ohne Anhang', '#' not in pg.url, pg.url)
            # Uhr: Weltzeit, 30-fach
            r=await pg.evaluate("()=>{const t=document.getElementById('clock').textContent.split(':').map(Number);return {clock:t[0]*3600+t[1]*60+t[2], g:LMO.world.gameNow()%86400}}")
            d=abs(r['clock']-r['g']); d=min(d, 86400-d); ok('Uhr zeigt die gemeinsame Weltzeit', d<8, f"{r}")
            a=await pg.evaluate("[__lm.sim(), performance.now()]"); await pg.wait_for_timeout(2000); c=await pg.evaluate("[__lm.sim(), performance.now()]")
            rate=(c[0]-a[0])/((c[1]-a[1])/1000); ok('Zeit läuft 30-fach', 27<rate<33, f'{rate:.1f}')
            wt=await pg.evaluate("LMO.world.gameNow()-__lm.worldT()"); ok('Weltzeit des Spiels folgt der Serverzeit', abs(wt)<4, f'{wt:.2f}')
            await pg.keyboard.press('Space'); await pg.wait_for_timeout(300)
            a2=await pg.evaluate("__lm.sim()"); await pg.wait_for_timeout(500); c2=await pg.evaluate("__lm.sim()"); ok('Leertaste pausiert nicht', c2>a2)
            # erstes Speichern in die Cloud
            for _ in range(20):
                if (dbstate().get('savemeta') or {}).get(uid): break
                await pg.wait_for_timeout(500)
            S=dbstate(); sv=json.loads(S['saves'][uid]['o_'+CK]['data'])
            ok('Stand in der Cloud', sv['mode']=='online' and sv['sess']==S['sessions'][uid]['o_'+CK]['sess'] and S['saves'][uid]['o_'+CK]['sess']==sv['sess'] and sv['srv']>1e12, '')
            ok('Info für die Liste', S['savemeta'][uid]['o_'+CK]['info'].startswith('Online · Essen'), S['savemeta'][uid]['o_'+CK]['info'])
            ok('Kopie auf dem Gerät, nicht in der Solo-Liste', await pg.evaluate("Object.keys(localStorage).some(k=>k.startsWith('lm.osave.'))") and not await pg.evaluate("Object.keys(localStorage).some(k=>k.startsWith('lm.save.'))"))
            # Wertung und Rangliste
            await pg.evaluate("__lm.setCash(1500); __lm.stats.n=7"); ok('Unternehmenswert = Kasse + Fahrrad', await pg.evaluate("__lm.value()")==1560)
            ok('Speichern meldet Erfolg', await pg.evaluate("__lm.push()"))
            B=dbstate()['board']
            ok('Rangeinträge für Stadt und weltweit', all(uid in B[k][s] for k in (CK,'_global') for s in ('all','day','week')), json.dumps(B)[:300])
            e=B[CK]['all'][uid]; ok('Eintrag: Name, Wachstum, Lieferungen', e['n']=='Tim Express' and e['g']==1350 and e['l']==7 and e['c'].startswith('Essen'), json.dumps(e))
            await pg.evaluate("__lm.rank()"); await pg.wait_for_timeout(600)
            ok('Chip zeigt den Rang', 'Rang 1' in await pg.inner_text('#onChip'), await pg.inner_text('#onChip'))
            await pg.click('#onChip'); await pg.wait_for_timeout(900)
            ok('Rangliste offen mit eigener Zeile', await vis(pg,'#dlg') and 'Rangliste' in await pg.inner_text('#dlgT') and await pg.locator('#dlgB tr.me').count()==1, (await pg.inner_text('#dlgB'))[:160].replace('\n',' | '))
            await pg.screenshot(path=OUT+'on_rank.png')
            for lab,exp in (('Woche','Tim Express'),('Heute','Tim Express'),('Weltweit','Tim Express'),('Gesamt','Tim Express')):
                await pg.click('#dlgB .seg button >> text='+lab); await pg.wait_for_timeout(500)
                ok('Rangliste '+lab, exp in await pg.inner_text('#dlgB'), (await pg.inner_text('#dlgB'))[:90].replace('\n',' | '))
            await pg.click('#dlgB .seg button >> text=Essen'); await pg.wait_for_timeout(300)
            await pg.click('#dlgB .seg button >> text=Lieferungen'); await pg.wait_for_timeout(500); ok('Rangliste Lieferungen zeigt 7', '7' in await pg.inner_text('#dlgB tr.me'), await pg.inner_text('#dlgB tr.me'))
            await pg.keyboard.press('Escape')
            # Menü
            await pg.click('#menuBtn'); await pg.wait_for_timeout(200); mt=await pg.inner_text('#dlgB')
            ok('Menü online: Rangliste und Konto ja, Export/Import und Aufgeben nein', 'Rangliste' in mt and 'Konto' in mt and 'exportieren' not in mt and 'importieren' not in mt and 'aufgeben' not in mt, mt[:200].replace('\n',' | '))
            await pg.keyboard.press('Escape')
            # ---------- zweites Gerät übernimmt
            pg2, errs2 = await newpage(ctx, URL, 800)
            ok('zweiter Tab startet von selbst mit dem Unternehmen', await wait_app(pg2))
            ok('zweiter Tab hat den Stand (Kasse 1500)', abs(await pg2.evaluate("__lm.cash()")-1500)<60, str(await pg2.evaluate("__lm.cash()")))
            ok('erster Tab: Speichern wird abgelehnt', not await pg.evaluate("__lm.push()")); await pg.wait_for_timeout(300)
            ok('erster Tab: Sitzung beendet, Dialog, angehalten', await pg.evaluate("__lm.halted()") and 'Sitzung beendet' in await pg.inner_text('#dlgT') and 'Beendet' in await pg.inner_text('#onChip'))
            t1=await pg.inner_text('#clock'); await pg.wait_for_timeout(1500); ok('erster Tab: Uhr steht', t1==await pg.inner_text('#clock'))
            await pg.screenshot(path=OUT+'on_superseded.png')
            ok('zweiter Tab kann speichern', await pg2.evaluate("__lm.push()"))
            await pg.close()
            # ---------- Abwesenheit
            await pg2.evaluate("__lm.setCash(2000); Object.assign(__lm.stats,{n:9,pay:90,tip:6,cost:2}); __lm.push()"); await pg2.wait_for_timeout(500)
            await pg2.goto('about:blank'); await pg2.wait_for_timeout(1000)
            sim0=json.loads(dbstate()['saves'][uid]['o_'+CK]['data'])['simClock']
            ctl('skew', {'ms': 600000}); await pg2.goto(URL)
            ok('Neu laden: Online startet wieder', await wait_app(pg2)); await pg2.wait_for_timeout(500)
            dl=await pg2.inner_text('#dlgB') if await vis(pg2,'#dlg') else ''
            ok('Willkommen-Meldung nach 10 Minuten', 'Willkommen' in await pg2.inner_text('#dlgT') and ('10 Minuten' in dl or '11 Minuten' in dl) and 'Spielwelt' in dl, dl[:200].replace('\n',' | '))
            ok('ohne Disposition: Betrieb ruht', 'geruht' in dl)
            sim1=await pg2.evaluate("__lm.sim()"); ok('Spielzeit +10 min Echtzeit = +5 Spielstunden', abs((sim1-sim0)-18000)<900, f'{sim1-sim0:.0f}')
            wt=await pg2.evaluate("LMO.world.gameNow()-__lm.worldT()"); ok('Weltzeit nach Abwesenheit wieder an der Serverzeit', abs(wt)<4, f'{wt:.2f}')
            await pg2.screenshot(path=OUT+'on_welcome.png')
            await pg2.keyboard.press('Escape')
            # mit Disposition
            await pg2.evaluate("__lm.setCash(3000); __lm.buy('dispatch')"); ok('Disposition gekauft', await pg2.evaluate("__lm.owned.dispatch===true && __lm.cash()<3000"))
            await pg2.evaluate("__lm.push()"); await pg2.wait_for_timeout(300)
            cash0=await pg2.evaluate("__lm.cash()"); n0=await pg2.evaluate("__lm.stats.n")
            await away(pg2, 600000+1800000); ok('Neu laden nach 30 Min.', await wait_app(pg2)); await pg2.wait_for_timeout(500)
            dl=await pg2.inner_text('#dlgB') if await vis(pg2,'#dlg') else ''
            ok('Auto-Disposition hat gearbeitet', 'Auto-Disposition hat' in dl and 'Bestellungen ausgeliefert' in dl, dl[:260].replace('\n',' | '))
            n1=await pg2.evaluate("__lm.stats.n"); cash1=await pg2.evaluate("__lm.cash()"); ok('Lieferungen und Kasse gestiegen', n1>n0+5 and cash1>cash0, f'{n0}->{n1}, {cash0:.0f}->{cash1:.0f}')
            await pg2.keyboard.press('Escape')
            # Obergrenze: 3 Stunden weg, angerechnet 1 Stunde
            await pg2.evaluate("__lm.push()"); await pg2.wait_for_timeout(300)
            cash0=await pg2.evaluate("__lm.cash()")
            await pg2.goto('about:blank'); await pg2.wait_for_timeout(1000)
            sim0=json.loads(dbstate()['saves'][uid]['o_'+CK]['data'])['simClock']
            ctl('skew', {'ms': 600000+1800000+3*3600000}); await pg2.goto(URL); ok('Neu laden nach 3 Stunden', await wait_app(pg2)); await pg2.wait_for_timeout(500)
            dl=await pg2.inner_text('#dlgB') if await vis(pg2,'#dlg') else ''
            ok('Obergrenze 1 Stunde im Text', 'höchstens 1 Stunde' in dl and '30 Stunden' in dl, dl[:260].replace('\n',' | '))
            sim1=await pg2.evaluate("__lm.sim()"); ok('angerechnet: 30 Spielstunden', abs((sim1-sim0)-108000)<600, f'{sim1-sim0:.0f}')
            wt=await pg2.evaluate("LMO.world.gameNow()-__lm.worldT()"); ok('Welt läuft über die Obergrenze hinaus weiter', abs(wt)<4, f'{wt:.2f}')
            gain=await pg2.evaluate("__lm.cash()")-cash0; ok('Gewinn in 30 Spielstunden plausibel (Rangliste würde ihn akzeptieren)', 0<gain<3600*10, f'{gain:.0f}')
            await pg2.keyboard.press('Escape')
            ok('Speichern nach Obergrenze durch die Regeln erlaubt', await pg2.evaluate("__lm.push()"), json.dumps(ctl('state')['LOG'][-3:]))
            # ---------- Zwischenzeit mitten im Spiel (Tab im Hintergrund): 10 Sekunden Stillstand
            sA=await pg2.evaluate("__lm.sim()"); oA=await pg2.evaluate("__lm.orders()")
            await pg2.evaluate("()=>{const t=Date.now();while(Date.now()-t<10000);}")
            await pg2.wait_for_timeout(600)
            sB=await pg2.evaluate("__lm.sim()"); wt=await pg2.evaluate("LMO.world.gameNow()-__lm.worldT()")
            ok('Zwischenzeit: Spielzeit holt 10 s (=300 Spielsekunden) auf', 280<sB-sA<420, f'{sB-sA:.0f}')
            ok('Zwischenzeit: Welt bleibt an der Serverzeit', abs(wt)<4, f'{wt:.2f}')
            ok('Zwischenzeit: keine Meldung bei kurzer Pause, Spiel läuft', not await vis(pg2,'#dlg') and not await pg2.evaluate("__lm.halted()"))
            # ---------- Kopie auf dem Gerät, wenn die Cloud nicht erreichbar ist
            await pg2.evaluate("__lm.setCash(4321)"); await pg2.wait_for_timeout(300)
            ctl('fail', {'match':'saves/','method':'PUT','status':500,'times':1000})
            await pg2.evaluate("window.dispatchEvent(new Event('pagehide'))"); await pg2.wait_for_timeout(1200)
            ctl('fail', {})
            await pg2.reload(); ok('Neu laden bei ausgefallener Cloud-Speicherung', await wait_app(pg2)); await pg2.wait_for_timeout(500)
            ok('Stand kommt von der Kopie auf dem Gerät (Kasse 4321)', abs(await pg2.evaluate("__lm.cash()")-4321)<80, str(await pg2.evaluate("__lm.cash()")))
            if await vis(pg2,'#dlg'): await pg2.keyboard.press('Escape')
            # ---------- Neu anfangen (Konto-Fenster)
            await pg2.click('#menuBtn'); await pg2.wait_for_timeout(200); await pg2.click('#dlgB button >> text=Konto'); await pg2.wait_for_timeout(900)
            ok('Konto-Fenster: Unternehmen mit Wert und Lieferungen', 'Startort: Essen' in await pg2.inner_text('#accBody') and 'Lieferungen' in await pg2.inner_text('#accBody'), (await pg2.inner_text('#accBody'))[:300].replace('\n',' | '))
            await pg2.click('#accBody button >> text=Neu anfangen'); await pg2.wait_for_timeout(200); ok('erster Klick fragt nach', 'Wirklich' in await pg2.inner_text('#accBody'))
            await pg2.click('#accBody button >> text=Wirklich'); await wait_vis(pg2,'#pickMain',20000); await pg2.wait_for_timeout(500)
            S=dbstate(); ok('Neu anfangen löscht Stand, Sitzung und Stadt-Eintrag', not (S.get('saves') or {}).get(uid) and not (S.get('sessions') or {}).get(uid) and uid not in ((S.get('board') or {}).get(CK) or {}).get('all',{}), json.dumps(S.get('saves'))[:100])
            ok('weltweiter Eintrag bleibt', uid in S['board']['_global']['all'])
            ok('zurück bei der Startort-Wahl', await vis(pg2,'#pickMain') and not await vis(pg2,'#app'))
            ok('keine Seitenfehler', not errs and not errs2, str(errs+errs2)[:300])
            # ---------- Handy-Breite
            await ctx.close()
            ctx2 = await newctx(b, (390,780)); pg3, e3 = await newpage(ctx2)
            await pg3.evaluate("([e,p])=>LMO.login(e,p)", ['tim@example.de','geheim123']); await wait_vis(pg3,'#pickMain')
            await pg3.click('#chips button >> text=Essen'); await pg3.click('#confirmGo'); ok('Handy: Online startet (neues Unternehmen)', await wait_app(pg3)); await pg3.wait_for_timeout(1200)
            await pg3.screenshot(path=OUT+'on_mobile.png')
            await pg3.evaluate("__lm.push()")
            await pg3.click('#menuBtn'); await pg3.wait_for_timeout(200); await pg3.click('#dlgB button >> text=Konto'); await pg3.wait_for_timeout(1200)
            ct=await pg3.inner_text('#accBody'); ok('Handy: Konto-Fenster mit Unternehmen', 'Startort: Essen' in ct and 'Neu anfangen' in ct, ct[:200].replace('\n',' | '))
            await pg3.screenshot(path=OUT+'on_account.png')
            w=await pg3.evaluate("[document.documentElement.scrollWidth, innerWidth, document.getElementById('accBox').getBoundingClientRect().width]"); ok('Handy: Konto-Fenster passt in die Breite', w[0]<=w[1]+1 and w[2]<=w[1], str(w))
            await pg3.keyboard.press('Escape')
            ok('Handy: kein seitliches Scrollen', await pg3.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"))
            ok('Handy: keine Seitenfehler', not e3, str(e3)[:200])
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    bad=[n for n,c in R if not c]; print(f'\n{len(R)-len(bad)} bestanden, {len(bad)} fehlgeschlagen'); sys.exit(1 if bad else 0)
asyncio.run(main())
