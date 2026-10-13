"""A small in-memory stand-in for Supabase, shaped like the QC contract (ramgear-app/supabase/migrations/002_customer_cards.sql):
GoTrue password sign-in, the rg-admin "activate" Edge Function, and the PostgREST subset Cardfile uses on public.customer_cards.

Used two ways:
  * Playwright request routing (MockSupabase.handle), so the real supabase-js runs against it in the browser (tools/test_sync.py);
  * a local HTTP server (serve()), so tools/live_check.py can be tried without touching the real project.

Emulates: updated_at set by a trigger on every insert/update; unique id and customer_id; title max 39 characters; soft delete
via deleted_at; SELECT/INSERT/UPDATE for signed-in users only, no DELETE, anon nothing; optional `file` column (file_column=);
the table not existing yet (table_exists=False -> 404 PGRST205); unknown columns rejected like PostgREST (400 42703 / PGRST204);
filters eq/neq/gt/gte/lt/lte/is, order, limit, offset, Prefer: return=representation.
QC-side helpers (qc_insert, qc_update, qc_link, qc_unlink, hard_delete) play the QC app / admin in tests.
"""
import asyncio, base64, json, threading, time, uuid
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit, parse_qsl

CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*',
        'access-control-expose-headers': '*', 'content-type': 'application/json'}
PUBLISHABLE = 'sb_publishable_mock_for_tests'
QC_COLS = ('id', 'customer_id', 'title', 'body', 'notes', 'source', 'created_at', 'updated_at', 'deleted_at')
META = ('select', 'order', 'limit', 'offset', 'columns', 'on_conflict')


def norm(username):
    return str(username or '').strip().lower()


def qc_email(username):   # same mapping as the QC app and the rg-admin function: 'u' + hex(UTF-8 of trimmed, lower-cased username)
    return 'u' + norm(username).encode('utf-8').hex() + '@users.invalid'


def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip('=')


class MockSupabase:
    def __init__(self, base='https://cardfile-mock.supabase.co', table='customer_cards', file_column=True, table_exists=True,
                 publishable=PUBLISHABLE):
        self.base, self.table, self.publishable = base, table, publishable
        self.file_column, self.table_exists = file_column, table_exists
        self.rows = {}
        self.log = []            # (method, path, query dict, body)
        self.users = {}          # email -> password (active cloud accounts)
        self.members = {}        # username -> PIN: QC users imported from a tablet, not activated for the cloud yet
        self.activations = []    # (username, headers ok) for each activate call
        self.tokens = set()
        self.fail = []           # queued failures for REST calls: 'abort' | (status, body)
        self.down = False        # True: every REST call fails like a dropped network
        self._last = datetime.now(timezone.utc) - timedelta(minutes=5)

    @property
    def cols(self):
        return set(QC_COLS) | ({'file'} if self.file_column else set())

    # ---- server clock (monotonic, close to real time so last-write-wins comparisons make sense) ----
    def now(self):
        t = max(datetime.now(timezone.utc), self._last + timedelta(milliseconds=1))
        self._last = t
        return t.isoformat(timespec='microseconds')

    # ---- QC side helpers ----
    def add_user(self, email, password):
        self.users[email] = password

    def add_qc_user(self, username, pin, activated=True):
        if activated:
            self.users[qc_email(username)] = 'rg1:' + pin
        else:
            self.members[norm(username)] = pin

    def qc_insert(self, title, body, customer_id, notes=None, file=None, source='qc'):
        rid = str(uuid.uuid4()); t = self.now()
        row = {'id': rid, 'customer_id': customer_id, 'title': title, 'body': body, 'notes': notes, 'source': source,
               'created_at': t, 'updated_at': t, 'deleted_at': None}
        if self.file_column:
            row['file'] = file if file is not None or source != 'qc' else 'Customers'   # live QC sets 'Customers' on insert
        self.rows[rid] = row
        return rid

    def qc_update(self, rid, **fields):
        self.rows[rid].update(fields); self.rows[rid]['updated_at'] = self.now()

    def qc_link(self, rid, customer_id):
        self.qc_update(rid, customer_id=customer_id)

    def qc_unlink(self, rid):   # QC deleted the customer: the trigger keeps the row and only clears customer_id
        self.qc_update(rid, customer_id=None)

    def hard_delete(self, rid):   # an admin removing a row by hand (Cardfile itself cannot delete)
        self.rows.pop(rid, None)

    def add_file_column(self):
        self.file_column = True
        for r in self.rows.values():
            r.setdefault('file', None)

    def find(self, **kv):
        return [r for r in self.rows.values() if all(r.get(k) == v for k, v in kv.items())]

    def rest_writes(self):
        return [x for x in self.log if x[1].startswith('/rest/') and x[0] in ('POST', 'PATCH', 'DELETE')]

    # ---- request handling (Playwright route) ----
    async def handle(self, route, request):
        st, hdrs, body = await self.respond(request.method, request.url, request.headers, request.post_data)
        if st == 'abort':
            return await route.abort('internetdisconnected')
        await route.fulfill(status=st, headers=hdrs, body=body)

    async def respond(self, m, url, headers, post_data):
        """returns (status | 'abort', headers, body text)"""
        u = urlsplit(url)
        q = dict(parse_qsl(u.query, keep_blank_values=True))
        headers = {k.lower(): v for k, v in (headers or {}).items()}
        if m == 'OPTIONS':
            return 200, CORS, ''
        try:
            body = json.loads(post_data) if post_data else None
        except Exception:
            body = post_data
        self.log.append((m, u.path, q, body))
        if u.path.startswith('/auth/v1/'):
            return self.auth(u.path[len('/auth/v1/'):], q, body)
        if u.path.startswith('/functions/v1/'):
            return self.function(u.path[len('/functions/v1/'):], headers, body)
        if u.path.startswith('/rest/v1/'):
            if self.down:
                return 'abort', None, None
            if self.fail:
                f = self.fail.pop(0)
                if f == 'abort':
                    return 'abort', None, None
                return self.out(f[0], f[1])
            if u.path != f'/rest/v1/{self.table}' or not self.table_exists:
                name = u.path[len('/rest/v1/'):]
                return self.out(404, {'code': 'PGRST205', 'details': None, 'hint': None,
                                      'message': f"Could not find the table 'public.{name}' in the schema cache"})
            tok = (headers.get('authorization') or '').replace('Bearer ', '')
            if tok not in self.tokens:   # anon: no grants at all
                return self.out(401, {'code': '42501', 'message': f'permission denied for table {self.table}'})
            return self.rest(m, q, body, headers)
        return self.out(404, {'message': 'not found'})

    @staticmethod
    def out(status, data, extra=None):
        h = dict(CORS); h.update(extra or {})
        return status, h, '' if data is None else json.dumps(data)

    def auth(self, path, q, body):
        if path == 'token' and q.get('grant_type') == 'password':
            email, pw = (body or {}).get('email'), (body or {}).get('password')
            if self.users.get(email) != pw:
                return self.out(400, {'code': 400, 'error_code': 'invalid_credentials', 'msg': 'Invalid login credentials'})
            exp = int(time.time()) + 3600
            uid = str(uuid.uuid5(uuid.NAMESPACE_DNS, email))
            tok = b64({'alg': 'HS256', 'typ': 'JWT'}) + '.' + b64({'sub': uid, 'email': email, 'role': 'authenticated', 'aud': 'authenticated', 'exp': exp}) + '.sig'
            self.tokens.add(tok)
            user = {'id': uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': email, 'app_metadata': {'provider': 'email'},
                    'user_metadata': {}, 'created_at': '2026-01-01T00:00:00Z'}
            return self.out(200, {'access_token': tok, 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': exp,
                                  'refresh_token': 'r-' + uid, 'user': user})
        if path == 'logout':
            return self.out(204, None)
        if path == 'user':
            return self.out(200, {'id': 'u', 'email': 'x'})
        return self.out(404, {'msg': 'unsupported in mock: ' + path})

    def function(self, name, headers, body):   # the rg-admin Edge Function, "activate" action only
        if name != 'rg-admin':
            return self.out(404, {'message': 'Function not found'})
        ok_hdr = headers.get('apikey') == self.publishable and headers.get('authorization') == 'Bearer ' + self.publishable
        body = body if isinstance(body, dict) else {}
        user, pin = norm(body.get('username')), str(body.get('password') or '')
        self.activations.append((user, ok_hdr))
        if not ok_hdr:
            return self.out(401, {'ok': False, 'error': 'Invalid JWT'})
        if body.get('action') != 'activate':
            return self.out(400, {'ok': False, 'error': 'unknown action'})
        if self.users.get(qc_email(user)) == 'rg1:' + pin:
            return self.out(200, {'ok': True, 'already': True})
        if self.members.get(user) != pin:
            return self.out(403, {'ok': False, 'error': 'Wrong username or password/PIN.'})
        del self.members[user]
        self.users[qc_email(user)] = 'rg1:' + pin
        return self.out(200, {'ok': True, 'activated': True})

    @staticmethod
    def _val(col, v):
        if v is None:
            return None
        if col in ('updated_at', 'created_at', 'deleted_at'):
            return datetime.fromisoformat(str(v).replace('Z', '+00:00'))
        if isinstance(v, bool):
            return v
        return str(v)

    def _match(self, r, q):
        for k, v in q.items():
            if k in META:
                continue
            op, _, raw = v.partition('.')
            a = self._val(k, r.get(k))
            if op == 'is':
                want = None if raw == 'null' else (raw == 'true')
                if (a is None) != (want is None) or (want is not None and a != want):
                    return False
                continue
            b = self._val(k, raw)
            if a is None:
                return False
            if op == 'eq' and not a == b: return False
            if op == 'neq' and not a != b: return False
            if op == 'gt' and not a > b: return False
            if op == 'gte' and not a >= b: return False
            if op == 'lt' and not a < b: return False
            if op == 'lte' and not a <= b: return False
        return True

    def _project(self, row, q):
        sel = q.get('select', '*')
        return dict(row) if sel in ('', '*') else {c: row.get(c) for c in sel.split(',')}

    def rest(self, m, q, body, headers):
        rep = 'return=representation' in (headers.get('prefer') or '')
        cols = self.cols
        for k in list(q) + [c for c in q.get('select', '*').split(',') if c not in ('', '*')] + [p.split('.')[0] for p in (q.get('order') or '').split(',') if p]:
            if k not in META and k not in cols:
                return self.out(400, {'code': '42703', 'details': None, 'hint': None, 'message': f'column {self.table}.{k} does not exist'})
        items = body if isinstance(body, list) else [body] if isinstance(body, dict) else []
        for it in items:
            for k in it:
                if k not in cols:
                    return self.out(400, {'code': 'PGRST204', 'message': f"Could not find the '{k}' column of '{self.table}' in the schema cache"})
            if len(it.get('title') or '') > 39:
                return self.out(400, {'code': '23514', 'message': 'new row for relation "customer_cards" violates check constraint "customer_cards_title_check"'})
            if 'source' in it and it['source'] not in ('qc', 'cardfile'):
                return self.out(400, {'code': '23514', 'message': 'violates check constraint "customer_cards_source_check"'})
        hit = [r for r in self.rows.values() if self._match(r, q)]
        if m == 'GET':
            for part in reversed((q.get('order') or '').split(',')):
                if part:
                    col, _, d = part.partition('.')
                    hit.sort(key=lambda r: (self._val(col, r.get(col)) is None, self._val(col, r.get(col)) or ''), reverse=d.startswith('desc'))
            off = int(q.get('offset') or 0)
            hit = hit[off: off + int(q['limit'])] if q.get('limit') else hit[off:]
            return self.out(200, [self._project(r, q) for r in hit])
        if m == 'POST':
            out = []
            for it in items:
                rid = it.get('id') or str(uuid.uuid4())
                if rid in self.rows:
                    return self.out(409, {'code': '23505', 'message': 'duplicate key value violates unique constraint "customer_cards_pkey"'})
                if it.get('customer_id') and self.find(customer_id=it['customer_id']):
                    return self.out(409, {'code': '23505', 'message': 'duplicate key value violates unique constraint "customer_cards_customer_id_key"'})
                if 'title' not in it or it['title'] is None:
                    return self.out(400, {'code': '23502', 'message': 'null value in column "title" violates not-null constraint'})
                t = self.now()
                row = {'id': rid, 'customer_id': None, 'title': '', 'body': '', 'notes': None, 'source': 'qc', 'created_at': t, 'deleted_at': None}
                if self.file_column:
                    row['file'] = None
                row.update(it); row['id'] = rid; row['created_at'] = t; row['updated_at'] = t   # defaults + trigger
                self.rows[rid] = row; out.append(row)
            return self.out(201, [self._project(r, q) for r in out] if rep else None)
        if m == 'PATCH':
            for r in hit:
                r.update(body or {}); r['updated_at'] = self.now()   # trigger
            return self.out(200, [self._project(r, q) for r in hit] if rep else None)
        if m == 'DELETE':   # no DELETE grant for authenticated
            return self.out(403, {'code': '42501', 'message': f'permission denied for table {self.table}'})
        return self.out(405, {'message': 'method'})


def serve(mock, port=0):
    """Run the mock as a local HTTP server (for tools/live_check.py). Returns (server, base_url)."""
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
    lock = threading.Lock()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _do(self):
            n = int(self.headers.get('content-length') or 0)
            data = self.rfile.read(n).decode() if n else None
            with lock:
                st, hdrs, body = asyncio.run(mock.respond(self.command, 'http://mock' + self.path, dict(self.headers), data))
            if st == 'abort':
                self.close_connection = True; return
            self.send_response(st)
            for k, v in (hdrs or {}).items():
                self.send_header(k, v)
            b = (body or '').encode()
            self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
        do_GET = do_POST = do_PATCH = do_DELETE = do_OPTIONS = _do

    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}'
