#!/usr/bin/env python3
"""Build tools/testdata/fixture_cards.json: MADE-UP card files used by the tests (the app ships no card data; real cards
live only in the Supabase table). Every name, address and phone number here is invented (555 numbers, example.com).
Also writes a made-up MGC .CRD file for the import test:  python3 tools/make_fixture.py [crd-out-path]"""
import base64, json, os, struct, sys, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'testdata', 'fixture_cards.json')
WORDS = ['ALPHA', 'BRAVO', 'CEDAR', 'DUNE', 'EMBER', 'FALCON', 'GROVE', 'HARBOR', 'IRIS', 'JUNIPER', 'KESTREL', 'LARK', 'MESA',
         'NOVA', 'ORBIT', 'PRAIRIE', 'QUARRY', 'RIDGE', 'SUMMIT', 'TIDE', 'UPLAND', 'VALE', 'WILLOW', 'XENON', 'YARROW', 'ZEPHYR']


def png32():
    raw = b''.join(b'\x00' + b''.join(bytes((x * 8 % 256, y * 8 % 256, 128)) for x in range(32)) for y in range(32))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 32, 32, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    return 'data:image/png;base64,' + base64.b64encode(png).decode()


def body(i, city='SINTON TX 78387', extra=''):
    return f'  {100 + i} MAIN ST\n  {city}\n\n  PAT DOE  361-555-{i % 100:04d}\n  FAX  361-555-{(i + 50) % 100:04d}\n{extra}'


def files():
    steel = ['AAA ZENITH STEEL', 'KESTREL ALLOYS', 'ADDER PIPE & SUPPLY', 'BRAVO BEARING CO', 'RIDGE METALS INC', 'FORGEWORKS EXAMPLE']
    steel += [f'{w} STEEL SUPPLY' for w in WORDS if w not in ('ZEPHYR', 'KESTREL', 'RIDGE', 'BRAVO')][:22]
    out = [{'name': 'STEEL', 'sourceFile': 'STEEL.CRD', 'format': 'MGC',
            'cards': [{'title': t, 'body': body(i, 'HOUSTON TX 77001' if i == 7 else 'SINTON TX 78387')} for i, t in enumerate(steel)]}]
    out.append({'name': 'AUTO', 'sourceFile': 'AUTO.CRD', 'format': 'RRG',
                'cards': [{'title': 'A1 EXAMPLE AUTO PARTS', 'body': body(1), 'image': {'src': png32(), 'w': 32, 'h': 32}}]
                + [{'title': f'{w} AUTO REPAIR', 'body': body(i)} for i, w in enumerate(WORDS[1:19])]})
    out.append({'name': 'OILUNIT', 'sourceFile': 'OILUNIT.CRD', 'format': 'LCP', 'cards': [{'title': 'EXAMPLE OIL UNIT LAYOUT', 'body': 'MODEL X-100\nMADE-UP TEST CARD'}]})
    out.append({'name': 'TRCKING', 'sourceFile': 'TRCKING.CRD', 'format': 'MGC', 'cards': [{'title': f'{w} TRUCKING', 'body': body(i)} for i, w in enumerate(WORDS)]})
    out.append({'name': 'EMPLST', 'sourceFile': 'EMPLST.CRD', 'format': 'MGC', 'cards': [{'title': f'DOE, {n}', 'body': body(i)} for i, n in enumerate(['ALEX', 'JORDAN', 'SAM', 'TAYLOR'])]})
    out.append({'name': 'PHONENUB', 'sourceFile': 'PHONENUB.CRD', 'format': 'MGC', 'cards': [{'title': f'{w} OFFICE', 'body': f'  361-555-01{i:02d}'} for i, w in enumerate(WORDS[:4])]})
    out.append({'name': 'AC', 'sourceFile': 'AC.CRD', 'format': 'MGC', 'cards': [
        {'title': 'ARCTIC AIR EXAMPLE', 'body': body(1)}, {'title': 'ARCTIC AIR EXAMPLE', 'body': body(1)},   # exact duplicate
        {'title': '', 'body': 'card with an empty index line'}, {'title': 'BREEZE COOLING', 'body': body(3)},
        {'title': 'CHILL HVAC', 'body': body(4)}, {'title': 'DRAFT DUCT CO', 'body': body(5)}]})
    return out


def fixture_js():
    """init script: put the made-up cards into the browser cache (localStorage) on the first load in a test context"""
    return ("if (!localStorage.getItem('ramgear-cardfile-v1')) localStorage.setItem('ramgear-cardfile-v1', JSON.stringify({files: %s, cur: 0, view: 'card'}));"
            % json.dumps(files()))


def write_mgc(path, cards):
    n = len(cards); off = 5 + 52 * n; idx = b''; data = b''
    for t, b in cards:
        e = bytearray(52); struct.pack_into('<I', e, 6, off); tb = t.encode('cp1252')[:39]; e[11:11 + len(tb)] = tb; idx += bytes(e)
        bb = b.replace('\n', '\r\n').encode('cp1252'); d = struct.pack('<HH', 0, len(bb)) + bb; data += d; off += len(d)
    open(path, 'wb').write(b'MGC' + struct.pack('<H', n) + idx + data)


if __name__ == '__main__':
    json.dump(files(), open(OUT, 'w'), indent=1)
    if len(sys.argv) > 1:
        write_mgc(sys.argv[1], [(f'{w} GEAR WORKS', body(i)) for i, w in enumerate(WORDS[:23])])
    print('wrote', OUT)
