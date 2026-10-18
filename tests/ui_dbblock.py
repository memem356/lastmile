"""Kartenspeicher blockiert: Ein anderer Tab hält die ältere Datenbank (Version 1) offen. Die neue Seite darf nicht ewig warten.
Start: python3 tests/ui_dbblock.py   (Port 8398)"""
import asyncio, os, re, subprocess, sys, time
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
sys.path.insert(0, HERE)
from fakeworld import World
REPO = os.path.abspath(HERE + '..')
PORT = 8398
BASE = 'http://127.0.0.1:%d/' % PORT


async def main():
    ok = bad = 0

    def check(n, c, info=''):
        nonlocal ok, bad
        if c: ok += 1; print('OK  ', n)
        else: bad += 1; print('FAIL', n, info)
    web = subprocess.Popen(['python3', '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1000, 'height': 900})
            await ctx.route(re.compile(r'https://(identitytoolkit|securetoken)\.googleapis\.com/.*|https://lastmile-c6976-.*'), lambda r, q: r.abort())
            w = World(); await w.install(ctx)
            errs = []
            old = await ctx.new_page(); await old.goto(BASE + 'README.md')
            await old.evaluate("""()=>new Promise((res,rej)=>{ const rq=indexedDB.open('lastmile',1);
              rq.onupgradeneeded=()=>{ const d=rq.result; d.createObjectStore('cities',{keyPath:'id'}); };
              rq.onsuccess=()=>{ window.__old=rq.result; res(true); }; rq.onerror=()=>rej(String(rq.error)); })""")
            check('A1 Der andere Tab hält die Datenbank in Version 1 offen', await old.evaluate("window.__old.version") == 1)
            pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.goto(BASE + 'index.html?probe=Teststadt'); await pg.wait_for_timeout(500)
            t0 = time.time()
            await pg.wait_for_function("!!document.getElementById('dbNote')", timeout=15000)
            check('A2 Startseite weist auf den anderen Tab hin (nach wenigen Sekunden, nicht nie)', time.time() - t0 < 10 and 'anderen Tab' in await pg.inner_text('#dbNote'))
            check('A3 Die Startseite ist trotzdem bedienbar (Suchfeld da)', await pg.evaluate("!document.getElementById('start').hidden"))
            await pg.click('#probeGo')
            await pg.wait_for_function("document.getElementById('probeOut').textContent.includes('Fertig nach')", timeout=60000)
            out = await pg.inner_text('#probeOut')
            check('A4 Stadt-Test läuft trotz blockiertem Speicher bis zum Ende', 'Kachel' in out and 'Schätzung' in out, out[:300])
            check('A5 ... und nennt den Grund', 'Hinweis' in out and 'anderen Tab' in out and 'Gefunden: Teststadt' in out, out[:300])
            # der andere Tab gibt frei: die wartende Anfrage gelingt, der Speicher steht danach zur Verfügung
            await old.evaluate("window.__old.close()"); await pg.wait_for_timeout(1500)
            await pg.click('#probeGo')
            await pg.wait_for_function("document.getElementById('probeOut').textContent.includes('Fertig nach')", timeout=60000)
            out2 = await pg.inner_text('#probeOut')
            check('A6 Zweiter Lauf nach Freigabe ohne Hinweis', 'Hinweis' not in out2 and 'Schätzung' in out2, out2[:300])
            info = await pg.evaluate("""()=>new Promise(res=>{ const rq=indexedDB.open('lastmile'); rq.onsuccess=()=>{ const d=rq.result, v=d.version, t=d.transaction('packs','readonly').objectStore('packs').getAllKeys();
              t.onsuccess=()=>{ d.close(); res({v, keys:t.result}); }; }; rq.onerror=()=>res(null); })""")
            check('A7 Datenbank ist jetzt Version 2 und die Stadt liegt im Zwischenspeicher', info and info['v'] == 2 and any(k.startswith('city:') for k in info['keys']), str(info))
            # frischer Start ohne Blockade: kein Hinweis
            pg2 = await ctx.new_page(); await pg2.goto(BASE + 'index.html?probe=Teststadt'); await pg2.wait_for_timeout(3500)
            check('A8 Ohne anderen Tab erscheint kein Hinweis', not await pg2.evaluate("!!document.getElementById('dbNote')"))
            check('A9 Keine Skriptfehler', not errs, str(errs))
            await b.close()
    finally:
        web.terminate()
    print('\n%d/%d bestanden' % (ok, ok + bad)); sys.exit(1 if bad else 0)

asyncio.run(main())
