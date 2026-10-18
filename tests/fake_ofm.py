"""Nachbau von tiles.openfreemap.org für die Tests: Stil, Kachelinfo und echte Vektorkacheln (MVT) aus den Straßen der Essen-Demo.
Die Straßen werden in kräftigem Magenta gezeichnet, damit ein Test auf Bildpunkten prüfen kann, ob Spielschicht und Kartenbild genau übereinanderliegen."""
import json, math, os, re

HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,OPTIONS'}
STATE = {'mode': 'ok', 'tiles': 0, 'styles': [], 'other': [], 'log': []}   # mode: ok | style500 | tiles500 | tiles404


def essen_ways():
    d = json.load(open(HERE + '../data/essen.json', encoding='utf-8'))
    R = d['roads']; la, lo = R['o'][0], R['o'][1]
    pts = []
    for i in range(len(R['n']) // 2):
        la += R['n'][2 * i]; lo += R['n'][2 * i + 1]; pts.append((la / 1e5, lo / 1e5))
    ways = []
    for w in R['w']:
        p = 0; idx = []
        for k in range(3, len(w)):
            p += w[k]; idx.append(p)
        if len(idx) > 1: ways.append((w[0], [pts[i] for i in idx]))
    return ways


WAYS = essen_ways()
CLASSES = ['motorway', 'primary', 'secondary', 'tertiary', 'minor', 'minor', 'service', 'path']


def merc(lat, lon):
    s = math.sin(max(-85.0511287798, min(85.0511287798, lat)) * math.pi / 180)
    return (lon + 180) / 360, 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); break
    return bytes(out)


zz = lambda n: (n << 1) ^ (n >> 63)
key = lambda num, wt: varint((num << 3) | wt)
ld = lambda num, payload: key(num, 2) + varint(len(payload)) + payload


def line_geom(pts):
    g = [9]; cx = cy = 0
    x, y = pts[0]; g += [zz(x - cx), zz(y - cy)]; cx, cy = x, y
    g.append(2 | ((len(pts) - 1) << 3))
    for x, y in pts[1:]:
        g += [zz(x - cx), zz(y - cy)]; cx, cy = x, y
    return g


def tile(z, x, y, ext=4096, buf=256):
    n = 2 ** z; feats = []; vals = []; vidx = {}
    for c, poly in WAYS:
        pp = []
        for lat, lon in poly:
            u, v = merc(lat, lon); pp.append((round((u * n - x) * ext), round((v * n - y) * ext)))
        xs = [p[0] for p in pp]; ys = [p[1] for p in pp]
        if max(xs) < -buf or min(xs) > ext + buf or max(ys) < -buf or min(ys) > ext + buf: continue
        # doppelte Punkte (bei kleinen Zoomstufen) entfernen
        q = [pp[0]]
        for p in pp[1:]:
            if p != q[-1]: q.append(p)
        if len(q) < 2: continue
        cl = CLASSES[c]
        if cl not in vidx: vidx[cl] = len(vals); vals.append(cl)
        tags = b''.join(varint(t) for t in (0, vidx[cl])); geom = b''.join(varint(g) for g in line_geom(q))
        feats.append(ld(2, ld(2, tags) + key(3, 0) + varint(2) + ld(4, geom)))
    if not feats: return b''
    layer = ld(1, b'transportation') + b''.join(feats) + ld(3, b'class') + b''.join(ld(4, ld(1, v.encode())) for v in vals) + key(5, 0) + varint(ext) + key(15, 0) + varint(2)
    return ld(3, layer)


STYLE = {
    'version': 8, 'name': 'test',
    'sources': {'openmaptiles': {'type': 'vector', 'url': 'https://tiles.openfreemap.org/planet'}},
    'layers': [
        {'id': 'background', 'type': 'background', 'paint': {'background-color': 'rgb(242,243,240)'}},
        {'id': 'roads', 'type': 'line', 'source': 'openmaptiles', 'source-layer': 'transportation',
         'layout': {'line-cap': 'round', 'line-join': 'round'}, 'paint': {'line-color': 'rgb(255,0,255)', 'line-width': 3}}
    ]
}
STYLE_DARK = json.loads(json.dumps(STYLE)); STYLE_DARK['layers'][0]['paint']['background-color'] = 'rgb(12,12,12)'
TILEJSON = {'tilejson': '3.0.0', 'name': 'OpenFreeMap', 'tiles': ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'], 'minzoom': 0, 'maxzoom': 14,
            'bounds': [-180, -85.05113, 180, 85.05113], 'attribution': '<a href="https://openfreemap.org">OpenFreeMap</a>'}


async def handler(route, request):
    u = request.url; STATE['log'].append(u)
    h = dict(CORS)
    if request.method == 'OPTIONS': return await route.fulfill(status=204, headers=h)
    m = re.match(r'https://tiles\.openfreemap\.org/(.*)$', u); path = m.group(1) if m else ''
    if path.startswith('styles/'):
        STATE['styles'].append(path)
        if STATE['mode'] == 'style500': return await route.fulfill(status=500, headers=h, body='fehler')
        st = STYLE_DARK if path.startswith('styles/dark') else STYLE
        return await route.fulfill(status=200, headers=dict(h, **{'content-type': 'application/json'}), body=json.dumps(st))
    if path == 'planet':
        return await route.fulfill(status=200, headers=dict(h, **{'content-type': 'application/json'}), body=json.dumps(TILEJSON))
    t = re.match(r'planet/test/(\d+)/(\d+)/(\d+)\.pbf$', path)
    if t:
        STATE['tiles'] += 1
        if STATE['mode'] == 'tiles500': return await route.fulfill(status=500, headers=h, body='fehler')
        if STATE['mode'] == 'tiles404': return await route.fulfill(status=404, headers=h, body='')
        body = tile(*[int(v) for v in t.groups()])
        return await route.fulfill(status=200, headers=dict(h, **{'content-type': 'application/x-protobuf'}), body=body)
    STATE['other'].append(path)
    return await route.fulfill(status=404, headers=h, body='')
