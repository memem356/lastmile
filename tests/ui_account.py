import asyncio, json, re, subprocess, time, urllib.request, urllib.error, sys
from playwright.async_api import async_playwright
import os
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
OUT=HERE+'out/'; os.makedirs(OUT, exist_ok=True)
MOCK='http://127.0.0.1:9299'
REPO=os.path.abspath(HERE+'..')
URL='http://127.0.0.1:8399/index.html'  # über einen kleinen Webserver statt file://, damit der lokale Speicher beim Neuladen zuverlässig bleibt
CODE=re.search(r"'(LM-[A-Z0-9-]+)'", open(HERE+'../firebase-rules.json').read()).group(1)
CORS={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,PUT,POST,DELETE,PATCH,OPTIONS'}
def fx(c): return list(json.load(open(HERE+f'fixtures/save_{c}.json')).values())[0]
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
async def newpage(b, seed=None, vw=(1000,900), ctx=None):
    if ctx is None:
        ctx = await b.new_context(viewport={'width':vw[0],'height':vw[1]})
        await ctx.route(re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*'), handler)
    pg = await ctx.new_page(); errs=[]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append('console:'+m.text) if m.type=='error' and 'fonts' not in m.text and 'ERR_' not in m.text and 'Failed to load resource' not in m.text else None)
    js = "localStorage.setItem('lm-tut','1');localStorage.setItem('lm-snd','0');"
    if seed: js += "if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + ''.join(f"localStorage.setItem({json.dumps(k)},{json.dumps(v)});" for k,v in seed.items()) + "}"
    await pg.add_init_script(js)
    await pg.goto(URL); await pg.wait_for_timeout(1200)
    return ctx, pg, errs
async def vis(pg, sel): return await pg.evaluate("s=>{const e=document.querySelector(s);return !!e&&!e.hidden&&e.offsetParent!==null||(!!e&&getComputedStyle(e).position==='fixed'&&!e.hidden)}", sel)
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
            KEY='lm.save.51.451,7.014.rush'; sv=fx('7dd6126')
            ctx,pg,errs = await newpage(b, {KEY: sv, KEY+'.bak': sv})
            ok('Leiste: nicht angemeldet', 'Nicht angemeldet' in await pg.inner_text('#accTxt') and await pg.inner_text('#accBtn')=='Anmelden')
            n=await pg.evaluate("document.querySelectorAll('#saveList li').length"); ok('.bak-Stände werden nicht doppelt gelistet', n==1, str(n))
            await pg.click('#accBtn'); await pg.wait_for_timeout(200)
            ok('Fenster offen mit Tabs', await vis(pg,'#accWrap') and await pg.locator('.acctabs button').count()==2)
            await pg.screenshot(path=OUT+'acc_login.png')
            await pg.keyboard.press('Escape'); ok('Escape schließt', not await vis(pg,'#accWrap'))
            await pg.click('#accBtn'); await pg.click('.acctabs button >> text=Registrieren')
            await pg.fill('input[name=name]', 'Hitler'); await pg.wait_for_timeout(100)
            ok('Namensfilter zeigt Hinweis', 'nicht erlaubt' in await pg.inner_text('.accmsg'), await pg.inner_text('.accmsg'))
            await pg.click('button >> text=Vorschlag'); name=await pg.input_value('input[name=name]'); ok('Namensvorschlag gefüllt', 3<=len(name)<=16, name)
            await pg.fill('input[name=email]', 'tim@example.de'); await pg.fill('input[name=password]', 'geheim123'); await pg.fill('input[name=code]', 'falsch')
            await pg.screenshot(path=OUT+'acc_reg.png')
            await pg.click('button >> text=Konto erstellen'); await pg.wait_for_timeout(300)
            ok('ohne Häkchen: Hinweis', 'Datenschutz' in await pg.inner_text('.accmsg'), await pg.inner_text('.accmsg'))
            await pg.check('.chk input'); await pg.click('button >> text=Konto erstellen'); await pg.wait_for_timeout(1200)
            ok('falscher Code: Meldung', 'Einladungscode' in await pg.inner_text('.accmsg'), await pg.inner_text('.accmsg'))
            ok('falscher Code: kein Konto übrig', len(ctl('state')['USERS'])==0)
            await pg.fill('input[name=code]', CODE.lower()); await pg.click('button >> text=Konto erstellen'); await pg.wait_for_timeout(2500)
            body=await pg.inner_text('#accBody')
            ok('Registriert: Willkommen + Konto-Ansicht', 'Willkommen' in body and name in body and 'noch nicht bestätigt' in body, body[:200].replace('\n',' / '))
            ok('Leiste zeigt Namen', ('Angemeldet als '+name) in await pg.inner_text('#accTxt'), await pg.inner_text('#accTxt'))
            st=ctl('state'); ok('Mock: Konto, Profil, Namen, Einladung', len(st['USERS'])==1 and len(st['DB']['users'])==1 and len(st['DB']['names'])==1 and len(st['DB']['redeemed'])==1 and st['MAILS'][0]['type']=='VERIFY_EMAIL')
            await pg.click('button >> text=Ich habe bestätigt'); await pg.wait_for_timeout(500)
            ok('noch nicht bestätigt: Hinweis', 'Noch nicht bestätigt' in await pg.inner_text('#accBody'))
            ctl('verify', {'email':'tim@example.de'})
            await pg.click('button >> text=Ich habe bestätigt'); await pg.wait_for_timeout(1500)
            ok('bestätigt: Anzeige und Leiste', 'E-Mail-Adresse bestätigt' in await pg.inner_text('#accBody') and 'bestätigt' not in (await pg.inner_text('#accTxt')).replace('Angemeldet als',''), await pg.inner_text('#accTxt'))
            # Cloud
            body=await pg.inner_text('#accBody')
            ok('Cloud: lokaler Stand sichtbar, noch nicht in Cloud', 'Essen · Rush' in body and 'noch nicht in der Cloud' in body and 'Noch nichts in der Cloud' in body, body.replace('\n',' / ')[:400])
            await pg.screenshot(path=OUT+'acc_account.png', full_page=False)
            await pg.click('#accBody button >> text=Hochladen'); await pg.wait_for_timeout(2000)
            body=await pg.inner_text('#accBody'); ok('Hochladen: Meldung und Eintrag in der Cloud', 'in der Cloud gesichert' in body and 'Hierher laden' in body, body.replace('\n',' / ')[:500])
            st=ctl('state'); ok('Mock: Stand gespeichert', len(st['DB']['saves'][list(st['DB']['saves'])[0]])==1)
            # lokal löschen, dann aus der Cloud laden
            await pg.evaluate("k=>{localStorage.removeItem(k);localStorage.removeItem(k+'.bak')}", KEY)
            await pg.click('button >> text=Neu laden') if await pg.locator('button >> text=Neu laden').count() else None
            await pg.click('#accClose'); await pg.click('#accBtn'); await pg.wait_for_timeout(1500)
            await pg.click('button >> text=Hierher laden'); await pg.wait_for_timeout(1500)
            ok('Laden: Stand wieder lokal', await pg.evaluate("k=>!!localStorage.getItem(k)", KEY))
            lst=await pg.inner_text('#saveList'); ok('Laden: unter Weiter spielen', 'Essen' in lst, lst.replace('\n',' '))
            # Löschen mit Bestätigung
            await pg.click('#accBody button >> text=Löschen'); ok('Löschen: erst nachfragen', await pg.locator('button >> text=Wirklich löschen?').count()==1)
            await pg.click('button >> text=Wirklich löschen?'); await pg.wait_for_timeout(1500)
            ok('Löschen: Cloud leer', 'Noch nichts in der Cloud' in await pg.inner_text('#accBody'))
            # Abmelden / Anmelden
            await pg.click('#accBody button >> text=Abmelden'); await pg.wait_for_timeout(300)
            ok('Abmelden: Formular + Leiste', await pg.locator('input[name=password]').count()==1 and 'Nicht angemeldet' in await pg.inner_text('#accTxt'))
            await pg.fill('input[name=email]', 'tim@example.de'); await pg.fill('input[name=password]', 'falsch'); await pg.click('#accBody button.primary >> text=Anmelden'); await pg.wait_for_timeout(800)
            ok('Falsches Passwort: Meldung', 'stimmt nicht' in await pg.inner_text('.accmsg'), await pg.inner_text('.accmsg'))
            await pg.click('button >> text=Passwort vergessen?'); ok('Passwort vergessen: E-Mail vorbelegt', await pg.input_value('input[name=email]')=='tim@example.de')
            await pg.click('button >> text=E-Mail senden'); await pg.wait_for_timeout(800)
            ok('Passwort vergessen: Meldung + Mail', 'unterwegs' in await pg.inner_text('.accmsg') and any(m['type']=='PASSWORD_RESET' for m in ctl('state')['MAILS']))
            await pg.click('button >> text=Zurück zur Anmeldung'); await pg.fill('input[name=email]', 'tim@example.de'); await pg.fill('input[name=password]', 'geheim123'); await pg.press('input[name=password]', 'Enter'); await pg.wait_for_timeout(1500)
            ok('Anmelden mit Enter', name in await pg.inner_text('#accBody') and 'bestätigt' in await pg.inner_text('#accBody'))
            await pg.click('#accClose'); await pg.wait_for_timeout(100)
            # Neu laden: Sitzung bleibt
            await pg.reload(); await pg.wait_for_timeout(1500)
            ok('Nach Neuladen weiter angemeldet', ('Angemeldet als '+name) in await pg.inner_text('#accTxt'), await pg.inner_text('#accTxt'))
            # Datenschutz
            await pg.click('#accBtn'); await pg.click('#accBody button >> text=Datenschutz'); ok('Datenschutz-Ansicht', 'Firebase' in await pg.inner_text('#accBody'))
            await pg.screenshot(path=OUT+'acc_privacy.png')
            await pg.keyboard.press('Escape'); ok('Escape: zurück zum Konto', 'Abmelden' in await pg.inner_text('#accBody'))
            # Konto löschen
            await pg.click('summary >> text=Konto löschen'); await pg.fill('.accbox details input[name=password]', 'falsch'); await pg.click('button >> text=Konto endgültig löschen'); await pg.wait_for_timeout(900)
            ok('Löschen mit falschem Passwort: Meldung', 'stimmt nicht' in await pg.inner_text('.accbox details .accmsg'), await pg.inner_text('.accbox details .accmsg'))
            await pg.fill('.accbox details input[name=password]', 'geheim123'); await pg.click('button >> text=Konto endgültig löschen'); await pg.wait_for_timeout(2000)
            body=await pg.inner_text('#accBody'); st=ctl('state')
            ok('Konto gelöscht: Hinweis, Formular, Leiste', 'gelöscht' in body and 'Nicht angemeldet' in await pg.inner_text('#accTxt'), body[:120].replace('\n',' / '))
            ok('Mock leer', len(st['USERS'])==0 and not st['DB'].get('users') and not st['DB'].get('names') and not st['DB'].get('saves'), json.dumps(st['DB'])[:200])
            ok('keine Seitenfehler', not errs, str(errs))
            await ctx.close()
            # Handy-Breite
            ctl('reset')
            ctx,pg,errs = await newpage(b, {KEY: sv}, (390,800))
            await pg.click('#accBtn'); await pg.click('.acctabs button >> text=Registrieren'); await pg.wait_for_timeout(200)
            await pg.screenshot(path=OUT+'acc_mobile.png')
            w=await pg.evaluate("[document.documentElement.scrollWidth, innerWidth, document.getElementById('accBox').getBoundingClientRect().width]")
            ok('Handy: kein Seitwärts-Scrollen', w[0]<=w[1]+1 and w[2]<=w[1], str(w))
            # Dunkelmodus
            await ctx.close()
            ctx = await b.new_context(viewport={'width':900,'height':800}, color_scheme='dark'); await ctx.route(re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*'), handler)
            ctx,pg,errs = await newpage(b, {KEY: sv}, ctx=ctx); await pg.click('#accBtn'); await pg.wait_for_timeout(200); await pg.screenshot(path=OUT+'acc_dark.png')
            await ctx.close()
            # Offline/Serverfehler
            ctx,pg,errs = await newpage(b, {KEY: sv})
            await ctx.route(re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*'), lambda r, q: r.abort())
            await pg.click('#accBtn'); await pg.fill('input[name=email]', 'a@b.de'); await pg.fill('input[name=password]', 'x'); await pg.click('#accBody button.primary >> text=Anmelden'); await pg.wait_for_timeout(1500)
            ok('Offline: verständliche Meldung', 'Verbindung' in await pg.inner_text('.accmsg'), await pg.inner_text('.accmsg'))
            await ctx.close(); await b.close()
    finally:
        srv.terminate(); web.terminate()
    print('ERGEBNIS', sum(1 for _,c in R if c), '/', len(R))
asyncio.run(main())
