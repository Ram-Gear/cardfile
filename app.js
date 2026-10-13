/* Cardfile for the browser: recreates the Windows 3.1 Cardfile workflow for Ram-Gear's card files.
 * Plain JS, no build step. Cards come from the shared Supabase table after sign-in; localStorage is the
 * offline cache. The app ships no card data. */
(function () {
  'use strict';
  const LS_KEY = 'ramgear-cardfile-v1';
  const LS_PREFS = 'ramgear-cardfile-prefs';
  const ALL = 'ALL';
  const MAX_BEHIND = 7;
  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };

  // ---------------- state ----------------
  let state = { files: [], cur: 0, view: 'card' };
  let pos = 0;                 // index into current sorted list
  let frontSnap = null;        // {id,title,body} when card came to front (for Restore)
  let editSnapTaken = false;   // undo snapshot taken for current body-edit session
  let undoStack = [];
  let findParams = { text: '', matchCase: false, up: false };
  let prefs = { areaCode: '361', fixedFont: false };
  let nextId = 1;
  const newId = () => 'c' + (nextId++);

  function sortKey(t) { return (t || '').trim().toLowerCase(); }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function cmpCards(a, b) { return collator.compare(sortKey(a.title), sortKey(b.title)) || collator.compare(a.title, b.title); }
  function sortFile(f) { f.cards.sort(cmpCards); }
  const SYNC = () => (window.CardSync && CardSync.configured ? CardSync : null);
  const linkedCard = c => !!(SYNC() && CardSync.isLinked(c));
  const goneCard = c => !!(SYNC() && CardSync.isGone(c));
  const showNotes = c => !!SYNC() || !!(c && c.notes);
  function sortFiles() { state.files.sort((a, b) => (b.builtin === 'customers') - (a.builtin === 'customers') || collator.compare(a.name, b.name)); }

  function initFiles(files) {
    for (const f of files) { for (const c of f.cards) c.id = c.id || newId(); sortFile(f); }
    for (const f of files) for (const c of f.cards) { const n = parseInt(String(c.id).slice(1), 10); if (n >= nextId) nextId = n + 1; }
    return files;
  }
  function loadSeed() { return []; }   // no built-in cards: they come from Supabase after sign-in (or File > Import)
  function load() {
    try { Object.assign(prefs, JSON.parse(localStorage.getItem(LS_PREFS) || '{}')); } catch (e) {}
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { saved = null; }
    if (saved && Array.isArray(saved.files)) { state = { files: initFiles(saved.files), cur: saved.cur ?? 0, view: saved.view || 'card' }; pos = saved.pos || 0; }
    else { state = { files: loadSeed(), cur: 0, view: 'card' }; pos = 0; }
    if (state.cur !== ALL && !state.files[state.cur]) state.cur = 0;
  }
  let saveTimer = null;
  function save(now) {
    $('#saveState').textContent = 'Saving…';
    clearTimeout(saveTimer);
    const doit = () => {
      try {
        if (SYNC()) CardSync.localChanged();
        localStorage.setItem(LS_KEY, JSON.stringify({ files: state.files, cur: state.cur, view: state.view, pos, savedAt: new Date().toISOString() }));
        $('#saveState').textContent = 'Saved in this browser';
      } catch (e) { $('#saveState').textContent = 'NOT SAVED'; message('Could not save changes in this browser (storage full or disabled).\nUse File > Export to keep a copy.\n\n' + e.message); }
    };
    if (now) doit(); else saveTimer = setTimeout(doit, 400);
  }
  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ files: state.files, cur: state.cur, view: state.view, pos, savedAt: new Date().toISOString() })); } catch (e) {}
  }
  function savePrefs() { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); }

  // ---------------- list helpers ----------------
  function curFile() { return state.cur === ALL ? null : state.files[state.cur]; }
  function list() {
    if (state.cur === ALL) {
      const out = [];
      state.files.forEach(f => f.cards.forEach(c => out.push({ file: f, card: c })));
      out.sort((a, b) => cmpCards(a.card, b.card) || collator.compare(a.file.name, b.file.name));
      return out;
    }
    const f = curFile();
    return f ? f.cards.map(c => ({ file: f, card: c })) : [];
  }
  function curEntry() { const L = list(); if (!L.length) return null; pos = ((pos % L.length) + L.length) % L.length; return L[pos]; }
  function indexOfId(id) { return list().findIndex(e => e.card.id === id); }
  function fileLabel(f) { if (!f) return '(no cards)'; const sf = f.sourceFile || ''; return sf && sf.replace(/\.[^.]*$/, '').toUpperCase() === f.name ? sf : f.name + '.CRD'; }

  // ---------------- undo ----------------
  function pushUndo(desc) {
    undoStack.push({ desc, files: JSON.stringify(state.files), cur: state.cur, id: curEntry()?.card.id });
    if (undoStack.length > 40) undoStack.shift();
    updateMenus();
  }
  function undo() {
    const u = undoStack.pop();
    if (!u) return;
    state.files = initFiles(JSON.parse(u.files)); state.cur = u.cur;
    const i = indexOfId(u.id); pos = i >= 0 ? i : 0;
    bringFront(); save(); render();
  }

  // ---------------- navigation ----------------
  function bringFront() {
    const e = curEntry();
    frontSnap = e ? { id: e.card.id, title: e.card.title, body: e.card.body } : null;
    editSnapTaken = false;
  }
  function go(i, focusBody) {
    const L = list(); if (!L.length) return;
    pos = ((i % L.length) + L.length) % L.length;
    bringFront(); render();
    if (focusBody) focusText();
    save();
  }
  const next = () => go(pos + 1, isTextFocused());
  const prev = () => go(pos - 1, isTextFocused());
  function isTextFocused() { return document.activeElement && document.activeElement.id === 'bodyText'; }
  function focusText() { const t = $('#bodyText'); if (t) t.focus(); }
  function jumpLetter(ch) {
    ch = ch.toLowerCase();
    const L = list();
    const i = L.findIndex(e => sortKey(e.card.title).startsWith(ch));
    if (i >= 0) go(i);
  }
  function switchFile(cur, keepId) {
    state.cur = cur; pos = 0;
    if (keepId) { const i = indexOfId(keepId); if (i >= 0) pos = i; }
    undoStack = [];
    bringFront(); save(); render();
  }

  // ---------------- rendering ----------------
  function render() {
    const f = curFile(), L = list(), e = curEntry();
    $('#appTitle').textContent = 'Cardfile - ' + (state.cur === ALL ? '(All files)' : fileLabel(f));
    document.title = (state.cur === ALL ? 'All files' : f ? f.name : 'No cards') + ' - Cardfile';
    $('#viewName').textContent = state.view === 'card' ? 'Card View' : 'List View';
    $('#cardCount').textContent = L.length === 1 ? '1 Card' : L.length + ' Cards';
    renderPicker(); renderLetters(L);
    const chip = $('#shareChip');
    if (chip) { const f = curFile(); chip.hidden = !SYNC() || !f; if (f && SYNC()) { const sh = CardSync.isShared(f); chip.textContent = sh ? (CardSync.isCustomers(f) ? '⇄ Always shared with QC' : '⇄ Shared with QC') : 'Not shared'; chip.className = sh ? 'on' : 'off'; chip.title = CardSync.shareAll() && !CardSync.isCustomers(f) ? 'All card files are shared with the QC app.' : CardSync.isCustomers(f) ? 'The Customers file is always shared with the QC app.' : 'File › Share with QC turns sharing ' + (sh ? 'off' : 'on') + ' for this file.'; } }
    $('#cardView').classList.toggle('fixedfont', !!prefs.fixedFont);
    $('#printArea').classList.toggle('fixedfont', !!prefs.fixedFont);
    $('#cardView').hidden = state.view !== 'card';
    $('#listView').hidden = state.view !== 'list';
    if (state.view === 'card') renderCards(L, e); else renderList(L);
    updateMenus();
  }
  function renderPicker() {
    const sel = $('#filePicker');
    const want = state.files.length + 1;
    if (sel.options.length !== want || sel.dataset.sig !== state.files.map(f => f.name + f.cards.length + (f.shared ? 's' : '')).join()) {
      sel.innerHTML = '';
      sel.append(el('option', { value: ALL, text: '(All files) — ' + state.files.reduce((n, f) => n + f.cards.length, 0) + ' cards' }));
      state.files.forEach((f, i) => sel.append(el('option', { value: i, text: `${f.name} (${f.cards.length})` + (SYNC() && CardSync.isShared(f) ? '  ⇄ QC' : '') })));
      sel.dataset.sig = state.files.map(f => f.name + f.cards.length + (f.shared ? 's' : '')).join();
    }
    sel.value = String(state.cur);
  }
  function renderLetters(L) {
    const bar = $('#letterbar'); bar.innerHTML = '';
    const have = new Set(L.map(e => sortKey(e.card.title)[0]));
    for (const ch of '#ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const has = ch === '#' ? [...have].some(c => c && !/[a-z]/.test(c)) : have.has(ch.toLowerCase());
      bar.append(el('button', { text: ch, disabled: !has, title: 'Jump to first card starting with ' + ch, onclick: () => {
        if (ch === '#') { const i = list().findIndex(e => !/^[a-z]/.test(sortKey(e.card.title))); if (i >= 0) go(i); }
        else jumpLetter(ch);
      } }));
    }
  }
  function phoneMatches(text) {
    const re = /(?:\+?1[-. ]?)?(?:\(\d{3}\)\s*|\b\d{3}[-. /])?\b\d{3}[-. ]\d{4}\b/g;
    const out = []; let m;
    while ((m = re.exec(text))) out.push(m[0].trim());
    return [...new Set(out)];
  }
  function telHref(num) {
    let d = num.replace(/\D/g, '');
    if (d.length === 7 && prefs.areaCode) d = prefs.areaCode + d;
    return 'tel:' + d;
  }
  // Stack geometry: every back card is a full-size copy of the front card's outline, offset up/right so
  // its index line shows above the next card. How many back cards we show depends on the window size.
  let stackRO = null, stackK = -1;
  function stackGeom() {
    const narrow = window.innerWidth < 600;
    return narrow ? { narrow, offX: 6, offY: 30, minK: 2, maxK: 3 } : { narrow, offX: 18, offY: 34, minK: 3, maxK: MAX_BEHIND };
  }
  function fitBehind(L, H, W) {
    const g = stackGeom(), ws = $('#workspace'), cv = $('#cardView'), cs = getComputedStyle(cv);
    const availH = ws.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const availW = cv.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let fit = Math.floor((availH - H) / g.offY);
    if (!g.narrow) fit = Math.min(fit, Math.floor((availW - W) / g.offX));
    return Math.max(0, Math.min(L.length - 1, g.maxK, Math.max(g.minK, fit)));
  }
  function renderCards(L, e) {
    const cv = $('#cardView'); cv.innerHTML = '';
    if (stackRO) { stackRO.disconnect(); stackRO = null; }
    if (!e) { stackK = -1; cv.append(el('div', { class: 'empty', text: state.files.length ? 'This file has no cards. Use Card > Add (F7) to create one.' : 'No cards yet. Sign in to load the shared cards, or use File > Import .CRD.' })); return; }
    const g = stackGeom(), { offX, offY } = g;
    const stack = el('div', { class: 'stack' });
    // front card first, so we can measure its real size (text area, picture, phone bar)
    const c = e.card;
    const front = el('div', { class: 'card front' + (c.image && c.image.src && !isBig(c) ? ' hasimg' : ''), style: 'left:0; top:0; z-index:20' });
    const linked = linkedCard(c), gone = goneCard(c);
    const tbar = el('div', { class: 'ctitle', title: linked ? 'Linked to a QC customer: edit the name and text in the QC app' : 'Double-click to edit the index line (F6)', ondblclick: openIndex },
      el('span', { class: 't', text: c.title || ' ' }),
      linked ? el('span', { class: 'qcbadge', text: 'Linked to QC customer' }) : null,
      gone ? el('span', { class: 'qcbadge gone', text: 'No longer in QC', title: 'This customer was removed in QC. The card is kept here because it has your notes.' }) : null,
      state.cur === ALL ? el('span', { class: 'filetag', text: e.file.name }) : null);
    const body = el('div', { class: 'cbody' });
    if (c.image && c.image.src) body.append(el('img', { class: 'cimg' + (isBig(c) ? ' big' : ''), src: c.image.src, alt: c.image.kind || 'picture', title: c.image.kind || '' }));
    const ta = el('textarea', { id: 'bodyText', spellcheck: 'false', 'aria-label': 'Card text', readonly: linked });
    ta.value = c.body;
    if (linked) body.append(el('div', { class: 'qchint', text: 'Name and card text come from the QC app (edit them there). Your notes below are yours and sync to every device.' }));
    ta.addEventListener('input', () => {
      if (!editSnapTaken) { const v = ta.value; ta.value = c.body; pushUndo('Typing'); ta.value = v; editSnapTaken = true; }
      c.body = ta.value; save(); updatePhones(front, c);
    });
    body.append(ta);
    if (showNotes(c)) {
      const nt = el('textarea', { id: 'notesText', spellcheck: 'true', rows: '3', 'aria-label': 'My notes', placeholder: CardSync && CardSync.isShared && SYNC() && CardSync.isShared(e.file) ? 'Add your notes… (synced with QC)' : 'Add your notes… (kept in this browser)' });
      nt.value = c.notes || '';
      nt.addEventListener('input', () => {
        if (!editSnapTaken) { const v = nt.value; nt.value = c.notes || ''; pushUndo('Notes'); nt.value = v; editSnapTaken = true; }
        c.notes = nt.value; save();
      });
      body.append(el('div', { class: 'notes' }, el('label', { for: 'notesText', text: 'My notes' }), nt));
    }
    front.append(tbar, body);
    updatePhones(front, c);
    // narrow screens: the card fills the width left over after the back cards' right-hand offsets
    const k0 = Math.min(L.length - 1, g.maxK);
    cv.style.setProperty('--card-w', g.narrow ? `calc(100vw - ${24 + k0 * offX}px)` : '');
    stack.append(front); cv.append(stack);
    const H = front.offsetHeight, W = front.offsetWidth;
    const k = fitBehind(L, H, W);
    stackK = k;
    if (g.narrow && k !== k0) cv.style.setProperty('--card-w', `calc(100vw - ${24 + k * offX}px)`);
    // back cards, furthest first, each the same size as the front card
    const behind = [];
    for (let j = k; j >= 1; j--) {
      const be = L[(pos + j) % L.length];
      const card = el('div', { class: 'card behind', title: 'Bring this card to the front', onclick: () => go(pos + j),
        style: `left:${j * offX}px; top:${(k - j) * offY}px; z-index:${10 - j}; height:${H}px` },
        el('div', { class: 'ctitle' },
          el('span', { class: 't', text: be.card.title || ' ' }),
          state.cur === ALL ? el('span', { class: 'filetag', text: be.file.name }) : null));
      behind.push(card);
    }
    stack.prepend(...behind);
    front.style.top = (k * offY) + 'px';
    const sync = () => {
      const h = front.offsetHeight;
      behind.forEach(b => { b.style.height = h + 'px'; });
      stack.style.height = (k * offY + h) + 'px';
      stack.style.width = (k * offX + front.offsetWidth) + 'px';
    };
    sync();
    // keep the back cards matched if the front card grows/shrinks (text area resized, picture loads)
    if (window.ResizeObserver) { stackRO = new ResizeObserver(sync); stackRO.observe(front); }
  }
  function isBig(c) { return c.image && /TPictureObject|photo/i.test(c.image.kind || ''); }
  function updatePhones(front, c) {
    let p = front.querySelector('.phones');
    const nums = phoneMatches(c.title + '\n' + c.body);
    if (!nums.length) { if (p) p.remove(); return; }
    if (!p) { p = el('div', { class: 'phones' }); front.append(p); }
    p.innerHTML = ''; p.append(el('span', { text: 'Call:' }));
    nums.forEach(n => p.append(el('a', { href: telHref(n), text: n, title: 'Call ' + telHref(n).slice(4) })));
  }
  function renderList(L) {
    const ul = $('#cardList'); ul.innerHTML = '';
    L.forEach((e, i) => {
      const li = el('li', { role: 'option', class: i === pos ? 'sel' : '', 'aria-selected': i === pos ? 'true' : 'false',
        onclick: () => { pos = i; bringFront(); renderList(list()); save(); },
        ondblclick: () => { pos = i; bringFront(); setView('card'); } },
        el('span', { class: 't', text: e.card.title || ' ' }),
        linkedCard(e.card) ? el('span', { class: 'qcbadge small', text: 'QC', title: 'Linked to QC customer' }) : null,
        goneCard(e.card) ? el('span', { class: 'qcbadge small gone', text: 'gone', title: 'No longer in QC' }) : null,
        state.cur === ALL ? el('span', { class: 'filetag', text: e.file.name }) : null);
      ul.append(li);
    });
    const sel = ul.children[pos]; if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function setView(v) { state.view = v; render(); save(); if (v === 'list') $('#cardList').focus(); }

  // ---------------- dialogs ----------------
  function showDialog(id, onClose, modeless) {
    const d = $(id);
    const handler = () => { d.removeEventListener('close', handler); onClose && onClose(d.returnValue); };
    d.returnValue = '';
    d.addEventListener('close', handler);
    modeless ? d.show() : d.showModal();
    return d;
  }
  function message(text) { $('#confirmText').textContent = text; $('#confirmCancel').hidden = true; showDialog('#dlgConfirm', () => { $('#confirmCancel').hidden = false; }); }
  function confirmBox(text, okLabel = 'OK') {
    return new Promise(res => { $('#confirmText').textContent = text; $('#confirmOk').textContent = okLabel; $('#confirmCancel').hidden = false;
      showDialog('#dlgConfirm', v => { $('#confirmOk').textContent = 'OK'; res(v === 'ok'); }); });
  }
  function promptBox(title, label, value = '', maxlength) {
    return new Promise(res => {
      $('#promptTitle').textContent = title; $('#promptLabel span').textContent = label;
      const inp = $('#promptInput'); inp.value = value; maxlength ? inp.setAttribute('maxlength', maxlength) : inp.removeAttribute('maxlength');
      showDialog('#dlgPrompt', v => res(v === 'ok' ? inp.value : null)); inp.select();
    });
  }
  function openIndex() {
    const e = curEntry(); if (!e) return;
    if (linkedCard(e.card)) { message('This card is linked to a QC customer, so its name comes from the QC app. Change it there; it updates here on the next sync.'); return; }
    const inp = $('#indexInput'); inp.value = e.card.title;
    showDialog('#dlgIndex', v => {
      if (v !== 'ok' || inp.value === e.card.title) return;
      pushUndo('Index'); e.card.title = inp.value.slice(0, 39); sortFile(e.file);
      pos = indexOfId(e.card.id); if (frontSnap) frontSnap.title = frontSnap.title; save(); render();
    });
    inp.select();
  }
  function openAdd() {
    const inp = $('#addInput'); inp.value = '';
    const row = $('#addFileRow'), fs = $('#addFile');
    if (state.cur === ALL) {
      row.hidden = false; fs.innerHTML = '';
      state.files.forEach((f, i) => fs.append(el('option', { value: i, text: f.name })));
      const e = curEntry(); if (e) fs.value = String(state.files.indexOf(e.file));
    } else row.hidden = true;
    showDialog('#dlgAdd', v => {
      if (v !== 'ok') return;
      let f = state.cur === ALL ? state.files[+fs.value] : curFile();
      if (!f && !state.files.length) { f = addFile({ name: 'CARDS', sourceFile: 'CARDS.CRD', format: 'MGC', cards: [] }); state.cur = state.files.indexOf(f); }
      if (!f) return;
      pushUndo('Add');
      const c = { id: newId(), title: inp.value.slice(0, 39), body: '' };
      f.cards.push(c); sortFile(f); pos = indexOfId(c.id); bringFront(); save(); setViewIfList(); render(); focusText();
    });
    inp.focus();
  }
  // ---------------- scan business card (scan.js does the camera/OCR/review part) ----------------
  function scanCard() {
    if (!window.CardScan) { message('The business card scanner (scan.js) did not load.'); return; }
    CardScan.open({
      files: () => state.files,
      defaultFileIndex: () => { if (state.cur !== ALL) return state.cur; const e = curEntry(); return e ? state.files.indexOf(e.file) : 0; },
      showDialog,
      addCard: ({ fileIndex, newFileName, title, body, image }) => {
        pushUndo('Scan card');
        let f;
        if (newFileName) {
          const n = uniqueName(newFileName);
          f = { name: n, sourceFile: n + '.CRD', format: 'new', modified: new Date().toISOString().slice(0, 10), cards: [] };
          state.files.push(f); sortFiles();
        } else f = state.files[fileIndex] || curFile() || state.files[0];
        const c = { id: newId(), title: String(title || '').slice(0, 39), body: body || '' };
        if (image) c.image = image;
        f.cards.push(c); sortFile(f);
        if (state.cur !== ALL) { state.cur = state.files.indexOf(f); undoStack = undoStack.slice(-40); }
        pos = indexOfId(c.id); bringFront(); setViewIfList(); save(); render();
      },
    });
  }
  function setViewIfList() { if (state.view === 'list') state.view = 'card'; }
  async function deleteCard() {
    const e = curEntry(); if (!e) return;
    if (linkedCard(e.card)) { message('This card is linked to a QC customer. Remove the customer in the QC app instead; your notes are kept here if you wrote any.'); return; }
    if (!(await confirmBox(`Delete "${e.card.title.trim()}"?`))) return;
    pushUndo('Delete');
    e.file.cards.splice(e.file.cards.indexOf(e.card), 1);
    const n = list().length; if (pos >= n) pos = 0;
    bringFront(); save(); render();
  }
  function duplicateCard() {
    const e = curEntry(); if (!e) return;
    pushUndo('Duplicate');
    const c = JSON.parse(JSON.stringify(e.card)); c.id = newId(); delete c.sync;
    e.file.cards.splice(e.file.cards.indexOf(e.card) + 1, 0, c); sortFile(e.file);
    pos = indexOfId(c.id); bringFront(); save(); render();
  }
  function restoreCard() {
    const e = curEntry(); if (!e || !frontSnap || frontSnap.id !== e.card.id || linkedCard(e.card)) return;
    if (e.card.title === frontSnap.title && e.card.body === frontSnap.body) return;
    pushUndo('Restore');
    e.card.title = frontSnap.title; e.card.body = frontSnap.body; sortFile(e.file); pos = indexOfId(e.card.id);
    editSnapTaken = false; save(); render();
  }
  function openGoto() {
    const inp = $('#gotoInput'); inp.select();
    showDialog('#dlgGoto', v => { if (v === 'ok' && inp.value) gotoText(inp.value); });
    inp.select();
  }
  function gotoText(q) {
    const L = list(), ql = q.toLowerCase();
    for (let j = 1; j <= L.length; j++) {
      const i = (pos + j) % L.length;
      if (L[i].card.title.toLowerCase().includes(ql)) { go(i); return true; }
    }
    for (let j = 1; j <= L.length; j++) {   // nothing in the index lines: try My notes
      const i = (pos + j) % L.length;
      if ((L[i].card.notes || '').toLowerCase().includes(ql)) { go(i); return true; }
    }
    message(`Cannot find "${q}".`); return false;
  }
  function openFind() {
    const inp = $('#findInput'); inp.value = findParams.text; $('#findCase').checked = findParams.matchCase;
    document.querySelector(`input[name=findDir][value=${findParams.up ? 'up' : 'down'}]`).checked = true;
    const d = $('#dlgFind'); if (!d.open) d.show(); inp.select(); inp.focus();
  }
  function readFindForm() {
    findParams = { text: $('#findInput').value, matchCase: $('#findCase').checked, up: document.querySelector('input[name=findDir]:checked').value === 'up' };
  }
  function findNext() {
    if (!findParams.text) { openFind(); return; }
    const L = list(); if (!L.length) return;
    const norm = s => findParams.matchCase ? s : s.toLowerCase();
    const q = norm(findParams.text);
    const ta = $('#bodyText'), nt = $('#notesText'), inNotes = nt && document.activeElement === nt;
    const off = inNotes ? L[pos].card.body.length + 2 : 0, box = inNotes ? nt : ta;
    const caretEnd = box && state.view === 'card' ? box.selectionEnd + off : 0;
    const caretStart = box && state.view === 'card' ? box.selectionStart + off : 0;
    const textOf = c => c.body + '\n\u0001' + (c.notes || '');
    // current card first (after/before caret), then other cards, then wrap to current card
    const cur = norm(textOf(L[pos].card));
    let hit = -1;
    if (!findParams.up) {
      hit = cur.indexOf(q, caretEnd);
      if (hit >= 0) return selectHit(pos, hit);
      for (let j = 1; j <= L.length; j++) {
        const i = (pos + j) % L.length; const h = norm(textOf(L[i].card)).indexOf(q);
        if (h >= 0 && !(i === pos && h >= caretEnd)) return selectHit(i, h);
      }
    } else {
      hit = caretStart > 0 ? cur.lastIndexOf(q, caretStart - 1) : -1;
      if (hit >= 0) return selectHit(pos, hit);
      for (let j = 1; j <= L.length; j++) {
        const i = ((pos - j) % L.length + L.length) % L.length; const h = norm(textOf(L[i].card)).lastIndexOf(q);
        if (h >= 0) return selectHit(i, h);
      }
    }
    message(`Cannot find "${findParams.text}".`);
  }
  function selectHit(i, h) {
    if (state.view !== 'card') state.view = 'card';
    if (i !== pos) { pos = i; bringFront(); }
    render(); save();
    const card = list()[pos].card, bl = card.body.length;
    let ta = $('#bodyText');
    if (h > bl && $('#notesText')) { ta = $('#notesText'); h -= bl + 2; }
    ta.focus(); ta.setSelectionRange(h, h + findParams.text.length);
    const line = ta.value.slice(0, h).split('\n').length - 1;
    ta.scrollTop = Math.max(0, line * 20 - 40);
  }
  function openDial() {
    const e = curEntry(); if (!e) return;
    const nums = phoneMatches(e.card.title + '\n' + e.card.body);
    const ul = $('#dialList'); ul.innerHTML = '';
    if (!nums.length) ul.append(el('li', {}, el('span', { text: 'No phone numbers found on this card.', style: 'padding:6px;display:block' })));
    nums.forEach(n => ul.append(el('li', {}, el('a', { href: telHref(n) }, el('span', { text: n }), el('span', { class: 'meta', text: telHref(n).slice(4) })))));
    showDialog('#dlgDial');
  }
  function openOpen() {
    const flt = $('#openFilter'); flt.value = '';
    const fill = () => {
      const ul = $('#openList'); ul.innerHTML = ''; const q = flt.value.trim().toLowerCase();
      const items = [{ i: ALL, name: '(All files)', n: state.files.reduce((n, f) => n + f.cards.length, 0), meta: 'search & browse every card' }]
        .concat(state.files.map((f, i) => ({ i, name: fileLabel(f), n: f.cards.length, meta: (f.modified ? 'modified ' + f.modified : (f.format || '')) })));
      for (const it of items) {
        if (q && !it.name.toLowerCase().includes(q)) continue;
        ul.append(el('li', { class: String(it.i) === String(state.cur) ? 'current' : '' },
          el('button', { type: 'button', onclick: () => { $('#dlgOpen').close('ok'); switchFile(it.i); } },
            el('span', { text: it.name }), el('span', { class: 'meta', text: `${it.n} card${it.n === 1 ? '' : 's'} · ${it.meta}` }))));
      }
    };
    flt.oninput = fill; fill();
    showDialog('#dlgOpen'); flt.focus();
  }
  function openSearchAll(q) {
    const inp = $('#searchAllInput'); if (q != null) inp.value = q;
    const run = () => {
      const t = inp.value.trim().toLowerCase(); const ul = $('#searchAllList'); ul.innerHTML = '';
      if (!t) { $('#searchAllCount').textContent = ''; return; }
      let n = 0;
      state.files.forEach((f, fi) => f.cards.forEach(c => {
        const inTitle = c.title.toLowerCase().includes(t), bi = c.body.toLowerCase().indexOf(t), ni = (c.notes || '').toLowerCase().indexOf(t);
        if (!inTitle && bi < 0 && ni < 0) return;
        n++; if (n > 300) return;
        const snip = bi >= 0 ? c.body.slice(Math.max(0, bi - 30), bi + t.length + 40).replace(/\s+/g, ' ')
          : ni >= 0 ? 'My notes: ' + c.notes.slice(Math.max(0, ni - 30), ni + t.length + 40).replace(/\s+/g, ' ') : '';
        ul.append(el('li', {}, el('button', { type: 'button', onclick: () => {
          $('#dlgSearch').close('ok');
          if (state.cur !== ALL) switchFile(fi, c.id); else go(indexOfId(c.id));
          if (bi >= 0) { findParams = { text: inp.value.trim(), matchCase: false, up: false }; selectHit(pos, c.body.toLowerCase().indexOf(t)); }
          else if (ni >= 0 && showNotes(c)) { findParams = { text: inp.value.trim(), matchCase: false, up: false }; selectHit(pos, c.body.length + 2 + c.notes.toLowerCase().indexOf(t)); }
        } }, el('span', { text: `${c.title.trim() || '(no index line)'}  — ${f.name}` }), el('span', { class: 'snip', text: snip }))));
      }));
      $('#searchAllCount').textContent = n ? `${n} matching card${n === 1 ? '' : 's'}${n > 300 ? ' (showing first 300)' : ''}` : 'No matches.';
    };
    inp.oninput = run; run();
    showDialog('#dlgSearch'); inp.focus();
  }

  // ---------------- files: new / import / export / reset ----------------
  function uniqueName(name) {
    let n = name.toUpperCase().replace(/\.CRD$/i, ''), k = 2, base = n;
    while (state.files.some(f => f.name === n)) n = `${base}-${k++}`;
    return n;
  }
  async function newFile() {
    const name = await promptBox('New card file', 'File name:', '', 40);
    if (!name || !name.trim()) return;
    const n = uniqueName(name.trim());
    pushUndo('New file');
    state.files.push({ name: n, sourceFile: n + '.CRD', format: 'new', modified: new Date().toISOString().slice(0, 10), cards: [{ id: newId(), title: '', body: '' }] });
    sortFiles();
    switchFile(state.files.findIndex(f => f.name === n));
  }
  async function deleteFile() {
    const f = curFile(); if (!f) { message('Choose a single card file first (not "All files").'); return; }
    if (f.builtin === 'customers') { message('The Customers file is built in and shared with QC, so it can’t be deleted.'); return; }
    const up = SYNC() && CardSync.isShared(f) ? f.cards.filter(c => c.sync && c.sync.id && !c.sync.linked).length : 0;
    if (!(await confirmBox(`Delete the whole card file "${fileLabel(f)}" and its ${f.cards.length} card(s) from this browser?\n\n(Reset (reload cards) brings the shared canal files back.)` + (up ? `\n\nThis file is shared with QC: its ${up} uploaded card(s) will also be removed from the shared table.` : ''), 'Delete'))) return;
    state.files.splice(state.cur, 1); switchFile(0);
  }
  function importCrdFiles(fileList) {
    const reports = []; let lastIdx = null;
    const jobs = [...fileList].map(file => file.arrayBuffer().then(buf => {
      try {
        const r = CRD.parseCRD(buf);
        const name = uniqueName(file.name.replace(/\.[^.]*$/, ''));
        const f = { name, sourceFile: file.name, format: r.format, modified: new Date(file.lastModified).toISOString().slice(0, 10),
                    cards: r.cards.map(c => Object.assign({ id: newId() }, c)) };
        state.files.push(f); sortFile(f); lastIdx = name;
        reports.push(`${file.name}: ${r.cards.length} card(s) imported as ${name} [${r.format}]` + (r.warnings.length ? `\n   warnings: ${r.warnings.join('; ')}` : ''));
      } catch (e) { reports.push(`${file.name}: ${e.message}`); }
    }));
    Promise.all(jobs).then(() => {
      if (lastIdx) { pushUndo('Import'); sortFiles(); switchFile(state.files.findIndex(f => f.name === lastIdx)); }
      message(reports.join('\n'));
    });
  }
  function download(name, data, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([data], { type })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportJson() {
    const data = { app: 'Ram-Gear Cardfile', exported: new Date().toISOString(), files: state.files.map(f => ({ name: f.name, sourceFile: f.sourceFile, format: f.format, modified: f.modified, ...(f.shared ? { shared: true } : {}), ...(f.builtin ? { builtin: f.builtin } : {}), cards: f.cards.map(({ id, ...c }) => c) })) };
    download(`cardfile-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1), 'application/json');
  }
  function exportCrd() {
    const L = list(); if (!L.length) { message('There are no cards to export.'); return; }
    const cards = L.map(e => e.card);
    const bytes = CRD.writeMGC(cards);
    const name = state.cur === ALL ? 'ALLFILES.CRD' : (curFile().name + '.CRD');
    download(name, bytes, 'application/octet-stream');
    const pics = cards.filter(c => c.image).length;
    const long = cards.filter(c => (c.title || '').length > 39).length;
    if (pics || long) message(`${name} written in Cardfile 3.0 (MGC) format.` + (pics ? `\n${pics} picture(s) were not included (text only).` : '') + (long ? `\n${long} index line(s) were cut to 39 characters.` : ''));
  }
  function importJson(file) {
    file.text().then(async t => {
      let data; try { data = JSON.parse(t); } catch (e) { message('Not a valid backup file: ' + e.message); return; }
      const files = Array.isArray(data) ? data : data.files;
      if (!Array.isArray(files)) { message('Not a Cardfile backup (no "files" list).'); return; }
      if (!(await confirmBox(`Replace ALL card files in this browser with the ${files.length} file(s) from ${file.name}?`, 'Replace'))) return;
      pushUndo('Restore backup');
      state.files = initFiles(files.map(f => ({ ...f, cards: (f.cards || []).map(c => ({ title: c.title || '', body: c.body || '', ...(c.notes ? { notes: c.notes } : {}), ...(c.image ? { image: c.image } : {}), ...(c.sync ? { sync: c.sync } : {}) })) })));
      if (SYNC()) CardSync.resetLocal(true);   // re-pair with the server by remote id; never turns the swap into remote deletes
      sortFiles(); switchFile(0);
      if (SYNC()) CardSync.sync({ full: true, manual: true });
    });
  }
  async function resetData() {
    if (!(await confirmBox('Clear this browser and reload?\n\nThis throws away every card kept in this browser (including imported cards and changes not yet synced).' + (SYNC() ? '\nThe shared cards are downloaded again from the database.' : '') + '\nTip: File > Export Backup (JSON) first if you might want your changes back.', 'Reset'))) return;
    localStorage.removeItem(LS_KEY);
    state = { files: loadSeed(), cur: 0, view: state.view }; pos = 0; undoStack = [];
    if (SYNC()) { CardSync.resetLocal(false); sortFiles(); }   // Customers comes back from the server on the next (full) sync
    bringFront(); save(true); render();
    if (SYNC()) CardSync.sync({ full: true, manual: true });
  }
  async function setAreaCode() {
    const v = await promptBox('Phone settings', 'Area code to add to 7-digit numbers (blank = none):', prefs.areaCode, 3);
    if (v === null) return; prefs.areaCode = v.replace(/\D/g, '').slice(0, 3); savePrefs(); render();
  }

  // ---------------- printing ----------------
  function printCards(entries) {
    const pa = $('#printArea'); pa.innerHTML = '';
    const head = el('div', { class: 'phead' }, el('span', { text: state.cur === ALL ? 'All files' : fileLabel(curFile()) }), el('span', { text: new Date().toLocaleDateString() }));
    pa.append(head);
    for (const e of entries) {
      const c = e.card;
      pa.append(el('div', { class: 'pcard' },
        el('div', { class: 'pt', text: c.title + (state.cur === ALL ? `   [${e.file.name}]` : '') }),
        c.image && c.image.src ? el('img', { src: c.image.src, alt: '' }) : null,
        el('pre', { text: c.body }),
        c.notes ? el('div', { class: 'pnotes' }, el('b', { text: 'My notes: ' }), document.createTextNode(c.notes)) : null));
    }
    setTimeout(() => window.print(), 50);
  }

  // ---------------- menus ----------------
  const MENUS = [
    ['&File', [
      ['&New card file…', newFile], ['&Open…', openOpen, 'Ctrl+O'], ['-'],
      ['&Print', () => { const e = curEntry(); if (e) printCards([e]); }], ['Print A&ll', () => printCards(list())], ['-'],
      ['&Import .CRD file(s)…', () => $('#importCrd').click()],
      ['Export as .&CRD (Cardfile 3.0)', exportCrd], ['Export &Backup (JSON)', exportJson], ['Restore Backup (JSON)…', () => $('#importJson').click()], ['-'],
      ['Phone &settings…', setAreaCode], ['&Delete this card file…', deleteFile], ['&Reset (reload cards)…', resetData],
      ['-', null, '', null, null, () => !SYNC()],
      ['Share with &QC', () => CardSync.toggleShare(curFile()), '', () => !curFile() || curFile().builtin === 'customers', () => !!(SYNC() && CardSync.isShared(curFile())), () => !SYNC() || CardSync.shareAll()],
      ['S&ync with QC now', () => CardSync.sync({ manual: true }), '', () => !CardSync.status().signedIn, null, () => !SYNC()],
      ['Full resync with QC', () => CardSync.fullResync(), '', () => !CardSync.status().signedIn, null, () => !SYNC()],
      ['Sign &in to QC sync…', () => CardSync.openSignIn(), '', null, null, () => !SYNC() || CardSync.status().signedIn],
      ['Sign out of QC sync', () => CardSync.signOut(), '', null, null, () => !SYNC() || !CardSync.status().signedIn]]],
    ['&Edit', [
      ['&Undo', undo, 'Ctrl+Z', () => !undoStack.length], ['-'],
      ['&Index…', openIndex, 'F6', () => !curEntry()], ['&Restore', restoreCard, '', () => !curEntry()]]],
    ['&View', [
      ['&Card', () => setView('card'), '', null, () => state.view === 'card'],
      ['&List', () => setView('list'), '', null, () => state.view === 'list'], ['-'],
      ['&Fixed-width text (aligns columns)', () => { prefs.fixedFont = !prefs.fixedFont; savePrefs(); render(); }, '', null, () => !!prefs.fixedFont]]],
    ['&Card', [
      ['&Add…', openAdd, 'F7'], ['&Delete', deleteCard, '', () => !curEntry()], ['Du&plicate', duplicateCard, '', () => !curEntry()],
      ['Au&todial (call)…', openDial, 'F5', () => !curEntry()], ['-'],
      ['&Scan business card…', scanCard, 'F8']]],
    ['&Search', [
      ['&Go To…', openGoto, 'F4'], ['&Find…', openFind], ['Find &Next', findNext, 'F3'], ['-'],
      ['Search &All Files…', () => openSearchAll(), 'Ctrl+Shift+F']]],
    ['&Help', [['&Keys and Commands', openHelp, 'F1'], ['&About Cardfile…', openAbout]]],
  ];
  const menuEls = [];
  function label(s) { const i = s.indexOf('&'); const frag = document.createDocumentFragment(); if (i < 0) { frag.append(s); return frag; } frag.append(s.slice(0, i), el('u', { text: s[i + 1] }), s.slice(i + 2)); return frag; }
  function buildMenus() {
    const bar = $('#menubar');
    MENUS.forEach(([name, items], mi) => {
      const m = el('div', { class: 'menu' });
      const btn = el('button', { type: 'button', 'aria-haspopup': 'true' }, label(name));
      const ul = el('ul', { role: 'menu' });
      items.forEach(it => {
        if (it[0] === '-') { const li = el('li', {}, el('hr')); li._hidden = it[5]; ul.append(li); return; }
        const b = el('button', { type: 'button', role: 'menuitem' }, el('span', {}, label(it[0])), el('span', { class: 'acc', text: it[2] || '' }));
        b._disabled = it[3]; b._checked = it[4];
        b.addEventListener('click', () => { closeMenus(); it[1](); });
        const li = el('li', {}, b); li._hidden = it[5]; ul.append(li);
      });
      btn.addEventListener('click', ev => { ev.stopPropagation(); const open = m.classList.contains('open'); closeMenus(); if (!open) openMenu(mi); });
      btn.addEventListener('mouseenter', () => { if (menuEls.some(x => x.classList.contains('open')) && !m.classList.contains('open')) { closeMenus(); openMenu(mi); } });
      m.append(btn, ul); bar.append(m); menuEls.push(m);
    });
    document.addEventListener('click', closeMenus);
  }
  function openMenu(i) { updateMenus(); menuEls[i].classList.add('open'); const f = menuEls[i].querySelector('li button:not([disabled])'); f && f.focus(); }
  function closeMenus() { menuEls.forEach(m => m.classList.remove('open')); }
  function updateMenus() {
    document.querySelectorAll('.menu li').forEach(li => { if (li._hidden) li.hidden = !!li._hidden(); });
    document.querySelectorAll('.menu li button').forEach(b => {
      b.disabled = b._disabled ? !!b._disabled() : false;
      if (b._checked) b.classList.toggle('checked', !!b._checked());
    });
  }
  function openHelp() {
    const rows = [['F7', 'Add a card'], ['F8, camera button', 'Scan a business card: photo → text → new card'], ['F6 / double-click title', 'Edit the index line (max 39 characters)'], ['F4', 'Go To: next card whose index line contains the text'],
      ['Search > Find, F3', 'Find text inside cards / Find Next'], ['F5', 'Autodial: call a phone number on the card'], ['PgDn / PgUp, ◀ ▶', 'Next / previous card'],
      ['Ctrl+Home / Ctrl+End', 'First / last card'], ['Ctrl+Shift+letter, A–Z bar', 'Jump to first card starting with that letter (in List view just type the letter)'],
      ['Ctrl+Shift+F, search box', 'Search all files (index lines and card text)'], ['Ctrl+Z (outside the card text)', 'Undo last card operation'], ['Edit > Restore', 'Undo all changes to the card in front since you brought it forward'],
      ['Alt+F / E / V / C / S / H', 'Open a menu']];
    const t = el('table'); rows.forEach(r => t.append(el('tr', {}, el('td', { text: r[0] }), el('td', { text: r[1] }))));
    const b = $('#helpBody'); b.innerHTML = ''; b.append(t, el('p', { class: 'hint', text: 'Changes are saved automatically in this browser only. Use File > Export Backup to move data to another computer.' }));
    showDialog('#dlgHelp');
  }
  function openAbout() {
    const b = $('#helpBody'); b.innerHTML = '';
    const total = state.files.reduce((n, f) => n + f.cards.length, 0);
    b.append(el('p', { text: 'Cardfile for Ram-Gear Manufacturing: a browser rebuild of the Windows 3.1 Cardfile.' }),
      el('p', { text: `${state.files.length} card files, ${total} cards. Data is kept in this browser (localStorage).` }),
      el('p', { class: 'hint', text: 'Original data imported from the shop’s .CRD files (1996–2003).' }));
    showDialog('#dlgHelp');
  }

  // ---------------- keyboard ----------------
  function anyModalOpen() { return [...document.querySelectorAll('dialog')].some(d => d.open && d.id !== 'dlgFind'); }
  document.addEventListener('keydown', ev => {
    if (document.body.classList.contains('locked') && !document.querySelector('dialog[open]')) return;   // signed out: cards hidden
    const k = ev.key;
    if (anyModalOpen()) return;
    const inFind = $('#dlgFind').contains(document.activeElement);
    if (k === 'Escape') { closeMenus(); if ($('#dlgFind').open) $('#dlgFind').close(); return; }
    if (ev.altKey && !ev.ctrlKey && /^[fevcsh]$/i.test(k)) {
      const i = 'fevcsh'.indexOf(k.toLowerCase()); ev.preventDefault(); closeMenus(); openMenu(i); return;
    }
    const fn = { F1: openHelp, F3: () => { if (inFind) readFindForm(); findNext(); }, F4: openGoto, F5: openDial, F6: openIndex, F7: openAdd, F8: scanCard }[k];
    if (fn) { ev.preventDefault(); closeMenus(); fn(); return; }
    if (inFind) return;
    if (k === 'PageDown' && !ev.ctrlKey) { ev.preventDefault(); next(); return; }
    if (k === 'PageUp' && !ev.ctrlKey) { ev.preventDefault(); prev(); return; }
    if (ev.ctrlKey && k === 'Home') { ev.preventDefault(); go(0, isTextFocused()); return; }
    if (ev.ctrlKey && k === 'End') { ev.preventDefault(); go(list().length - 1, isTextFocused()); return; }
    if (ev.ctrlKey && ev.shiftKey && (k === 'F' || k === 'f')) { ev.preventDefault(); openSearchAll(); return; }
    if (ev.ctrlKey && ev.shiftKey && /^Key[A-Z]$/.test(ev.code)) { ev.preventDefault(); jumpLetter(ev.code.slice(3)); return; }
    if (ev.ctrlKey && !ev.shiftKey && (k === 'o' || k === 'O')) { ev.preventDefault(); openOpen(); return; }
    const typing = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName);
    if (ev.ctrlKey && !ev.shiftKey && (k === 'z' || k === 'Z') && !typing) { ev.preventDefault(); undo(); return; }
    if (state.view === 'list' && !typing && !ev.ctrlKey && !ev.altKey) {
      if (k === 'ArrowDown') { ev.preventDefault(); pos = Math.min(pos + 1, list().length - 1); bringFront(); renderList(list()); return; }
      if (k === 'ArrowUp') { ev.preventDefault(); pos = Math.max(pos - 1, 0); bringFront(); renderList(list()); return; }
      if (k === 'Enter') { ev.preventDefault(); setView('card'); return; }
      if (/^[a-z0-9]$/i.test(k)) { jumpLetter(k); return; }
    }
    if (state.view === 'card' && !typing && !ev.ctrlKey && !ev.altKey && k.length === 1) focusText();
  });

  // ---------------- wire up ----------------
  function wire() {
    $('#btnScan').onclick = () => scanCard();
    $('#btnPrev').onclick = () => prev();
    $('#btnNext').onclick = () => next();
    $('#filePicker').onchange = ev => switchFile(ev.target.value === ALL ? ALL : +ev.target.value);
    $('#quickSearchForm').onsubmit = ev => { ev.preventDefault(); openSearchAll($('#quickSearch').value); };
    $('#importCrd').onchange = ev => { if (ev.target.files.length) importCrdFiles(ev.target.files); ev.target.value = ''; };
    $('#importJson').onchange = ev => { if (ev.target.files[0]) importJson(ev.target.files[0]); ev.target.value = ''; };
    $('#findForm').addEventListener('submit', ev => {
      const sub = ev.submitter && ev.submitter.value;
      if (sub === 'find') { ev.preventDefault(); readFindForm(); findNext(); }
    });
    window.addEventListener('afterprint', () => { $('#printArea').innerHTML = ''; });
    window.addEventListener('beforeunload', () => save(true));
  }

  let lastNarrow = window.innerWidth < 600;
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const n = window.innerWidth < 600;
      const front = document.querySelector('.card.front');
      // re-render when crossing the mobile breakpoint, or when the number of back cards that fit changes
      const needK = (state.view === 'card' && front) ? fitBehind(list(), front.offsetHeight, front.offsetWidth) : stackK;
      if (n === lastNarrow && needK === stackK) return;
      lastNarrow = n;
      const ta = $('#bodyText'), had = isTextFocused(), s0 = ta ? ta.selectionStart : 0, s1 = ta ? ta.selectionEnd : 0;
      render();
      if (had) { const t = $('#bodyText'); if (t) { t.focus(); t.setSelectionRange(s0, s1); } }
    }, 120);
  });
  // re-render after a sync without losing the caret in the card text / notes the user may be typing in
  function renderKeep() {
    const a = document.activeElement, id = a && (a.id === 'bodyText' || a.id === 'notesText') ? a.id : null;
    const keepId = curEntry() && curEntry().card.id, s0 = id ? a.selectionStart : 0, s1 = id ? a.selectionEnd : 0;
    if (keepId) { const i = indexOfId(keepId); if (i >= 0) pos = i; }
    if (frontSnap && keepId === frontSnap.id) { const c = curEntry().card; if (linkedCard(c)) { frontSnap.title = c.title; frontSnap.body = c.body; } }
    render();
    if (id) { const t = $('#' + id); if (t && !t.readOnly) { t.focus(); t.setSelectionRange(s0, s1); } }
  }
  function addFile(f) {
    const cur = curFile(); state.files.push(f); sortFiles();
    if (cur) state.cur = state.files.indexOf(cur);
    return f;
  }
  load(); buildMenus(); wire();
  if (window.CardSync) CardSync.init({
    files: () => state.files, addFile, newId, sortFile, persist, render: renderKeep, message, confirm: confirmBox, showDialog, updateMenus, undoable: pushUndo,
  });
  if (SYNC()) { sortFiles(); const c = curFile(); if (c) state.cur = state.files.indexOf(c); }
  bringFront(); render();
  $('#saveState').textContent = localStorage.getItem(LS_KEY) ? 'Saved in this browser' : '';
  window.cardfileApp = { state: () => state, list, go, undo, scanCard, CRD: window.CRD, sync: window.CardSync }; // for testing/debugging
})();
