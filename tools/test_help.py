"""Help link: static Grok URL (fixed question, no data), new tab, noopener noreferrer; visible signed out and with sync off.
Run: python3 tools/test_help.py http://127.0.0.1:8765/"""
import asyncio, sys
from urllib.parse import quote
from playwright.async_api import async_playwright
Q = "I'm using Ram-Gear's Cardfile, a web card-file app for customer and shop records that signs in with a QC Form login. Can you give me pointers on how to use it?"
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
            await ctx.close()
        await b.close()
    print(f'\n{sum(res)}/{len(res)} help checks passed'); sys.exit(0 if all(res) else 1)

asyncio.run(main())
