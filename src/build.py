# Baut index.html aus Vorlage, Engine, Stadtlader, Startlogik und der Essen-Demo (Aufruf im Projektordner: python3 src/build.py)
import json
d = json.load(open('data/essen.json', encoding='utf-8'))
d['elev'] = json.load(open('data/essen_elev.json'))
d.update({'v': 1, 'name': 'Essen', 'sub': 'Innenstadt (Demo), Deutschland',
          'tz': 'Europe/Berlin', 'radius': 750, 'ref': {'lat': 51.4510, 'lon': 7.0140}, 'hub': {'lat': 51.4513, 'lon': 7.0147}})
rd = lambda p: open(p, encoding='utf-8').read()
esc = lambda s: s.replace('</', '<\\/')
t = rd('src/template.html')
for k in ('/*DATA*/null', '/*ENGINE*/', '/*LOADER*/', '/*ONLINE*/', '/*CLAN*/', '/*BOOT*/', '/*ACCOUNT*/'):
    assert k in t, k
out = (t.replace('/*DATA*/null', esc(json.dumps(d, ensure_ascii=False, separators=(',', ':'))))
        .replace('/*ENGINE*/', esc(rd('src/engine.js')))
        .replace('/*LOADER*/', esc(rd('src/loader.js')))
        .replace('/*ONLINE*/', esc(rd('src/online.js')))
        .replace('/*CLAN*/', esc(rd('src/clan.js')))
        .replace('/*BOOT*/', esc(rd('src/boot.js')))
        .replace('/*ACCOUNT*/', esc(rd('src/account.js'))))
open('index.html', 'w', encoding='utf-8').write(out)
print(len(out))
