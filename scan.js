/* Scan business card: photo -> in-browser OCR (Tesseract.js, lazy-loaded from a CDN) -> fields -> new card.
 * The parser (CardScanParser) is pure JS and also runs under Node for unit tests (tools/test_scan_parser.js).
 * Nothing is uploaded: the photo is processed on this device; only the OCR engine files are downloaded. */
(function (root) {
  'use strict';

  // =====================================================================================
  //  Parser: OCR text -> fields
  // =====================================================================================
  const STATE_NAMES = {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
    delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
    kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
    minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
    'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
    oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
    tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
    wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC', 'tex': 'TX', 'calif': 'CA', 'la': 'LA'
  };
  const STATE_ABBR = new Set(Object.values(STATE_NAMES).concat(['PR']));
  const NAMES_RE = Object.keys(STATE_NAMES).filter(n => n.length > 3).sort((a, b) => b.length - a.length).map(n => n.replace(/ /g, '\\s+')).join('|');
  // "<city>, <state> <zip>" at the end of a line; state = 2-letter code or full name
  const CSZ_RE = new RegExp('(^|[\\s,])(' + NAMES_RE + '|[A-Za-z]{2})\\.?,?\\s+(\\d{5}(?:\\s?-\\s?\\d{4})?)(?!\\d)', 'gi');

  const COMPANY_RE = /\b(inc|incorporated|llc|l\.l\.c|llp|ltd|limited|co|corp|corporation|company|companies|group|supply|supplies|gear|gears|industries|industrial|manufacturing|mfg|machine|machining|machinery|works|shop|services|service co|systems|solutions|enterprises|associates|partners|steel|metals?|tools?|tooling|electric|electrical|equipment|engineering|fabrication|fabricators|bearings?|hydraulics?|distributors?|distribution|international|intl|technologies|technology|labs?|freight|trucking|logistics|transport|rentals?|welding|plumbing|construction|contractors?|insurance|bank|agency|products|parts|motors?|auto|automotive|pumps?|valves?|oil|gas|energy|chemicals?|plastics?|rubber|lumber|hardware|printing|packaging|safety|uniforms?|marine|controls|instruments|wholesale|sales\s*&\s*service)\b\.?/i;
  const TITLE_RE = /\b(president|vice\s*president|vp|ceo|cfo|coo|cto|cio|owner|co-owner|founder|partner|principal|manager|mgr|director|dir|sales|salesman|engineer|eng|representative|rep|specialist|coordinator|supervisor|superintendent|account|accounts|estimator|buyer|purchasing|agent|consultant|technician|tech|foreman|administrator|admin|assistant|executive|officer|associate|analyst|operations|service|customer|inside|outside|territory|regional|general|plant|branch|attorney|broker|counter|dispatcher|dispatch|machinist|inspector|planner|controller|treasurer|secretary|chairman|chair|head|lead|senior|sr|junior|jr\.? manager|marketing|logistics|quality|safety|project)\b/i;
  const STREET_RE = /\b(st|street|ave|avenue|av|rd|road|dr|drive|blvd|boulevard|hwy|highway|ln|lane|way|ct|court|pkwy|parkway|pl|place|cir|circle|ter|terrace|trl|trail|loop|fm\s*\d+|cr\s*\d+|sh\s*\d+|us\s*\d+|suite|ste|unit|bldg|building|floor|fl|box|p\.?\s*o\.?)\b\.?/i;
  const TOLLFREE = new Set(['800', '888', '877', '866', '855', '844', '833']);
  const FREEMAIL = /^(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|att|sbcglobal|comcast|verizon|example)$/i;

  function cleanLine(s) {
    return s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-')
      .replace(/^[\s|•·*_~=>«»©®°]+|[\s|•·*_~=<«»©®°]+$/g, '').replace(/\s+/g, ' ').trim();
  }
  const letters = s => (s.match(/[A-Za-z]/g) || []).length;
  const isCaps = s => letters(s) > 2 && s === s.toUpperCase();

  function normPhone(raw) {
    const ext = raw.match(/(?:x|ext\.?|extension)\s*(\d{1,5})\s*$/i);
    let d = raw.replace(/(?:x|ext\.?|extension)\s*\d{1,5}\s*$/i, '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    let out = d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d.length === 7 ? `${d.slice(0, 3)}-${d.slice(3)}` : null;
    if (out && ext) out += ' EXT ' + ext[1];
    return out;
  }
  function phoneLabel(before, after, digits) {
    const b = before.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    const last = b.split(' ').slice(-2).join(' ');
    if (/(^|\s)(fax|facsimile|fx|f)$/.test(last)) return 'fax';
    if (/(^|\s)(ce[l1i]{1,2}|cellular|mobile|mob|m|c)$/.test(last)) return 'cell';
    if (/toll[\s-]*free$|(^|\s)(tf|toll)$/.test(last)) return 'tollfree';
    if (/(^|\s)(office|off|tel|tele|telephone|phone|ph|p|o|t|direct|dir|d|main|work|w|business|bus|voice)$/.test(last)) return 'office';
    const a = after.toLowerCase();
    if (/^\W*\(?\s*fax\b/.test(a)) return 'fax';
    if (/^\W*\(?\s*(cell|mobile)\b/.test(a)) return 'cell';
    if (/^\W*\(?\s*(office|direct|main)\b/.test(a)) return 'office';
    if (TOLLFREE.has(digits.replace(/^1/, '').slice(0, 3)) && digits.replace(/^1/, '').length === 10) return 'tollfree';
    return '';
  }
  // OCR often reads 0 as O and 1 as l/I inside numbers; fix only inside digit-heavy runs
  function fixDigits(line) {
    return line.replace(/[\dOoIl()\-. +]{9,}/g, m => ((m.match(/\d/g) || []).length >= 6 ? m.replace(/[Oo]/g, '0').replace(/[Il]/g, '1') : m));
  }
  const PHONE_RE = /(?<![\d-])(?:\+?1[\s.\-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.\-\/]*\d{3}[\s.\-]*\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d{1,5})?(?![\d-])|(?<![\d-])\d{3}[\s.\-]\d{4}(?![\d-])/gi;
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|biz|us|info|co|io|edu|gov|ws|tv|pro)\b(?:\/[^\s,;]*)?/gi;
  const LABEL_WORDS = /\b(office|off|tel|tele|telephone|phone|ph|cell|cellular|mobile|mob|fax|facsimile|toll[\s-]*free|direct|main|e-?mail|email|web|website|www|url|ext)\b\.?:?|(?:^|\s)[PFMCTOWED][.:]?(?=\s|$)/gi;

  function looksLikeName(seg) {
    const s = seg.replace(/,?\s+(jr|sr|ii|iii|iv|p\.?e|ph\.?d|cpa|mba)\.?$/i, '').trim();
    const t = s.split(/\s+/);
    if (t.length < 2 || t.length > 4) return false;
    if (/[\d@]/.test(s) || COMPANY_RE.test(s) || TITLE_RE.test(s) || STREET_RE.test(s)) return false;
    let words = 0;
    for (const w of t) {
      if (/^[A-Z]\.?$/.test(w)) continue;                                     // middle initial
      if (!/^[A-Z][A-Za-z'\-]*[a-zA-Z]\.?$/.test(w) || /^[A-Z][a-z]*[A-Z]/.test(w.slice(1)) && !isCaps(w)) return false;
      words++;
    }
    return words >= 2;
  }

  function parseCard(text) {
    const raw = String(text || '');
    const lines = raw.split(/\r?\n/).map(cleanLine).filter(l => letters(l) + (l.match(/\d/g) || []).length >= 2);
    const f = { company: '', name: '', title: '', phones: [], email: '', website: '', address: '', city: '', state: '', zip: '' };
    const info = lines.map(l => ({ text: l, rest: l, used: false }));

    // --- emails, websites, phones (anywhere on a line) ---
    for (const L of info) {
      let s = L.text, found = false;
      if (/@/.test(s)) s = s.replace(/\s*@\s*/g, '@').replace(/@([A-Za-z0-9-]+),(com|net|org)\b/i, '@$1.$2');
      const em = s.match(EMAIL_RE);
      if (em) { found = true; if (!f.email) f.email = em[0].toLowerCase().replace(/^[.\-]+|[.\-]+$/g, ''); s = s.replace(EMAIL_RE, ' '); }
      const urls = s.match(URL_RE);
      if (urls) {
        found = true;
        const u = urls.find(x => /www\.|https?:|\//i.test(x)) || urls.find(x => !/^\d/.test(x));
        if (u && !f.website) f.website = u.replace(/[.)]+$/, '').replace(/^https?:\/\//i, '').toLowerCase();
        s = s.replace(URL_RE, ' ');
      }
      const fixed = fixDigits(s);
      let m, lastEnd = 0, out = '';
      PHONE_RE.lastIndex = 0;
      while ((m = PHONE_RE.exec(fixed))) {
        const num = normPhone(m[0]); if (!num) continue;
        const before = fixed.slice(lastEnd, m.index), after = fixed.slice(m.index + m[0].length, m.index + m[0].length + 12);
        const type = phoneLabel(fixed.slice(0, m.index).slice(-24), after, m[0].replace(/\D/g, ''));
        if (!f.phones.some(p => p.number === num)) f.phones.push({ type, number: num });
        out += before; lastEnd = m.index + m[0].length;
      }
      if (lastEnd) { found = true; s = out + fixed.slice(lastEnd); }
      const took = found;
      L.rest = cleanLine((took ? s.replace(LABEL_WORDS, ' ') : s).replace(/[()|:;,]+\s*$/g, '').replace(/^\W+/, ''));
      if (letters(L.rest) < 2) L.used = true;
    }

    // --- city / state / ZIP, and the street address above it ---
    for (let i = info.length - 1; i >= 0 && !f.zip; i--) {
      const L = info[i]; if (L.used) continue;
      let m, last = null; CSZ_RE.lastIndex = 0;
      while ((m = CSZ_RE.exec(L.rest))) last = m;
      if (!last) continue;
      const st = last[2].replace(/\s+/g, ' ');
      let code = st.length === 2 ? st.toUpperCase() : STATE_NAMES[st.toLowerCase()];
      if (st.length === 2 && (!STATE_ABBR.has(code) || st !== st.toUpperCase())) continue;
      if (!code) continue;
      f.state = code; f.zip = last[3].replace(/\s/g, '');
      let prefix = L.rest.slice(0, last.index + last[1].length).replace(/[,\s]+$/, '').trim();
      let street = '';
      if (prefix.includes(',')) {
        const parts = prefix.split(',').map(x => x.trim()).filter(Boolean);
        f.city = parts.pop() || ''; street = parts.join(', ');
      } else if (/\d/.test(prefix)) {
        const sm = prefix.match(/^(.*\b(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|hwy|highway|ln|lane|way|ct|court|pkwy|parkway|pl|place|cir|circle|loop|fm\s*\d+|suite\s*\w+|ste\.?\s*\w+|box\s*\d+)\.?)\s+([A-Za-z][A-Za-z .'-]*)$/i);
        if (sm) { street = sm[1]; f.city = sm[2]; } else { street = prefix; }
      } else f.city = prefix;
      L.used = true;
      if (!street) {     // up to two address-looking lines directly above
        const above = [];
        for (let j = i - 1; j >= 0 && above.length < 2; j--) {
          const A = info[j]; if (A.used) break;
          if (/^\d/.test(A.rest) || /p\.?\s*o\.?\s*box/i.test(A.rest) || (STREET_RE.test(A.rest) && /\d/.test(A.rest))) { above.unshift(A.rest); A.used = true; }
          else break;
        }
        street = above.join(', ');
      }
      f.address = street.replace(/\s+,/g, ',');
    }
    if (!f.address) {   // no city line found: take a lone street-looking line
      const A = info.find(L => !L.used && (/^\d+\s+\S+/.test(L.rest) && STREET_RE.test(L.rest) || /p\.?\s*o\.?\s*box\s*\d+/i.test(L.rest)));
      if (A) { f.address = A.rest; A.used = true; }
    }
    f.address = f.address.replace(/\bP\.?\s*[O0]\.?\s*(?=Box\b)/i, 'P.O. ');   // OCR: "PO. Box", "P0 Box"

    // --- remaining lines: company, name, title ---
    const cand = info.map((L, i) => ({ ...L, i })).filter(L => !L.used && letters(L.rest) >= 2);
    // company: best-scoring line
    let best = null, bestScore = -99;
    for (const L of cand) {
      const t = L.rest; let sc = 0;
      if (COMPANY_RE.test(t)) sc += 5;
      if (/&/.test(t)) sc += 1;
      if (L.i <= 1) sc += 1.5;
      if (isCaps(t) && t.length > 4) sc += 1;
      if (/^(the)\b/i.test(t)) sc += 0.5;
      if (looksLikeName(t)) sc -= 3;
      if (TITLE_RE.test(t) && !COMPANY_RE.test(t)) sc -= 3;
      if (/\|/.test(t)) sc -= 2;
      if (t.split(/\s+/).length === 1 && !COMPANY_RE.test(t)) sc -= 1;
      if (sc > bestScore) { bestScore = sc; best = L; }
    }
    if (best && bestScore >= 1) { f.company = best.rest.replace(/\s+,/g, ','); best.used = true; }

    // split leftovers into segments ("Name | Title", "Name, Title")
    const segs = [];
    for (const L of cand) {
      if (L.used) continue;
      const parts = L.rest.split(/\s+[|•·\/]\s+|\s{3,}|\s+-\s+|,\s+(?=[A-Za-z])/).map(cleanLine).filter(p => letters(p) >= 2);
      parts.forEach((p, k) => segs.push({ text: p, i: L.i, k }));
    }
    const titles = segs.filter(s => TITLE_RE.test(s.text) && !/\d/.test(s.text) && s.text.split(/\s+/).length <= 7 && !looksLikeName(s.text));
    const local = (f.email.split('@')[0] || '').toLowerCase().replace(/[^a-z]/g, '');
    let bestName = null, bestNS = -99;
    for (const s of segs) {
      if (!looksLikeName(s.text)) continue;
      let sc = 1;
      if (titles.some(t => Math.abs(t.i - s.i) <= 1 && t !== s)) sc += 3;
      const toks = s.text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 1);
      if (local && toks.length >= 2) {
        const first = toks[0], lastN = toks[toks.length - 1];
        if (local.includes(lastN) || local === first + lastN || local === first[0] + lastN || local.includes(first)) sc += 2;
      }
      if (!isCaps(s.text)) sc += 0.5;
      if (s.i === 0 && !f.company) sc -= 0.5;
      if (sc > bestNS) { bestNS = sc; bestName = s; }
    }
    if (bestName) f.name = bestName.text;
    if (titles.length) {
      const pick = bestName ? titles.slice().sort((a, b) => (Math.abs(a.i - bestName.i) + a.k * 0.1) - (Math.abs(b.i - bestName.i) + b.k * 0.1))[0] : titles[0];
      f.title = pick.text;
    }
    // company fallback: an unused, non-name, non-title segment near the top; else the web/email domain
    if (!f.company) {
      const other = segs.find(s => s !== bestName && !titles.includes(s) && letters(s.text) >= 3 && !/\d{3}/.test(s.text));
      if (other && other.i <= 2) f.company = other.text;
      else {
        const dom = (f.website || f.email.split('@')[1] || '').replace(/^www\./, '').split(/[./]/)[0];
        if (dom && !FREEMAIL.test(dom)) f.company = dom.toUpperCase();
      }
    }
    return f;
  }

  // phones array -> the review form's slots
  function phoneSlots(phones) {
    const s = { office: '', cell: '', fax: '', tollfree: '', other: '' }, extra = [];
    for (const p of phones) {
      const t = p.type || '';
      if (t && !s[t]) s[t] = p.number;
      else if (!t && !s.office) s.office = p.number;
      else extra.push(p.number);
    }
    s.other = extra.join(', ');
    return s;
  }

  // fields -> {title, body} in the style of the existing Ram-Gear cards
  function formatCard(f) {
    const up = s => String(s || '').toUpperCase().replace(/[ \t]+/g, ' ').trim();
    const company = up(f.company), name = up(f.name);
    const title = (company || name || 'NEW CARD').slice(0, 39);
    const L = [];
    if (company.length > 39) L.push(company);
    if (company && name === title) {}   // nothing
    String(f.address || '').split(/\n/).map(up).filter(Boolean).forEach(a => L.push(a));
    const csz = [up(f.city), [up(f.state), up(f.zip)].filter(Boolean).join(' ')].filter(Boolean).join(' ');
    if (csz) L.push(csz);
    if (L.length) L.push('');
    const ph = { office: f.office, cell: f.cell, fax: f.fax, tollfree: f.tollfree, other: f.other };
    let who = name;
    if (f.title) who += (who ? ' ' : '') + `(${up(f.title)})`;
    if (who || ph.office) L.push([who, ph.office].filter(Boolean).join('  ') || '');
    if (!who && ph.office) L[L.length - 1] = 'OFFICE  ' + ph.office;
    if (ph.cell) L.push('CELL  ' + ph.cell);
    if (ph.fax) L.push('FAX  ' + ph.fax);
    if (ph.tollfree) L.push('TOLL FREE  ' + ph.tollfree);
    if (ph.other) L.push('PHONE  ' + ph.other);
    if (f.email) L.push(String(f.email).trim().toLowerCase());
    if (f.website) L.push(String(f.website).trim().toLowerCase());
    while (L.length && !L[L.length - 1]) L.pop();
    return { title, body: L.map(l => (l ? '  ' + l : '')).join('\n') + '\n' };
  }

  const Parser = { parseCard, phoneSlots, formatCard, normPhone };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Parser; return; }
  root.CardScanParser = Parser;

  // =====================================================================================
  //  UI: capture -> preprocess -> OCR -> review -> save
  // =====================================================================================
  const TESS_VERSION = '7.0.0';
  const TESS_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/tesseract.min.js`;
  const TESS_SRI = 'sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM';
  const MAX_OCR_SIDE = 2000, MIN_OCR_SIDE = 1200, PHOTO_SIDE = 640;
  const $ = s => document.querySelector(s);
  let api = null, srcCanvas = null, rot = 0, ocrText = '', ocrConf = null, runId = 0, stream = null;
  let tessPromise = null, workerPromise = null, progressCb = null;

  function loadTesseract() {
    if (root.Tesseract) return Promise.resolve();
    if (!tessPromise) tessPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = TESS_URL; s.async = true; s.crossOrigin = 'anonymous'; s.integrity = TESS_SRI;
      s.onload = () => (root.Tesseract ? res() : rej(new Error('OCR engine did not load')));
      s.onerror = () => { s.remove(); rej(new Error('Could not download the OCR engine (are you offline?)')); };
      document.head.append(s);
    }).catch(e => { tessPromise = null; throw e; });
    return tessPromise;
  }
  function withTimeout(p, ms, msg) {
    let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
  }
  function getWorker() {
    if (!workerPromise) workerPromise = withTimeout(loadTesseract().then(() => root.Tesseract.createWorker('eng', 1, {
      logger: m => progressCb && progressCb(m), errorHandler: e => console.warn('OCR worker:', e),
    })), 120000, 'The OCR engine took too long to load (slow or no internet connection).')
      .catch(e => { workerPromise = null; throw e; });
    return workerPromise;
  }
  async function runOCR(canvas, onProgress) {
    const mock = root.CARDSCAN_MOCK_OCR;     // used by tests when the CDN is not reachable
    if (mock != null) { onProgress({ status: 'recognizing text (mock)', progress: 1 }); return { text: typeof mock === 'function' ? await mock(canvas) : String(mock), confidence: null }; }
    progressCb = onProgress;
    try {
      const w = await getWorker();
      const r = await w.recognize(canvas);
      return { text: r.data.text || '', confidence: r.data.confidence };
    } finally { progressCb = null; }
  }

  // ---------- image loading & preprocessing ----------
  async function loadImage(blob) {
    // EXIF orientation: createImageBitmap/drawImage apply it in current browsers ("from-image")
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) {}
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('That file is not an image this browser can read.')); };
      img.style.imageOrientation = 'from-image'; img.src = url;
    });
  }
  function toCanvas(src, maxSide) {
    const w0 = src.width || src.videoWidth, h0 = src.height || src.videoHeight;
    const k = Math.min(1, maxSide / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function rotated(src, deg, maxSide, minSide) {
    const sw = src.width, sh = src.height, swap = deg % 180 !== 0;
    let k = Math.min(1, maxSide / Math.max(sw, sh));
    if (minSide && Math.max(sw, sh) < minSide) k = Math.min(2, minSide / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.round((swap ? sh : sw) * k); c.height = Math.round((swap ? sw : sh) * k);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.translate(c.width / 2, c.height / 2); g.rotate(deg * Math.PI / 180); g.scale(k, k); g.drawImage(src, -sw / 2, -sh / 2);
    return c;
  }
  // grayscale + contrast stretch (2nd..98th percentile); invert light-on-dark cards
  function enhance(c) {
    const g = c.getContext('2d'), im = g.getImageData(0, 0, c.width, c.height), d = im.data, n = d.length / 4;
    const hist = new Uint32Array(256), lum = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; lum[j] = v; hist[lum[j]]++; }
    const pct = p => { let acc = 0; const target = n * p; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; } return 255; };
    const lo = pct(0.02), hi = Math.max(lo + 1, pct(0.98));
    // decide polarity from the central half of the image (where the card usually is)
    let sum = 0, cnt = 0;
    for (let y = c.height >> 2; y < (c.height * 3) >> 2; y += 4) for (let x = c.width >> 2; x < (c.width * 3) >> 2; x += 4) { sum += lum[y * c.width + x]; cnt++; }
    const invert = cnt && sum / cnt < 105;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      let v = (lum[j] - lo) * 255 / (hi - lo); v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (invert) v = 255 - v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(im, 0, 0);
    return { canvas: c, inverted: invert };
  }

  // ---------- dialog ----------
  const FIELDS = ['company', 'name', 'title', 'office', 'cell', 'fax', 'tollfree', 'other', 'email', 'website', 'address', 'city', 'state', 'zip'];
  function step(which) {
    $('#scanCapture').hidden = which !== 'capture';
    $('#scanReview').hidden = which !== 'review';
    $('#scanSave').hidden = which !== 'review';
    $('#scanBack').hidden = which !== 'review';
    $('#dlgScan').dataset.step = which;
  }
  function setError(msg) { const e = $('#scanError'); e.textContent = msg || ''; e.hidden = !msg; $('#scanErrorBtns').hidden = !msg; }
  function setProgress(label, frac) {
    $('#scanProgress').hidden = label == null;
    if (label != null) { $('#scanStatus').textContent = label; const b = $('#scanBar'); if (frac == null) b.removeAttribute('value'); else b.value = frac; }
  }
  const STATUS = {
    'loading tesseract core': 'Loading the OCR engine…', 'initializing tesseract': 'Starting the OCR engine…',
    'loading language traineddata': 'Loading English text data…', 'loaded language traineddata': 'Loading English text data…',
    'initializing api': 'Starting the OCR engine…', 'initialized api': 'Starting the OCR engine…', 'recognizing text': 'Reading the card…',
  };

  function open(appApi) {
    api = appApi; srcCanvas = null; rot = 0; ocrText = ''; ocrConf = null;
    $('#scanKeepPhoto').checked = false;   // default off every time (photos use browser storage)
    stopCam(); setError(''); setProgress(null);
    $('#scanPreviewWrap').hidden = true; $('#scanCam').hidden = true;
    const touch = matchMedia('(pointer: coarse)').matches;
    // phones/tablets: "Take photo" opens the camera app; desktops: choose a file or use the webcam
    $('#scanTake').hidden = !touch;
    $('#scanChoose').classList.toggle('default', !touch);
    $('#scanWebcam').hidden = touch || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    step('capture');
    api.showDialog('#dlgScan', () => { runId++; stopCam(); });
  }
  function stopCam() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } const v = $('#scanVideo'); if (v) v.srcObject = null; }
  async function startCam() {
    setError('');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) {
      setError(e && e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow the camera for this site, or use "Choose image…".'
        : 'No camera is available on this device. Use "Choose image…" to pick a photo instead.');
      return;
    }
    const v = $('#scanVideo'); v.srcObject = stream; $('#scanCam').hidden = false; $('#scanPreviewWrap').hidden = true;
    try { await v.play(); } catch (e) {}
  }
  function snap() {
    const v = $('#scanVideo'); if (!v.videoWidth) return;
    const c = toCanvas(v, MAX_OCR_SIDE); stopCam(); $('#scanCam').hidden = true;
    useCanvas(c);
  }
  async function useFile(file) {
    if (!file) return;
    setError(''); setProgress('Opening photo…', null);
    try { const img = await loadImage(file); useCanvas(toCanvas(img, MAX_OCR_SIDE)); if (img.close) img.close(); }
    catch (e) { setProgress(null); setError(e.message || 'Could not open that image.'); }
  }
  function useCanvas(c) { srcCanvas = c; rot = 0; showPreview(); recognize(); }
  function showPreview() {
    const p = $('#scanPreview'), r = rotated(srcCanvas, rot, 900);
    p.width = r.width; p.height = r.height; p.getContext('2d').drawImage(r, 0, 0);
    $('#scanPreviewWrap').hidden = false;
  }
  async function recognize() {
    const my = ++runId; setError('');
    const t0 = performance.now();
    setProgress('Preparing photo…', null);
    await new Promise(r => setTimeout(r, 20));
    const prep = enhance(rotated(srcCanvas, rot, MAX_OCR_SIDE, MIN_OCR_SIDE));
    try {
      const r = await runOCR(prep.canvas, m => {
        if (my !== runId) return;
        setProgress(STATUS[m.status] || (m.status ? m.status[0].toUpperCase() + m.status.slice(1) + '…' : 'Working…'), typeof m.progress === 'number' ? m.progress : null);
      });
      if (my !== runId) return;
      ocrText = r.text; ocrConf = r.confidence;
      $('#dlgScan').dataset.ocrMs = String(Math.round(performance.now() - t0));
      setProgress(null);
      if (!ocrText.trim()) { setError('No text was found in that photo. Try again closer, in good light, with the card filling the frame (or rotate it).'); return; }
      review(CardScanParser.parseCard(ocrText));
    } catch (e) {
      if (my !== runId) return;
      setProgress(null);
      setError((e && e.message ? e.message : String(e)) + '\nYou can try again, or type the details in yourself.');
    }
  }

  function review(f) {
    const slots = CardScanParser.phoneSlots(f.phones || []);
    const vals = Object.assign({}, f, slots);
    for (const k of FIELDS) $('#sf_' + k).value = vals[k] || '';
    $('#scanRaw').value = ocrText;
    $('#scanConf').textContent = ocrConf == null ? '' : `OCR confidence ${Math.round(ocrConf)}%`;
    const thumb = $('#scanThumb');
    if (srcCanvas) { const r = rotated(srcCanvas, rot, 520); thumb.width = r.width; thumb.height = r.height; thumb.getContext('2d').drawImage(r, 0, 0); thumb.hidden = false; }
    else thumb.hidden = true;
    $('#scanKeepPhoto').disabled = !srcCanvas; if (!srcCanvas) $('#scanKeepPhoto').checked = false;
    // target file picker: current file by default
    const sel = $('#scanTarget'); sel.innerHTML = '';
    api.files().forEach((file, i) => sel.append(new Option(`${file.name} (${file.cards.length})`, String(i))));
    sel.append(new Option('➕ New card file…', 'new'));
    const cur = api.defaultFileIndex(); sel.value = cur == null ? '0' : String(cur);
    $('#scanNewFileRow').hidden = true; $('#scanNewFileLbl').hidden = true; $('#scanNewFile').value = '';
    $('#scanIndex').dataset.touched = '';
    updatePreview();
    step('review');
    $('#sf_company').focus();
  }
  function readFields() { const f = {}; for (const k of FIELDS) f[k] = $('#sf_' + k).value.trim(); return f; }
  function updatePreview() {
    const card = CardScanParser.formatCard(readFields());
    const ix = $('#scanIndex');
    if (!ix.dataset.touched) ix.value = card.title;
    $('#scanCardPreview').textContent = card.body;
  }
  function manual() { ocrText = ''; ocrConf = null; review(CardScanParser.parseCard('')); }
  function photoImage() {
    if (!srcCanvas || !$('#scanKeepPhoto').checked) return null;
    const c = rotated(srcCanvas, rot, PHOTO_SIDE);
    return { src: c.toDataURL('image/jpeg', 0.72), kind: 'Scanned business card photo', width: c.width, height: c.height };
  }
  function save() {
    const f = readFields(), card = CardScanParser.formatCard(f);
    const title = ($('#scanIndex').value.trim() || card.title).toUpperCase().slice(0, 39);
    const tv = $('#scanTarget').value;
    let target;
    if (tv === 'new') {
      const nm = $('#scanNewFile').value.trim();
      if (!nm) { $('#scanNewFile').focus(); $('#scanNewFile').setCustomValidity('Type a name for the new card file'); $('#scanNewFile').reportValidity(); return; }
      target = { newFileName: nm };
    } else target = { fileIndex: +tv };
    const image = photoImage();
    $('#dlgScan').close('ok');
    api.addCard(Object.assign(target, { title, body: card.body, image }));
  }

  function wire() {
    const d = $('#dlgScan'); if (!d || d.dataset.wired) return; d.dataset.wired = '1';
    $('#scanTake').onclick = () => $('#scanFileCam').click();
    $('#scanChoose').onclick = () => $('#scanFile').click();
    $('#scanWebcam').onclick = startCam;
    $('#scanSnap').onclick = snap;
    $('#scanCamStop').onclick = () => { stopCam(); $('#scanCam').hidden = true; };
    $('#scanManual').onclick = manual;
    $('#scanManual2').onclick = manual;
    $('#scanRetry').onclick = () => (srcCanvas ? recognize() : $('#scanFile').click());
    for (const id of ['#scanFileCam', '#scanFile']) $(id).addEventListener('change', e => { const fl = e.target.files[0]; e.target.value = ''; useFile(fl); });
    $('#scanRotL').onclick = () => { if (!srcCanvas) return; rot = (rot + 270) % 360; showPreview(); recognize(); };
    $('#scanRotR').onclick = () => { if (!srcCanvas) return; rot = (rot + 90) % 360; showPreview(); recognize(); };
    $('#scanBack').onclick = () => { setError(''); step('capture'); };
    $('#scanSave').onclick = save;
    $('#scanReparse').onclick = () => { ocrText = $('#scanRaw').value; review(CardScanParser.parseCard(ocrText)); };
    $('#scanTarget').onchange = () => { const n = $('#scanTarget').value === 'new'; $('#scanNewFileRow').hidden = !n; $('#scanNewFileLbl').hidden = !n; if (n) $('#scanNewFile').focus(); };
    $('#scanNewFile').oninput = () => $('#scanNewFile').setCustomValidity('');
    $('#scanIndex').oninput = () => { $('#scanIndex').dataset.touched = '1'; };
    for (const k of FIELDS) $('#sf_' + k).addEventListener('input', updatePreview);
    // Enter in a field must not trigger the form's only submit button (Cancel)
    $('#scanForm').addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      if (d.dataset.step === 'review' && (e.ctrlKey || e.metaKey)) save();
    });
    // dropping or pasting an image also works
    d.addEventListener('dragover', e => { if (d.dataset.step === 'capture') e.preventDefault(); });
    d.addEventListener('drop', e => { if (d.dataset.step !== 'capture') return; e.preventDefault(); const fl = [...(e.dataTransfer.files || [])].find(x => /^image\//.test(x.type)); if (fl) useFile(fl); });
    d.addEventListener('paste', e => { if (d.dataset.step !== 'capture') return; const it = [...(e.clipboardData.items || [])].find(x => /^image\//.test(x.type)); if (it) useFile(it.getAsFile()); });
  }

  root.CardScan = { open: a => { wire(); open(a); }, version: TESS_VERSION, _debug: () => ({ ocrText, ocrConf, rot, hasPhoto: !!srcCanvas }) };
})(typeof window !== 'undefined' ? window : globalThis);
