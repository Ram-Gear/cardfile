"""Per-app role tests (QC Rev 1.9: members.card_role none | viewer | editor | admin, RPC card_role(), RLS, RG_CARD_DELETE),
against the in-memory mock (tools/mock_supabase.py). The real project is never contacted.
Run:  python3 tools/test_roles.py http://127.0.0.1:8765/ [scenario ...]   (none viewer editor admin denied legacy; default: all)
Also run at the end of tools/test_app.py."""
import asyncio, json, os, sys
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mock_supabase import MockSupabase
from test_sync import new_ctx, sign_in, sync_now, show_card, caret_end, delete_card, real_hits, CUST, MOCK

LS = 'ramgear-cardfile-v1'
VISIBLE_MENU = '''(label => [...document.querySelectorAll('#menubar li button')].filter(b => b.textContent.replace(/\\s+/g, ' ').trim().startsWith(label))
  .some(b => !b.closest('li').hidden))'''


def server(role, rows=3):
    m = MockSupabase(MOCK); m.add_qc_user('pat', '1111', role=role)
    ids = [m.qc_insert(f'ROLE TEST VENDOR {i}', f'  {i} MAIN ST\n  361-555-01{i:02d}', None, source='cardfile') for i in range(rows)]
    return m, ids


async def page_for(b, m, fixture=False):
    ctx = await new_ctx(b, mock=m, kw_fixture=fixture); pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(URL); await pg.wait_for_selector('#menubar', state='attached')
    return ctx, pg, errs


async def menu_visible(pg, label):
    return await pg.evaluate(VISIBLE_MENU + '(%s)' % json.dumps(label))


def table_writes(m):
    return [x for x in m.rest_writes() if '/rpc/' not in x[1]]


async def t_none(b, check):
    m, _ = server('none')
    ctx, pg, errs = await page_for(b, m, fixture=True)   # this browser still has cached (made-up) cards
    cached = await pg.evaluate('cardfileApp.state().files.length')
    await sign_in(pg, 'pat', '1111', wait=False)
    await pg.wait_for_function('CardSync.status().role === "none" && !CardSync.status().running', timeout=30000)
    st = await pg.evaluate('''({files: cardfileApp.state().files.reduce((n, f) => n + f.cards.length, 0), ls: localStorage.getItem("%s"),
        locked: document.body.classList.contains("locked"), gate: !document.querySelector("#gate").hidden, msg: document.querySelector("#gateMsg").textContent,
        out: !document.querySelector("#gateSignOut").hidden})''' % LS)
    reads = [x for x in m.log if x[0] == 'GET' and x[1] == '/rest/v1/customer_cards']
    check('role none: no cards, local cache cleared, plain "no Cardfile access yet" message, table never read',
          cached > 0 and st['files'] == 0 and (st['ls'] is None or json.loads(st['ls'])['files'] == []) and st['locked'] and st['gate']
          and 'don’t have Cardfile access yet' in st['msg'] and st['out'] and not reads and not table_writes(m), json.dumps(st)[:200])
    await pg.reload(); await pg.wait_for_timeout(1500)
    st2 = await pg.evaluate('({n: cardfileApp.state().files.reduce((n, f) => n + f.cards.length, 0), locked: document.body.classList.contains("locked")})')
    check('role none: still locked and empty after reload', st2['n'] == 0 and st2['locked'], str(st2))
    await pg.click('#gateSignOut'); await pg.wait_for_timeout(500)
    check('role none: Sign out returns to the normal sign-in screen', not await pg.is_visible('#gateSignOut') and await pg.is_visible('#gateText'))
    check('no JS errors (role none)', not errs, '; '.join(errs[:3]))
    await ctx.close()


async def t_viewer(b, check):
    m, ids = server('viewer')
    ctx, pg, errs = await page_for(b, m)
    await sign_in(pg, 'pat', '1111')
    n = await pg.evaluate(f'{CUST}.cards.length')
    check('viewer: cards are shown', n == 3 and not await pg.evaluate('document.body.classList.contains("locked")'), str(n))
    hidden = {l: not await menu_visible(pg, l) for l in ['Add', 'Delete', 'Duplicate', 'Scan business card', 'Import .CRD', 'Restore Backup', 'New card file', 'Index', 'Delete this card file']}
    check('viewer: Add, Delete, Duplicate, Scan, Import, Restore Backup, New file, Index all hidden', all(hidden.values()), str(hidden))
    check('viewer: still allowed to search, print and export', await menu_visible(pg, 'Go To') and await menu_visible(pg, 'Export Backup') and await menu_visible(pg, 'Print'))
    ro = await pg.evaluate('({b: document.querySelector("#bodyText").readOnly, n: (document.querySelector("#notesText") || {readOnly: true}).readOnly, scan: document.querySelector("#btnScan").hidden})')
    check('viewer: card text and notes read-only, camera button hidden', ro['b'] and ro['n'] and ro['scan'], str(ro))
    await pg.click('#workspace', position={'x': 900, 'y': 300})
    for k in ['F7', 'F6', 'F8']:
        await pg.keyboard.press(k); await pg.wait_for_timeout(150)
    dlg = await pg.evaluate('!!document.querySelector("dialog[open]")')
    check('viewer: F7 / F6 / F8 open nothing', not dlg)
    await pg.keyboard.type('typed by viewer'); await pg.wait_for_timeout(300)
    # even a change forced into the data is never sent
    await pg.evaluate(f'(() => {{ {CUST}.cards[0].body += " FORCED"; {CUST}.cards.push({{id: "vx", title: "VIEWER NEW", body: ""}}); CardSync.localChanged(); }})()')
    st = await sync_now(pg)
    check('viewer: nothing is pushed (no insert/update/delete requests), status says Read-only',
          not table_writes(m) and 'Read-only' in await pg.text_content('#syncLabel') and not any('typed by viewer' in r['body'] for r in m.rows.values()),
          f"{len(table_writes(m))} writes; {await pg.text_content('#syncLabel')}")
    check('no JS errors (viewer)', not errs, '; '.join(errs[:3]))
    await ctx.close()


async def t_editor(b, check):
    m, ids = server('editor')
    ctx, pg, errs = await page_for(b, m)
    await sign_in(pg, 'pat', '1111')
    vis = {l: await menu_visible(pg, l) for l in ['Add', 'Duplicate', 'Scan business card', 'Import .CRD', 'Index']}
    check('editor: add / duplicate / scan / import / index available', all(vis.values()), str(vis))
    check('editor: Delete card and Delete card file hidden', not await menu_visible(pg, 'Delete'), '')
    await show_card(pg, 'CUSTOMERS', 'ROLE TEST VENDOR 1')
    await caret_end(pg, '#bodyText'); await pg.keyboard.type('\nEDITOR WAS HERE'); await pg.wait_for_timeout(500)
    await sync_now(pg)
    check('editor: edits are pushed', 'EDITOR WAS HERE' in m.rows[ids[1]]['body'])
    await pg.keyboard.press('F7'); await pg.fill('#addInput', 'EDITOR NEW CARD'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(1200)
    await sync_now(pg)
    check('editor: new cards are inserted', bool(m.find(title='EDITOR NEW CARD')))
    check('no JS errors (editor)', not errs, '; '.join(errs[:3]))
    await ctx.close()


async def t_admin(b, check):
    m, ids = server('admin')
    ctx, pg, errs = await page_for(b, m)
    await sign_in(pg, 'pat', '1111')
    check('admin: Delete card and Delete card file shown', await menu_visible(pg, 'Delete') and await menu_visible(pg, 'Delete this card file'))
    await show_card(pg, 'CUSTOMERS', 'ROLE TEST VENDOR 2')
    await delete_card(pg); await sync_now(pg)
    check('admin: delete is pushed (deleted_at set)', m.rows[ids[2]]['deleted_at'] is not None)
    check('no JS errors (admin)', not errs, '; '.join(errs[:3]))
    await ctx.close()


async def t_denied(b, check):
    # the role was lowered to editor after this browser queued a delete: the server answers RG_CARD_DELETE
    m, ids = server('editor')
    ctx, pg, errs = await page_for(b, m)
    await sign_in(pg, 'pat', '1111')
    await pg.evaluate(f'(() => {{ const f = {CUST}; f.cards.splice(f.cards.findIndex(c => c.title === "ROLE TEST VENDOR 0"), 1); CardSync.localChanged(); }})()')
    await sync_now(pg)
    await pg.wait_for_timeout(300)
    msg = await pg.text_content('#confirmText') if await pg.is_visible('#confirmText') else ''
    back = await pg.evaluate(f'{CUST}.cards.some(c => c.title === "ROLE TEST VENDOR 0")')
    st = await pg.evaluate('CardSync.status()')
    check('RG_CARD_DELETE: friendly message, card put back here, row untouched, nothing left waiting',
          'Only a Cardfile admin can delete' in msg and 'ROLE TEST VENDOR 0' in msg and back and m.rows[ids[0]]['deleted_at'] is None and st['pending'] == 0 and not st['lastError'],
          f'{msg[:80]!r} back={back} pending={st["pending"]} err={st["lastError"]!r}')
    if await pg.is_visible('#confirmOk'): await pg.click('#confirmOk')
    tries = lambda: [x for x in m.log if x[0] == 'PATCH' and 'deleted_at' in (x[3] or {})]
    n1 = len(tries())
    await sync_now(pg); await sync_now(pg, manual=False); await pg.wait_for_timeout(1500)
    check('RG_CARD_DELETE: not retried in a loop (one attempt only)', n1 == 1 and len(tries()) == 1, f'{n1} -> {len(tries())}')
    # an Undo of an already-pushed delete (undelete) is an admin action too
    m.rows[ids[1]]['deleted_at'] = m.now(); m.rows[ids[1]]['updated_at'] = m.now()
    await sync_now(pg)
    gone = not await pg.evaluate(f'{CUST}.cards.some(c => c.title === "ROLE TEST VENDOR 1")')
    check('a card deleted by an admin disappears for the editor', gone)
    check('no JS errors (RG_CARD_DELETE)', not errs, '; '.join(errs[:3]))
    await ctx.close()


async def t_legacy(b, check):
    m, ids = server(None); m.rpc_exists = False
    ctx, pg, errs = await page_for(b, m)
    await sign_in(pg, 'pat', '1111')
    st = await pg.evaluate('CardSync.status()')
    check('server without card_role(): treated as the default role (editor), sync works, no error',
          st['role'] == 'editor' and not st['lastError'] and await pg.evaluate(f'{CUST}.cards.length') == 3 and not await menu_visible(pg, 'Delete'), json.dumps({k: st[k] for k in ('role', 'lastError')}))
    check('no JS errors (legacy server)', not errs, '; '.join(errs[:3]))
    await ctx.close()


async def t_livecheck(b, check):
    # tools/live_check.py with an editor account: soft delete must be refused with RG_CARD_DELETE, hard DELETE refused
    import subprocess
    from mock_supabase import serve, PUBLISHABLE
    m = MockSupabase('http://mock'); m.add_qc_user('ed', '3579', role='editor')
    srv, base = serve(m)
    lc = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'live_check.py')
    env = dict(os.environ, SUPABASE_URL=base, SUPABASE_PUBLISHABLE_KEY=PUBLISHABLE, RG_USERNAME='ed', RG_PIN='3579')
    res = await asyncio.to_thread(subprocess.run, [sys.executable, lc], env=env, capture_output=True, text=True, timeout=60)
    rows = [x for x in m.rows.values() if x['title'].startswith('ZZ CARDFILE LIVE CHECK')]
    check('live_check.py as an editor: RG_CARD_DELETE on soft delete, hard DELETE refused, row kept live', res.returncode == 0 and 'ALL CHECKS PASSED' in res.stdout
          and 'RG_CARD_DELETE' in res.stdout and len(rows) == 1 and rows[0]['deleted_at'] is None and '3579' not in res.stdout + res.stderr,
          ' | '.join((res.stdout + res.stderr).strip().splitlines()[-2:]))
    srv.shutdown()


SCENARIOS = {'none': t_none, 'viewer': t_viewer, 'editor': t_editor, 'admin': t_admin, 'denied': t_denied, 'legacy': t_legacy, 'livecheck': t_livecheck}
URL = 'http://127.0.0.1:8765/'


async def role_tests(b, url, check, names=None):
    global URL
    URL = url
    for n in names or SCENARIOS:
        await SCENARIOS[n](b, check)
    check('roles: the real Supabase project was never contacted', not real_hits, str(real_hits[:3]))


async def main():
    url = sys.argv[1] if len(sys.argv) > 1 else URL
    names = sys.argv[2:] or None
    results = []
    def check(name, cond, extra=''):
        results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name, extra, flush=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        await role_tests(b, url, check, names)
        await b.close()
    print(f'\n{sum(results)}/{len(results)} role checks passed')
    sys.exit(0 if all(results) else 1)

if __name__ == '__main__':
    asyncio.run(main())
