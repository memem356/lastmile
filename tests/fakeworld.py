"""Künstliche OpenStreetMap-Welt für Browser-Tests: antwortet statt Overpass und Nominatim (kein Netz nötig).
Ein Straßengitter (300 x 300 Knoten, ca. 13 x 12 km) mit vier Städten als Rechtecken (A links oben, B rechts daneben, C unter A, D unter B).
Der Startort der Tests liegt in der Mitte von A. Alle Koordinaten sind ganze Vielfache von 1e-5 Grad, damit sich Kernkarte und Städtepakete
über gleiche Koordinaten verbinden (wie bei echten Daten).
Benutzung:  w = World(); await w.install(ctx)"""
import json, re, math
from urllib.parse import unquote

LA0, LO0, DLA, DLO, NI, NJ = 51.40, 6.95, 0.0004, 0.0006, 300, 300
nlat = lambda i: round(LA0 + i * DLA, 5)
nlon = lambda j: round(LO0 + j * DLO, 5)
nid = lambda i, j: 1000000000 + i * 100000 + j
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
J = dict(CORS, **{'content-type': 'application/json'})

# rel: (Name, Zeilen von, bis, Spalten von, bis, Einwohner, Art)
CITIES = {
    111: ('Teststadt', 10, 110, 10, 110, 120000, 'city'),
    222: ('Nachbarstadt', 10, 110, 120, 220, 45000, 'town'),
    333: ('Südstadt', 125, 225, 10, 110, 80000, 'city'),
    444: ('Weitstadt', 125, 225, 120, 220, 30000, 'town'),
}
START = (nlat(60), nlon(60))                       # Mitte von Teststadt


def poly(c):
    _, i0, i1, j0, j1 = c[:5]
    return [[nlon(j0), nlat(i0)], [nlon(j1), nlat(i0)], [nlon(j1), nlat(i1)], [nlon(j0), nlat(i1)], [nlon(j0), nlat(i0)]]


def way_tags(kind, a, seg):
    major = (a % 10 == 0) if kind == 'h' else (a % 12 == 0)
    if major: hw = 'secondary'
    elif a % 7 == 0: hw = 'tertiary'
    elif a % 11 == 0: hw = 'living_street'
    else: hw = 'residential'
    t = {'highway': hw, 'name': ('Querstraße ' if kind == 'h' else 'Längsstraße ') + str(a)}
    if kind == 'h' and a % 17 == 3: t.update({'highway': 'service', 'service': 'parking_aisle'})
    return t


class World:
    def __init__(self):
        self.calls = {'roads': 0, 'places': 0, 'firms': 0, 'isin': 0, 'lookup': 0, 'nearby': 0, 'search': 0, 'reverse': 0}
        self.no_reverse = False          # Nominatim reverse antwortet mit 429
        self.fail_roads = 0              # die nächsten n Straßenabfragen scheitern (504)
        self.offline = False             # alles scheitert
        self.no_link = False             # Abfragen nach großen Straßen (Verbindungen) bleiben leer
        self.hw = []                     # Art jeder Straßenabfrage: 'all' oder 'main'
        self.log = []

    # ---------- Overpass ----------
    def roads(self, b, allowed=None):
        s, w, n, e = b
        ilo, ihi = max(0, math.floor((s - LA0) / DLA)), min(NI - 1, math.ceil((n - LA0) / DLA))
        jlo, jhi = max(0, math.floor((w - LO0) / DLO)), min(NJ - 1, math.ceil((e - LO0) / DLO))
        ways, nodes = [], {}

        def add(kind, a, seg):
            ids = []
            for k in range(seg * 6, min(seg * 6 + 6, (NJ if kind == 'h' else NI) - 1) + 1):
                i, j = (a, k) if kind == 'h' else (k, a)
                ids.append(nid(i, j))
            if len(ids) < 2: return
            hit = False
            for x in ids:
                i, j = (x - 1000000000) // 100000, (x - 1000000000) % 100000
                if s <= nlat(i) <= n and w <= nlon(j) <= e: hit = True
                nodes[x] = {'type': 'node', 'id': x, 'lat': nlat(i), 'lon': nlon(j)}
            tg = way_tags(kind, a, seg)
            if hit and (allowed is None or tg['highway'] in allowed): ways.append({'type': 'way', 'id': (2000000000 if kind == 'h' else 3000000000) + a * 1000 + seg, 'nodes': ids, 'tags': tg})
        for i in range(ilo, ihi + 1):
            for seg in range(jlo // 6, jhi // 6 + 1): add('h', i, seg)
        for j in range(jlo, jhi + 1):
            for seg in range(ilo // 6, ihi // 6 + 1): add('v', j, seg)
        used = {x for wy in ways for x in wy['nodes']}
        return {'elements': ways + [nodes[x] for x in used]}

    def places(self, b):
        s, w, n, e = b; out = []
        kinds = [('amenity', 'restaurant'), ('amenity', 'cafe'), ('amenity', 'fast_food'), ('shop', 'bakery'), ('shop', 'supermarket')]
        ilo, ihi = max(0, math.floor((s - LA0) / DLA)), min(NI - 1, math.ceil((n - LA0) / DLA))
        jlo, jhi = max(0, math.floor((w - LO0) / DLO)), min(NJ - 1, math.ceil((e - LO0) / DLO))
        for i in range(ilo, ihi + 1):
            for j in range(jlo, jhi + 1):
                if (i * 13 + j * 7) % 41 == 0 and s <= nlat(i) <= n and w <= nlon(j) <= e:
                    k, v = kinds[(i + j) % 5]
                    out.append({'type': 'node', 'id': 4000000000 + i * 1000 + j, 'lat': nlat(i), 'lon': nlon(j), 'tags': {k: v, 'name': 'Lokal %d/%d' % (i, j)}})
                if (i * 3 + j * 5) % 4 == 0:
                    la, lo = round(nlat(i) + DLA / 2, 5), round(nlon(j) + DLO / 2, 5)
                    if s <= la <= n and w <= lo <= e: out.append({'type': 'way', 'id': 6000000000 + i * 1000 + j, 'center': {'lat': la, 'lon': lo}})
        return {'elements': out}

    def firms(self, b):
        s, w, n, e = b; out = []
        ilo, ihi = max(0, math.floor((s - LA0) / DLA)), min(NI - 1, math.ceil((n - LA0) / DLA))
        jlo, jhi = max(0, math.floor((w - LO0) / DLO)), min(NJ - 1, math.ceil((e - LO0) / DLO))
        for i in range(ilo, ihi + 1):
            for j in range(jlo, jhi + 1):
                if (i * 31 + j * 7) % 13 != 0 or not (s <= nlat(i) <= n and w <= nlon(j) <= e): continue
                tags = {'name': 'Bäckerei %d' % i, 'shop': 'bakery'} if (i + j) % 11 == 0 else {'name': 'Firma %d/%d' % (i, j), 'office': 'company'}
                out.append({'type': 'node', 'id': 5000000000 + i * 1000 + j, 'lat': nlat(i), 'lon': nlon(j), 'tags': tags})
        return {'elements': out}

    def overpass(self, q):
        if self.offline: return None
        if '["place"~' in q:
            self.calls['nearby'] += 1
            m = re.search(r'around:(\d+),([\d.]+),([\d.]+)', q); R, la, lo = int(m[1]), float(m[2]), float(m[3])
            els = []
            for rel, c in CITIES.items():
                clat, clon = nlat((c[1] + c[2]) // 2), nlon((c[3] + c[4]) // 2)
                d = math.hypot((clat - la) * 110574, (clon - lo) * 111320 * math.cos(math.radians(la)))
                if d <= R: els.append({'type': 'node', 'id': rel, 'lat': clat, 'lon': clon, 'tags': {'place': c[6], 'name': c[0], 'population': str(c[5])}})
            els.append({'type': 'node', 'id': 9, 'lat': nlat(5), 'lon': nlon(5), 'tags': {'place': 'village', 'name': 'Dorf'}})
            return {'elements': [x for x in els if x['tags']['place'] != 'village']}
        if 'is_in(' in q:
            self.calls['isin'] += 1
            m = re.search(r'is_in\(([\d.]+),([\d.]+)\)', q); la, lo = float(m[1]), float(m[2]); out = []
            for rel, c in CITIES.items():
                if nlat(c[1]) <= la <= nlat(c[2]) and nlon(c[3]) <= lo <= nlon(c[4]):
                    out += [{'type': 'relation', 'id': rel, 'tags': {'boundary': 'administrative', 'admin_level': '8', 'name': c[0], 'population': str(c[5])}}, {'type': 'relation', 'id': 999, 'tags': {'boundary': 'administrative', 'admin_level': '6', 'name': 'Testkreis'}}]
            return {'elements': out}
        bb = re.search(r'\(([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\)', q); b = [float(x) for x in bb.groups()]
        if '["highway"' in q:
            self.calls['roads'] += 1
            m = re.search(r'\["highway"~"\^\(([^)]*)\)\$"\]', q); allowed = set(m[1].split('|')) if m else None
            self.hw.append('main' if allowed and 'residential' not in allowed else 'all')
            if allowed and 'residential' not in allowed and self.no_link: return {'elements': []}
            if self.fail_roads > 0: self.fail_roads -= 1; return 'fail'
            return self.roads(b, allowed)
        if '["office"]' in q: self.calls['firms'] += 1; return self.firms(b)
        if '["amenity"~"^(restaurant' in q: self.calls['places'] += 1; return self.places(b)
        return {'elements': []}

    # ---------- Nominatim ----------
    def nominatim(self, url):
        if self.offline: return None
        if '/reverse' in url:
            self.calls['reverse'] += 1
            if self.no_reverse: return 'fail'
            m = re.search(r'lat=([\d.]+)&lon=([\d.]+)', url); la, lo = float(m[1]), float(m[2])
            for rel, c in CITIES.items():
                if nlat(c[1]) <= la <= nlat(c[2]) and nlon(c[3]) <= lo <= nlon(c[4]):
                    return {'osm_type': 'relation', 'osm_id': rel, 'name': c[0], 'lat': str(nlat((c[1] + c[2]) // 2)), 'lon': str(nlon((c[3] + c[4]) // 2)), 'geojson': {'type': 'Polygon', 'coordinates': [poly(c)]},
                            'extratags': {'population': str(c[5]), 'admin_level': '8'}}
            return {'error': 'Unable to geocode'}
        if 'lookup' in url:
            self.calls['lookup'] += 1
            rel = int(re.search(r'osm_ids=R(\d+)', url)[1]); c = CITIES.get(rel)
            if not c: return []
            return [{'name': c[0], 'lat': str(nlat((c[1] + c[2]) // 2)), 'lon': str(nlon((c[3] + c[4]) // 2)), 'geojson': {'type': 'Polygon', 'coordinates': [poly(c)]}}]
        self.calls['search'] += 1
        q = unquote(url.split('q=')[-1]).lower()
        for rel, c in CITIES.items():
            if c[0].lower().startswith(q.split(',')[0].strip()[:6]):
                return [{'name': c[0], 'display_name': c[0] + ', Testland', 'lat': str(START[0] if rel == 111 else nlat((c[1] + c[2]) // 2)), 'lon': str(START[1] if rel == 111 else nlon((c[3] + c[4]) // 2)),
                         'address': {'city': c[0], 'state': 'Testland', 'country': 'Deutschland'}}]
        return []

    async def install(self, ctx):
        await ctx.add_init_script('window.__LM_TILE_ROADS = 2600')      # kleine künstliche Städte: mehrere Kacheln (echt: 5200 m)
        async def ov(route, request):
            q = unquote((request.post_data or '').replace('data=', '', 1))
            r = self.overpass(q)
            if r is None: return await route.abort()
            if r == 'fail': return await route.fulfill(status=504, headers=CORS, body='')
            await route.fulfill(status=200, headers=J, body=json.dumps(r))

        async def no(route, request):
            r = self.nominatim(request.url)
            if r is None: return await route.abort()
            if r == 'fail': return await route.fulfill(status=429, headers=CORS, body='')
            await route.fulfill(status=200, headers=J, body=json.dumps(r))
        await ctx.route(re.compile(r'https://(overpass-api\.de|overpass\.private\.coffee|overpass\.kumi\.systems|maps\.mail\.ru)/.*'), ov)
        await ctx.route(re.compile(r'https://nominatim\.openstreetmap\.org/.*'), no)
        await ctx.route(re.compile(r'https://api\.open-meteo\.com/.*'), lambda r, q: r.abort())
