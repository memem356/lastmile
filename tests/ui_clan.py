import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys, os
from playwright.async_api import async_playwright
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
OUT=HERE+'out/'; os.makedirs(OUT, exist_ok=True)
MOCK='http://127.0.0.1:9298'
REPO=os.path.abspath(HERE+'..')
BASE='http://127.0.0.1:8398/index.html'
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
    await pg.add_init_script("window.__LM_PLAN='legacy';localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
    await pg.goto(url); await pg.wait_for_timeout(wait)
    return pg, errs
async def in_game(pg): return await pg.evaluate("!document.getElementById('app').hidden && !!window.__lm")
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
async def konto(pg):
    await pg.click('#menuBtn'); await pg.wait_for_timeout(200); await pg.click('#dlgB button >> text=Konto'); await pg.wait_for_timeout(300)
    try: await pg.wait_for_function("(()=>{const t=document.querySelector('#accBody').innerText;return t.includes('Clan') && !t.includes('Clan wird geladen')})()", timeout=15000)
    except Exception: pass
async def main():
    srv=subprocess.Popen(['node',HERE+'fbmock.js','9298'], stdout=subprocess.DEVNULL)
    web=subprocess.Popen(['python3','-m','http.server','8398','--bind','127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
    async def has(pg, scope, text, ms=15000):  # warten, bis ein Text im Bereich steht (Netzwerk und Spiel laufen parallel, feste Zeiten sind zu knapp)
        try: await pg.wait_for_function("([s,t])=>document.querySelector(s).innerText.includes(t)", arg=[scope, text], timeout=ms)
        except Exception: pass
    async def btn(pg, scope, label, wait=500):
        await pg.click(scope+' button >> text='+label); await idle(pg, scope, wait)
    async def twice(pg, scope, label, wait=900):  # zweistufige Bestätigung
        await pg.click(scope+' button >> text='+label); await pg.wait_for_timeout(150)
        first=await pg.locator(scope+' button.btn:has-text("?")').count()
        await pg.locator(scope+' button.btn:has-text("?")').first.click(); await idle(pg, scope, wait); return first
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            # ---------- Tim gründet einen Clan im Konto-Fenster
            ctxT = await newctx(b); pT, eT = await newpage(ctxT)
            await pT.evaluate("code=>LMO.register({name:'Tim Express',email:'tim@example.de',password:'geheim123',code})", CODE)
            uidT=await pT.evaluate("LMO.state().uid")
            ok('Tim: Startort gewählt, Spiel läuft', await enter(pT)); await konto(pT)
            t=await txt(pT); ok('Konto-Fenster: Clan-Bereich mit Gründen und Beitreten', 'clan gründen' in t.lower() and 'clan beitreten' in t.lower() and await pT.locator('#accBody button:has-text("Beitreten")').count()==1, t[:120].replace('\n',' | '))
            await pT.fill('#accBody input[name=clanname]', 'Nazi Clan'); await btn(pT,'#accBody','Clan gründen'); t=await txt(pT)
            ok('unzulässiger Clan-Name wird abgelehnt', 'nicht erlaubt' in t, t[-160:].replace('\n',' | '))
            await pT.fill('#accBody input[name=clanname]', 'Die Boten'); await btn(pT,'#accBody','Clan gründen', 500); await has(pT,'#accBody','Du bist der Leiter'); t=await txt(pT)
            ok('Clan gegründet: Name, Leiter, Plätze', 'Die Boten' in t and 'Du bist der Leiter' in t and '1 von 12' in t, t.replace('\n',' | '))
            code=await pT.input_value('#accBody input[readonly]:not([name=uid])'); ok('Code sichtbar im Format CL-XXXX-XXXX', re.match(r'^CL-[A-Z2-9]{4}-[A-Z2-9]{4}$', code), code)
            ok('eigene Zeile mit (du) und Leiter', 'Tim Express · Leiter (du)' in t, t[:300].replace('\n',' | '))
            ok('als Leiter ohne Mitglieder: Auflösen statt Verlassen', 'Clan auflösen' in t and 'Clan verlassen' not in t and 'Neuen Code erzeugen' in t)
            await pT.screenshot(path=OUT+'cl_account.png')
            # ---------- Zoe tritt bei, auch mit Tippfehlern im Format
            ctxZ = await newctx(b); pZ, eZ = await newpage(ctxZ)
            await pZ.evaluate("code=>LMO.register({name:'Zoe',email:'zoe@example.de',password:'geheim123',code})", CODE)
            ok('Zoe: Startort gewählt, Spiel läuft', await enter(pZ)); await konto(pZ)
            await pZ.fill('#accBody input[name=clancode]', 'cl-aaaa-bbbb'); await btn(pZ,'#accBody','Beitreten'); t=await txt(pZ)
            ok('falscher Code: klare Meldung', 'gibt es nicht' in t, t[-140:].replace('\n',' | '))
            await pZ.fill('#accBody input[name=clancode]', code.lower().replace('-',' ')); await btn(pZ,'#accBody','Beitreten', 300)
            try: await pZ.wait_for_function("document.querySelector('#accBody').innerText.includes('Du bist Mitglied')", timeout=10000)
            except Exception: pass
            t=await txt(pZ)
            ok('Zoe ist im Clan, Mitglied, 2 von 12', 'Du hast' not in t and 'Du bist Mitglied' in t and '2 von 12' in t and 'Die Boten' in t, t[:300].replace('\n',' | '))
            ok('Mitglied sieht den Code, aber keine Leiter-Knöpfe', await pZ.input_value('#accBody input[readonly]:not([name=uid])')==code and 'Clan auflösen' not in t and 'Entfernen' not in t and 'Clan verlassen' in t)
            # ---------- Tim im Spiel: Rangliste mit Clans
            await pT.click('#accClose'); ok('Tim im Spiel', await in_game(pT)); await pT.wait_for_timeout(1000)
            await pT.evaluate("__lm.setCash(1500)"); ok('Speichern', await pT.evaluate("__lm.push()")); await pT.evaluate("__lm.rank()"); await pT.wait_for_timeout(1500)
            S=dbstate(); cid=S['clanof'][uidT]
            ok('Wertung des Clans wurde geschrieben (Wachstum 1350)', S['clanboard']['all'][cid]['g']==1350 and S['clanboard']['all'][cid]['m']==2 and S['clanboard']['day'][cid]['g']==1350, json.dumps(S.get('clanboard'))[:300])
            await pT.click('#onChip'); await pT.wait_for_timeout(900)
            await pT.click('#dlgB .seg button >> text=Clans'); await pT.wait_for_timeout(900); t=await txt(pT,'#dlgB')
            ok('Clan-Rangliste zeigt den eigenen Clan hervorgehoben', 'Die Boten' in t and await pT.locator('#dlgB tr.me').count()==1 and '1.350' in t, t[:200].replace('\n',' | '))
            for lab in ('Woche','Heute'):
                await pT.click('#dlgB .seg button >> text='+lab); await pT.wait_for_timeout(600); ok('Clan-Rangliste '+lab, 'Die Boten' in await txt(pT,'#dlgB'))
            await pT.click('#dlgB .seg button >> text=Mein Clan'); await pT.wait_for_timeout(1500); t=await txt(pT,'#dlgB')
            ok('Mein Clan: Leiter, zwei Mitglieder, Summe', 'Die Boten' in t and 'Du bist der Leiter' in t and 'Zoe' in t and 'Wachstum des Clans' in t and '1.350' in t, t[:400].replace('\n',' | '))
            ok('Mein Clan: Zeitraum-Auswahl ausgeblendet', not await pT.evaluate("[...document.querySelectorAll('#dlgB .rkbar .seg')][0].offsetParent!==null"))
            await pT.screenshot(path=OUT+'cl_rank.png')
            await pT.click('#dlgB .seg button >> text=Weltweit'); await pT.wait_for_timeout(600)
            ok('zurück zu Weltweit: Zeitraum-Auswahl wieder da', await pT.evaluate("[...document.querySelectorAll('#dlgB .rkbar .seg')][0].offsetParent!==null") and 'Tim Express' in await txt(pT,'#dlgB'))
            # Leiter-Aktionen im Spiel
            await pT.click('#dlgB .seg button >> text=Mein Clan'); await pT.wait_for_timeout(1200)
            await twice(pT,'#dlgB','Leitung'); t=await txt(pT,'#dlgB'); ok('Leitung übergeben', 'Leitung liegt jetzt bei Zoe' in t and 'Du bist Mitglied' in t, t[:200].replace('\n',' | '))
            # Zoe ist jetzt Leiterin (Fenster neu laden)
            await pZ.click('#accClose'); await konto(pZ); t=await txt(pZ)
            ok('Zoe ist Leiterin und sieht Entfernen/Leitung bei Tim', 'Du bist der Leiter' in t and 'Entfernen' in t, t[:200].replace('\n',' | '))
            oldc=code
            await twice(pZ,'#accBody','Neuen Code erzeugen'); code2=await pZ.input_value('#accBody input[readonly]:not([name=uid])')
            ok('neuer Code', code2!=code and re.match(r'^CL-', code2) and 'neue Code gilt' in await txt(pZ), code2)
            # Tim: Code erneuert, er bleibt Mitglied und sieht den neuen Code
            await pT.click('#dlgB .seg button >> text=Gesamt') if False else None
            await pT.click('#dlgB .seg button >> text=Weltweit'); await pT.click('#dlgB .seg button >> text=Mein Clan'); await pT.wait_for_timeout(1500)
            ok('Tim sieht den neuen Code', await pT.input_value('#dlgB input[readonly]')==code2)
            # Tim verlässt den Clan, Zoe löst auf
            await twice(pT,'#dlgB','Clan verlassen'); t=await txt(pT,'#dlgB'); ok('Tim verlassen: Gründen/Beitreten wieder da', 'verlassen' in t and 'clan gründen' in t.lower() and 'clan beitreten' in t.lower(), t[:200].replace('\n',' | '))
            await pT.fill('#dlgB input[name=clancode]', code2); await btn(pT,'#dlgB','Beitreten',300)
            try: await pT.wait_for_function("document.querySelector('#dlgB').innerText.includes('Du bist Mitglied')", timeout=8000)
            except Exception: pass
            t=await txt(pT,'#dlgB'); ok('Tim tritt mit dem neuen Code wieder bei', 'Die Boten' in t and 'Du bist Mitglied' in t, t[:300].replace('\n',' | '))
            await twice(pZ,'#accBody','Entfernen'); await has(pZ,'#accBody','wurde aus dem Clan entfernt'); t=await txt(pZ); ok('Zoe entfernt Tim', 'wurde aus dem Clan entfernt' in t and '1 von 12' in t, t[:200].replace('\n',' | '))
            await pT.click('#dlgB .seg button >> text=Weltweit'); await pT.click('#dlgB .seg button >> text=Mein Clan'); await pT.wait_for_timeout(1500)
            ok('Tim merkt es beim nächsten Öffnen', 'Clan gründen' in await txt(pT,'#dlgB'))
            await twice(pZ,'#accBody','Clan auflösen'); await has(pZ,'#accBody','aufgelöst'); t=await txt(pZ); ok('Zoe löst den Clan auf', 'aufgelöst' in t and 'Clan gründen' in t, t[:200].replace('\n',' | '))
            S=dbstate(); ok('nach dem Auflösen bleibt nichts übrig', not S.get('clans') and not S.get('clancodes') and not S.get('clannames') and not S.get('members') and not any((S.get('clanboard') or {}).get(k) for k in ('all','day','week')), json.dumps({k:S.get(k) for k in ('clans','clanboard','members')})[:200])
            # ---------- Handy-Breite
            await pT.keyboard.press('Escape'); await pT.close(); await ctxT.close()
            ctxM = await newctx(b,(390,780)); pM, eM = await newpage(ctxM)
            await pM.evaluate("([e,p])=>LMO.login(e,p)", ['tim@example.de','geheim123'])
            ok('Handy: Online startet von selbst', await wait_app(pM)); await pM.wait_for_timeout(1000)
            await pM.evaluate("__lm.setCash(900); __lm.push()"); await pM.wait_for_timeout(600)
            await pM.click('#onChip'); await pM.wait_for_timeout(700); await pM.click('#dlgB .seg button >> text=Mein Clan'); await pM.wait_for_timeout(1000)
            await pM.fill('#dlgB input[name=clanname]', 'Nachtfahrer'); await btn(pM,'#dlgB','Clan gründen',1500)
            try: await pM.wait_for_function("document.querySelector('#dlgB').innerText.includes('Nachtfahrer')", timeout=10000)
            except Exception: pass
            ok('Handy: Clan gegründet', 'Nachtfahrer' in await txt(pM,'#dlgB'))
            await pM.screenshot(path=OUT+'cl_mobile.png')
            ok('Handy: kein seitliches Scrollen im Dialog', await pM.evaluate("(()=>{const d=document.querySelector('#dlg .dlg');return d.scrollWidth<=d.clientWidth+1 && document.documentElement.scrollWidth<=window.innerWidth+1})()"))
            ok('keine Seitenfehler', not eT and not eZ and not eM, str(eT+eZ+eM)[:300])
            await b.close()
    finally:
        srv.terminate(); web.terminate()
    bad=[n for n,c in R if not c]; print(f'\n{len(R)-len(bad)} bestanden, {len(bad)} fehlgeschlagen'); sys.exit(1 if bad else 0)
asyncio.run(main())
