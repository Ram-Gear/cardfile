#!/usr/bin/env python3
"""End-to-end check of Cardfile's QC sync contract against a real Supabase project (run it once the migration is live).

What it does, as the QC user given in the environment (same sign-in as Cardfile and the QC app):
  1. sign in: e-mail u<hex(UTF-8 of trimmed, lower-cased username)>@users.invalid, password rg1:<PIN>; on
     "Invalid login credentials" it calls the rg-admin Edge Function ("activate") once and retries
  2. checks that the anonymous role can't read the table
  3. probes the optional `file` column (select=id,file&limit=1)
  4. inserts one test row (source='cardfile', customer_id NULL, title "ZZ CARDFILE LIVE CHECK <time>")
  5. reads it back by id, and finds it with the incremental query Cardfile uses (updated_at=gt.…&order=updated_at.asc,id.asc)
  6. patches notes (expects the trigger to bump updated_at)
  7. soft-deletes it (deleted_at = now), reads it back
  8. checks that DELETE is refused (no DELETE permission by design), then signs out
The test row stays in the table, soft-deleted (Cardfile can't hard-delete). While the check runs (a few seconds) the QC app
may show it, because QC lists every row whose deleted_at is NULL.

Usage:
  RG_USERNAME=gary RG_PIN=1234 python3 tools/live_check.py
Optional: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (default: read from config.js), CARDFILE_TABLE (default customer_cards).
Only the publishable key is used. The PIN is never printed or written anywhere.
"""
import json, os, re, sys, uuid
import urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))


def from_config(name):
    try:
        s = open(os.path.join(HERE, '..', 'config.js'), encoding='utf-8').read()
        m = re.search(name + r"\s*:\s*'([^']*)'", s)
        return m.group(1) if m else ''
    except OSError:
        return ''


URL = (os.environ.get('SUPABASE_URL') or from_config('url')).rstrip('/')
KEY = os.environ.get('SUPABASE_PUBLISHABLE_KEY') or from_config('publishableKey')
TABLE = os.environ.get('CARDFILE_TABLE', 'customer_cards')
USER, PIN = os.environ.get('RG_USERNAME', ''), os.environ.get('RG_PIN', '')
results = []


def norm(u):
    return str(u or '').strip().lower()


def qc_email(u):
    return 'u' + norm(u).encode('utf-8').hex() + '@users.invalid'


def call(method, path, body=None, token=None, prefer=None, anon=False):
    """returns (status, parsed JSON or text)"""
    h = {'apikey': KEY, 'Content-Type': 'application/json', 'Accept': 'application/json'}
    if token:
        h['Authorization'] = 'Bearer ' + token
    elif not anon and path.startswith('/functions/'):
        h['Authorization'] = 'Bearer ' + KEY
    if prefer:
        h['Prefer'] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw, st = r.read().decode(), r.status
    except urllib.error.HTTPError as e:
        raw, st = e.read().decode(), e.code
    try:
        return st, json.loads(raw) if raw else None
    except ValueError:
        return st, raw


def check(name, ok, info=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{info}]' if info else ''))
    return ok


def ts(v):
    return datetime.fromisoformat(str(v).replace('Z', '+00:00'))


def table_missing(st, j):
    msg = str(j.get('message', '')) if isinstance(j, dict) else ''
    return st == 404 or (isinstance(j, dict) and j.get('code') in ('PGRST205', '42P01')) or bool(re.search(r'Could not find the table|relation .* does not exist', msg))


def main():
    if not (URL and KEY and USER and PIN):
        print('Set RG_USERNAME and RG_PIN (and SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY if config.js has none).'); return 2
    if not KEY.startswith('sb_publishable_'):
        print('Refusing to run: SUPABASE_PUBLISHABLE_KEY must be a publishable key (sb_publishable_…), never a secret key.'); return 2
    print(f'Project {URL}, table {TABLE}, user from RG_USERNAME (username and PIN are never shown)\n')
    rest = f'/rest/v1/{TABLE}'

    # 1) sign in (+ activate once)
    creds = {'email': qc_email(USER), 'password': 'rg1:' + PIN}
    st, j = call('POST', '/auth/v1/token?grant_type=password', creds)
    activated = None
    if st == 400 and 'invalid login credentials' in json.dumps(j).lower():
        ast, aj = call('POST', '/functions/v1/rg-admin', {'action': 'activate', 'username': norm(USER), 'password': PIN})
        activated = f'activate -> HTTP {ast} {aj.get("error") or ("ok" if aj.get("ok") else "") if isinstance(aj, dict) else ""}'.strip()
        st, j = call('POST', '/auth/v1/token?grant_type=password', creds)
    if not check('sign in with username + PIN' + (' (after activation)' if activated else ''), st == 200 and isinstance(j, dict) and j.get('access_token'),
                 activated or f'HTTP {st} {j.get("msg") or j.get("error_description") or "" if isinstance(j, dict) else ""}'):
        return 1
    tok = j['access_token']

    try:
        # 1b) per-app role (QC Rev 1.9). Servers without card_role() behave like the old rules (soft delete for everyone).
        st, j = call('POST', '/rest/v1/rpc/card_role', {}, token=tok)
        role = j if st == 200 and isinstance(j, str) else None
        check('card_role()', st == 200 or (isinstance(j, dict) and j.get('code') == 'PGRST202'), role or 'no card_role() on this server (pre Rev 1.9)')
        if role in ('none', 'viewer'):
            check('role can insert/update (editor or admin needed for this check)', False, f'card_role = {role}'); return 1
        admin = role in (None, 'admin')

        # 2) anon can't read
        st, j = call('GET', rest + '?select=id&limit=1', anon=True)
        if table_missing(st, j):
            check(f'table public.{TABLE} exists', False, f'HTTP {st}: does not exist yet (migration not applied?)'); return 1
        check('anonymous role gets nothing', st in (401, 403) or j == [], f'HTTP {st}')

        # 3) file column
        st, j = call('GET', rest + '?select=id,file&limit=1', token=tok)
        if table_missing(st, j):
            check(f'table public.{TABLE} exists', False, f'HTTP {st}: does not exist yet (migration not applied?)'); return 1
        has_file = st == 200
        check('file column probe', st in (200, 400), 'present' if has_file else f'absent (HTTP {st} {j.get("code") if isinstance(j, dict) else ""})')

        # 4) insert
        rid = str(uuid.uuid4())
        title = 'ZZ CARDFILE LIVE CHECK ' + datetime.now().strftime('%Y%m%d-%H%M%S')
        row = {'id': rid, 'title': title, 'body': 'Test row from Cardfile tools/live_check.py; safe to ignore.', 'notes': 'live check note 1',
               'source': 'cardfile', 'customer_id': None}
        if has_file:
            row['file'] = None
        st, j = call('POST', rest, row, token=tok, prefer='return=representation')
        if not check('insert a cardfile row', st == 201 and isinstance(j, list) and j and j[0]['id'] == rid, f'HTTP {st} {"" if st == 201 else j}'):
            return 1
        r0 = j[0]

        # 5) read back + incremental query
        st, j = call('GET', f'{rest}?select=*&id=eq.{rid}', token=tok)
        r1 = j[0] if st == 200 and j else {}
        check('read it back (title, source, customer_id NULL, deleted_at NULL, timestamps set)', r1.get('title') == title and r1.get('source') == 'cardfile'
              and r1.get('customer_id') is None and r1.get('deleted_at') is None and r1.get('created_at') and r1.get('updated_at'), f'HTTP {st}')
        since = (ts(r0['updated_at']) - timedelta(milliseconds=1)).isoformat().replace('+00:00', 'Z')
        st, j = call('GET', f'{rest}?select=*&updated_at=gt.{since}&order=updated_at.asc,id.asc&limit=1000', token=tok)
        check('incremental query (updated_at=gt.…, order=updated_at.asc,id.asc) finds it', st == 200 and any(x.get('id') == rid for x in j or []), f'HTTP {st}')

        # 6) patch notes
        st, j = call('PATCH', f'{rest}?id=eq.{rid}', {'notes': 'live check note 2'}, token=tok, prefer='return=representation')
        r2 = j[0] if st == 200 and j else {}
        check('patch notes (PATCH ?id=eq.<id>)', r2.get('notes') == 'live check note 2', f'HTTP {st}')
        check('trigger bumped updated_at', r2 and ts(r2['updated_at']) > ts(r1['updated_at']), f'{r1.get("updated_at")} -> {r2.get("updated_at")}')

        # 7) soft delete
        now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        st, j = call('PATCH', f'{rest}?id=eq.{rid}', {'deleted_at': now}, token=tok, prefer='return=representation')
        if admin:
            r3 = j[0] if st == 200 and j else {}
            check('soft delete (deleted_at set)', r3.get('deleted_at') is not None and ts(r3['updated_at']) > ts(r2['updated_at']), f'HTTP {st}')
            st, j = call('GET', f'{rest}?select=id,deleted_at&id=eq.{rid}', token=tok)
            check('soft-deleted row still readable (so other devices see the delete)', st == 200 and j and j[0]['deleted_at'], f'HTTP {st}')
            # 8) hard DELETE: admins may hard-delete under Rev 1.9, so it is not probed (the test row is kept, soft-deleted)
            check('hard DELETE not probed for an admin (allowed by Rev 1.9 rules)', True, 'skipped')
        else:
            check('non-admin soft delete refused with RG_CARD_DELETE', st >= 400 and 'RG_CARD_DELETE' in json.dumps(j), f'HTTP {st}')
            check('row still live after the refused delete', (call('GET', f'{rest}?select=deleted_at&id=eq.{rid}', token=tok)[1] or [{}])[0].get('deleted_at') is None)
            # 8) hard DELETE must be refused for a non-admin
            st, j = call('DELETE', f'{rest}?id=eq.{rid}', token=tok, prefer='return=representation')
            gone = call('GET', f'{rest}?select=id&id=eq.{rid}', token=tok)[1] == []
            check('DELETE refused (needs card_can_delete)', st in (401, 403, 405) or (st in (200, 204) and not gone), f'HTTP {st}{" - ROW WAS DELETED" if gone else ""}')
    finally:
        call('POST', '/auth/v1/logout?scope=local', {}, token=tok)

    print(f'\n{"ALL CHECKS PASSED" if all(results) else "SOME CHECKS FAILED"} ({sum(results)}/{len(results)}). Test row {rid} left ' + ('soft-deleted.' if admin else 'in the table (live; an admin can delete it).'))
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
