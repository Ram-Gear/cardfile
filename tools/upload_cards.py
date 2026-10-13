#!/usr/bin/env python3
"""Upload every card of a cards.json export (made by tools/extract_crd.py; NOT kept in the repo) into public.customer_cards (one-time seed of the shared table; Gary approved all 88
files on 2026-10-13, including EMPLST, PHONENUB and GOLF).

Each card becomes {id, title, body, notes: null, source: 'cardfile', customer_id: null, file}:
  * id    deterministic: uuid5(NS, "<sourceFile>\\n<index in the file>\\n<title>"), so a rerun never duplicates
  * file  the card file's name as Cardfile knows it: source file without .CRD ('STEEL', 'ramunit')
  * pictures are not in the schema: skipped (listed)
Rows that already exist (same id, or a live source='cardfile' row with the same file + title + body, e.g. uploaded by the
app) are not inserted again. Existing QC rows are never touched. Only INSERT and SELECT are used.

  RG_USERNAME=… RG_PIN=… python3 tools/upload_cards.py            # dry run: signs in, compares, inserts nothing
  RG_USERNAME=… RG_PIN=… python3 tools/upload_cards.py --apply    # insert the missing rows, then verify
The username and PIN are never printed or stored.
"""
import collections, json, os, sys, uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_check as L

NS = uuid.uuid5(uuid.NAMESPACE_URL, 'https://github.com/Ram-Gear/cardfile#seed-cards')
DATA = os.environ.get('CARDS_JSON', '')   # path to the extracted cards.json (outside the repo)
BATCH = 100


def file_value(f):
    sf = f.get('sourceFile') or ''
    return sf.rsplit('.', 1)[0] if '.' in sf else (sf or f['name'])


def card_id(f, i, c):
    return str(uuid.uuid5(NS, f"{f.get('sourceFile') or f['name']}\n{i}\n{c['title']}"))


def planned(path=None):
    rows, pics = [], []
    for f in json.load(open(path or DATA, encoding='utf-8')):
        for i, c in enumerate(f['cards']):
            if c.get('image'):
                pics.append((file_value(f), c['title'].strip() or '(no index line)'))
            title = ''.join(list(c['title'])[:39])
            rows.append({'id': card_id(f, i, c), 'title': title, 'body': c.get('body', ''), 'notes': None,
                         'source': 'cardfile', 'customer_id': None, 'file': file_value(f)})
    return rows, pics


def select_all(tok, query):
    out, off = [], 0
    while True:
        st, j = L.call('GET', f'/rest/v1/{L.TABLE}?{query}&order=id.asc&limit=1000&offset={off}', token=tok)
        if st != 200:
            raise SystemExit(f'select failed: HTTP {st} {j}')
        out += j
        if len(j) < 1000:
            return out
        off += 1000


def sign_in():
    creds = {'email': L.qc_email(L.USER), 'password': 'rg1:' + L.PIN}
    st, j = L.call('POST', '/auth/v1/token?grant_type=password', creds)
    if st != 200:
        raise SystemExit(f'sign-in failed: HTTP {st} {(j or {}).get("msg") if isinstance(j, dict) else ""}')
    return j['access_token']


def main():
    apply = '--apply' in sys.argv
    if not (L.URL and L.KEY and L.USER and L.PIN) or not L.KEY.startswith('sb_publishable_'):
        print('Set RG_USERNAME and RG_PIN; a publishable key is required.'); return 2
    rows, pics = planned()
    print(f'Project {L.URL}, table {L.TABLE}; {len(rows)} cards in {len({r["file"] for r in rows})} files; '
          f'{"APPLY" if apply else "dry run"} (credentials from env, not shown)')
    tok = sign_in()
    try:
        existing = select_all(tok, 'select=id,file,title,body,deleted_at&source=eq.cardfile')
        ids = {r['id'] for r in existing}
        content = collections.Counter((str(r['file'] or '').lower(), r['title'], r['body']) for r in existing if not r['deleted_at'] and r['id'] not in {x['id'] for x in rows})
        todo = []
        for r in rows:
            if r['id'] in ids:
                continue
            k = (r['file'].lower(), r['title'], r['body'])
            if content[k] > 0:          # already uploaded by the app (different id): don't duplicate
                content[k] -= 1; continue
            todo.append(r)
        print(f'already in the table: {len(rows) - len(todo)}; to insert: {len(todo)}')
        failed = []
        if apply:
            for i in range(0, len(todo), BATCH):
                chunk = todo[i:i + BATCH]
                st, j = L.call('POST', f'/rest/v1/{L.TABLE}', chunk, token=tok, prefer='return=minimal')
                if st == 409:                    # a row appeared meanwhile: one by one, skipping duplicates
                    for r in chunk:
                        s1, j1 = L.call('POST', f'/rest/v1/{L.TABLE}', r, token=tok, prefer='return=minimal')
                        if s1 not in (201, 409):
                            failed.append((r['file'], r['title'], s1, j1))
                elif st != 201:
                    failed += [(r['file'], r['title'], st, j) for r in chunk]
                print(f'  batch {i // BATCH + 1}: HTTP {st}')
        # verify
        live = select_all(tok, 'select=id,file&source=eq.cardfile&deleted_at=is.null')
        want = collections.Counter(r['file'] for r in rows)
        mine = {r['id'] for r in rows}
        got = collections.Counter(r['file'] for r in live if r['id'] in mine)
        other = collections.Counter(r['file'] for r in live if r['id'] not in mine)
        print('\nfile          expected  in table')
        for f in sorted(want, key=str.lower):
            flag = '' if got[f] == want[f] else '   <-- MISMATCH'
            print(f'{f:<14}{want[f]:>8}{got[f]:>10}{flag}')
        print(f'{"TOTAL":<14}{sum(want.values()):>8}{sum(got.values()):>10}')
        if other:
            print('other live source=cardfile rows (not from this seed):', dict(other))
        hits, sts = {}, []
        for col in ('title', 'body'):
            st, j = L.call('GET', f'/rest/v1/{L.TABLE}?select=id,title,file&source=eq.cardfile&deleted_at=is.null&{col}=ilike.*bearing*&limit=1000', token=tok)
            sts.append(st); hits.update({r['id']: r for r in j} if isinstance(j, list) else {})
        sample = sorted((r['file'], r['title'].strip()) for r in hits.values())
        print(f'\nsample search "bearing" in title or body: HTTP {sts}, {len(sample)} rows; first few: {sample[:5]}')
        print(f'\npictures skipped ({len(pics)} cards):'); [print(f'  {f}: {t}') for f, t in pics]
        if failed:
            print(f'\nFAILED ({len(failed)}):'); [print('  ', x[:3], str(x[3])[:200]) for x in failed]
        ok = not failed and all(got[f] == want[f] for f in want)
        print('\nRESULT:', 'OK' if ok else ('DRY RUN' if not apply else 'PROBLEMS'))
        return 0 if ok or not apply else 1
    finally:
        L.call('POST', '/auth/v1/logout?scope=local', {}, token=tok)


if __name__ == '__main__':
    sys.exit(main())
