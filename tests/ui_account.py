import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys
from playwright.async_api import async_playwright
import os
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
OUT=HERE+'out/'; os.makedirs(OUT, exist_ok=True)
MOCK='http://127.0.0.1:9299'
REPO=os.path.abspath(HERE+'..')
BASE='http://127.0.0.1:8399/index.html'
URL=BASE+'?debug'  # über einen kleinen Webserver statt file://, damit der lokale Speicher beim Neuladen zuverlässig bleibt
CODE=re.search(r"'(LM-[A-Z0-9-]+)'", open(HERE+'../firebase-rules.json').read()).group(1)
CORS={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,PUT,POST,DELETE,PATCH,OPTIONS'}
CK='51_451_7_014'  # Essen
ROUTES=re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*')
NOMI=[{'name':'Bochum','lat':'51.4818','lon':'7.2162','display_name':'Bochum, Nordrhein-Westfalen, Deutschland','address':{'city':'Bochum','state':'Nordrhein-Westfalen','country':'Deutschland'}},
      {'name':'Bochum','lat':'-25.0','lon':'29.0','display_name':'Bochum, Limpopo, Südafrika','address':{'village':'Bochum','state':'Limpopo','country':'Südafrika'}}]
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
async def newctx(b, vw=(1000,900), **kw):
    ctx = await b.new_context(viewport={'width':vw[0],'height':vw[1]}, **kw)
    await ctx.route(ROUTES, handler)
    await ctx.route(re.compile(r'https://nominatim\.openstreetmap\.org/.*'), lambda r, q: r.fulfill(status=200, headers=dict(CORS,**{'content-type':'application/json'}), body=json.dumps(NOMI)))
    await ctx.route(re.compile(r'https://[^/]*overpass[^/]*/.*'), lambda r, q: r.abort())
    return ctx
async def newpage(ctx, url=URL, wait=1200):
    pg = await ctx.new_page(); errs=[]
    pg.on('pageerror', lambda e: errs.append(str(e)) if 'Access is denied' not in str(e) else None)
    pg.on('console', lambda m: errs.append('console:'+m.text) if m.type=='error' and 'fonts' not in m.text and 'ERR_' not in m.text and 'Failed to load resource' not in m.text and 'Kartendaten konnten nicht' not in m.text and 'Online-Stand ist beschädigt' not in m.text and 'Keine Verbindung zum Server' not in m.text else None)
    await pg.add_init_script("localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');")
    await pg.goto(url); await pg.wait_for_timeout(wait)
    return pg, errs
async def vis(pg, sel): return await pg.evaluate("s=>{const e=document.querySelector(s);return !!e&&!e.hidden&&(e.offsetParent!==null||getComputedStyle(e).position==='fixed')}", sel)
async def in_game(pg): return await pg.evaluate("!document.getElementById('app').hidden && !!window.__lm")
async def wait_game(pg, ms=25000):
    for _ in range(ms//250):
        if await in_game(pg): return True
        await pg.wait_for_timeout(250)
    return False
async def wait_vis(pg, sel, ms=8000):
    for _ in range(ms//100):
        try:
            if await vis(pg, sel): return True
        except Exception: pass  # Seite wird gerade neu geladen
        await pg.wait_for_timeout(100)
    return False
def uid_in(db, ck):
    b=db.get('board',{}); return bool((b.get(ck,{}).get('all') or {}) and (b.get('_global',{}).get('all') or {}))
async def main():
    srv=subprocess.Popen(['node',HERE+'fbmock.js','9299'], stdout=subprocess.DEVNULL)
    web=subprocess.Popen(['python3','-m','http.server','8399','--bind','127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: ctl('reset'); break
        except Exception: time.sleep(0.1)
    R=[]
    def ok(name, cond, info=''): R.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL'), name, info, flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await newctx(b); pg, errs = await newpage(ctx)
            # ---------- Startseite: nur Anmeldung und Registrierung
            ok('Startseite: Anmeldung sichtbar, sonst nichts', await vis(pg,'#authBox') and await pg.locator('#authBody .acctabs button').count()==2 and not await vis(pg,'#pickBox') and not await vis(pg,'#status') and not await vis(pg,'#app'))
            gone=await pg.evaluate("['playSec','modeSec','saveBox','fileBox','recentBox','gateBox','onlineBox','accBar','accBtn','switchCity','searchBox','chipBox'].filter(i=>document.getElementById(i))")
            ok('Solo-Teile und Menü sind weg', gone==[], str(gone))
            ok('Einleitung nennt den Startort', 'Startort' in await pg.inner_text('#lead'))
            ok('Ohne Konto sichtbar: kein Fokus im Feld erzwungen', await pg.evaluate("document.activeElement===document.body"))
            await pg.screenshot(path=OUT+'acc_login.png')
            await pg.click('#authBody .acctabs button >> text=Registrieren')
            await pg.fill('input[name=name]', 'Hitler'); await pg.wait_for_timeout(100)
            ok('Namensfilter zeigt Hinweis', 'nicht erlaubt' in await pg.inner_text('#authBody .accmsg'), await pg.inner_text('#authBody .accmsg'))
            await pg.click('#authBody button >> text=Vorschlag'); name=await pg.input_value('input[name=name]'); ok('Namensvorschlag gefüllt', 3<=len(name)<=16, name)
            await pg.fill('input[name=email]', 'tim@example.de'); await pg.fill('input[name=password]', 'geheim123'); await pg.fill('input[name=code]', 'falsch')
            await pg.screenshot(path=OUT+'acc_reg.png')
            await pg.click('button >> text=Konto erstellen'); await pg.wait_for_timeout(300)
            ok('ohne Häkchen: Hinweis', 'Datenschutz' in await pg.inner_text('#authBody .accmsg'), await pg.inner_text('#authBody .accmsg'))
            await pg.check('#authBody .chk input'); await pg.click('button >> text=Konto erstellen'); await pg.wait_for_timeout(1200)
            ok('falscher Code: Meldung', 'Einladungscode' in await pg.inner_text('#authBody .accmsg'), await pg.inner_text('#authBody .accmsg'))
            ok('falscher Code: kein Konto übrig', len(ctl('state')['USERS'])==0)
            # Datenschutz-Ansicht auf der Startseite (und zurück mit eingegebenen Werten)
            await pg.click('#authBody .chk button'); await wait_vis(pg, '#authBody .privacy')
            pv=await pg.inner_text('#authBody'); ok('Datenschutz auf der Startseite: ohne Solo, mit Firebase und Neu anfangen', 'Firebase' in pv and 'Solo' not in pv and 'Neu anfangen' in pv, pv[:80])
            await pg.screenshot(path=OUT+'acc_privacy.png')
            await pg.click('#authBody button >> text=Zurück'); await pg.wait_for_timeout(100)
            ok('Zurück: Registrierungsformular mit erhaltenen Eingaben', await pg.input_value('input[name=email]')=='tim@example.de' and await pg.input_value('input[name=name]')==name)
            await pg.fill('input[name=password]', 'geheim123'); await pg.fill('input[name=code]', CODE.lower()); await pg.check('#authBody .chk input')
            await pg.click('button >> text=Konto erstellen')
            ok('Registriert: Startort-Wahl statt Menü', await wait_vis(pg, '#pickMain') and not await vis(pg,'#authBox'))
            try: await pg.wait_for_function("n=>document.getElementById('pickWho').innerText.includes('Angemeldet als '+n) && document.getElementById('pickNote').innerText.includes(n)", arg=name, timeout=6000)
            except Exception: pass
            ok('Willkommen-Hinweis und Name', 'Willkommen' in await pg.inner_text('#pickNote') and name in await pg.inner_text('#pickNote') and ('Angemeldet als '+name) in await pg.inner_text('#pickWho'), await pg.inner_text('#pickNote'))
            st=ctl('state'); ok('Mock: Konto, Profil, Namen, Einladung, Bestätigungsmail', len(st['USERS'])==1 and len(st['DB']['users'])==1 and len(st['DB']['names'])==1 and len(st['DB']['redeemed'])==1 and st['MAILS'][0]['type']=='VERIFY_EMAIL')
            ok('Noch kein Unternehmen in der Cloud', not st['DB'].get('saves'))
            await pg.screenshot(path=OUT+'acc_pick.png')
            # ---------- Startort wählen (mit Rückfrage)
            await pg.fill('#q', 'Bochum'); await pg.press('#q', 'Enter'); await pg.wait_for_function("document.querySelectorAll('#results li').length>0")
            res=await pg.inner_text('#results'); ok('Suche: zwei Treffer', await pg.locator('#results li').count()==2 and 'Nordrhein-Westfalen' in res and 'Südafrika' in res, res.replace('\n',' / '))
            await pg.click('#results li >> nth=0'); await pg.wait_for_timeout(100)
            ok('Treffer: Rückfrage statt Start', await vis(pg,'#confirmBox') and not await vis(pg,'#pickMain') and await pg.inner_text('#confirmName')=='Bochum' and 'Nordrhein-Westfalen' in await pg.inner_text('#confirmSub'))
            ok('Rückfrage nennt „Neu anfangen“', 'Neu anfangen' in await pg.inner_text('#confirmBox'))
            await pg.screenshot(path=OUT+'acc_confirm.png')
            await pg.click('#confirmBack'); ok('Anderen Ort suchen: zurück zur Suche', await vis(pg,'#pickMain') and not await vis(pg,'#confirmBox'))
            # Karte lässt sich nicht laden (Overpass gesperrt): klare Meldung, Wiederholen oder anderer Ort
            await pg.click('#results li >> nth=0'); await pg.click('#confirmGo'); ok('Kartenfehler: Meldung mit zwei Auswegen', await wait_vis(pg, '#statusBtns', 20000) and await pg.inner_text('#statusRetry')=='Erneut versuchen' and await pg.inner_text('#statusBack')=='Anderen Ort wählen', await pg.inner_text('#statusT'))
            ok('Kartenfehler: noch kein Unternehmen angelegt', not ctl('state')['DB'].get('saves') and not await in_game(pg))
            await pg.click('#statusBack'); ok('Anderen Ort wählen: wieder bei der Suche', await vis(pg,'#pickMain') and not await vis(pg,'#status'))
            # Essen (liegt im Spiel bei): starten
            await pg.click('#chips button >> text=Essen'); ok('Essen: Rückfrage', await pg.inner_text('#confirmName')=='Essen')
            await pg.click('#confirmGo'); ok('Spiel startet', await wait_game(pg))
            ok('Startseite ist weg, Adresse ohne Anhang', not await vis(pg,'#start') and '#' not in pg.url)
            ok('Kein „Stadt wechseln“, im Menü stattdessen „Konto“', await pg.locator('#switchCity').count()==0)
            await pg.click('#menuBtn'); await pg.wait_for_timeout(200); mt=await pg.inner_text('#dlg')
            ok('Menü: Konto da, Stadt wechseln und Aufgeben weg', 'Konto' in mt and 'Stadt wechseln' not in mt and 'Unternehmen aufgeben' not in mt and 'Neues Spiel' not in mt, mt.replace('\n',' / ')[:300])
            await pg.screenshot(path=OUT+'acc_menu.png')
            await pg.click('#dlg button >> text=Konto'); await pg.wait_for_timeout(1200)
            body=await pg.inner_text('#accBody')
            ok('Konto im Spiel: Name, Unternehmen, Startort, Hinweis zur Bestätigung', name in body and 'dein unternehmen' in body.lower() and 'Startort: Essen' in body and 'noch nicht bestätigt' in body, body.replace('\n',' / ')[:300])
            ok('Keine Solo-Cloud-Sicherung mehr', 'Cloud-Sicherung' not in body and 'Auf diesem Gerät' not in body and 'Hochladen' not in body)
            await pg.screenshot(path=OUT+'acc_account.png')
            await pg.click('button >> text=Ich habe bestätigt'); await pg.wait_for_timeout(500)
            ok('noch nicht bestätigt: Hinweis', 'Noch nicht bestätigt' in await pg.inner_text('#accBody'))
            ctl('verify', {'email':'tim@example.de'})
            await pg.click('button >> text=Ich habe bestätigt'); await pg.wait_for_timeout(1500)
            ok('bestätigt: Anzeige', 'E-Mail-Adresse bestätigt' in await pg.inner_text('#accBody'))
            ok('Unternehmen in der Cloud (Startort Essen)', await pg.evaluate("LMUI.game.flush()") is True and ('o_'+CK) in list(ctl('state')['DB']['saves'].values())[0])
            await pg.keyboard.press('Escape'); ok('Escape schließt das Konto-Fenster', not await vis(pg,'#accWrap'))
            # ---------- Neuladen: direkt ins Spiel
            await pg.reload(); ok('Nach Neuladen: direkt im Spiel, ohne Menü', await wait_game(pg))
            ok('Spielstand stammt aus der Cloud/Kopie (Fahrer vorhanden)', await pg.evaluate("window.__lm.drivers().length>=1"))
            # ---------- Abmelden im Spiel
            await pg.click('#menuBtn'); await pg.click('#dlg button >> text=Konto'); await pg.wait_for_timeout(600)
            await pg.click('#accBody button >> text=Abmelden'); await pg.wait_for_selector('#authBox:not([hidden])', timeout=15000); await pg.wait_for_timeout(300)
            ok('Abmelden: Anmeldeseite, Spiel weg', await vis(pg,'#authBox') and not await vis(pg,'#app') and await pg.evaluate("!localStorage.getItem('lm.auth')"))
            ok('Abmelden: Unternehmen bleibt in der Cloud', len(list(ctl('state')['DB']['saves'].values())[0])==1)
            await pg.fill('input[name=email]', 'tim@example.de'); await pg.fill('input[name=password]', 'falsch'); await pg.click('#authBody button.primary >> text=Anmelden'); await pg.wait_for_timeout(800)
            ok('Falsches Passwort: Meldung', 'stimmt nicht' in await pg.inner_text('#authBody .accmsg'), await pg.inner_text('#authBody .accmsg'))
            await pg.click('button >> text=Passwort vergessen?'); ok('Passwort vergessen: E-Mail vorbelegt', await pg.input_value('input[name=email]')=='tim@example.de')
            await pg.click('button >> text=E-Mail senden'); await pg.wait_for_timeout(800)
            ok('Passwort vergessen: Meldung + Mail', 'unterwegs' in await pg.inner_text('#authBody .accmsg') and any(m['type']=='PASSWORD_RESET' for m in ctl('state')['MAILS']))
            await pg.click('button >> text=Zurück zur Anmeldung'); await pg.fill('input[name=email]', 'tim@example.de'); await pg.fill('input[name=password]', 'geheim123'); await pg.press('input[name=password]', 'Enter')
            ok('Anmelden mit Enter: direkt im Spiel (kein Startort mehr nötig)', await wait_game(pg) and not await vis(pg,'#pickBox'))
            # ---------- Alte Links mit Anhang
            await pg.goto('about:blank'); await pg.goto(URL+'#c=essen-demo&m=o'); ok('Alter Link: Anhang weg, Spiel startet', await wait_game(pg) and '#' not in pg.url)
            # ---------- Neu anfangen
            await pg.evaluate("LMO.board.submit('"+CK+"',{city:'Essen',l:1,r:3,g:{all:10,day:10,week:10}})")
            ok('Rangliste: Eintrag der Stadt und weltweit vorhanden', uid_in(ctl('state')['DB'], CK))
            await pg.click('#menuBtn'); await pg.click('#dlg button >> text=Konto'); await pg.wait_for_timeout(600)
            ok('Neu anfangen: Hinweistext', 'Weltrangliste' in await pg.inner_text('#accBody') and 'Clan' in await pg.inner_text('#accBody'))
            await pg.click('#accBody button >> text=Neu anfangen'); await pg.wait_for_timeout(200)
            ok('Neu anfangen: erst nachfragen', await pg.locator('#accBody button >> text=Wirklich? Dein Unternehmen in Essen wird gelöscht').count()==1 and len(ctl('state')['DB'].get('saves',{}))>0)
            await pg.click('#accBody button >> text=Wirklich? Dein Unternehmen'); await wait_vis(pg, '#pickMain', 20000); await pg.wait_for_timeout(300)
            st=ctl('state')['DB']
            ok('Neu anfangen: Startort-Wahl mit Hinweis', await vis(pg,'#pickMain') and 'gelöscht' in await pg.inner_text('#pickNote') and not await vis(pg,'#app'), await pg.inner_text('#pickNote'))
            uid=await pg.evaluate("LMO.state().uid")
            ok('Neu anfangen: Unternehmen, Stand, Sitzung, Stadt-Rangliste weg', not st.get('saves',{}).get(uid) and not st.get('savemeta',{}).get(uid) and not st.get('sessions',{}).get(uid) and not (st.get('board',{}).get(CK,{}).get('all',{}) or {}).get(uid), json.dumps(st)[:300])
            ok('Neu anfangen: Wert in der Weltrangliste bleibt', uid in (st.get('board',{}).get('_global',{}).get('all',{}) or {}))
            ok('Neu anfangen: lokale Kopie entfernt', await pg.evaluate("!Object.keys(localStorage).some(k=>k.startsWith('lm.osave.'))"))
            ok('Neu anfangen: Konto bleibt angemeldet', await pg.evaluate("LMO.state().signedIn"))
            await pg.reload(); ok('Nach Neuladen ohne Unternehmen: wieder Startort-Wahl', await wait_vis(pg, '#pickMain'))
            await pg.click('#chips button >> text=Essen'); await pg.click('#confirmGo'); ok('Neues Spiel am neuen Startort', await wait_game(pg))
            ok('Neues Spiel ist wirklich neu (Kasse 100 €)', await pg.evaluate("Math.round(window.__lm.cash())")<=150)
            # ---------- Unlesbarer Cloud-Stand: Ausweg über „Unternehmen löschen und neu anfangen“
            await pg.evaluate("LMUI.game.flush()"); await pg.evaluate("LMUI.game.stop()")
            uid=await pg.evaluate("LMO.state().uid")
            ctl('put', {'path':'saves/%s/o_%s/data'%(uid,CK), 'value':'{"v":2,"kaputt":"xxxxxxxxxxxxxxxxxxxxxxxx"}'})
            await pg.reload(); ok('Unlesbarer Stand: Fehleransicht mit Ausweg', await wait_vis(pg,'#statusExtra',20000) and 'beschädigt' in await pg.inner_text('#statusT') and await pg.inner_text('#statusRetry')=='Erneut versuchen', await pg.inner_text('#statusT'))
            ok('Der Stand wird nicht von selbst angefasst', 'kaputt' in ctl('state')['DB']['saves'][uid]['o_'+CK]['data'] and not await in_game(pg))
            await pg.click('#statusExtra'); await pg.wait_for_timeout(200)
            ok('Löschen: erst nachfragen, noch nichts gelöscht', 'Wirklich' in await pg.inner_text('#statusExtra') and ('o_'+CK) in ctl('state')['DB']['saves'][uid])
            await pg.click('#statusExtra'); ok('Löschen: danach Startort-Wahl, Cloud und Kopie leer', await wait_vis(pg,'#pickMain',20000) and not ctl('state')['DB'].get('saves',{}).get(uid) and await pg.evaluate("!Object.keys(localStorage).some(k=>k.startsWith('lm.osave.'))"))
            await pg.click('#chips button >> text=Essen'); await pg.click('#confirmGo'); ok('Danach neues Spiel', await wait_game(pg))
            # ---------- Keine Verbindung beim Start: Meldung statt falscher Registrierungsseite
            await pg.evaluate("LMUI.game.flush()"); await pg.evaluate("LMUI.game.stop()")
            async def dead(r, q): await r.abort()
            await ctx.route(ROUTES, dead)
            await pg.reload(); ok('Offline beim Start: Meldung mit Wiederholen und Abmelden', await wait_vis(pg,'#statusBtns',20000) and 'Verbindung' in await pg.inner_text('#statusT') and not await vis(pg,'#authBox'), await pg.inner_text('#statusT'))
            await ctx.unroute(ROUTES, dead)
            await pg.click('#statusRetry'); ok('Wieder online: Wiederholen startet das Spiel', await wait_game(pg))
            # ---------- Konto löschen
            await pg.click('#menuBtn'); await pg.click('#dlg button >> text=Konto'); await pg.wait_for_timeout(600)
            await pg.click('summary >> text=Konto löschen'); await pg.fill('.accbox details input[name=password]', 'falsch'); await pg.click('button >> text=Konto endgültig löschen'); await pg.wait_for_timeout(900)
            ok('Löschen mit falschem Passwort: Meldung, Spiel läuft weiter', 'stimmt nicht' in await pg.inner_text('.accbox details .accmsg') and await in_game(pg), await pg.inner_text('.accbox details .accmsg'))
            await pg.fill('.accbox details input[name=password]', 'geheim123'); await pg.click('button >> text=Konto endgültig löschen'); await wait_vis(pg, '#authBox', 20000); await pg.wait_for_timeout(300)
            body=await pg.inner_text('#authBody'); st=ctl('state')
            ok('Konto gelöscht: Hinweis und Anmeldeseite', 'gelöscht' in body and await vis(pg,'#authBox') and not await vis(pg,'#app'), body[:120].replace('\n',' / '))
            ok('Mock leer', len(st['USERS'])==0 and not st['DB'].get('users') and not st['DB'].get('names') and not st['DB'].get('saves'), json.dumps(st['DB'])[:200])
            ok('keine Seitenfehler', not errs, str(errs))
            await ctx.close()
            # ---------- Server nicht erreichbar, während das Unternehmen gesucht wird
            ctl('reset')
            ctx = await newctx(b); pg, errs = await newpage(ctx)
            await pg.evaluate("code=>LMO.register({name:'Tim Express',email:'tim@example.de',password:'geheim123',code})", CODE)
            await pg.evaluate("LMO.logout()")
            await ctx.route(re.compile(r'https://lastmile-c6976-.*savemeta.*'), lambda r, q: r.abort())
            await pg.evaluate("email=>LMO.login(email,'geheim123')", 'tim@example.de')
            ok('Cloud nicht erreichbar: Meldung mit Wiederholen und Abmelden', await wait_vis(pg, '#statusBtns', 20000) and await pg.inner_text('#statusRetry')=='Erneut versuchen' and await pg.inner_text('#statusBack')=='Abmelden', await pg.inner_text('#statusT'))
            ok('Meldung nennt das Problem', 'Verbindung' in await pg.inner_text('#statusT') or 'Unternehmen' in await pg.inner_text('#statusT'), await pg.inner_text('#statusT'))
            await pg.click('#statusBack'); ok('Abmelden aus der Fehleransicht', await wait_vis(pg, '#authBox') and not await vis(pg,'#status'))
            await ctx.close()
            # ---------- Handy-Breite
            ctl('reset')
            ctx = await newctx(b, (390,800)); pg, errs = await newpage(ctx)
            await pg.click('#authBody .acctabs button >> text=Registrieren'); await pg.wait_for_timeout(200)
            await pg.screenshot(path=OUT+'acc_mobile.png')
            w=await pg.evaluate("[document.documentElement.scrollWidth, innerWidth]"); ok('Handy: Anmeldung ohne Seitwärts-Scrollen', w[0]<=w[1]+1, str(w))
            await pg.evaluate("code=>LMO.register({name:'Tim Express',email:'tim@example.de',password:'geheim123',code})", CODE)
            await wait_vis(pg, '#pickMain'); await pg.fill('#q', 'Bochum'); await pg.press('#q', 'Enter'); await pg.wait_for_function("document.querySelectorAll('#results li').length>0")
            await pg.screenshot(path=OUT+'acc_pick_mobile.png')
            w=await pg.evaluate("[document.documentElement.scrollWidth, innerWidth]"); ok('Handy: Startort-Wahl ohne Seitwärts-Scrollen', w[0]<=w[1]+1, str(w))
            await pg.click('#results li >> nth=0'); await pg.screenshot(path=OUT+'acc_confirm_mobile.png')
            w=await pg.evaluate("[document.documentElement.scrollWidth, innerWidth]"); ok('Handy: Rückfrage ohne Seitwärts-Scrollen', w[0]<=w[1]+1, str(w))
            await ctx.close()
            # ---------- Dunkelmodus, offline
            ctx = await newctx(b, (900,800), color_scheme='dark'); pg, errs = await newpage(ctx); await pg.screenshot(path=OUT+'acc_dark.png'); await ctx.close()
            ctl('reset')
            ctx = await newctx(b); pg, errs = await newpage(ctx)
            await ctx.route(ROUTES, lambda r, q: r.abort())
            await pg.fill('input[name=email]', 'a@b.de'); await pg.fill('input[name=password]', 'x'); await pg.click('#authBody button.primary >> text=Anmelden'); await pg.wait_for_timeout(1500)
            ok('Offline: verständliche Meldung', 'Verbindung' in await pg.inner_text('#authBody .accmsg'), await pg.inner_text('#authBody .accmsg'))
            await ctx.close(); await b.close()
    finally:
        srv.terminate(); web.terminate()
    print('ERGEBNIS', sum(1 for _,c in R if c), '/', len(R))
    sys.exit(0 if all(c for _,c in R) else 1)
asyncio.run(main())
