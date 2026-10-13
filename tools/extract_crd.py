#!/usr/bin/env python3
"""Usage: python3 tools/extract_crd.py <folder of .CRD files> [out dir]
Extract every card from Windows Cardfile .CRD files (MGC, RRG) and the
third-party 'LCP' card-layout files into <out>/cards.json + cards.txt (outside the repo).
Originals are only read, never modified."""
import struct, json, os, sys, re, io, hashlib
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
# usage: python3 tools/extract_crd.py <folder-with-.CRD-files> [output-dir, default: ../../cardfile-extracted, outside the repo]
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'crd')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', '..', 'cardfile-extracted')   # keep card data OUT of the repo
IMG = os.path.join(OUT, 'images')
os.makedirs(IMG, exist_ok=True)

class R:
    def __init__(s, d, p=0): s.d, s.p = d, p
    def u16(s): v = struct.unpack_from('<H', s.d, s.p)[0]; s.p += 2; return v
    def i16(s): v = struct.unpack_from('<h', s.d, s.p)[0]; s.p += 2; return v
    def u32(s): v = struct.unpack_from('<I', s.d, s.p)[0]; s.p += 4; return v
    def take(s, n):
        if s.p + n > len(s.d): raise ValueError('read past end')
        v = s.d[s.p:s.p+n]; s.p += n; return v
    def lstr(s):  # OLE1 length-prefixed string (len includes NUL)
        n = s.u32(); return s.take(n).split(b'\0')[0].decode('cp1252', 'replace')

def dec(b):
    return b.decode('cp1252', 'replace')

def norm(t):
    return t.replace('\r\n', '\n').replace('\r', '\n')

# ---------- images ----------
def dib_to_png(dib, path):
    """dib = BITMAPINFOHEADER + palette + bits"""
    hsz, w, h, planes, bpp, comp, isz = struct.unpack_from('<IiiHHII', dib, 0)
    ncol = struct.unpack_from('<I', dib, 32)[0] if hsz >= 36 else 0
    if bpp <= 8 and ncol == 0: ncol = 1 << bpp
    off = 14 + hsz + 4 * ncol
    bmp = b'BM' + struct.pack('<IHHI', 14 + len(dib), 0, 0, off) + dib
    Image.open(io.BytesIO(bmp)).save(path); return True

def ddb_to_png(bits, w, h, path, wb=None, bpp=1):
    """Win16 device-dependent monochrome bitmap: rows of wb bytes, word aligned, top-down"""
    if bpp != 1: return False
    wb = wb or ((w + 15) // 16) * 2
    rows = [bits[r*wb:(r*wb)+(w+7)//8] for r in range(h)]
    img = Image.frombytes('1', (w, h), b''.join(rows))
    img.save(path); return True

def wmf_to_png(wmf, path):
    """Pull the largest embedded DIB out of a Windows metafile (clip art is usually a
    StretchDIB record). Returns True if a PNG was written."""
    r = R(wmf)
    try:
        typ, hs, ver = r.u16(), r.u16(), r.u16()
        r.p = hs * 2
        best = None
        while r.p + 6 <= len(wmf):
            size = r.u32(); fn = r.u16()
            if size < 3: break
            body = wmf[r.p:r.p + size*2 - 6]
            r.p += size*2 - 6
            if fn == 0x0F43:   # META_STRETCHDIB: rop(4) usage(2) srcH srcW srcY srcX dH dW dY dX = 22 bytes
                dib = body[22:]
            elif fn == 0x0B41: # META_DIBSTRETCHBLT: rop(4) srcY srcX srcH srcW... 20 bytes (with bitmap)
                dib = body[20:]
            elif fn == 0x0940: # META_DIBBITBLT
                dib = body[16:]
            else:
                continue
            if len(dib) > 40 and struct.unpack_from('<I', dib, 0)[0] in (12, 40):
                if not best or len(dib) > len(best): best = dib
            if fn == 0 : break
        if best:
            return dib_to_png(best, path)
    except Exception as e:
        print('  wmf parse error', e)
    return False

# ---------- OLE 1.0 object ----------
def read_presentation(r, info):
    ver = r.u32(); fmt = r.u32()
    if fmt == 0: return             # no presentation
    cls = r.lstr(); info['presClass'] = cls
    if cls in ('METAFILEPICT', 'BITMAP', 'DIB'):
        info['presWidthHimetric'] = r.u32(); info['presHeightHimetric'] = r.u32()
        n = r.u32(); info['presData'] = r.take(n)
    else:
        cf = r.u32()
        if cf == 0: info['presClipName'] = r.lstr()
        n = r.u32(); info['presData'] = r.take(n)

def read_ole(r):
    info = {}
    start = r.p
    info['oleVersion'] = hex(r.u32())
    fmt = r.u32(); info['format'] = {1: 'linked', 2: 'embedded', 3: 'static'}.get(fmt, fmt)
    info['class'] = r.lstr()
    if fmt == 3:
        info['presClass'] = info['class']
        info['presWidthHimetric'] = r.u32(); info['presHeightHimetric'] = r.u32()
        n = r.u32(); info['presData'] = r.take(n)
    else:
        info['topic'] = r.lstr(); info['item'] = r.lstr()
        if fmt == 2:
            n = r.u32(); info['native'] = r.take(n)
        else:
            info['network'] = r.lstr(); r.u32(); r.u32()
        read_presentation(r, info)
    info['raw'] = r.d[start:r.p]
    return info

def save_object_image(info, base):
    """Try presentation (METAFILEPICT/DIB/BITMAP), then native BMP. Returns png file name or None"""
    png = base + '.png'; path = os.path.join(IMG, png)
    pd = info.get('presData'); pc = info.get('presClass')
    try:
        if pd and pc == 'DIB' and dib_to_png(pd, path): return png
        if pd and pc == 'METAFILEPICT':
            wmf = pd[8:] if pd[8:10] in (b'\x01\x00', b'\x02\x00') else pd
            open(os.path.join(IMG, base + '.wmf'), 'wb').write(wmf)
            if wmf_to_png(wmf, path): return png
        if pd and pc == 'BITMAP':
            bmType, w, h, wb, planes, bpp = struct.unpack_from('<hhhhBB', pd, 0)
            if ddb_to_png(pd[10:], w, h, path, wb, bpp): return png
        nat = info.get('native', b'')
        i = nat.find(b'BM')
        if i >= 0 and dib_to_png(nat[i+14:], path): return png
    except Exception as e:
        print('  image error', base, e)
    return None

# ---------- file parsers ----------
def parse_cardfile(d, name, warnings):
    sig = d[:3].decode()
    r = R(d, 3)
    if sig == 'MGC': n = r.u16(); lastobj = None
    else: lastobj = r.u32(); n = r.u16()
    base = r.p
    cards = []
    end_of_index = base + 52 * n
    expect = end_of_index
    for i in range(n):
        e = d[base + 52*i: base + 52*i + 52]
        if len(e) < 52: warnings.append(f'{name}: truncated index entry {i}'); break
        off = struct.unpack_from('<I', e, 6)[0]
        raw_title = e[11:51]
        title_b = raw_title.split(b'\0')[0]
        junk = raw_title[len(title_b)+1:].rstrip(b'\0')
        card = {'title': dec(title_b), 'body': ''}
        if e[:6] != b'\0'*6 or e[10] != 0: card['_indexFlags'] = e[:6].hex() + '/' + str(e[10])
        if off != expect: warnings.append(f'{name}: card {i} data at {off}, expected {expect}')
        cr = R(d, off)
        if sig == 'MGC':
            blen = cr.u16()
            if blen:
                w, h, x, y = cr.u16(), cr.u16(), cr.u16(), cr.u16()
                bits = cr.take(blen)
                pngname = f'{os.path.splitext(name)[0]}_{i:03d}.png'
                ok = ddb_to_png(bits, w, h, os.path.join(IMG, pngname))
                card['image'] = {'file': 'images/' + pngname if ok else None, 'kind': 'bitmap (Cardfile 3.0)',
                                 'width': w, 'height': h, 'x': x, 'y': y}
        else:
            flag = cr.u16()
            if flag:
                objid = cr.u32()
                info = read_ole(cr)
                cw, ch = cr.u16(), cr.u16()
                rect = [cr.i16() for _ in range(4)]
                otype = cr.u16()
                pngname = save_object_image(info, f'{os.path.splitext(name)[0]}_{i:03d}')
                card['image'] = {'file': 'images/' + pngname if pngname else None,
                                 'kind': f"OLE {info['format']} object, class {info['class']}" +
                                         (f", presentation {info.get('presClass')}" if info.get('presClass') else ''),
                                 'objectId': objid, 'objectType': {0:'embedded',1:'linked',2:'static'}.get(otype, otype),
                                 'rect': rect, 'charSize': [cw, ch],
                                 'oleBytes': len(info['raw'])}
                if info.get('topic'): card['image']['topic'] = info['topic']
        tlen = cr.u16()
        card['body'] = norm(dec(cr.take(tlen)))
        expect = cr.p
        cards.append(card)
    if expect != len(d): warnings.append(f'{name}: {len(d)-expect} trailing bytes after last card')
    return sig, n, lastobj, cards

def parse_lcp(d, name, warnings):
    """Third-party card-layout format (Delphi object stream: TCardPage/TCardPanel/
    TTextObject/TPictureObject). Not Microsoft Cardfile. Extract text objects + bitmaps."""
    texts = []
    # text object: FF FF 01, rect(4*u16), 00 00 00 01 00 00, len16, text, pstr(font), 00 00 00 00, u16 size
    for m in re.finditer(rb'\xff\xff\x01(.{8})\x00\x00\x00\x01\x00\x00(..)', d, re.S):
        ln = struct.unpack('<H', m.group(2))[0]
        p = m.end()
        if 0 < ln < 1000 and p + ln < len(d):
            t = d[p:p+ln]
            fl = d[p+ln]
            font = d[p+ln+1:p+ln+1+fl]
            if fl and re.fullmatch(rb'[A-Za-z ]+', font) and all(32 <= c < 256 for c in t):
                rect = struct.unpack('<4H', m.group(1))
                size = struct.unpack_from('<H', d, p+ln+1+fl+4)[0]
                texts.append({'text': dec(t), 'font': font.decode(), 'size': size, 'rect': list(rect)})
    images = []
    for m in re.finditer(rb'BM', d):
        i = m.start()
        if i + 54 > len(d): continue
        sz, r1, r2, off = struct.unpack_from('<IHHI', d, i+2)
        if r1 == 0 and r2 == 0 and struct.unpack_from('<I', d, i+14)[0] == 40 and i + sz <= len(d):
            pngname = f'{os.path.splitext(name)[0]}_{len(images):03d}.png'
            Image.open(io.BytesIO(d[i:i+sz])).save(os.path.join(IMG, pngname))
            w, h = struct.unpack_from('<ii', d, i+18)
            images.append({'file': 'images/' + pngname, 'kind': 'TPictureObject bitmap', 'width': w, 'height': h,
                           'rect': list(struct.unpack_from('<4H', d, i - 16))})
    classes = re.findall(rb'[\x05-\x10](T[A-Za-z]+)', d[-200:])
    card = {'title': texts[0]['text'] if texts else os.path.splitext(name)[0],
            'body': '\n'.join(t['text'] for t in texts),
            'layout': {'format': 'LCP card layout (not Microsoft Cardfile)', 'texts': texts,
                       'classes': [c.decode() for c in classes]}}
    if images:
        card['image'] = images[0]
        if len(images) > 1: card['extraImages'] = images[1:]
    return 'LCP', 1, None, [card]

def main():
    files = sorted(os.listdir(SRC), key=lambda s: s.upper())
    out, warnings, report = [], [], []
    hashes = {}
    for fn in files:
        d = open(os.path.join(SRC, fn), 'rb').read()
        sig = d[:3]
        if sig in (b'MGC', b'RRG'): s, n, lastobj, cards = parse_cardfile(d, fn, warnings)
        elif sig == b'LCP': s, n, lastobj, cards = parse_lcp(d, fn, warnings)
        else: warnings.append(f'{fn}: unknown signature {sig!r}'); continue
        if len(cards) != n: warnings.append(f'{fn}: header says {n}, parsed {len(cards)}')
        st = os.stat(os.path.join(SRC, fn))
        import datetime
        entry = {'name': os.path.splitext(fn)[0].upper(), 'sourceFile': fn, 'format': s,
                 'headerCount': n, 'modified': datetime.datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d'),
                 'sha1': hashlib.sha1(d).hexdigest(), 'cards': cards}
        if lastobj is not None and s == 'RRG': entry['lastObjectId'] = lastobj
        out.append(entry)
    json.dump(out, open(os.path.join(OUT, 'cards.json'), 'w'), indent=1, ensure_ascii=False)
    with open(os.path.join(OUT, 'cards.txt'), 'w', encoding='utf-8') as f:
        tot = sum(len(e['cards']) for e in out)
        f.write(f'Ram-Gear Cardfile data: {len(out)} files, {tot} cards\n')
        for e in out:
            f.write('\n' + '=' * 72 + f"\nFILE {e['sourceFile']}  [{e['format']}]  {len(e['cards'])} cards  (modified {e['modified']})\n" + '=' * 72 + '\n')
            for i, c in enumerate(e['cards']):
                f.write(f"\n--- [{i+1}] {c['title']}\n")
                if c.get('image'): f.write(f"    <picture: {c['image']['kind']} -> {c['image'].get('file')}>\n")
                for line in c['body'].split('\n'): f.write('    ' + line + '\n')
    for w in warnings: print('WARN', w)
    for e in out: print(f"{e['sourceFile']:14s} {e['format']} header={e['headerCount']:3d} cards={len(e['cards']):3d}")
    print('TOTAL files', len(out), 'cards', sum(len(e['cards']) for e in out))

main()
