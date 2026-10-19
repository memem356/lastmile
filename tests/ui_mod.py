import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
OUT=HERE+'out/'; os.makedirs(OUT, exist_ok=True)
MOCK='http://127.0.0.1:9299'
REPO=os.path.abspath(HERE+'..')
BASE='http://127.0.0.1:8399/index.html'
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
async def in_game(pg): return await pg.evaluate("!document.getElementById('app').hidden && !!window.__lm")
async def wait_vis(pg, sel, ms=8000):
    for _ in range(ms//100):
        try:
            if await vis(pg, sel): return True
        except Exception: pass
        await pg.wait_for_timeout(100)
    return False
async def enter(pg):
    # neues Konto: Startort Essen wählen und starten; Konto mit Unternehmen: das Spiel startet von selbst
    if await wait_vis(pg,'#pickMain',3000): await pg.click('#chips button >> text=Essen'); await pg.click('#confirmGo')
    return await wait_app(pg)
async def konto(pg, extra=300):
    await pg.click('#menuBtn'); await pg.wait_for_timeout(200); await pg.click('#dlgB button >> text=Konto'); await pg.wait_for_timeout(300)
    try: await pg.wait_for_function("(()=>{const t=document.querySelector('#accBody').innerText;return t.includes('Clan') && !t.includes('Clan wird geladen')})()", timeout=15000)
    except Exception: pass
    await pg.wait_for_timeout(extra)
async def main():
    srv=subprocess.Popen(['node',HERE+'fbmock.js','9299'], stdout=subprocess.DEVNULL)
    web=subprocess.Popen(['python3','-m','http.server','8399','--bind','127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R=[]
    def ok(name, cond, info=''): R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    async def txt(pg, sel='#accBody'): return await pg.inner_text(sel)
    async def idle(pg, scope, wait):  # erst die feste Zeit, dann warten, bis in diesem Bereich keine Schaltfläche mehr beschäftigt (gesperrt) ist
        await pg.wait_for_timeout(wait)
        try: await pg.wait_for_function("s=>![...document.querySelectorAll(s+' button:disabled')].length && !document.querySelector(s).innerText.includes('Clan wird geladen')", arg=scope, timeout=15000)
        except Exception: pass
        await pg.wait_for_timeout(200)
    async def btn(pg, scope, label, wait=500):
        await pg.click(scope+' button >> text='+label); await idle(pg, scope, wait)
    async def twice(pg, scope, label, wait=1200):  # zweistufige Bestätigung
        await pg.click(scope+' button >> text='+label); await pg.wait_for_timeout(150)
        await pg.locator(scope+' button.btn:has-text("?")').first.click(); await idle(pg, scope, wait)
    async def play(pg, cash):
        good=await enter(pg); await pg.wait_for_timeout(900)
        await pg.evaluate("c=>__lm.setCash(c)", cash); await pg.evaluate("__lm.push()"); await pg.evaluate("__lm.rank()"); await pg.wait_for_timeout(800)
        return good
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctxT = await newctx(b); pT, eT = await newpage(ctxT)
            ctxZ = await newctx(b); pZ, eZ = await newpage(ctxZ)
            ctxC = await newctx(b); pC, eC = await newpage(ctxC)
            for pg, n, e in ((pT,'Tim Express','tim@example.de'),(pZ,'Zoe','zoe@example.de'),(pC,'Cara Cool','cara@example.de')):
                await pg.evaluate("([n,e,c])=>LMO.register({name:n,email:e,password:'geheim123',code:c})", [n,e,CODE])
            uidT,uidZ,uidC=[await pg.evaluate("LMO.state().uid") for pg in (pT,pZ,pC)]
            ctl('put', {'path':'admins/'+uidT, 'value':True})
            # ---------- Zoe und Cara spielen online
            ok('Zoe: Online-Spiel startet', await play(pZ, 1500)); ok('Cara: Online-Spiel startet', await play(pC, 1200))
            # ---------- Cara meldet Zoe über die Rangliste
            await pC.click('#onChip'); await pC.wait_for_timeout(1200); t=await txt(pC,'#dlgB')
            ok('Rangliste zeigt beide Spieler', 'Zoe' in t and 'Cara Cool' in t, t[:200].replace('\n',' | '))
            ok('Melden-Fahne bei Zoe, nicht bei der eigenen Zeile', await pC.locator('#dlgB button.flag[aria-label="Melden: Zoe"]').count()==1 and await pC.locator('#dlgB tr.me button.flag').count()==0)
            await pC.screenshot(path=OUT+'mod_rank.png')
            await pC.click('#dlgB button.flag[aria-label="Melden: Zoe"]'); await pC.wait_for_timeout(500); t=await txt(pC,'#dlgB')
            ok('Meldeformular: Name, Gründe', 'zoe' in t.lower() and all(x in t for x in ('Beleidigend oder vulgär','Hass, Extremismus','Echter Name oder persönliche Daten','Gibt sich als Betreiber oder andere Person aus','Sonstiges')) and await pC.locator('#dlgB input[type=radio]').count()==5, t[:300].replace('\n',' | '))
            ok('kein Freitextfeld', await pC.locator('#dlgB input[type=text], #dlgB textarea').count()==0)
            ok('Melden-Knopf erst nach Auswahl aktiv', await pC.locator('#dlgB button:has-text("Melden")').first.is_disabled())
            await pC.screenshot(path=OUT+'mod_form.png')
            await pC.click('#dlgB label:has-text("Hass, Extremismus")'); await pC.wait_for_timeout(200)
            ok('nach der Auswahl aktiv', not await pC.locator('#dlgB button.primary').is_disabled())
            await pC.click('#dlgB button.primary'); await pC.wait_for_timeout(900); t=await txt(pC,'#dlgB')
            ok('Bestätigung „Danke, die Meldung ist angekommen.“', 'Danke, die Meldung ist angekommen.' in t, t[:200].replace('\n',' | '))
            S=dbstate(); R0=list(S['reports'][uidC].values())[0]
            ok('Meldung gespeichert (Spieler, Grund)', R0['k']=='p' and R0['id']==uidZ and R0['r']=='hass' and R0['n']=='Zoe', json.dumps(R0))
            await btn(pC,'#dlgB','Zurück',900); ok('Zurück führt in die Rangliste', 'Rangliste' in await pC.inner_text('#dlgT') and 'Zoe' in await txt(pC,'#dlgB'))
            await pC.click('#dlgB button.flag[aria-label="Melden: Zoe"]'); await pC.wait_for_timeout(400); await pC.click('#dlgB label:has-text("Sonstiges")'); await pC.click('#dlgB button.primary'); await pC.wait_for_timeout(800)
            ok('doppelte Meldung: verständliche Meldung', 'schon gemeldet' in await txt(pC,'#dlgB'), (await txt(pC,'#dlgB'))[-160:].replace('\n',' | '))
            await btn(pC,'#dlgB','Abbrechen',900); ok('Abbrechen führt zurück', 'Rangliste' in await pC.inner_text('#dlgT'))
            await pC.keyboard.press('Escape')
            # ---------- Clan: Zoe gründet, Cara tritt bei und meldet den Clan-Namen
            await pZ.goto(URL); await wait_app(pZ); await konto(pZ)
            await pZ.fill('#accBody input[name=clanname]', 'Schlimme Boten'); await btn(pZ,'#accBody','Clan gründen',1500)
            code=await pZ.input_value('#accBody input[readonly]:not([name=uid])')
            await pC.goto(URL); await wait_app(pC); await konto(pC)
            await pC.fill('#accBody input[name=clancode]', code); await btn(pC,'#accBody','Beitreten',1500); t=await txt(pC)
            ok('Cara ist im Clan, sieht Melden bei Zoe und „Clan-Namen melden“', 'Du bist Mitglied' in t and await pC.locator('#accBody .cl button:has-text("Melden")').count()==1 and await pC.locator('#accBody button:has-text("Clan-Namen melden")').count()==1, t[:300].replace('\n',' | '))
            ok('keine Melden-Knöpfe bei der eigenen Zeile', await pC.locator('#accBody li:has-text("heute")').count()==2)
            await pC.click('#accBody button:has-text("Clan-Namen melden")'); await pC.wait_for_timeout(500); t=await txt(pC)
            ok('Clan-Meldeformular im Konto-Fenster', 'clan melden: schlimme boten' in t.lower() and await pC.locator('#accBody input[type=radio]').count()==5, t[:200].replace('\n',' | '))
            await pC.click('#accBody label:has-text("Beleidigend")'); await pC.click('#accBody button.primary:text-is("Melden")'); await pC.wait_for_timeout(900)
            ok('Clan gemeldet', 'Danke, die Meldung ist angekommen.' in await txt(pC))
            await btn(pC,'#accBody','Zurück',1500); ok('Zurück zur Clan-Ansicht', 'Du bist Mitglied' in await txt(pC))
            ok('Cara sieht keinen Betreiber-Bereich', not await vis(pC,'#accBody section:has(h4:text-is("Betreiber: Meldungen und Sperren"))') if False else 'Betreiber: Meldungen' not in await pC.inner_text('#accBody'))
            await pC.screenshot(path=OUT+'mod_member.png')
            # ---------- Tim als Betreiber
            ok('Tim: Startort gewählt, Spiel läuft', await enter(pT)); await konto(pT, 2500); t=await txt(pT)
            ok('Betreiber sieht den Bereich', 'betreiber: meldungen und sperren' in t.lower() and 'offene meldungen (2)' in t.lower(), t[:100].replace('\n',' | '))
            ok('Meldung zu Zoe mit Grund und Status', 'Zoe · Spieler · 1 Meldung' in t and 'Hass, Extremismus' in t and 'Name noch aktuell' in t, t[t.lower().find('offene'):][:400].replace('\n',' | '))
            ok('Meldung zum Clan', 'Schlimme Boten · Clan · 1 Meldung' in t and 'Beleidigend oder vulgär' in t)
            ok('Sperrliste leer', 'Noch keine gesperrten Namen.' in t)
            await pT.locator('#accBody li:has-text("Zoe · Spieler")').scroll_into_view_if_needed(); await pT.evaluate("document.querySelector('.accwrap').scrollBy(0,150)"); await pT.screenshot(path=OUT+'mod_admin.png')
            ok('Technische Angaben zeigen die Kennung', await pT.evaluate("()=>{const d=[...document.querySelectorAll('#accBody details')].find(x=>x.innerText.includes('Technische Angaben'));return !!d && d.querySelector('input').value===LMO.state().uid}"))
            # Verwerfen und Sperren
            await pT.fill('body', '') if False else None
            await twice(pT,'#accBody','Sperren') # erster Eintrag der Liste (meistgemeldet gleich, zuletzt gemeldet zuerst)
            try: await pT.wait_for_function("document.querySelector('#accBody').innerText.includes('ist gesperrt')", timeout=15000)
            except Exception: pass
            t=await txt(pT); ok('Sperren (zweistufig) funktioniert', 'ist gesperrt' in t and 'offene meldungen (1)' in t.lower() and 'gesperrte namen (1)' in t.lower(), t[t.lower().find('offene')-80:][:300].replace('\n',' | '))
            S=dbstate(); blocked=list(S.get('blockednames',{}).keys())
            ok('Name steht auf der Sperrliste', len(blocked)==1 and blocked[0] in ('zoe','schlimme_boten'), str(blocked))
            await pT.evaluate("document.querySelector('.accwrap').scrollBy(0,5000)"); await pT.screenshot(path=OUT+'mod_admin2.png')
            await pT.click('#accBody button >> text=Verwerfen'); await pT.wait_for_timeout(1500); t=await txt(pT)
            ok('Verwerfen entfernt die Meldung ohne zu sperren', 'offene meldungen (0)' in t.lower() and 'Keine offenen Meldungen.' in t and 'gesperrte namen (1)' in t.lower() and not (dbstate().get('reports') and any(dbstate()['reports'].values())), t[t.lower().find('offene')-80:][:300].replace('\n',' | '))
            ctl('put', {'path':'blockednames/zoe', 'value':int(time.time()*1000)})  # Zoe zusätzlich sperren (Test der Umbenennung)
            S=dbstate()
            # ---------- Zoe wird gesperrt: Hinweis und Umbenennen im Spiel
            await pZ.reload(); await pZ.wait_for_timeout(500)
            ok('Online-Spiel startet wieder', await wait_app(pZ)); await pZ.wait_for_timeout(500); await pZ.evaluate("__lm.rank()"); await pZ.wait_for_timeout(1500)
            ok('Hinweis „Name gesperrt“ öffnet sich', await vis(pZ,'#dlg') and 'Name gesperrt' in await pZ.inner_text('#dlgT') and 'wurde vom Betreiber gesperrt' in await pZ.inner_text('#dlgB'), (await pZ.inner_text('#dlgB'))[:200].replace('\n',' | '))
            ok('Chip zeigt „Name ändern“', 'Name ändern' in await pZ.inner_text('#onChip'))
            await pZ.screenshot(path=OUT+'mod_rename.png')
            await pZ.fill('#dlgB input[name=newname]', 'Nazi 99'); await pZ.wait_for_timeout(200)
            ok('schlechter Name wird sofort bemängelt', 'nicht erlaubt' in await pZ.inner_text('#dlgB'))
            await btn(pZ,'#dlgB','Neuen Namen speichern',800); ok('und abgelehnt', await vis(pZ,'#dlg') and 'Name gesperrt' in await pZ.inner_text('#dlgT'))
            await pZ.fill('#dlgB input[name=newname]', 'Zoe Neu'); await btn(pZ,'#dlgB','Neuen Namen speichern',500)
            try: await pZ.wait_for_function("document.getElementById('dlg').hidden", timeout=10000)
            except Exception: pass
            ok('Umbenennen klappt, Fenster schließt', not await vis(pZ,'#dlg'), (await pZ.inner_text('#dlgB'))[:200])
            try: await pZ.wait_for_function("!document.getElementById('onChip').innerText.includes('Name ändern')", timeout=8000)
            except Exception: pass
            ok('Chip wieder normal', 'Name ändern' not in await pZ.inner_text('#onChip'), await pZ.inner_text('#onChip')+' | '+await pZ.evaluate("JSON.stringify({b:LMO.state().blocked,n:LMO.state().name,e:__lm.net.err&&__lm.net.err.code,h:__lm.halted()})"))
            S=dbstate(); ok('Profil trägt den neuen Namen', S['users'][uidZ]['name']=='Zoe Neu' and S['names'].get('zoe_neu')==uidZ and 'zoe' not in S['names'], json.dumps(S['users'][uidZ]))
            ok('Rangliste: Eintrag trägt den neuen Namen', S['board']['_global']['all'][uidZ]['n']=='Zoe Neu', json.dumps(S['board']['_global']['all'][uidZ]))
            # ---------- Clan sperren (Tims erste Sperre oben galt dem zuletzt gemeldeten Ziel: dem Clan)
            S=dbstate(); ok('Clan wurde mit der Sperre aufgelöst', not (S.get('clans') or {}) and not (S.get('clannames') or {}) and 'schlimme_boten' in (S.get('blockednames') or {}), json.dumps({k:S.get(k) for k in ('clans','clannames','blockednames')})[:200])
            await pC.reload(); await wait_app(pC); await konto(pC, 500); t=await txt(pC)
            ok('Cara merkt: der Clan ist weg', 'Clan gründen' in t and 'Du bist Mitglied' not in t, t[:200].replace('\n',' | '))
            # ---------- Cara wird gesperrt: Umbenennen im Konto-Fenster (das Hinweisfenster im Spiel wird geschlossen)
            ctl('put', {'path':'blockednames/cara_cool', 'value':int(time.time()*1000)})
            await pC.reload(); await wait_app(pC); await pC.wait_for_timeout(1500); await pC.evaluate("__lm.rank()"); await pC.wait_for_timeout(1500)
            ok('Chip warnt: Name ändern', 'Name ändern' in await pC.inner_text('#onChip'), await pC.inner_text('#onChip'))
            if await vis(pC,'#dlg'): await pC.keyboard.press('Escape')
            await konto(pC, 500); t=await txt(pC)
            ok('Konto-Fenster zeigt Hinweis und Namensfeld', 'wurde vom Betreiber gesperrt' in t and await pC.locator('#accBody input[name=newname]').count()==1, t[:200].replace('\n',' | '))
            await pC.fill('#accBody input[name=newname]', 'Cara Cool'); await btn(pC,'#accBody','Neuen Namen speichern',800)
            ok('derselbe Name wird abgelehnt', 'anderen Namen' in await txt(pC), (await txt(pC))[:200].replace('\n',' | '))
            await pC.fill('#accBody input[name=newname]', 'Cara Neu'); await btn(pC,'#accBody','Neuen Namen speichern',2500); t=await txt(pC)
            for _ in range(20):
                if 'Dein neuer Name ist' in t: break
                await pC.wait_for_timeout(500); t=await txt(pC)
            ok('umbenannt: Hinweis und neuer Name', 'Cara Neu' in t and 'wurde vom Betreiber gesperrt' not in t and 'Dein neuer Name ist' in t, t[:200].replace('\n',' | '))
            ok('Konto zeigt den neuen Namen', await pC.evaluate("LMO.state().name")=='Cara Neu' and not await pC.evaluate("LMO.state().blocked"))
            try: await pC.wait_for_function("!document.getElementById('onChip').innerText.includes('Name ändern')", timeout=8000)
            except Exception: pass
            ok('Chip im Spiel wieder normal', 'Name ändern' not in await pC.inner_text('#onChip'), await pC.inner_text('#onChip'))
            # ---------- Freigeben
            await pT.reload(); await wait_app(pT); await konto(pT, 2500); t=await txt(pT)
            ok('Sperrliste im Betreiber-Bereich', 'gesperrte namen (3)' in t.lower() and 'schlimme boten' in t and 'cara cool' in t, t[t.lower().find('gesperrte'):][:200].replace('\n',' | '))
            li=pT.locator('#accBody .cl li:has-text("gesperrt vor")').filter(has_text='gesperrt').first
            await twice(pT,'#accBody','Freigeben'); t=await txt(pT)
            ok('Freigeben nimmt einen Namen von der Liste', 'gesperrte namen (2)' in t.lower() and 'ist wieder frei' in t, t[t.lower().find('gesperrte')-60:][:200].replace('\n',' | '))
            # ---------- Handy-Breite
            ctxM = await newctx(b,(390,780)); pM, eM = await newpage(ctxM)
            await pM.evaluate("([e,p])=>LMO.login(e,p)", ['tim@example.de','geheim123']); await wait_app(pM); await konto(pM, 2500)
            ok('Handy: Betreiber-Bereich ohne seitliches Scrollen', await pM.evaluate("(()=>{const d=document.querySelector('.accbox');return d.scrollWidth<=d.clientWidth+1 && document.documentElement.scrollWidth<=window.innerWidth+1})()"))
            await pM.screenshot(path=OUT+'mod_mobile.png')
            ctxN = await newctx(b,(390,780)); pN, eN = await newpage(ctxN)
            await pN.evaluate("([e,p])=>LMO.login(e,p)", ['zoe@example.de','geheim123']); await wait_app(pN); await pN.wait_for_timeout(1500)
            await pN.click('#onChip'); await pN.wait_for_timeout(1200)
            fl=pN.locator('#dlgB button.flag').first
            if await fl.count(): await fl.click(); await pN.wait_for_timeout(500)
            ok('Handy: Meldeformular ohne seitliches Scrollen', await pN.evaluate("(()=>{const d=document.querySelector('#dlg .dlg');return d.scrollWidth<=d.clientWidth+1 && document.documentElement.scrollWidth<=window.innerWidth+1})()"))
            await pN.screenshot(path=OUT+'mod_mobile_form.png')
            ok('keine Seitenfehler', not (eT+eZ+eC+eM+eN), str(eT+eZ+eC+eM+eN)[:400])
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    bad=[n for n,c in R if not c]; print(f'\n{len(R)-len(bad)} bestanden, {len(bad)} fehlgeschlagen'); sys.exit(1 if bad else 0)
asyncio.run(main())
