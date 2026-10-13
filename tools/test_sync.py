"""QC sync tests: the real supabase-js (from jsDelivr) talks to an in-memory mock of Supabase shaped like the QC contract
(tools/mock_supabase.py) through Playwright request routing. The real project is never contacted: every context also routes
the real Supabase host to a guard that blocks and records requests, and the tests check that nothing reached it.
Run on their own:  python3 tools/test_sync.py http://127.0.0.1:8765/   (also run at the end of tools/test_app.py)."""
import asyncio, json, os, subprocess, sys
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mock_supabase import MockSupabase, qc_email, serve, PUBLISHABLE
import make_fixture
FIXTURE_JS = make_fixture.fixture_js()   # made-up cards in the browser cache; the app itself ships no card data

MOCK = 'https://cardfile-mock.supabase.co'
REAL = 'https://dbveedcksommanxshpzx.supabase.co'
INIT = "window.CARDFILE_SUPABASE = { url: '%s', publishableKey: '" + PUBLISHABLE + "', autoSyncDelayMs: %d %s};"
CUST = 'cardfileApp.state().files.find(f => f.builtin === "customers")'
CARDS_JS = f'{CUST}.cards.map(c => ({{t: c.title, b: c.body, n: c.notes || "", linked: !!(c.sync && c.sync.linked), gone: !!(c.sync && c.sync.gone), id: c.sync && c.sync.id}}))'
INSERT_KEYS = {'id', 'title', 'body', 'notes', 'source', 'customer_id', 'file'}
real_hits = []


async def guard_real(ctx):
    async def block(route):
        real_hits.append(route.request.url); await route.abort()
    await ctx.route(REAL + '/**', block)


async def new_ctx(b, extra='', mock=None, delay=600, kw_fixture=True, **kw):
    ctx = await b.new_context(viewport=kw.pop('viewport', {'width': 1200, 'height': 820}), **kw)
    await guard_real(ctx)
    if kw_fixture: await ctx.add_init_script(FIXTURE_JS)
    if mock is not None:
        if 'shareAllFiles' not in extra:   # most tests exercise per-file sharing; the share-all test sets it explicitly
            extra = 'shareAllFiles: false' + (', ' + extra if extra else '')
        await ctx.add_init_script(INIT % (MOCK, delay, ', ' + extra))
        await ctx.route(MOCK + '/**', mock.handle)
    return ctx


async def sync_now(pg, manual=True):
    await pg.evaluate('m => CardSync.sync({ manual: m })', manual)
    await pg.wait_for_function('!CardSync.status().running', timeout=20000)
    return await pg.evaluate('CardSync.status()')


async def caret_end(pg, sel):
    await pg.click(sel)
    await pg.evaluate('s => { const t = document.querySelector(s); t.setSelectionRange(t.value.length, t.value.length); }', sel)


async def show_card(pg, file_name, title):
    """switch to a file and bring the card with this title to the front"""
    i = await pg.evaluate('n => cardfileApp.state().files.findIndex(f => f.name === n)', file_name)
    await pg.select_option('#filePicker', str(i)); await pg.wait_for_timeout(80)
    k = await pg.evaluate('t => cardfileApp.list().findIndex(e => e.card.title.trim() === t.trim())', title)
    if k < 0:
        raise AssertionError(f'card {title!r} not found in {file_name}')
    await pg.evaluate('k => cardfileApp.go(k)', k); await pg.wait_for_timeout(80)
    return k


async def file_menu(pg, item):
    await pg.click('#menubar > .menu:nth-child(1) > button'); await pg.click(f'#menubar > .menu:nth-child(1) li button:has-text("{item}")')
    await pg.wait_for_timeout(150)


async def delete_card(pg):
    await pg.click('#menubar > .menu:nth-child(4) > button'); await pg.click('#menubar > .menu:nth-child(4) li button:has-text("Delete")')
    await pg.click('#confirmOk'); await pg.wait_for_timeout(400)


async def open_sign_in(pg):
    await pg.click('#gateSignIn' if await pg.is_visible('#gateSignIn') else '#btnSync'); await pg.wait_for_selector('#dlgSignIn[open]')


async def sign_in(pg, user, pin, wait=True):
    if not await pg.is_visible('#dlgSignIn'):
        await open_sign_in(pg)
    await pg.fill('#siUser', user); await pg.fill('#siPass', pin); await pg.click('#siGo')
    if wait:
        await pg.wait_for_function('CardSync.status().signedIn && !CardSync.status().running && (CardSync.status().lastSyncAt || CardSync.status().unavailable || CardSync.status().lastError)', timeout=20000)


async def sync_tests(b, URL, OUT, check):
    # ---------- 0a) sync switched off (publishableKey ''): the app is exactly as before ----------
    plain = await new_ctx(b)
    await plain.add_init_script("window.CARDFILE_SUPABASE = { publishableKey: '' };")
    p0 = await plain.new_page(); await p0.goto(URL); await p0.wait_for_selector('.card.front', state='attached')
    nf = await p0.evaluate('cardfileApp.state().files.length')
    check('sync off (empty key): app unchanged (7 cached files, no Sync button, no notes box, supabase-js not loaded)',
          nf == 7 and not await p0.is_visible('#btnSync') and not await p0.query_selector('#notesText') and not await p0.evaluate('!!window.supabase'), f'{nf} files')
    await plain.close()

    # ---------- 0b) shipped config.js (real project + publishable key): signed out, nothing is sent ----------
    dflt = await new_ctx(b)
    p0 = await dflt.new_page(); await p0.goto(URL); await p0.wait_for_selector('.card.front', state='attached'); await p0.wait_for_timeout(1500)
    cfg = await p0.evaluate('({c: CardSync.configured, url: CardSync.config.url, key: CardSync.config.publishableKey, cols: CardSync.config.columns, auth: CardSync.config.auth.method})')
    lbl = (await p0.text_content('#syncLabel')).strip()
    check('shipped config: real project + publishable key, QC schema defaults (deleted_at, file probed), Username/PIN sign-in',
          cfg['c'] and cfg['url'] == REAL and cfg['key'].startswith('sb_publishable_') and cfg['cols']['deletedAt'] == 'deleted_at' and not cfg['cols']['deleted'] and cfg['auth'] == 'qc', json.dumps(cfg)[:160])
    check('shipped config, signed out: "Sign in to sync", Customers file added, no request to the real project', lbl == 'Sign in to sync' and not real_hits
          and (await p0.evaluate('cardfileApp.state().files[0].name')) == 'CUSTOMERS', f'{lbl}; {real_hits[:2]}')
    gate = await p0.evaluate('({locked: document.body.classList.contains("locked"), gate: !document.querySelector("#gate").hidden, cards: !!document.querySelector(".card.front") && document.querySelector(".card.front").offsetParent !== null})')
    check('signed out: sign-in screen shown, no cards visible', gate['locked'] and gate['gate'] and not gate['cards'], str(gate))
    await open_sign_in(p0)
    labels = [await p0.text_content('#siUserLabel'), await p0.text_content('#siPassLabel')]
    check('sign-in dialog asks for Username and PIN', labels == ['Username', 'PIN'], str(labels))
    await dflt.close()

    # ---------- main flow: file column present ----------
    mock = MockSupabase(MOCK)
    mock.add_qc_user('José', '4321', activated=False)       # imported from a QC tablet; cloud account made on first sign-in
    acme = mock.qc_insert('ACME GEAR CO', 'Contact: Pat Doe\nPhone: 361-555-0100\nAddress: 100 Main St, Sinton TX 78387', 'C-100')
    bolt = mock.qc_insert('BOLT & NUT SUPPLY', 'Phone: 361-555-0101\nAddress: Box 9, Taft TX 78390', 'C-101')
    other = mock.qc_insert('COASTAL PUMP REPAIR', '  JOE  361-555-0111', None, notes='call before 3pm', source='cardfile')   # uploaded by another Cardfile
    ctx = await new_ctx(b, mock=mock, accept_downloads=True)
    pg = await ctx.new_page(); errors = []; consoles = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: (consoles.append(m.text), errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None))
    await pg.goto(URL); await pg.wait_for_selector('.card.front', state='attached')
    files = await pg.evaluate('cardfileApp.state().files.map(f => f.name)')
    check('signed out: Customers file added (first), nothing sent', files[0] == 'CUSTOMERS' and len(files) == 8 and not [x for x in mock.log if x[1].startswith('/rest/')])
    shared = await pg.evaluate('cardfileApp.state().files.filter(f => CardSync.isShared(f)).map(f => f.name)')
    check('all 7 cached files default to NOT shared', shared == ['CUSTOMERS'], str(shared))

    # sign in: wrong PIN (sign-in fails -> activate refused -> plain error), then the right PIN (activate -> retry succeeds)
    await open_sign_in(pg)
    await pg.fill('#siUser', 'José'); await pg.fill('#siPass', '4321'); await pg.screenshot(path=f'{OUT}/qc-signin.png')
    await sign_in(pg, 'José', '9999', wait=False)
    await pg.wait_for_function('document.querySelector("#siMsg").classList.contains("err")', timeout=10000)
    msg = await pg.text_content('#siMsg')
    check('wrong PIN: sign-in, activation attempt, plain "Wrong username or PIN."', msg == 'Wrong username or PIN.' and len(mock.activations) == 1, msg)
    await pg.fill('#siPass', '4321')
    await pg.click('#siGo')
    await pg.wait_for_function('CardSync.status().signedIn && !CardSync.status().running && CardSync.status().lastSyncAt', timeout=20000)
    tok = [x[3] for x in mock.log if x[1] == '/auth/v1/token']
    acts = [x[3] for x in mock.log if x[1] == '/functions/v1/rg-admin']
    check('non-ASCII username: e-mail = u + hex(UTF-8 of trimmed lower-case name) @users.invalid, password rg1:<PIN>',
          tok[-1]['email'] == qc_email('josé') == 'u6a6f73c3a9@users.invalid' and tok[-1]['password'] == 'rg1:4321', tok[-1]['email'])
    check('first sign-in: Invalid login credentials -> rg-admin activate (publishable key headers) -> retry once -> signed in',
          len(tok) == 3 and len(acts) == 2 and acts[-1] == {'action': 'activate', 'username': 'josé', 'password': '4321'} and all(ok for _, ok in mock.activations), f'{len(tok)} token calls, {acts[-1]}')
    who = await pg.text_content('#syncUser')
    check('signed-in indicator shows the QC user', 'josé (QC user)' in who, who)
    ls = await pg.evaluate('JSON.stringify(Object.entries(localStorage))')
    check('PIN never stored or logged (localStorage, console, PIN field cleared)', 'rg1:4321' not in ls and '"4321"' not in ls and not any('4321' in c for c in consoles)
          and await pg.input_value('#siPass') == '')
    probe = [x for x in mock.log if x[0] == 'GET' and x[2].get('select') == 'id,file']
    check('file column probed once (select=id,file&limit=1): present', len(probe) == 1 and probe[0][2].get('limit') == '1' and await pg.evaluate('CardSync.status().fileColumn') is True)

    # first pull
    cards = await pg.evaluate(CARDS_JS); byt = {c['t']: c for c in cards}
    check('first pull: 3 rows into Customers; QC rows linked, cardfile row not; QC body shown as-is', len(cards) == 3 and byt['ACME GEAR CO']['linked'] and byt['BOLT & NUT SUPPLY']['linked']
          and not byt['COASTAL PUMP REPAIR']['linked'] and byt['COASTAL PUMP REPAIR']['n'] == 'call before 3pm' and byt['ACME GEAR CO']['b'].startswith('Contact: Pat Doe\nPhone: 361-555-0100'))
    pulls = [x[2] for x in mock.log if x[0] == 'GET' and x[2].get('select') == '*']
    check('pull ordered by updated_at,id', pulls and all(p.get('order') == 'updated_at.asc,id.asc' for p in pulls if 'updated_at' not in p or p['updated_at'].startswith('gt.')), str(pulls[:1]))
    await show_card(pg, 'CUSTOMERS', 'ACME GEAR CO')
    check('linked card: badge + read-only text + hint', await pg.is_visible('.card.front .qcbadge:not(.gone)') and await pg.evaluate('document.querySelector("#bodyText").readOnly') and await pg.is_visible('.card.front .qchint'))
    await pg.keyboard.press('F6'); await pg.wait_for_timeout(150)
    msg = await pg.text_content('#confirmText'); await pg.click('#confirmOk')
    check('linked card: index line edit blocked with explanation', 'QC app' in msg, msg[:60])
    await pg.fill('#notesText', 'Prefers delivery Tuesdays. Gate code at office.')
    await pg.wait_for_timeout(500); await pg.mouse.move(5, 800)
    await pg.screenshot(path=f'{OUT}/qc-customers-badge.png')
    await sync_now(pg)
    w = mock.rest_writes()[-1]
    check('notes pushed with PATCH ?id=eq.<id>; linked card: only Cardfile columns (notes, file), no updated_at', mock.rows[acme]['notes'].startswith('Prefers delivery')
          and w[0] == 'PATCH' and w[2].get('id') == 'eq.' + acme and set(w[3]) <= {'notes', 'file'}, str(w[2:]))

    # QC edits title/body: notes kept
    mock.qc_update(acme, title='ACME GEAR COMPANY', body='Contact: Pat Doe\nPhone: 361-555-0100\nAddress: 100 Main St, Ste 4, Sinton TX 78387')
    await sync_now(pg)
    byt = {x['t']: x for x in await pg.evaluate(CARDS_JS)}
    inc = [x[2] for x in mock.log if x[0] == 'GET' and x[2].get('updated_at', '').startswith('gt.')]
    check('incremental pull: select=*&updated_at=gt.<ISO>&order=updated_at.asc,id.asc', inc and inc[-1].get('select') == '*' and inc[-1].get('order') == 'updated_at.asc,id.asc', str(inc[-1:]))
    check('QC update: title/body updated, notes preserved', 'Ste 4' in byt.get('ACME GEAR COMPANY', {}).get('b', '') and byt['ACME GEAR COMPANY']['n'].startswith('Prefers delivery')
          and mock.rows[acme]['notes'].startswith('Prefers delivery'))
    mock.qc_update(other, notes='call before 3pm\nAsk for Joe (cell 361-555-0119)')
    await sync_now(pg)
    byt = {x['t']: x for x in await pg.evaluate(CARDS_JS)}
    check('notes round-trip: notes edited on another device arrive', 'Ask for Joe' in byt['COASTAL PUMP REPAIR']['n'])
    newc = mock.qc_insert('DELTA MACHINE WORKS', 'Phone: 361-555-0102\nAddress: 4400 FM 666, Robstown TX 78380', 'C-102')
    await sync_now(pg)
    byt = {x['t']: x for x in await pg.evaluate(CARDS_JS)}
    check('new QC customer shows up as a linked card', byt.get('DELTA MACHINE WORKS', {}).get('linked'))

    # ---------- sharing a file ----------
    await show_card(pg, 'STEEL', 'AAA ZENITH STEEL')
    await file_menu(pg, 'Share with QC')
    conf = await pg.text_content('#confirmText'); await pg.click('#confirmOk'); await pg.wait_for_timeout(200)
    await sync_now(pg)
    steel = mock.find(file='STEEL')
    posts = [x[3] for x in mock.rest_writes() if x[0] == 'POST']
    check('shared file uploaded: 28 STEEL rows, source=cardfile, customer_id NULL, file=STEEL', len(steel) == 28 and all(r['source'] == 'cardfile' and r['customer_id'] is None for r in steel),
          f'{len(steel)} rows; confirm: {conf.splitlines()[0]}')
    check('insert payload per contract: title, body, notes, source, customer_id (+ id, file); nothing else', posts and all(set(p) <= INSERT_KEYS and p['source'] == 'cardfile' and p['customer_id'] is None for p in posts)
          and all(len(p['title']) <= 39 for p in posts), str(posts[0].keys()))
    check('share confirmation says QC shows the cards and warns about personal data', 'QC app shows every card' in conf and 'EMPLST' in conf)
    await pg.click('#menubar > .menu:nth-child(1) > button'); await pg.wait_for_timeout(150)
    await pg.screenshot(path=f'{OUT}/qc-share-toggle.png')
    await pg.keyboard.press('Escape'); await pg.click('#workspace', position={'x': 1000, 'y': 600})
    await show_card(pg, 'STEEL', 'AAA ZENITH STEEL')
    await caret_end(pg, '#bodyText'); await pg.keyboard.type('\nNEW REP: DANA 361-555-0150')
    await pg.wait_for_timeout(500); await sync_now(pg)
    r = [x for x in mock.find(file='STEEL') if 'ZENITH' in x['title']][0]
    check('edit in shared file pushed (update by id)', 'NEW REP: DANA' in r['body'])
    await pg.keyboard.press('F6'); await pg.fill('#indexInput', 'AAA ZENITH STEEL CO'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(500)
    await sync_now(pg)
    check('rename pushed', mock.rows[r['id']]['title'] == 'AAA ZENITH STEEL CO')
    await show_card(pg, 'STEEL', 'KESTREL ALLOYS')
    crucible = [x for x in mock.find(file='STEEL') if x['title'].strip() == 'KESTREL ALLOYS'][0]['id']
    await delete_card(pg); await sync_now(pg)
    check('delete = soft delete: deleted_at set, row kept, no DELETE request', mock.rows[crucible]['deleted_at'] is not None and not [x for x in mock.log if x[0] == 'DELETE'])
    await pg.click('#menubar > .menu:nth-child(2) > button'); await pg.click('#menubar > .menu:nth-child(2) li button:has-text("Undo")'); await pg.wait_for_timeout(500)
    await sync_now(pg)
    check('undo of delete brings the row back (deleted_at NULL)', mock.rows[crucible]['deleted_at'] is None)

    # ---------- unshared files never uploaded ----------
    await show_card(pg, 'EMPLST', (await pg.evaluate('cardfileApp.state().files.find(f => f.name === "EMPLST").cards[0].title')))
    await pg.click('#bodyText'); await pg.keyboard.type('PRIVATE-EMPLST-EDIT ')
    await show_card(pg, 'PHONENUB', (await pg.evaluate('cardfileApp.state().files.find(f => f.name === "PHONENUB").cards[0].title')))
    await pg.keyboard.press('F7'); await pg.fill('#addInput', 'PRIVATE PHONENUB CARD'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(500)
    await sync_now(pg)
    sent = json.dumps([x[3] for x in mock.log if x[1].startswith('/rest/')])
    check('unshared files never uploaded (EMPLST/PHONENUB edits and new cards stay local)', 'PRIVATE' not in sent and 'EMPLST' not in sent and 'PHONENUB' not in sent)

    # ---------- offline edit queued, pushed when back online ----------
    await show_card(pg, 'CUSTOMERS', 'COASTAL PUMP REPAIR')
    await ctx.set_offline(True); await pg.wait_for_timeout(200)
    await caret_end(pg, '#notesText'); await pg.keyboard.type('\nOFFLINE NOTE: quote sent')
    await pg.wait_for_timeout(1500)
    lbl = (await pg.text_content('#syncLabel')).strip(); pend = await pg.evaluate('CardSync._store().outbox.length')
    check('offline edit queued in the outbox', pend == 1 and 'Offline' in lbl and '1 change waiting' in lbl and 'OFFLINE NOTE' not in (mock.rows[other]['notes'] or ''), lbl)
    await pg.screenshot(path=f'{OUT}/qc-offline-queued.png')
    await ctx.set_offline(False)
    await pg.wait_for_function('CardSync._store().outbox.length === 0 && !CardSync.status().running', timeout=20000)
    check('back online: queued edit pushed automatically', 'OFFLINE NOTE: quote sent' in mock.rows[other]['notes'])

    # ---------- QC links a cardfile row ----------
    jr = [x for x in mock.find(file='STEEL') if 'ZENITH' in x['title']][0]['id']
    mock.qc_link(jr, 'C-200')
    await sync_now(pg)
    await show_card(pg, 'STEEL', 'AAA ZENITH STEEL CO')
    check('QC linked a cardfile row: badge + read-only', await pg.is_visible('.card.front .qcbadge') and await pg.evaluate('document.querySelector("#bodyText").readOnly'))
    await pg.fill('#notesText', 'Linked in QC as C-200; still my notes'); await pg.wait_for_timeout(500)
    n0 = len(mock.rest_writes()); await sync_now(pg)
    w = mock.rest_writes()[n0:]
    check('after linking only notes (+file) are written back', w and all(set(x[3]) <= {'notes', 'file'} for x in w) and mock.rows[jr]['notes'].startswith('Linked in QC'), str([x[3] for x in w])[:120])
    mock.qc_update(jr, title='ZENITH STEEL (QC NAME)')
    await sync_now(pg)
    check('QC owns the linked title from now on; notes kept', await pg.evaluate('cardfileApp.state().files.find(f => f.name === "STEEL").cards.some(c => c.title === "ZENITH STEEL (QC NAME)" && (c.notes || "").startsWith("Linked in QC"))'))

    mock.qc_update(other, body='  JOE  361-555-0111\n  (changed on another device)')
    await sync_now(pg)
    byt = {x['t']: x for x in await pg.evaluate(CARDS_JS)}
    check('unlinked row changed elsewhere: newer remote text applied', 'another device' in byt['COASTAL PUMP REPAIR']['b'])

    # ---------- QC deletes customers: it only clears customer_id ----------
    mock.qc_unlink(acme); mock.qc_unlink(bolt)
    await sync_now(pg)
    byt = {x['t']: x for x in await pg.evaluate(CARDS_JS)}
    check('QC cleared customer_id: card WITH notes kept as "No longer in QC"; without notes removed here (row untouched)',
          byt.get('ACME GEAR COMPANY', {}).get('gone') is True and 'BOLT & NUT SUPPLY' not in byt and mock.rows[bolt]['deleted_at'] is None, json.dumps(list(byt))[:120])
    await show_card(pg, 'CUSTOMERS', 'ACME GEAR COMPANY')
    check('"No longer in QC" badge; card editable again', await pg.is_visible('.card.front .qcbadge.gone') and not await pg.evaluate('document.querySelector("#bodyText").readOnly'))
    await pg.mouse.move(5, 800); await pg.screenshot(path=f'{OUT}/qc-no-longer-in-qc.png')
    await caret_end(pg, '#notesText'); await pg.keyboard.type(' Moved to Corpus.'); await pg.wait_for_timeout(400)
    await sync_now(pg)
    check('kept card stays tied to its row: notes still sync', mock.rows[acme]['notes'].endswith('Moved to Corpus.'))
    await sync_now(pg)
    n = await pg.evaluate(f'{CUST}.cards.length')
    check('released QC rows without notes are not pulled in again', n == 3, f'{n} cards')
    mock.qc_link(acme, 'C-100')
    await sync_now(pg)
    byt = {x['t']: x for x in await pg.evaluate(CARDS_JS)}
    check('QC links it again: the same card is linked again (no duplicate), notes kept', byt['ACME GEAR COMPANY']['linked'] and not byt['ACME GEAR COMPANY']['gone']
          and byt['ACME GEAR COMPANY']['n'].endswith('Moved to Corpus.') and n == len(byt))
    mock.qc_unlink(acme); await sync_now(pg)
    # a row removed by an admin (vanishes) with notes: kept on full resync
    await show_card(pg, 'CUSTOMERS', 'DELTA MACHINE WORKS')
    await pg.fill('#notesText', 'Met at the trade show'); await pg.wait_for_timeout(500); await sync_now(pg)
    mock.hard_delete(newc)
    await pg.evaluate('CardSync.fullResync()'); await pg.wait_for_function('!CardSync.status().running', timeout=20000)
    byt = {x['t']: x for x in await pg.evaluate(CARDS_JS)}
    check('full resync: vanished linked row with notes kept as "No longer in QC", never re-uploaded', byt.get('DELTA MACHINE WORKS', {}).get('gone') is True
          and not mock.find(title='DELTA MACHINE WORKS'))

    # ---------- notes in search / Go To / Find / print / JSON export ----------
    await pg.select_option('#filePicker', 'ALL')
    await pg.keyboard.press('F4'); await pg.fill('#gotoInput', 'trade show'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
    check('Go To finds text in My notes', (await pg.text_content('.card.front .t')).strip() == 'DELTA MACHINE WORKS')
    await pg.fill('#quickSearch', 'gate code'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
    cnt = await pg.text_content('#searchAllCount'); snip = await pg.text_content('#searchAllList')
    check('Search All Files searches notes', '1 matching' in cnt and 'My notes' in snip, cnt)
    await pg.click('#searchAllList li button >> nth=0'); await pg.wait_for_timeout(200)
    await pg.click('#menubar > .menu:nth-child(5) > button'); await pg.click('#menubar > .menu:nth-child(5) li button:has-text("Find…")')
    await pg.fill('#findInput', 'quote sent'); await pg.click('#findNextBtn'); await pg.wait_for_timeout(200)
    sel = await pg.evaluate('document.activeElement.id + ":" + document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)')
    check('Find searches My notes and selects the hit there', sel == 'notesText:quote sent', sel)
    await pg.keyboard.press('Escape')
    await pg.evaluate('window.print = () => { window.__pn = document.querySelector("#printArea").textContent }')
    await show_card(pg, 'CUSTOMERS', 'COASTAL PUMP REPAIR')
    await pg.click('#menubar > .menu:nth-child(1) > button'); await pg.click('#menubar > .menu:nth-child(1) li button:has-text("Print") >> nth=0'); await pg.wait_for_timeout(200)
    check('print includes My notes', 'My notes: call before 3pm' in (await pg.evaluate('window.__pn') or ''))
    async with pg.expect_download() as dl:
        await file_menu(pg, 'Export Backup')
    d = await dl.value; pth = f'/tmp/{d.suggested_filename}'; await d.save_as(pth); j = json.load(open(pth))
    jc = [f for f in j['files'] if f['name'] == 'CUSTOMERS'][0]; js = [f for f in j['files'] if f['name'] == 'STEEL'][0]
    check('JSON backup includes notes, sharing and sync info', jc.get('builtin') == 'customers' and js.get('shared') and any(c.get('notes') for c in jc['cards']) and any(c.get('sync') for c in js['cards']))

    # ---------- stop sharing ----------
    await show_card(pg, 'STEEL', 'ADDER PIPE & SUPPLY')
    await file_menu(pg, 'Share with QC')
    conf = await pg.text_content('#confirmText'); await pg.click('#confirmOk'); await pg.wait_for_timeout(200)
    await sync_now(pg)
    live = [x for x in mock.find(file='STEEL') if x['deleted_at'] is None]
    check('stop sharing: uploaded rows get deleted_at (QC stops showing them), QC-linked row untouched, cards stay here', len(live) == 1 and live[0]['customer_id'] == 'C-200'
          and await pg.evaluate('cardfileApp.state().files.find(f => f.name === "STEEL").cards.length') == 28, f'{len(live)} live; {conf.splitlines()[0]}')
    await caret_end(pg, '#bodyText'); await pg.keyboard.type(' AFTER-UNSHARE'); await pg.wait_for_timeout(500); await sync_now(pg)
    check('edits after unsharing stay local', 'AFTER-UNSHARE' not in json.dumps([x[3] for x in mock.log]))

    # ---------- sync errors in plain words ----------
    mock.fail.append((500, {'message': 'boom'}))
    st = await sync_now(pg)
    check('server error shown in plain words', 'QC server had a problem' in st['lastError'] and await pg.is_visible('#syncError'), st['lastError'])
    mock.fail.append((403, {'code': '42501', 'message': 'new row violates row-level security policy for table "customer_cards"'}))
    st = await sync_now(pg)
    check('RLS refusal explained', 'RLS' in st['lastError'], st['lastError'])
    await pg.screenshot(path=f'{OUT}/qc-sync-error.png')
    mock.down = True; st = await sync_now(pg); mock.down = False
    check('network failure explained; data kept', 'Can’t reach the QC server' in st['lastError'] and await pg.evaluate(f'{CUST}.cards.length') >= 3, st['lastError'])
    st = await sync_now(pg)
    check('next good sync clears the error; last-synced time shown', not st['lastError'] and not await pg.is_visible('#syncError') and (await pg.text_content('#syncLabel')).strip().startswith('Synced '))
    await show_card(pg, 'CUSTOMERS', 'COASTAL PUMP REPAIR')
    await pg.mouse.move(5, 800); await pg.screenshot(path=f'{OUT}/qc-notes.png')
    await pg.select_option('#filePicker', '0'); await pg.click('#menubar > .menu:nth-child(3) > button'); await pg.click('#menubar > .menu:nth-child(3) li button:has-text("List")')
    await pg.wait_for_timeout(200); await pg.screenshot(path=f'{OUT}/qc-customers-list.png')
    await pg.click('#menubar > .menu:nth-child(3) > button'); await pg.click('#menubar > .menu:nth-child(3) li button:has-text("Card")')
    check('no JS errors (sync)', not errors, '; '.join(errors[:4]))

    # ---------- offline startup ----------
    off = await ctx.new_page(); oerr = []
    off.on('pageerror', lambda e: oerr.append(str(e)))
    await off.add_init_script("Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false })")
    await off.route('https://cdn.jsdelivr.net/**', lambda r: r.abort())
    await off.route(MOCK + '/**', lambda r: r.abort())
    await off.goto(URL); await off.wait_for_selector('.card.front', state='attached')
    n = await off.evaluate(f'{CUST}.cards.length'); lbl = (await off.text_content('#syncLabel')).strip()
    check('offline startup: synced cards and notes available from this browser, status "Offline"', n >= 3 and lbl.startswith('Offline') and not oerr, f'{n} cards, {lbl}, {oerr[:2]}')
    await off.close()

    # ---------- sign out ----------
    await file_menu(pg, 'Sign out of QC sync'); await pg.wait_for_timeout(300)
    lbl = (await pg.text_content('#syncLabel')).strip()
    check('sign out: indicator off, cards stay, app keeps working', lbl == 'Sign in to sync' and 'signed out' in await pg.text_content('#syncUser')
          and await pg.evaluate(f'{CUST}.cards.length') >= 3)
    await ctx.close()

    # ---------- table not created yet (migration not applied): calm status, app keeps working ----------
    m2 = MockSupabase(MOCK, table_exists=False); m2.add_qc_user('gary', '1234')
    c2 = await new_ctx(b, mock=m2)
    p2 = await c2.new_page(); e2 = []; p2.on('pageerror', lambda e: e2.append(str(e)))
    await p2.goto(URL); await p2.wait_for_selector('.card.front', state='attached')
    await sign_in(p2, 'gary', '1234')
    st = await p2.evaluate('CardSync.status()'); lbl = (await p2.text_content('#syncLabel')).strip()
    check('missing table: "QC sync not available yet", no error shown, no activation needed for an active account',
          st['unavailable'] and not st['lastError'] and lbl == 'QC sync not available yet' and not await p2.is_visible('#syncError') and not m2.activations, f'{lbl}; {st["lastError"]}')
    await p2.screenshot(path=f'{OUT}/qc-not-available.png')
    await p2.select_option('#filePicker', '0')
    await p2.keyboard.press('F7'); await p2.fill('#addInput', 'KESTREL WELDING'); await p2.keyboard.press('Enter'); await p2.wait_for_timeout(200)
    await p2.keyboard.type('  BOX 5\n  ARANSAS PASS TX'); await p2.wait_for_timeout(300)
    n0 = len(m2.log); await p2.wait_for_timeout(1500)
    check('missing table: editing works, change waits, automatic syncs don’t hammer the server', len(m2.log) == n0 and await p2.evaluate('CardSync._store().outbox.length') == 1
          and (await p2.text_content('#syncLabel')).strip() == 'QC sync not available yet', f'{len(m2.log) - n0} requests')
    m2.table_exists = True                                      # migration applied
    await p2.click('#btnSync'); await p2.wait_for_timeout(300); await p2.wait_for_function('!CardSync.status().running', timeout=20000)
    st = await p2.evaluate('CardSync.status()')
    check('after the migration: Sync button checks again, waiting card uploaded', not st['unavailable'] and not st['lastError'] and m2.find(title='KESTREL WELDING') and st['pending'] == 0, str(st)[:120])
    check('no JS errors (missing table)', not e2, '; '.join(e2[:3]))
    await c2.close()

    # ---------- file column absent (added later); QC unlink of cardfile/qc rows; title limit ----------
    m3 = MockSupabase(MOCK, file_column=False); m3.add_qc_user('gary', '1234')
    ra = m3.qc_insert('EAGLE FORD SERVICES', 'Contact: Ann Lee\nPhone: 361-555-0170', 'C-1')
    rb = m3.qc_insert('FALCON OILFIELD', 'Phone: 361-555-0171', 'C-2')
    c3 = await new_ctx(b, mock=m3, viewport={'width': 1100, 'height': 760})
    p3 = await c3.new_page(); e3 = []; p3.on('pageerror', lambda e: e3.append(str(e)))
    await p3.goto(URL); await p3.wait_for_selector('.card.front', state='attached')
    await sign_in(p3, 'Gary ', '1234')
    st = await p3.evaluate('CardSync.status()'); byt = {x['t']: x for x in await p3.evaluate(CARDS_JS)}
    check('file column absent: probe answers 400 "column does not exist" -> sync works without it',
          st['fileColumn'] is False and not st['lastError'] and byt['EAGLE FORD SERVICES']['linked'] and byt['EAGLE FORD SERVICES']['n'] == '', st['lastError'])
    check('already-activated user: signs in directly (no activation call); username trimmed + lower-cased', not m3.activations
          and [x[3] for x in m3.log if x[1] == '/auth/v1/token'][-1]['email'] == qc_email('gary'))
    await show_card(p3, 'AC', (await p3.evaluate('cardfileApp.state().files.find(f => f.name === "AC").cards[0].title')))
    await file_menu(p3, 'Share with QC'); conf = await p3.text_content('#confirmText'); await p3.click('#confirmOk'); await p3.wait_for_timeout(200)
    await show_card(p3, 'CUSTOMERS', 'EAGLE FORD SERVICES'); await p3.fill('#notesText', 'Ann prefers e-mail'); await p3.wait_for_timeout(300)
    await p3.keyboard.press('F7'); await p3.fill('#addInput', 'GULF COAST VALVE'); await p3.keyboard.press('Enter'); await p3.wait_for_timeout(800)
    await p3.keyboard.type('  BOX 77\n  INGLESIDE TX'); await p3.wait_for_timeout(1000)
    await p3.evaluate(f'(() => {{ {CUST}.cards.push({{ id: "longt", title: "A VERY LONG COMPANY NAME THAT GOES ON AND ON", body: "x" }}); CardSync.localChanged(); }})()')
    st = await sync_now(p3)
    nv = m3.find(title='GULF COAST VALVE'); ac = m3.find(source='cardfile')
    check('file column absent: nothing reads or writes it; notes, new cards and the shared AC file uploaded', not st['lastError'] and m3.rows[ra]['notes'] == 'Ann prefers e-mail'
          and len(nv) == 1 and 'file' not in nv[0] and not any('file' in (x[3] or {}) for x in m3.rest_writes()) and len(ac) == 6 + 2, f'{st["lastError"]} ac={len(ac)} nv={len(nv)} notes={m3.rows[ra]["notes"]!r}')
    check('share confirmation mentions the missing file column', 'no file column yet' in conf)
    longt = [x for x in m3.rows.values() if x['title'].startswith('A VERY LONG')]
    check('index line longer than 39 characters is cut to 39 when uploaded', len(longt) == 1 and len(longt[0]['title']) == 39)
    # QC links the cardfile card, then deletes that customer: a Cardfile card without notes simply becomes a normal card again
    gid = nv[0]['id']; m3.qc_link(gid, 'C-3'); await sync_now(p3)
    linked_now = await p3.evaluate(f'{CUST}.cards.find(c => c.title === "GULF COAST VALVE").sync.linked')
    m3.qc_unlink(gid); m3.qc_unlink(ra); m3.qc_unlink(rb)
    await sync_now(p3); byt = {x['t']: x for x in await p3.evaluate(CARDS_JS)}
    check('QC cleared customer_id: qc card with notes -> "No longer in QC"; qc card without notes removed; Cardfile card stays (editable)',
          linked_now and byt.get('EAGLE FORD SERVICES', {}).get('gone') is True and 'FALCON OILFIELD' not in byt
          and 'GULF COAST VALVE' in byt and not byt['GULF COAST VALVE']['linked'] and not byt['GULF COAST VALVE']['gone'], json.dumps(list(byt))[:160])
    await show_card(p3, 'CUSTOMERS', 'GULF COAST VALVE'); await delete_card(p3); st = await sync_now(p3)
    check('delete sets deleted_at (soft delete)', m3.rows[gid]['deleted_at'] is not None and not st['lastError'], st['lastError'])
    # the file column is added later: next session finds it and fills it in for shared files
    m3.add_file_column()
    await file_menu(p3, 'Sign out of QC sync'); await sign_in(p3, 'gary', '1234')
    await p3.wait_for_function('!CardSync.status().running && CardSync._store().outbox.length === 0', timeout=20000)
    st = await p3.evaluate('CardSync.status()')
    acrows = [x for x in m3.rows.values() if x['source'] == 'cardfile' and x.get('file') == 'AC']
    check('file column added later: found on the next sign-in, AC rows get file=AC, Customers rows stay NULL', st['fileColumn'] is True and len(acrows) == 6
          and m3.rows[ra].get('file') is None, f'{len(acrows)} AC rows')
    check('no JS errors (file column absent / added)', not e3, '; '.join(e3[:3]))
    await c3.close()

    # ---------- column names that don't match the table: a plain message ----------
    m4 = MockSupabase(MOCK); m4.add_qc_user('gary', '1234'); m4.qc_insert('HAWK PIPE', 'Phone: 361-555-0172', 'C-9')
    c4 = await new_ctx(b, mock=m4, extra="columns: { deleted: 'deleted', deletedAt: null }")
    p4 = await c4.new_page(); await p4.goto(URL); await p4.wait_for_selector('.card.front', state='attached')
    await sign_in(p4, 'gary', '1234')
    await show_card(p4, 'CUSTOMERS', 'HAWK PIPE')
    await p4.keyboard.press('F7'); await p4.fill('#addInput', 'IBIS SUPPLY'); await p4.keyboard.press('Enter'); await p4.wait_for_timeout(1000)
    st0 = await sync_now(p4)
    await show_card(p4, 'CUSTOMERS', 'IBIS SUPPLY'); await delete_card(p4); st = await sync_now(p4)
    check('column names that don’t match the table: explained in plain words', not st0['lastError'] and 'has no column' in st['lastError'] and 'config.js' in st['lastError'], st['lastError'])
    await c4.close()

    # ---------- share all files: the table already holds every card (tools/upload_cards.py); first sign-in binds, never duplicates ----------
    import upload_cards
    seed, _ = upload_cards.planned(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'testdata', 'fixture_cards.json'))
    m7 = MockSupabase(MOCK); m7.add_qc_user('gary', '1234')
    for r in seed:
        t = m7.now(); m7.rows[r['id']] = dict(r, created_at=t, updated_at=t, deleted_at=None)
    qcid = m7.qc_insert('BALCONES MINERALS', 'Phone: 361-555-0100', 'C-1')
    c7 = await new_ctx(b, mock=m7, extra='shareAllFiles: true'); e7 = []
    p7 = await c7.new_page(); p7.on('pageerror', lambda e: e7.append(str(e))); await p7.goto(URL); await p7.wait_for_selector('.card.front', state='attached')
    await sign_in(p7, 'gary', '1234')
    await p7.wait_for_function('!CardSync.status().running && CardSync._store().outbox.length === 0', timeout=30000)
    posts = [x for x in m7.rest_writes() if x[0] == 'POST']
    bound = await p7.evaluate('''(() => { const out = []; for (const f of cardfileApp.state().files) if (f.builtin !== 'customers')
        for (const c of f.cards) out.push({f: CardSync.fileFor(f), t: c.title, b: c.body, id: c.sync && c.sync.id}); return out; })()''')
    ok = sum(1 for x in bound if x['id'] in m7.rows and m7.rows[x['id']]['title'] == ''.join(list(x['t'])[:39]) and m7.rows[x['id']]['body'] == x['b']
             and m7.rows[x['id']]['file'] == x['f'])
    check('share all: first sign-in binds all 88 uploaded rows to their local cards (same file/title/body, distinct ids incl. duplicate + empty-title cards), no inserts',
          len(bound) == len(seed) == 88 and ok == 88 and len({x['id'] for x in bound}) == 88 and not posts and len(m7.rows) == 89,
          f'{ok}/{len(bound)} bound, {len(posts)} POSTs, {len(m7.rows)} rows')
    check('share all: QC rows untouched (no PATCH to the QC customer row), Customers card appears', not [x for x in m7.rest_writes() if qcid in x[1] + json.dumps(x[2:])]
          and any(c['t'] == 'BALCONES MINERALS' for c in await p7.evaluate(CARDS_JS)))
    hidden = await p7.evaluate('''(() => { const b = [...document.querySelectorAll('#menubar li button')].find(x => /Share with/.test(x.textContent)); return !b || b.closest('li').hidden || b.hidden || getComputedStyle(b.closest('li')).display === 'none'; })()''')
    await show_card(p7, 'STEEL', bound[[x['f'] for x in bound].index('STEEL')]['t'])
    chip = await p7.text_content('#shareChip') if await p7.query_selector('#shareChip') else ''
    check('share all: the per-file Share toggle is hidden and every file shows as shared', hidden and 'Shared with QC' in (chip or ''), f'hidden={hidden} chip={chip!r}')
    # a local edit after binding goes up as an update of that same row
    await p7.fill('#notesText', 'seed edit test'); await p7.wait_for_timeout(300); await sync_now(p7)
    patched = [x for x in m7.rest_writes() if x[0] == 'PATCH']
    srow = [r for r in m7.rows.values() if r.get('notes') == 'seed edit test']
    check('share all: an edit of a bound card patches that row (no new row)', len(srow) == 1 and srow[0]['file'] == 'STEEL' and len(m7.rows) == 89 and patched,
          f'{len(srow)} rows, {len(m7.rows)} total')
    check('no JS errors (share all)', not e7, '; '.join(e7[:3]))
    await c7.close()

    # ---------- tools/live_check.py against the mock server (the real project is not contacted) ----------
    m5 = MockSupabase('http://mock'); m5.add_qc_user('Zoë', '2468', activated=False)
    srv, base = serve(m5)
    env = dict(os.environ, SUPABASE_URL=base, SUPABASE_PUBLISHABLE_KEY=PUBLISHABLE, RG_USERNAME='Zoë', RG_PIN='2468')
    lc = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'live_check.py')
    res = subprocess.run([sys.executable, lc], env=env, capture_output=True, text=True, timeout=60)
    test_rows = [x for x in m5.rows.values() if x['title'].startswith('ZZ CARDFILE LIVE CHECK')]
    check('live_check.py passes against the mock (activate, insert, read back, patch notes, soft delete)', res.returncode == 0 and 'ALL CHECKS PASSED' in res.stdout
          and len(test_rows) == 1 and test_rows[0]['deleted_at'] and '2468' not in res.stdout + res.stderr, ' | '.join((res.stdout + res.stderr).strip().splitlines()[-1:]))
    srv.shutdown()
    m6 = MockSupabase('http://mock', file_column=False); m6.add_qc_user('gary', '1234')
    srv, base = serve(m6)
    res = subprocess.run([sys.executable, lc], env=dict(env, SUPABASE_URL=base, RG_USERNAME='gary', RG_PIN='1234'), capture_output=True, text=True, timeout=60)
    check('live_check.py passes without a file column too (activated account: no activation call)', res.returncode == 0 and 'absent' in res.stdout and not m6.activations,
          ' | '.join(res.stdout.strip().splitlines()[-1:]))
    m6.table_exists = False
    res = subprocess.run([sys.executable, lc], env=dict(env, SUPABASE_URL=base, RG_USERNAME='gary', RG_PIN='1234'), capture_output=True, text=True, timeout=60)
    check('live_check.py reports a missing table clearly', res.returncode != 0 and 'customer_cards' in res.stdout and 'not exist' in res.stdout, ' | '.join(res.stdout.strip().splitlines()[-1:]))
    srv.shutdown()

    check('the real Supabase project was never contacted', not real_hits, str(real_hits[:3]))


async def main():
    URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/'
    OUT = os.environ.get('SCREENS', '/tmp/sync-screens'); os.makedirs(OUT, exist_ok=True)
    results = []
    def check(name, cond, extra=''):
        results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name, extra)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        await sync_tests(b, URL, OUT, check)
        await b.close()
    print(f'\n{sum(results)}/{len(results)} sync checks passed')
    sys.exit(0 if all(results) else 1)

if __name__ == '__main__':
    asyncio.run(main())
