"""Help link: static Grok URL (fixed question, no data), new tab, noopener noreferrer; visible signed out and with sync off.
Run: python3 tools/test_help.py http://127.0.0.1:8765/"""
import asyncio, sys
from urllib.parse import quote
from playwright.async_api import async_playwright
Q = "I'm using Ram-Gear's Cardfile, a web card-file app for customer and shop records that signs in with a QC Form login. Please read https://ram-gear.github.io/cardfile/help.html first, then give me pointers."
EXPECTED = 'https://grok.com/?q=' + quote(Q, safe="-_.!~*'()")   # same as JavaScript encodeURIComponent
REAL = 'https://dbveedcksommanxshpzx.supabase.co'

async def main():
    url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/'
    res = []
    def check(n, c, x=''):
        res.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n, x, flush=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, init in [('signed out (sign-in screen)', ''), ('sync off', "window.CARDFILE_SUPABASE = { publishableKey: '' };")]:
            ctx = await b.new_context(); await ctx.route(REAL + '/**', lambda r: r.abort())
            if init: await ctx.add_init_script(init)
            pg = await ctx.new_page(); await pg.goto(url); await pg.wait_for_timeout(1200)
            a = await pg.evaluate('(() => { const a = document.querySelector("#helpLink"); return a && {href: a.getAttribute("href"), target: a.target, rel: a.rel, text: a.textContent.trim()}; })()')
            js = await pg.evaluate('q => "https://grok.com/?q=" + encodeURIComponent(q)', Q)
            check(f'{name}: Help href is exactly the static Grok link', a and a['href'] == EXPECTED == js, a and a['href'])
            check(f'{name}: target=_blank, rel="noopener noreferrer", label Help', a and a['target'] == '_blank' and set(a['rel'].split()) == {'noopener', 'noreferrer'} and a['text'] == 'Help', str(a))
            vis = await pg.is_visible('#helpLink')
            top = await pg.evaluate('(() => { const r = document.querySelector("#helpLink").getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e && e.closest("#helpLink") !== null; })()')
            check(f'{name}: Help visible and on top (clickable)', vis and top)
            if 'signed out' in name:
                check('signed out: sign-in screen shown under the Help button', await pg.is_visible('#gate'))
                g = await pg.evaluate('(() => { const a = document.querySelector("#gateHelp"); return a && a.getAttribute("href"); })()')
                check('signed out: sign-in screen links help.html', g == 'help.html' and await pg.is_visible('#gateHelp'), g)
            else:
                await pg.click('#menubar >> text=Help'); await pg.wait_for_timeout(200)
                async with ctx.expect_page() as np: await pg.click('text=User guide (help.html)')
                hp = await np.value; await hp.wait_for_load_state()
                check('sync off: Help > User guide opens help.html', hp.url.endswith('/help.html'), hp.url)
                await hp.close()
            await ctx.close()
        ctx = await b.new_context(); pg = await ctx.new_page(); r = await pg.goto(url.rstrip('/') + '/help.html')
        txt = await pg.inner_text('body')
        check('help.html loads (200) with all sections', r.status == 200 and await pg.evaluate('ids => ids.every(i => document.getElementById(i))', ['what', 'signin', 'card', 'list', 'scan', 'menus', 'tasks', 'roles', 'practice', 'trouble']))
        check('help.html: no external scripts, no Supabase', await pg.evaluate('[...document.scripts].every(s => !s.src)') and 'supabase' not in (await pg.content()).lower(), str(len(txt)))
        await ctx.close()
        # practice boxes: run fully offline (every non-local request is counted and blocked)
        ctx = await b.new_context(); ext = []
        async def guard(r):
            if r.request.url.startswith(url.rstrip('/')): await r.continue_()
            else: ext.append(r.request.url); await r.abort()
        await ctx.route('**/*', guard); pg = await ctx.new_page(); await pg.goto(url.rstrip('/') + '/help.html')
        async def t1(q):
            await pg.fill('#t1in', q); await pg.click('#t1go'); return await pg.inner_text('#t1res')
        r = await t1('bluebird'); check('try 1: unique word -> Correct', r.startswith('Correct'), r)
        r = await t1('widgets'); check('try 1: word in 2 cards -> Incorrect with reason', r.startswith('Incorrect') and 'matches 2 cards' in r, r)
        r = await t1('zzz'); check('try 1: no match -> Incorrect with reason', r.startswith('Incorrect') and 'no sample card' in r, r)
        r = await t1('gears'); check('try 1: wrong card -> Incorrect with reason', r.startswith('Incorrect') and 'Maple' in r, r)
        for v, ok in [('editor', False), ('viewer', False), ('admin', True)]:
            await pg.check(f'input[name=t2][value={v}]'); await pg.click('#t2go'); r = await pg.inner_text('#t2res')
            check(f'try 2: {v} -> ' + ('Correct' if ok else 'Incorrect with reason'), r.startswith('Correct') if ok else (r.startswith('Incorrect: ') and len(r) > 15), r)
        for v, ok in [('F5', False), ('F7', True)]:
            await pg.check(f'input[name=t3][value={v}]'); await pg.click('#t3go'); r = await pg.inner_text('#t3res')
            check(f'try 3: {v} -> ' + ('Correct' if ok else 'Incorrect with reason'), r.startswith('Correct') if ok else 'Autodial' in r, r)
        st = await pg.evaluate('[localStorage.length, sessionStorage.length]')
        check('practice: no network requests and nothing stored', not ext and st == [0, 0], str(ext) + str(st))
        # Ask Grok link on every section
        links = await pg.evaluate('[...document.querySelectorAll("main section")].map(s => { const a = s.querySelector("a.askGrok"); return [s.id, a && a.getAttribute("href"), a && a.target, a && a.rel]; })')
        from urllib.parse import urlparse, parse_qs
        good = []
        for sid, href, tgt, rel in links:
            q = href and parse_qs(urlparse(href).query).get('q', [''])[0]
            good.append(bool(href) and href.startswith('https://grok.com/?q=') and 'read https://ram-gear.github.io/cardfile/help.html first' in q and tgt == '_blank' and set((rel or '').split()) == {'noopener', 'noreferrer'})
        check(f'Ask Grok link on all {len(links)} sections (static q, reads help.html first, _blank, noopener noreferrer)', len(links) >= 11 and all(good), str([l[0] for l, g in zip(links, good) if not g]))
        await ctx.close()
        await b.close()
    print(f'\n{sum(res)}/{len(res)} help checks passed'); sys.exit(0 if all(res) else 1)

asyncio.run(main())
