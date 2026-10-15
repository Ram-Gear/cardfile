/* QC sync: two-way sync of shared card files with the Supabase table the QC app uses (config in config.js).
 *
 * Model (all kept in localStorage, so it works offline):
 *  - file.shared = true (per-file "Share with QC"), file.builtin = 'customers' for the always-shared Customers file.
 *  - card.notes = Gary's notes (synced via the `notes` column; never touched by QC title/body changes).
 *  - card.sync = { id, linked, cid, src, up, base:{t,b,n}, editAt, notesAt, ph, pn, gone, fs, undel }
 *      id      remote row id;   linked  QC-owned (customer_id set): title/body read-only here
 *      up      server updated_at of the row as last seen;   base  title/body/notes as last seen on the server
 *      editAt / notesAt  local time of the last local title/body / notes edit (for last-write-wins)
 *      gone    QC released the card (customer deleted -> customer_id NULL) or the row vanished; kept because it has
 *              notes ("No longer in QC"). With an id it stays tied to its row; without one it is local only.
 *      fs      `file` value last written/seen (only when the table has a file column);  undel  row must be un-deleted
 * Contract: ramgear-app/supabase/migrations/002_customer_cards.sql (soft delete via deleted_at, no DELETE, optional file).
 *  - sync store (LS 'ramgear-cardfile-sync'): watermark, outbox (pending inserts/updates/deletes), registry of remote
 *    ids bound to local cards (to notice local deletes), last sync time / error.
 * Sync = pull (incremental by updated_at watermark, keyset-paged; or full) → merge → push the outbox.
 * Merge: 3-way against `base`. Only when both sides changed the same part, the newer updated_at / local edit time wins.
 * Linked cards: QC's title/body always win; only notes are pushed. Unshared files are never read from or written to.
 */
(function (root) {
  'use strict';
  const LS_SYNC = 'ramgear-cardfile-sync';
  const DEF_COLS = { id: 'id', customerId: 'customer_id', title: 'title', body: 'body', notes: 'notes', source: 'source', createdAt: 'created_at', updatedAt: 'updated_at', deleted: null, deletedAt: 'deleted_at', file: 'file' };
  const RAW = root.CARDFILE_SUPABASE || {};
  const C = Object.assign({ table: 'customer_cards', shareAllFiles: true, clientIds: true, probeFile: true, titleMax: 39, customersFile: 'CUSTOMERS', pageSize: 500, autoSyncDelayMs: 4000, unavailableRetryMs: 10 * 60 * 1000 }, RAW);
  C.columns = Object.assign({}, DEF_COLS, RAW.columns || {});
  C.auth = Object.assign({ method: 'qc', activateFunction: 'rg-admin', storageKey: 'cardfile-sb-auth' }, RAW.auth || {});
  C.lib = Object.assign({}, RAW.lib || {});
  const K = C.columns;
  if (K.deletedAt) K.deleted = null;   // soft delete by timestamp (deleted_at, NULL = live) instead of a boolean flag
  const delMark = () => (K.deletedAt ? { [K.deletedAt]: nowIso() } : K.deleted ? { [K.deleted]: true } : {});
  // `file` column: optional (may be added later). Probed once per session; read and written only if it exists.
  let fileState = null;                                     // null = not checked yet, true = present, false = absent
  const FK = () => (K.file && fileState === true ? K.file : null);
  // value of the `file` column for a card file: the file's own name as Cardfile knows it (source file without .CRD, e.g.
  // 'STEEL', 'ramunit'); the Customers file uses 'Customers' like QC. Compared case-insensitively; NULL means Customers.
  const fileFor = f => (isCustomers(f) ? 'Customers' : String(f.sourceFile || '').replace(/\.[^.]*$/, '') || f.name);
  const sameFile = (val, f) => (val == null || val === '' ? isCustomers(f) : String(val).toLowerCase() === fileFor(f).toLowerCase());
  const clampTitle = t => { const a = Array.from(t || ''); return C.titleMax && a.length > C.titleMax ? a.slice(0, C.titleMax).join('') : t || ''; };
  const liveMark = () => (K.deletedAt ? { [K.deletedAt]: null } : K.deleted ? { [K.deleted]: false } : {});
  const configured = !!(C.url && C.publishableKey && C.lib.url) && !/placeholder|your[_-]?key|x{6}/i.test(C.publishableKey);
  const $ = s => document.querySelector(s);

  let host = null, sb = null, libPromise = null, session = null, running = null, again = false, pushTimer = 0, uiTimer = 0;
  let S = loadStore();
  function loadStore() {
    let s = null; try { s = JSON.parse(localStorage.getItem(LS_SYNC) || 'null'); } catch (e) {}
    return Object.assign({ wm: null, outbox: [], registry: {}, lastSyncAt: null, lastError: '', needFull: false, skipped: 0, stats: null }, s || {});
  }
  // ---------- per-app role (QC Rev 1.9: members.card_role = none | viewer | editor | admin, server default editor) ----------
  // Read once per signed-in user with the card_role() RPC and remembered (S.role / S.roleUser) for reloads and offline use.
  // Until it is known the app behaves like the server default (editor: may edit, may not delete).
  const ROLES = ['none', 'viewer', 'editor', 'admin'];
  const uid = () => (session && session.user && session.user.id) || null;
  const role = () => (configured && S.role && (!uid() || S.roleUser === uid()) ? S.role : 'editor');
  const canView = () => !configured || role() !== 'none';
  const canEdit = () => !configured || role() === 'editor' || role() === 'admin';
  const canDelete = () => !configured || role() === 'admin';
  async function loadRole(cl) {
    const res = await cl.rpc('card_role');
    let r;
    if (res.error) {
      const e = res.error;
      // a server from before Rev 1.9 has no card_role(): behave like the default role
      if (e.code === 'PGRST202' || /could not find the function/i.test(e.message || '')) r = 'editor';
      else { const x = new Error(e.message || 'role'); x.code = e.code; x.status = res.status; throw x; }
    } else r = String(res.data || '').toLowerCase();
    if (!ROLES.includes(r)) r = 'none';
    const was = S.role;
    S.role = r; S.roleUser = uid(); saveStore();
    if (r === 'none') noAccess();
    if (was !== r && host) { host.render(); if (host.updateMenus) host.updateMenus(); }
    return r;
  }
  // role none: nothing may stay in this browser
  function noAccess() {
    S.outbox = []; S.registry = {}; S.tomb = {}; S.wm = null; S.needFull = true; S.stats = null;
    if (host && host.clearAll) host.clearAll();
    saveStore();
  }
  function saveStore() { try { localStorage.setItem(LS_SYNC, JSON.stringify(S)); } catch (e) {} }
  const nowIso = () => new Date().toISOString();
  const ms = t => (t ? Date.parse(t) || 0 : 0);
  function hash(s) { s = String(s); let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + ':' + s.length; }
  const tbHash = c => hash((c.title || '') + '\u0001' + (c.body || ''));
  const nHash = c => hash(c.notes || '');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => { const r = Math.random() * 16 | 0; return (ch === 'x' ? r : (r & 3 | 8)).toString(16); }));

  // ---------- helpers on the app's data ----------
  const files = () => host.files();
  const isCustomers = f => !!f && f.builtin === 'customers';
  const isShared = f => !!f && (isCustomers(f) || !!C.shareAllFiles || !!f.shared);
  const isLinked = c => !!(c && c.sync && c.sync.linked && !c.sync.gone);
  const isGone = c => !!(c && c.sync && c.sync.gone);
  function findById(rid) {
    for (const f of files()) for (const c of f.cards) if (c.sync && c.sync.id === rid) return { f, c };
    return null;
  }
  function findGone(rid) {
    for (const f of files()) for (const c of f.cards) if (c.sync && c.sync.gone && c.sync.goneId === rid) return { f, c };
    return null;
  }
  function findCard(localId) { for (const f of files()) for (const c of f.cards) if (c.id === localId) return { f, c }; return null; }
  function fileByName(name) {
    const n = String(name || '').trim().toUpperCase(); if (!n) return null;
    return files().find(f => f.name.toUpperCase() === n) || files().find(f => fileFor(f).toUpperCase() === n) || null;
  }
  function customersFile() { return files().find(isCustomers) || null; }
  function ensureCustomers() {
    if (!configured) return null;
    let f = customersFile();
    if (!f) {
      f = fileByName(C.customersFile);
      if (f) f.builtin = 'customers';
      else f = host.addFile({ name: C.customersFile.toUpperCase(), sourceFile: C.customersFile.toUpperCase() + '.CRD', format: 'qc', builtin: 'customers', shared: true, cards: [] });
    }
    f.shared = true;
    return f;
  }
  const fileCol = r => (FK() ? r[FK()] ?? null : null);

  // ---------- outbox: recomputed from the data after every local change ----------
  function localChanged() {
    if (!configured || !host) return;
    const now = nowIso(), ids = new Set();
    for (const f of files()) {
      const shared = isShared(f);
      for (const c of f.cards) {
        if (!c.sync && shared) c.sync = { id: null, linked: false, base: null, editAt: now, notesAt: now, ph: tbHash(c), pn: nHash(c) };
        if (!c.sync) continue;
        const h = tbHash(c), hn = nHash(c);
        if (c.sync.ph !== h) { c.sync.editAt = now; c.sync.ph = h; }
        if (c.sync.pn !== hn) { c.sync.notesAt = now; c.sync.pn = hn; }
        if (c.sync.id) ids.add(c.sync.id);
      }
    }
    // remote ids that no longer have a local card were deleted here (Delete, Undo of Add, deleting a file, unsharing)
    for (const rid of Object.keys(S.registry)) {
      if (ids.has(rid)) continue;
      if (!S.registry[rid].linked && !S.outbox.some(o => o.op === 'delete' && o.id === rid)) S.outbox.push({ op: 'delete', id: rid, at: now });
      delete S.registry[rid];
    }
    // ...and a pending delete whose card came back (Undo) is cancelled
    S.outbox = S.outbox.filter(o => !(o.op === 'delete' && ids.has(o.id) && (S.registry[o.id] = { linked: false })));
    // ...and a card whose delete was already pushed came back (Undo): re-register it and push it again in full (deleted=false)
    if (S.tomb) for (const f of files()) if (isShared(f)) for (const c of f.cards) {
      const s = c.sync; if (!s || !s.id || s.linked || !S.tomb[s.id]) continue;
      delete S.tomb[s.id]; S.registry[s.id] = { linked: false }; s.base = { t: '\u0000', b: '\u0000', n: '\u0000' }; s.editAt = s.notesAt = now; s.undel = true;
    }
    const ops = S.outbox.filter(o => o.op === 'delete');
    for (const f of files()) {
      if (!isShared(f)) continue;
      for (const c of f.cards) {
        const s = c.sync; if (!s || (s.gone && !s.id)) continue;   // a kept card whose row is gone is never re-uploaded
        if (!s.id) { ops.push({ op: 'insert', card: c.id, file: f.name, title: c.title, at: s.editAt }); continue; }
        const b = s.base || { t: '', b: '', n: '' };
        const fields = [];
        if (!s.linked && (c.title !== b.t)) fields.push('title');
        if (!s.linked && (c.body !== b.b)) fields.push('body');
        if ((c.notes || '') !== (b.n || '')) fields.push('notes');
        if (FK() && !sameFile(s.fs, f)) fields.push('file');   // file column present: keep it right (also back-fills older rows)
        if (s.undel && !fields.length) fields.push('restore');
        if (fields.length) ops.push({ op: 'update', card: c.id, id: s.id, fields, title: c.title, at: fields.includes('notes') && fields.length === 1 ? s.notesAt : s.editAt });
      }
    }
    S.outbox = ops;
    saveStore(); ui();
    if (S.outbox.length && canSync()) { clearTimeout(pushTimer); pushTimer = setTimeout(() => sync(), C.autoSyncDelayMs); }
  }

  // ---------- supabase-js + auth ----------
  function loadLib() {
    if (root.supabase && root.supabase.createClient) return Promise.resolve();
    if (!libPromise) libPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = C.lib.url; s.async = true; s.crossOrigin = 'anonymous'; if (C.lib.integrity) s.integrity = C.lib.integrity;
      s.onload = () => (root.supabase && root.supabase.createClient ? res() : rej(new Error('lib')));
      s.onerror = () => { s.remove(); rej(Object.assign(new Error('Could not download the sync library (offline?)'), { offline: true })); };
      document.head.append(s);
    }).catch(e => { libPromise = null; throw e; });
    return libPromise;
  }
  async function client() {
    await loadLib();
    if (!sb) {
      sb = root.supabase.createClient(C.url, C.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: C.auth.storageKey, detectSessionInUrl: C.auth.method === 'magiclink' } });
      sb.auth.onAuthStateChange((ev, s) => {
        if ((s && s.user && s.user.id) !== (session && session.user && session.user.id)) fileState = null;   // probe again for a new session
        session = s || null; ui();
        if (ev === 'SIGNED_IN' && s) setTimeout(() => sync(), 0);
      });
    }
    return sb;
  }
  async function getSession() { const cl = await client(); const { data } = await cl.auth.getSession(); session = data.session || null; return session; }
  // Same accounts as the QC app: username -> synthetic e-mail, PIN -> 'rg1:' + PIN (ramgear-app/js/cloud.js emailFor / cloudPw)
  const norm = u => String(u || '').trim().toLowerCase();
  const hex = s => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');   // UTF-8 bytes
  const qcEmail = u => `u${hex(norm(u))}@users.invalid`;
  function displayUser(email) {
    const m = /^u([0-9a-f]+)@users\.invalid$/.exec(email || '');
    if (!m) return email || '';
    try { return new TextDecoder().decode(new Uint8Array(m[1].match(/../g).map(h => parseInt(h, 16)))) + ' (QC user)'; } catch (e) { return email; }
  }
  // First cloud sign-in of a user imported from a QC tablet: the rg-admin Edge Function checks the PIN against the stored
  // hash and creates the auth account. Called with the publishable key only (no session yet), exactly like the QC app.
  async function activate(username, pin) {
    let r;
    try {
      r = await fetch(`${C.url}/functions/v1/${C.auth.activateFunction}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: C.publishableKey, Authorization: `Bearer ${C.publishableKey}` },
        body: JSON.stringify({ action: 'activate', username: norm(username), password: pin }) });
    } catch (e) { throw Object.assign(new Error('network'), { offline: true }); }
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, activation: true });
    return j;
  }
  // Sign-in methods: pick one with config auth.method. Each gets the form values and returns { session } or { message }.
  // The PIN / password is only passed to supabase-js (and the activation call); it is never logged or stored.
  const AUTH = {
    qc: {                      // default: QC username + PIN (same accounts as the QC app)
      fields: ['user', 'password'], labels: { user: 'Username', password: 'PIN' },
      async signIn(cl, v) {
        const creds = { email: qcEmail(v.user), password: 'rg1:' + v.password };
        let { data, error } = await cl.auth.signInWithPassword(creds);
        if (error && (error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message || ''))) {
          await activate(v.user, v.password);                                  // then retry once
          ({ data, error } = await cl.auth.signInWithPassword(creds));
        }
        if (error) throw error;
        return { session: data.session };
      },
    },
    password: {                // plain e-mail + password accounts
      fields: ['user', 'password'], labels: { user: 'E-mail', password: 'Password' },
      async signIn(cl, v) {
        const { data, error } = await cl.auth.signInWithPassword({ email: v.user.trim(), password: v.password });
        if (error) throw error;
        return { session: data.session };
      },
    },
    otp: {
      fields: ['user', 'code'], labels: { user: 'E-mail' },
      async signIn(cl, v) {
        if (!v.code) { const { error } = await cl.auth.signInWithOtp({ email: v.user.trim(), options: { shouldCreateUser: false } }); if (error) throw error; return { message: 'We e-mailed you a sign-in code. Type it in and press Sign in again.', needCode: true }; }
        const { data, error } = await cl.auth.verifyOtp({ email: v.user.trim(), token: v.code.trim(), type: 'email' });
        if (error) throw error; return { session: data.session };
      },
    },
    magiclink: {
      fields: ['user'], labels: { user: 'E-mail' },
      async signIn(cl, v) {
        const { error } = await cl.auth.signInWithOtp({ email: v.user.trim(), options: { shouldCreateUser: false, emailRedirectTo: location.href.split('#')[0] } });
        if (error) throw error; return { message: 'Check your e-mail and open the sign-in link on this device.' };
      },
    },
  };
  function openSignIn() {
    if (!configured) return;
    const m = AUTH[C.auth.method] || AUTH.qc;
    $('#siUserRow').hidden = !m.fields.includes('user');
    $('#siPassRow').hidden = !m.fields.includes('password');
    $('#siCodeRow').hidden = true;
    $('#siUserLabel').textContent = m.labels.user; $('#siPassLabel').textContent = m.labels.password || 'Password';
    const qc = m === AUTH.qc; $('#siPass').inputMode = qc ? 'numeric' : 'text';
    $('#siHint').textContent = qc ? 'Use your QC app username and PIN. Once signed in, the Customers file and the files you share stay in sync with QC on every device.'
      : 'Once signed in, the Customers file and the files you share stay in sync with QC on every device.';
    $('#siMsg').hidden = true; $('#siPass').value = ''; $('#siCode').value = '';
    $('#siFields').hidden = false; $('#gateSignIn').hidden = true;   // the form lives on the sign-in screen
    $('#siUser').focus();
  }
  async function doSignIn() {
    const m = AUTH[C.auth.method] || AUTH.qc, msg = $('#siMsg'), btn = $('#siGo');
    const v = { user: $('#siUser').value, password: $('#siPass').value, code: $('#siCode').value };
    if (!v.user.trim()) { $('#siUser').focus(); return; }
    btn.disabled = true; msg.hidden = false; msg.className = 'hint'; msg.textContent = 'Signing in…';
    try {
      const r = await m.signIn(await client(), v);
      if (r.needCode) $('#siCodeRow').hidden = false;
      if (r.message) { msg.textContent = r.message; return; }
      $('#siPass').value = '';                            // don't keep the PIN around
      if (session && r.session && session.user && r.session.user && session.user.id !== r.session.user.id) fileState = null;
      if (S.roleUser !== (r.session && r.session.user && r.session.user.id)) { S.role = null; S.roleUser = null; }
      session = r.session; ui();
      sync({ full: !S.wm, manual: true });
    } catch (e) {
      msg.className = 'err'; msg.textContent = plainAuth(e);
    } finally { v.password = ''; btn.disabled = false; }
  }
  function plainAuth(e) {
    const t = (e && (e.message || e.error_description)) || String(e);
    const qc = (C.auth.method || 'qc') === 'qc';
    if ((e && e.activation && e.status === 403) || /invalid login|invalid_grant|credentials|wrong username/i.test(t)) return qc ? 'Wrong username or PIN.' : 'Wrong e-mail or password.';
    if (e && e.activation && e.status === 404) return 'The QC sign-in service isn’t set up on the server yet.';
    if (e && e.activation) return 'Couldn’t activate your QC account for sign-in: ' + t;
    if (/email not confirmed/i.test(t)) return 'This account’s e-mail address has not been confirmed yet.';
    if (/fetch|network|offline|Failed to/i.test(t) || (e && e.offline)) return 'Can’t reach the sign-in server. Check the internet connection and try again.';
    return 'Sign-in failed: ' + t;
  }
  async function signOut() {
    if (!configured) return;
    try { const cl = await client(); await cl.auth.signOut({ scope: 'local' }); } catch (e) {}
    session = null; fileState = null; S.role = null; S.roleUser = null; saveStore(); ui(); host.render();
  }

  // ---------- sync ----------
  const canSync = () => configured && !!session && navigator.onLine;
  function plain(e) {
    const t = (e && (e.message || e.msg)) || String(e), code = e && e.code, st = e && e.status;
    if ((e && e.offline) || /Failed to fetch|NetworkError|network|fetch failed|Load failed/i.test(t)) return 'Can’t reach the QC server. Check the internet connection; changes are kept and will sync later.';
    if (st === 401 || /JWT|expired|not authenticated|invalid token/i.test(t)) return 'Your sign-in has expired. Sign in again (File › Sign in to QC sync).';
    if (code === '42501' || st === 403 || /permission denied|row-level security/i.test(t)) return `The server refused access to ${C.table}. Check the table’s RLS policies and that your account is allowed (see README).`;
    if (code === '42P01' || /relation .* does not exist|Could not find the table/i.test(t)) return `The table ${C.table} doesn’t exist on the server yet.`;
    if (code === '42703' || code === 'PGRST204' || /column .* does not exist|Could not find the '.*' column/i.test(t)) {
      const m = /'([^']+)' column/.exec(t) || /column (?:[\w"]+\.)?"?([\w]+)"? does not exist/.exec(t);
      return `The table ${C.table} has no column “${m ? m[1] : '?'}”. Fix the column names in config.js (set ones the table doesn’t have to null).`;
    }
    if (code === '23514') return `The server rejected a card (${(/constraint "([^"]+)"/.exec(t) || [, 'check constraint'])[1]}). Index lines may be at most 39 characters.`;
    if (st >= 500) return 'The QC server had a problem (' + (st || 'error') + '). Try again in a minute.';
    return 'Sync failed: ' + t;
  }
  // table not created yet (migration not applied): PostgREST 404 (PGRST205 "Could not find the table", 42P01 relation does not exist)
  const missingTable = e => !!e && (e.code === 'PGRST205' || e.code === '42P01' || (e.status === 404 && !e.offline) || /Could not find the table|relation .* does not exist/i.test(e.message || ''));
  async function probeFile(cl) {
    if (!K.file || C.probeFile === false) { fileState = !!K.file; return; }
    const res = await cl.from(C.table).select(`${K.id},${K.file}`).limit(1);
    if (!res.error) { fileState = true; return; }
    const e = res.error;
    if (res.status === 400 && (e.code === '42703' || e.code === 'PGRST204' || /column .*does not exist|Could not find the '.*' column/i.test(e.message || ''))) { fileState = false; return; }
    chk(res);
  }
  function chk(res) { if (res.error) { const e = new Error(res.error.message || 'error'); e.code = res.error.code; e.status = res.status; throw e; } return res.data; }

  async function sync(opts = {}) {
    if (!configured) return;
    // table not there yet: automatic syncs check again only every few minutes (the Sync button always checks)
    if (S.unavailable && !opts.manual && Date.now() - ms(S.unavailable) < C.unavailableRetryMs) { ui(); return; }
    if (running) { again = true; return running; }
    clearTimeout(pushTimer);
    running = (async () => {
      S.running = true; ui();
      try {
        if (!navigator.onLine) throw Object.assign(new Error('offline'), { offline: true });
        if (!session) await getSession();
        if (!session) { S.lastError = ''; return; }
        if (!S.role || S.roleUser !== uid()) await loadRole(await client());
        if (role() === 'none') { S.lastError = ''; return; }
        ensureCustomers();
        localChanged();
        if (fileState === null) await probeFile(await client());
        const full = !!(opts.full || S.needFull || !S.wm);
        await pull(full);
        S.needFull = false;
        host.persist(); localChanged();
        if (canEdit()) await push();   // viewers are read-only: nothing is sent
        S.lastSyncAt = nowIso(); S.lastError = ''; S.unavailable = null;
      } catch (e) {
        if (missingTable(e)) { S.unavailable = nowIso(); S.lastError = ''; }
        else { S.unavailable = null; S.lastError = plain(e); if (e && !e.offline) console.warn('QC sync:', e.message || e); }
      } finally {
        S.running = false; saveStore(); host.persist(); host.render(); ui();
      }
    })();
    try { await running; } finally { running = null; if (again) { again = false; setTimeout(() => sync(), 50); } }
  }

  async function pull(full) {
    const cl = await client(), N = C.pageSize, stats = { added: 0, updated: 0, removed: 0, kept: 0, skipped: 0 };
    const seen = full ? new Set() : null, deferred = [];
    // incremental: start a little before the watermark (late commits); re-reading rows is harmless
    let cur = full || !S.wm ? null : { ts: new Date(ms(S.wm.ts) - 5000).toISOString(), id: null };
    let last = S.wm;
    for (let guard = 0; guard < 10000; guard++) {
      if (cur && cur.id != null) {      // drain rows that share the cursor's updated_at
        const rows = chk(await cl.from(C.table).select('*').eq(K.updatedAt, cur.ts).gt(K.id, cur.id).order(K.id, { ascending: true }).limit(N));
        rows.forEach(r => apply(r, stats, seen, deferred));
        if (rows.length) last = { ts: rows[rows.length - 1][K.updatedAt], id: rows[rows.length - 1][K.id] };
        if (rows.length === N) { cur.id = rows[rows.length - 1][K.id]; continue; }
        cur.id = null;
      }
      let q = cl.from(C.table).select('*');
      if (cur) q = q.gt(K.updatedAt, cur.ts);
      const rows = chk(await q.order(K.updatedAt, { ascending: true }).order(K.id, { ascending: true }).limit(N));
      rows.forEach(r => apply(r, stats, seen, deferred));
      if (rows.length) last = { ts: rows[rows.length - 1][K.updatedAt], id: rows[rows.length - 1][K.id] };
      if (rows.length < N) break;
      cur = { ts: last.ts, id: last.id };
    }
    bindByTitle(deferred, stats);
    if (full) {   // rows that vanished from the server (hard deletes, or rows we can no longer see)
      for (const f of files()) for (const c of f.cards.slice()) if (c.sync && c.sync.id && !seen.has(c.sync.id) && isShared(f)) remoteGone(f, c, null, stats);
    }
    if (last) S.wm = { ts: last.ts, id: last.id };
    S.stats = stats; S.skipped = stats.skipped;
  }

  function rowVals(r) {
    return { id: r[K.id], cid: r[K.customerId] ?? null, title: r[K.title] ?? '', body: r[K.body] ?? '', notes: r[K.notes] ?? '', src: r[K.source] || '',
      ua: r[K.updatedAt], del: K.deletedAt ? r[K.deletedAt] != null : !!(K.deleted && r[K.deleted]), file: fileCol(r) };
  }
  const titleKey = t => Array.from(String(t || '').trim().toLowerCase()).slice(0, C.titleMax || 1e9).join('');
  const bindable = x => (!x.sync || !x.sync.id) && !isGone(x);
  function apply(r, stats, seen, deferred) {
    const v = rowVals(r); if (seen) seen.add(v.id);
    // QC-linked: customer_id set. A source='qc' row whose customer_id is NULL was released by QC (its customer was deleted;
    // the QC draft trigger keeps the row and clears customer_id): treated like a removed customer.
    const linked = v.cid != null, orphan = !linked && v.src === 'qc';
    let hit = findById(v.id);
    if (!hit) {   // a card kept as "No longer in QC": QC linked the row again -> it comes back to life
      const g = findGone(v.id);
      if (g) {
        if (!linked || v.del) return;
        const gs = g.c.sync, localWins = ms(gs.notesAt) > ms(v.ua);
        Object.assign(gs, { id: v.id, gone: false, goneId: null, base: { t: v.title, b: v.body, n: localWins ? v.notes : (g.c.notes || '') } });
        hit = g;
      }
    }
    if (!hit && orphan && (v.del || !v.notes.trim())) return;   // a released QC card is only kept when it has notes
    if (!hit && !v.del && v.src !== 'qc') {   // same card uploaded from another device (e.g. both shared the same seed file)
      const tf = (v.file && fileByName(v.file)) || customersFile();
      const c = tf && isShared(tf) && tf.cards.find(x => (!x.sync || !x.sync.id) && !isGone(x) && x.title.trim().toLowerCase() === v.title.trim().toLowerCase() && x.body.trim() === v.body.trim());
      if (c) { c.sync = Object.assign(c.sync || {}, { id: v.id, base: { t: c.title, b: c.body, n: c.notes || '' } }); hit = { f: tf, c }; stats.bound = (stats.bound || 0) + 1; }
      // no identical card: decide after the whole pull (exact matches first), see bindByTitle
      else if (deferred && tf && isShared(tf) && !S.registry[v.id]) { deferred.push(r); return; }
    }
    if (!hit) {
      if (v.del) return;
      // deleted here, delete not pushed yet: keep it deleted unless the row was changed elsewhere after our delete (last write wins)
      const pend = S.outbox.find(o => o.op === 'delete' && o.id === v.id);
      if (pend) {
        if (linked || ms(v.ua) <= ms(pend.at)) return;
        S.outbox = S.outbox.filter(o => o !== pend); delete S.registry[v.id];
      }
      let f = (v.file && fileByName(v.file)) || null;
      if (v.file && !f) f = host.addFile({ name: String(v.file).toUpperCase(), sourceFile: String(v.file).toUpperCase() + '.CRD', format: 'qc', shared: true, cards: [] });
      if (!f) f = ensureCustomers();
      if (!isShared(f)) { stats.skipped++; return; }
      const c = { id: host.newId(), title: v.title, body: v.body, notes: v.notes };
      c.sync = { id: v.id, linked, cid: v.cid, src: v.src, up: v.ua, base: { t: v.title, b: v.body, n: v.notes }, editAt: v.ua, notesAt: v.ua, ph: tbHash(c), pn: nHash(c) };
      if (orphan) Object.assign(c.sync, { gone: true, goneAt: nowIso() });
      if (FK()) c.sync.fs = v.file;
      f.cards.push(c); host.sortFile(f); S.registry[v.id] = { linked }; stats.added++;
      return;
    }
    const { f, c } = hit, s = c.sync;
    if (!isShared(f)) { stats.skipped++; return; }
    if (v.del) { remoteGone(f, c, v, stats); return; }
    if (s.linked && !linked) {   // QC released the card (customer deleted -> customer_id cleared; the row stays)
      if ((c.notes || '').trim() || v.notes.trim()) { s.gone = true; s.goneAt = nowIso(); stats.kept++; }
      else if (v.src === 'qc') { delete S.registry[v.id]; f.cards.splice(f.cards.indexOf(c), 1); stats.removed++; return; }
    }
    const b = s.base || { t: c.title, b: c.body, n: c.notes || '' };
    const localTB = c.title !== b.t || c.body !== b.b, remoteTB = v.title !== b.t || v.body !== b.b;
    let changed = false;
    if (linked) { if (c.title !== v.title || c.body !== v.body) { c.title = v.title; c.body = v.body; changed = true; } }
    else if (remoteTB && (!localTB || ms(v.ua) >= ms(s.editAt))) { c.title = v.title; c.body = v.body; changed = true; }
    const localN = (c.notes || '') !== (b.n || ''), remoteN = v.notes !== (b.n || '');
    if (remoteN && (!localN || ms(v.ua) >= ms(s.notesAt))) { if ((c.notes || '') !== v.notes) { c.notes = v.notes; changed = true; } }
    Object.assign(s, { linked, cid: v.cid, src: v.src, up: v.ua, base: { t: v.title, b: v.body, n: v.notes }, gone: linked ? false : !!s.gone, ph: tbHash(c), pn: nHash(c) });
    if (linked) delete s.goneAt;
    if (FK()) s.fs = v.file;
    S.registry[v.id] = { linked };
    if (changed) { host.sortFile(f); stats.updated++; }
  }
  // Rows from Cardfile with no identical local card: bind each to the one unbound local card with the same index line in
  // that file (the card was edited here), taking the row as the base so the local edits are pushed up. Otherwise a new card.
  function bindByTitle(rows, stats) {
    for (const r of rows) {
      const v = rowVals(r);
      if (!findById(v.id)) {
        const tf = (v.file && fileByName(v.file)) || customersFile();
        const k = titleKey(v.title), cands = tf ? tf.cards.filter(x => bindable(x) && titleKey(x.title) === k) : [];
        const twins = rows.filter(o => o !== r && !findById(rowVals(o).id) && titleKey(rowVals(o).title) === k && sameFile(rowVals(o).file, tf));
        if (cands.length === 1 && !twins.length) {
          const c = cands[0], now = nowIso();
          c.sync = Object.assign(c.sync || {}, { id: v.id, base: { t: v.title, b: v.body, n: v.notes }, editAt: now, notesAt: now });
          stats.bound = (stats.bound || 0) + 1;
        }
      }
      apply(r, stats, null, null);
    }
  }
  // row deleted on the server (soft delete: v given) or vanished (full resync: v null)
  function remoteGone(f, c, v, stats) {
    // keep-with-notes applies to QC cards: linked ones, and (row vanished) ones already kept as "No longer in QC"
    const s = c.sync, rid = s.id, wasLinked = s.linked || (v ? v.cid != null : !!s.gone);
    delete S.registry[rid];
    if (wasLinked) {
      if ((c.notes || '').trim()) { Object.assign(s, { gone: true, linked: false, goneId: rid, id: null, goneAt: nowIso() }); stats.kept++; return; }
    } else {
      const b = s.base || {};
      const pending = c.title !== b.t || c.body !== b.b || (c.notes || '') !== (b.n || '');
      const localAt = Math.max(ms(s.editAt), ms(s.notesAt));
      if (pending && (!v || localAt > ms(v.ua))) {   // edited here after the delete: last write wins, keep (re-upload)
        if (!v) { s.id = null; s.base = null; }
        else { S.registry[rid] = { linked: false }; s.undel = true; }
        stats.kept++; return;
      }
    }
    f.cards.splice(f.cards.indexOf(c), 1); stats.removed++;
  }

  async function push() {
    const cl = await client(), stats = S.stats || {}, denied = [];
    stats.pushed = 0;
    try { await pushOps(cl, stats, denied); }
    finally {
      if (denied.length) host.message(`Only a Cardfile admin can delete cards (or bring deleted ones back).\n\n${denied.length === 1 ? 'This card was put back as it is on the server' : 'These cards were put back as they are on the server'}:\n` + denied.slice(0, 10).map(t => '  ' + (t.trim() || '(no index line)')).join('\n'));
    }
    S.stats = stats;
    localChanged();
  }
  // QC Rev 1.9: a non-admin changing deleted_at makes the server raise RG_CARD_DELETE
  const isDeleteDenied = res => !!(res && res.error && /RG_CARD_DELETE/.test((res.error.message || '') + ' ' + (res.error.details || '') + ' ' + (res.error.hint || '')));
  // put the server's copy of a row back into this browser (the local delete was refused)
  async function restoreRow(cl, rid, denied) {
    delete S.registry[rid]; if (S.tomb) delete S.tomb[rid];
    const g = findGone(rid); if (g && g.c.sync) g.c.sync.goneId = null;
    const data = chk(await cl.from(C.table).select('*').eq(K.id, rid));
    if (data && data[0]) {
      const before = findById(rid);
      apply(data[0], { added: 0, updated: 0, removed: 0, kept: 0, skipped: 0 }, null);
      const now = findById(rid);
      if (denied) denied.push(now ? now.c.title : (before ? before.c.title : ''));
    }
    host.persist(); saveStore();
  }
  async function pushOps(cl, stats, denied) {
    for (const op of S.outbox.slice()) {
      if (op.op === 'delete') {
        const dr = await cl.from(C.table).update(delMark()).eq(K.id, op.id);   // soft delete (deleted_at)
        if (isDeleteDenied(dr)) { S.outbox = S.outbox.filter(o => o !== op); await restoreRow(cl, op.id, denied); continue; }   // never retried
        chk(dr);
        S.outbox = S.outbox.filter(o => o !== op); stats.pushed++;
        S.tomb = S.tomb || {}; S.tomb[op.id] = 1;   // remembered so an Undo after the push can bring the row back
        const tk = Object.keys(S.tomb); if (tk.length > 2000) delete S.tomb[tk[0]];
        saveStore(); continue;
      }
      const hit = findCard(op.card); if (!hit) continue;
      const { f, c } = hit, s = c.sync;
      if (!s || (s.gone && !s.id) || !isShared(f)) continue;
      if (op.op === 'insert' && !s.id) {
        // updated_at / created_at / deleted_at are left to the server (trigger + defaults)
        const row = { [K.title]: clampTitle(c.title), [K.body]: c.body, [K.notes]: c.notes || null, [K.source]: 'cardfile', [K.customerId]: null };
        if (FK()) row[FK()] = fileFor(f);
        if (C.clientIds) row[K.id] = s.pendingId || (s.pendingId = uuid());
        saveStore(); host.persist();
        let res = await cl.from(C.table).insert(row).select();
        if (res.error && res.error.code === '23505' && C.clientIds) res = await cl.from(C.table).select('*').eq(K.id, row[K.id]);   // retry after a lost response
        const data = chk(res);
        if (data && data[0]) { s.id = data[0][K.id]; delete s.pendingId; s.base = { t: '\u0000', b: '\u0000', n: '\u0000' }; apply(data[0], {}, null); }
        stats.pushed++;
      } else if (op.op === 'update' && s.id) {
        const notesOnly = { [K.notes]: c.notes || null };   // Cardfile-owned columns only (QC owns title/body of linked rows)
        if (FK()) notesOnly[FK()] = fileFor(f);
        let data;
        if (!s.linked) {
          const full = Object.assign({ [K.title]: clampTitle(c.title), [K.body]: c.body }, notesOnly);
          if (s.undel) Object.assign(full, liveMark());   // bring back a row deleted earlier (Undo, or edited here after the delete)
          const ur = await cl.from(C.table).update(full).eq(K.id, s.id).is(K.customerId, null).select();
          if (s.undel && isDeleteDenied(ur)) { delete s.undel; denied.push(c.title); await restoreRow(cl, s.id, null); continue; }   // undelete is an admin action too
          data = chk(ur);
          if (!data.length) data = chk(await cl.from(C.table).update(notesOnly).eq(K.id, s.id).select());   // QC linked it meanwhile: only notes
        } else data = chk(await cl.from(C.table).update(notesOnly).eq(K.id, s.id).select());
        if (data.length) { delete s.undel; apply(data[0], {}, null); }
        else remoteGone(f, c, null, {});
        stats.pushed++;
      }
    }
  }

  // ---------- sharing ----------
  async function toggleShare(f) {
    if (!configured || !f || isCustomers(f) || C.shareAllFiles) return;
    if (!f.shared) {
      const ok = await host.confirm(`Share "${f.name}" with QC?\n\nIts ${f.cards.length} card(s), and every later change to them, will be uploaded to the shared ${C.table} table. The QC app shows every card in that table to everyone signed in to it.\n\nDon’t share files with personal data (e.g. EMPLST, PHONENUB).` + (fileState === false ? `\n\nNote: the shared table has no file column yet, so on other devices these cards appear in the Customers file.` : ''), 'Share');
      if (!ok) return;
      host.undoable('Share with QC');
      f.shared = true; S.needFull = true;
    } else {
      if (!canDelete()) { host.message('Only a Cardfile admin can stop sharing a file (that removes its cards from the shared table).'); return; }
      const up = f.cards.filter(c => c.sync && c.sync.id && !c.sync.linked).length;
      const ok = await host.confirm(`Stop sharing "${f.name}" with QC?` + (up ? `\n\nIts ${up} uploaded card(s) will be marked deleted in the shared table, so QC stops showing them. The cards stay here.` : ''), 'Stop sharing');
      if (!ok) return;
      host.undoable('Stop sharing');
      f.shared = false;
      for (const c of f.cards) if (c.sync && !c.sync.linked) delete c.sync;   // registry diff turns these into deletes
    }
    host.persist(); host.render();
    if (canSync()) sync();
  }

  // ---------- local resets (Reset to original data / Restore backup) ----------
  function resetLocal(keepIds) {
    if (!configured) return;
    S.outbox = []; S.registry = {}; S.tomb = {}; S.wm = null; S.needFull = true;
    if (keepIds) for (const f of files()) for (const c of f.cards) if (c.sync && c.sync.id) S.registry[c.sync.id] = { linked: !!c.sync.linked };
    ensureCustomers(); saveStore(); ui();
  }

  // ---------- status UI ----------
  function fmtTime(t) { if (!t) return ''; const d = new Date(t); return (d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString() + ' ') + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function storedEmail() { try { const j = JSON.parse(localStorage.getItem(C.auth.storageKey) || 'null'); return (j && (j.user || (j.currentSession || {}).user) || {}).email || ''; } catch (e) { return ''; } }
  const hasStoredSession = () => { try { return !!localStorage.getItem(C.auth.storageKey); } catch (e) { return false; } };
  function status() {
    return { configured, signedIn: !!session || (!sb && hasStoredSession()), user: displayUser(session ? session.user && session.user.email : storedEmail()), online: navigator.onLine, running: !!S.running,
      pending: S.outbox.length, lastSyncAt: S.lastSyncAt, lastError: S.lastError, unavailable: !!S.unavailable, fileColumn: fileState, skipped: S.skipped, stats: S.stats,
      role: role(), roleKnown: !!(S.role && S.roleUser === uid()), canView: canView(), canEdit: canEdit(), canDelete: canDelete() };
  }
  function ui() {
    if (!configured) return;
    clearTimeout(uiTimer);
    const st = status(), btn = $('#btnSync'), lbl = $('#syncLabel'), who = $('#syncUser');
    lock(!st.signedIn || !st.canView, st.signedIn && !st.canView);
    if (!btn) return;
    btn.hidden = false; who.hidden = false;
    const n = st.pending, waiting = n ? `${n} change${n === 1 ? '' : 's'} waiting` : '';
    let text, cls = '';
    if (!st.signedIn) { text = 'Sign in to sync'; cls = 'off'; }
    else if (st.running) { text = 'Syncing…'; cls = 'busy'; }
    else if (!st.online) { text = 'Offline' + (waiting ? ' · ' + waiting : ''); cls = 'off'; }
    else if (st.unavailable) { text = 'QC sync not available yet'; cls = 'off'; }
    else if (st.lastError) { text = 'Sync problem' + (waiting ? ' · ' + waiting : ''); cls = 'err'; }
    else if (!st.canEdit) { text = 'Read-only' + (st.lastSyncAt ? ' · synced ' + fmtTime(st.lastSyncAt) : ''); cls = 'ro'; }
    else if (waiting) { text = waiting; cls = 'wait'; }
    else text = st.lastSyncAt ? 'Synced ' + fmtTime(st.lastSyncAt) : 'Sync';
    lbl.textContent = text; btn.className = cls;
    btn.title = (st.unavailable ? `The shared ${C.table} table isn’t set up on the QC server yet. Cardfile works as usual and keeps your changes; it checks again every few minutes.\n\n` : '') + (st.lastError ? st.lastError + '\n\n' : '') + (st.lastSyncAt ? 'Last synced ' + new Date(st.lastSyncAt).toLocaleString() : 'Not synced yet') +
      (st.skipped ? `\n${st.skipped} row(s) belong to files not shared on this device.` : '') + '\nClick to sync now.';
    who.textContent = st.signedIn ? '● QC: ' + st.user : '○ QC: signed out';
    who.className = st.signedIn ? 'on' : 'off';
    const err = $('#syncError');
    if (err) { err.hidden = !st.lastError; err.textContent = st.lastError; }
    if (host && host.updateMenus) host.updateMenus();
  }
  // signed out: the cards stay hidden behind the sign-in screen (they come from the database; localStorage is only a cache)
  function lock(on, noRole) {
    document.body.classList.toggle('locked', !!on);
    const g = $('#gate'); if (g) g.hidden = !on;
    const m = $('#gateMsg'), b = $('#gateSignIn'), o = $('#gateSignOut');
    if (m) m.textContent = noRole ? 'You don’t have Cardfile access yet. Ask a QC admin to give you Cardfile access, then sign in again.' : '';
    if (b) b.hidden = !noRole;                      // role none: "Sign in as someone else" shows the form again
    const fs = $('#siFields'); if (fs && on) fs.hidden = !!noRole;
    if (o) o.hidden = !noRole;
    const t = $('#gateText'); if (t) t.hidden = !!noRole;
  }
  function onButton() { if (!session) openSignIn(); else sync({ manual: true }); }

  function init(h) {
    host = h;
    if (!configured) return;
    ensureCustomers();
    // every card file shared (Gary's decision): the first sync after switching this on reads everything, so rows
    // already in the table are bound to the local cards instead of being uploaded again
    if (!!C.shareAllFiles !== !!S.shareAll) { S.shareAll = !!C.shareAllFiles; S.needFull = true; saveStore(); }
    $('#siGo').onclick = doSignIn;
    $('#siForm').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); doSignIn(); } });
    $('#btnSync').onclick = onButton;
    if ($('#gateSignIn')) $('#gateSignIn').onclick = openSignIn;
    if ($('#gateSignOut')) $('#gateSignOut').onclick = signOut;
    $('#syncError').onclick = () => host.message(S.lastError);
    window.addEventListener('online', () => { ui(); sync(); });
    window.addEventListener('offline', () => ui());
    ui();
    if (navigator.onLine) getSession().then(s => { ui(); if (s) sync(); }).catch(e => { S.lastError = e && e.offline ? '' : plain(e); ui(); });
  }

  root.CardSync = {
    configured, config: C, init, localChanged, sync, fullResync: () => sync({ full: true, manual: true }), toggleShare, openSignIn, signOut, resetLocal,
    isShared, isCustomers, isLinked, isGone, status, role, canView, canEdit, canDelete, loadRole: async () => loadRole(await client()), ensureCustomers, shareAll: () => !!C.shareAllFiles, fileFor,
    _store: () => S, _qcEmail: qcEmail,
  };
})(window);
