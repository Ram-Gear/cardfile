/* crd.js: read/write Windows Cardfile .CRD files in the browser.
 * Supports MGC (Cardfile 3.0 / text-only 3.1), RRG (3.1 with OLE 1.0 objects) and the
 * third-party "LCP" card-layout format found in the Ram-Gear data. Port of tools/extract_crd.py. */
(function (global) {
  'use strict';
  // ---- cp1252 ----
  const CP1252_HI = [0x20AC,0xFFFD,0x201A,0x0192,0x201E,0x2026,0x2020,0x2021,0x02C6,0x2030,0x0160,0x2039,0x0152,0xFFFD,0x017D,0xFFFD,
                     0xFFFD,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,0x02DC,0x2122,0x0161,0x203A,0x0153,0xFFFD,0x017E,0x0178];
  function decode1252(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      s += String.fromCharCode(b >= 0x80 && b < 0xA0 ? CP1252_HI[b - 0x80] : b);
    }
    return s;
  }
  function encode1252(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x80 || (c >= 0xA0 && c < 0x100)) out.push(c);
      else { const i = CP1252_HI.indexOf(c); out.push(i >= 0 ? 0x80 + i : 0x3F); }
    }
    return out;
  }
  const norm = t => t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  class Reader {
    constructor(u8, p = 0) { this.d = u8; this.v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = p; }
    u16() { const x = this.v.getUint16(this.p, true); this.p += 2; return x; }
    i16() { const x = this.v.getInt16(this.p, true); this.p += 2; return x; }
    u32() { const x = this.v.getUint32(this.p, true); this.p += 4; return x; }
    take(n) { if (this.p + n > this.d.length) throw new Error('Unexpected end of file'); const s = this.d.subarray(this.p, this.p + n); this.p += n; return s; }
    lstr() { const s = this.take(this.u32()); let e = s.indexOf(0); if (e < 0) e = s.length; return decode1252(s.subarray(0, e)); }
  }

  // ---- images -> data URLs ----
  function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function dibToBmpURL(dib) {
    const dv = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
    const hsz = dv.getUint32(0, true), bpp = dv.getUint16(14, true);
    let ncol = hsz >= 36 ? dv.getUint32(32, true) : 0;
    if (bpp <= 8 && ncol === 0) ncol = 1 << bpp;
    const out = new Uint8Array(14 + dib.length), o = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4D; o.setUint32(2, out.length, true); o.setUint32(10, 14 + hsz + 4 * ncol, true);
    out.set(dib, 14);
    return 'data:image/bmp;base64,' + b64(out);
  }
  function monoToURL(bits, w, h, wb) {
    if (typeof document === 'undefined') return null;
    wb = wb || Math.ceil(w / 16) * 2;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const on = (bits[y * wb + (x >> 3)] >> (7 - (x & 7))) & 1, v = on ? 255 : 0, k = (y * w + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v; img.data[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0); return c.toDataURL('image/png');
  }
  function wmfToURL(wmf) {
    try {
      const r = new Reader(wmf); r.u16(); const hs = r.u16(); r.p = hs * 2; let best = null;
      while (r.p + 6 <= wmf.length) {
        const size = r.u32(), fn = r.u16(); if (size < 3) break;
        const body = wmf.subarray(r.p, r.p + size * 2 - 6); r.p += size * 2 - 6;
        let dib = null;
        if (fn === 0x0F43) dib = body.subarray(22); else if (fn === 0x0B41) dib = body.subarray(20); else if (fn === 0x0940) dib = body.subarray(16);
        if (dib && dib.length > 40) { const h = new DataView(dib.buffer, dib.byteOffset).getUint32(0, true); if ((h === 40 || h === 12) && (!best || dib.length > best.length)) best = dib; }
      }
      return best ? dibToBmpURL(best) : null;
    } catch (e) { return null; }
  }

  // ---- OLE 1.0 ----
  function readOle(r) {
    const info = {}; info.version = r.u32(); const fmt = r.u32();
    info.format = ({ 1: 'linked', 2: 'embedded', 3: 'static' })[fmt] || String(fmt);
    info.cls = r.lstr();
    const pres = () => {
      r.u32(); const pf = r.u32(); if (pf === 0) return;
      info.presClass = r.lstr();
      if (['METAFILEPICT', 'BITMAP', 'DIB'].includes(info.presClass)) { r.u32(); r.u32(); info.pres = r.take(r.u32()); }
      else { const cf = r.u32(); if (cf === 0) r.lstr(); info.pres = r.take(r.u32()); }
    };
    if (fmt === 3) { info.presClass = info.cls; r.u32(); r.u32(); info.pres = r.take(r.u32()); }
    else {
      info.topic = r.lstr(); info.item = r.lstr();
      if (fmt === 2) info.native = r.take(r.u32()); else { r.lstr(); r.u32(); r.u32(); }
      pres();
    }
    return info;
  }
  function oleImageURL(info) {
    const p = info.pres;
    try {
      if (p && info.presClass === 'DIB') return dibToBmpURL(p);
      if (p && info.presClass === 'METAFILEPICT') return wmfToURL(p[8] === 1 || p[8] === 2 ? p.subarray(8) : p);
      if (p && info.presClass === 'BITMAP') { const dv = new DataView(p.buffer, p.byteOffset); return monoToURL(p.subarray(10), dv.getInt16(2, true), dv.getInt16(4, true), dv.getInt16(6, true)); }
      if (info.native) { for (let i = 0; i + 1 < info.native.length; i++) if (info.native[i] === 0x42 && info.native[i + 1] === 0x4D) return dibToBmpURL(info.native.subarray(i + 14)); }
    } catch (e) { /* fall through */ }
    return null;
  }

  // ---- parsers ----
  function parseCardfile(u8, warnings) {
    const sig = decode1252(u8.subarray(0, 3)); const r = new Reader(u8, 3);
    if (sig === 'RRG') r.u32();
    const n = r.u16(), base = r.p, cards = [];
    let expect = base + 52 * n;
    for (let i = 0; i < n; i++) {
      const e = u8.subarray(base + 52 * i, base + 52 * i + 52);
      if (e.length < 52) { warnings.push('truncated index entry ' + i); break; }
      const off = new DataView(e.buffer, e.byteOffset).getUint32(6, true);
      const tb = e.subarray(11, 51); let z = tb.indexOf(0); if (z < 0) z = tb.length;
      const card = { title: decode1252(tb.subarray(0, z)), body: '' };
      if (off !== expect) warnings.push(`card ${i} data at ${off}, expected ${expect}`);
      const c = new Reader(u8, off);
      if (sig === 'MGC') {
        const blen = c.u16();
        if (blen) { const w = c.u16(), h = c.u16(), x = c.u16(), y = c.u16(); const bits = c.take(blen);
          card.image = { src: monoToURL(bits, w, h), kind: 'bitmap (Cardfile 3.0)', rect: [x, y, x + w, y + h] }; }
      } else {
        const flag = c.u16();
        if (flag) {
          c.u32(); const info = readOle(c); const cw = c.u16(), ch = c.u16();
          const rect = [c.i16(), c.i16(), c.i16(), c.i16()]; c.u16();
          card.image = { src: oleImageURL(info), kind: `OLE ${info.format} object, class ${info.cls}`, rect, charSize: [cw, ch] };
        }
      }
      card.body = norm(decode1252(c.take(c.u16())));
      expect = c.p; cards.push(card);
    }
    if (expect !== u8.length) warnings.push(`${u8.length - expect} trailing bytes`);
    return { format: sig, headerCount: n, cards };
  }
  function parseLCP(u8, warnings) {
    const texts = [], images = [];
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 8; i + 10 < u8.length; i++) {
      if (u8[i] === 0xFF && u8[i+1] === 0xFF && u8[i+2] === 1 && u8[i+11] === 0 && u8[i+12] === 0 && u8[i+13] === 0 && u8[i+14] === 1 && u8[i+15] === 0 && u8[i+16] === 0 && i + 19 < u8.length) {
        const ln = dv.getUint16(i + 17, true), p = i + 19;
        if (ln > 0 && ln < 1000 && p + ln + 1 < u8.length) {
          const t = u8.subarray(p, p + ln), fl = u8[p + ln], font = decode1252(u8.subarray(p + ln + 1, p + ln + 1 + fl));
          if (fl && /^[A-Za-z ]+$/.test(font) && t.every(b => b >= 32)) texts.push(decode1252(t));
        }
      }
      if (u8[i] === 0x42 && u8[i+1] === 0x4D && i + 54 < u8.length) {
        const sz = dv.getUint32(i + 2, true);
        if (dv.getUint32(i + 6, true) === 0 && dv.getUint32(i + 14, true) === 40 && i + sz <= u8.length) {
          images.push({ src: 'data:image/bmp;base64,' + b64(u8.subarray(i, i + sz)), kind: 'TPictureObject bitmap' }); i += sz - 1;
        }
      }
    }
    if (!texts.length && !images.length) warnings.push('no text or picture objects recognised');
    return { format: 'LCP', headerCount: 1, cards: [{ title: texts[0] || '(card layout)', body: texts.join('\n'), image: images[0] }] };
  }
  function parseCRD(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const sig = decode1252(u8.subarray(0, 3)), warnings = [];
    let res;
    if (sig === 'MGC' || sig === 'RRG') res = parseCardfile(u8, warnings);
    else if (sig === 'LCP') res = parseLCP(u8, warnings);
    else throw new Error('Not a Cardfile file (signature "' + sig + '"). Expected MGC, RRG or LCP.');
    res.warnings = warnings; return res;
  }

  // ---- writer (MGC, text only) ----
  function writeMGC(cards) {
    const sorted = cards.slice();
    const idx = [], data = [];
    const n = sorted.length; let off = 5 + 52 * n;
    for (const c of sorted) {
      const t = encode1252(c.title || '').slice(0, 39);
      const body = encode1252((c.body || '').replace(/\r?\n/g, '\r\n')).slice(0, 65535);
      const e = new Uint8Array(52); new DataView(e.buffer).setUint32(6, off, true); e.set(t, 11);
      idx.push(e);
      const d = new Uint8Array(4 + body.length); new DataView(d.buffer).setUint16(2, body.length, true); d.set(body, 4);
      data.push(d); off += d.length;
    }
    const out = new Uint8Array(off); out.set([0x4D, 0x47, 0x43], 0); new DataView(out.buffer).setUint16(3, n, true);
    let p = 5; for (const e of idx) { out.set(e, p); p += 52; } for (const d of data) { out.set(d, p); p += d.length; }
    return out;
  }

  global.CRD = { parseCRD, writeMGC, decode1252, encode1252 };
  if (typeof module !== 'undefined') module.exports = global.CRD;
})(typeof window !== 'undefined' ? window : globalThis);
