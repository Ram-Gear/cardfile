# Cardfile (Ram-Gear Manufacturing)

A browser rebuild of the old **Windows 3.1 Cardfile** program the shop used (1996–2003) to keep vendor, supplier and
contact cards.

**The repository contains no card data.** The cards live in the shared Supabase table `customer_cards` (the same table the QC app
uses). The app opens on a sign-in screen; after signing in with a QC username and PIN it downloads the cards and keeps a copy in
the browser (localStorage) as a cache.

It is plain HTML/CSS/JavaScript with no build step and no server code, so it can be hosted as static files (e.g. GitHub Pages).
The only outside dependency is the OCR engine for **Scan business card** ([Tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0),
which is downloaded from the jsDelivr CDN only when you first scan a card.

## Data and privacy

- No card data, pictures or extracted files are committed (the history was rewritten in Oct 2026 to remove the old seed data).
- Only the Supabase **publishable** key is in `config.js`; Row Level Security lets only signed-in QC members read or write.
- Signed out, the app shows only the sign-in screen. Tests use made-up cards (`tools/make_fixture.py`).

## Run locally

```bash
python3 -m http.server 8765      # from the repo root
# open http://127.0.0.1:8765/
```

Opening `index.html` directly from disk also works.

Edits are saved automatically in the browser (localStorage), separately for each browser and computer. Use **File > Export Backup (JSON)**
and **File > Restore Backup** to move data between them. **File > Reset (reload cards)** clears this browser and downloads the shared cards again.

## Features (mirrors the original Cardfile)

- **Opening files:** File > Open (Ctrl+O) or the File dropdown picks a card file. **(All files)** shows every card in one stack.
- **Views:** Card view (stacked cards, edit the front card) and List view, with an *N Cards* count. Text uses a proportional font by default; **View → Fixed-width text** switches to monospace when space-padded columns need to line up.
- **Card commands:** Add **F7**, Index/rename **F6** (max 39 characters), Delete (with confirmation), Duplicate, Restore, Undo.
- **Search:**
  - Go To **F4** searches index lines (case-insensitive, matches part of a line, wraps around).
  - Find / Find Next **F3** searches card text, with a Match Case option.
  - Search All Files (Ctrl+Shift+F).
- **Navigation:** PgUp/PgDn, Ctrl+Home/End, Ctrl+Shift+letter, A–Z letter bar.
- **Phones:** phone numbers are `tel:` links (this replaces Autodial, **F5**).
- **Scan business card** (new; Card > Scan business card, the camera button in the toolbar, or **F8**):
  1. Take a photo (phones open the camera), choose an existing image, use a webcam (desktop), or drag/paste an image in.
     Use the rotate buttons if the photo is sideways.
  2. The text is read **in the browser** with Tesseract.js. The photo is never uploaded. The first scan downloads about 7 MB
     (engine and English data from cdn.jsdelivr.net); after that it is cached by the browser. Before reading, the photo is
     turned upright from its EXIF data, scaled to at most 2000 px, converted to grayscale with stretched contrast, and
     inverted if the card has light text on a dark background.
  3. The text is split into company, name, title, office/cell/fax/toll-free phones, email, website, street, and
     city/state/ZIP. You can correct any field (or the read text, then **Re-read fields from text**) and pick the card file
     to save to: the current file, any other file, or a new one.
  4. **Save card** adds a card in the usual style: the index line is the company in capitals (or the person's name),
     then the address lines, `NAME (TITLE)  office phone`, `CELL`, `FAX`, `TOLL FREE`, email, and website. Phones become `tel:`
     links. Tick **Keep the photo on the card** to store a small JPEG (about 30 KB) with the card. This is off by default
     because browser storage is limited.
  - If the OCR engine can't be downloaded (you're offline or the CDN is blocked), or the photo has no readable text,
    you get a message and can **Type it in instead** using the same form.
  - The parser is built for US-style cards. Logos, very stylized fonts, vertical text, and cards with several people or
    addresses may need hand corrections.
- **Printing:** Print the current card or Print All.
- **Import/export:** import other `.CRD` files (MGC / RRG / LCP), export a `.CRD` (Cardfile 3.0 format, text only) or JSON.

## QC sync (two-way, Supabase)

Cardfile shares cards with the QC app through the table `public.customer_cards` in the QC app's Supabase project
(`https://dbveedcksommanxshpzx.supabase.co`). The table is defined by the QC app's migration
`ramgear-app/supabase/migrations/002_customer_cards.sql`. **Until that migration is applied, Cardfile shows
"QC sync not available yet" and otherwise works as usual.** Signed out, offline, or without the table, nothing leaves the
browser except the sign-in itself.

### Setup

All settings are in `config.js`. It holds the project URL and the **publishable** key (`sb_publishable_…`). That key is
public by design; Row Level Security decides who can read or write. Never put a secret / `service_role` key there.
Set `publishableKey: ''` to switch sync off completely: no Customers file, no Sync button, no network calls.

**Signing in:** click **Sign in to sync** (status bar) or **File › Sign in to QC sync…**, and use your QC app **Username**
and **PIN**. These are the same accounts as the QC app, and you need to be a QC member (`public.is_member()`).
- Cardfile calls `signInWithPassword` with the e-mail `u<hex of the UTF-8 bytes of the trimmed, lower-cased username>@users.invalid`
  and the password `rg1:<PIN>`.
- If that fails with *Invalid login credentials*, Cardfile activates the account once and retries. Activation is the
  `rg-admin` Edge Function, called with the publishable key; it covers users imported from a QC tablet who haven't used
  the cloud yet.
- The PIN is never logged or stored. supabase-js keeps the session (tokens only) in this browser under `cardfile-sb-auth`.
- `auth.method` can switch sign-in to e-mail + password, an e-mailed code, or a magic link.

supabase-js v2 is loaded from jsDelivr only when sync is configured. The version is pinned (2.117.2, same as the QC app)
and checked with Subresource Integrity.

### What syncs

- **Customers** is a built-in card file that is always shared. QC customers arrive here, and cards you add here are uploaded.
- **All files are shared** (`shareAllFiles: true` in `config.js`; Gary's decision, Oct 2026). All 88 original files, including
  EMPLST, PHONENUB and GOLF, were uploaded once with `tools/upload_cards.py` (546 cards, `source='cardfile'`, `file` = card
  file name such as `STEEL` or `ramunit`; the 5 cards with pictures were uploaded without their pictures).
  - **The QC app shows every row whose `deleted_at` is NULL, whatever its source**, so all cards appear in QC.
  - On first sign-in Cardfile binds those rows to its local cards: an exact title+body match first, then a unique title
    match. Nothing is uploaded twice.
  - With `shareAllFiles: false` the per-file **File › Share with QC** toggle comes back (off by default). Turning a file
    off soft-deletes its uploaded cards; the cards stay in Cardfile.
- **The `file` column** (optional, Cardfile-owned) records which card file a row belongs to.
  - Cardfile checks once per session whether the column exists (`select=id,file&limit=1`; a "column does not exist" 400
    means no). It reads and writes the column only if it is there.
  - Without it, cards from shared files show up in Customers on other devices.
  - When the column is added later, the next session fills it in for rows already uploaded.
- **When it syncs:** the **Sync** button or **File › Sync with QC now**. It also syncs automatically when the app opens
  online and signed in, a few seconds after each change, and when the browser comes back online.
  **File › Full resync with QC** re-reads everything.
- **Pull** is incremental: `select=*&updated_at=gt.<last>&order=updated_at.asc,id.asc`, paged. It includes soft-deleted
  rows, so deletes reach every device.
- **Push** inserts `{id, title, body, notes, source:'cardfile', customer_id:null}`, plus `file` when present. The id is
  a UUID made in the browser, so a retried insert can't duplicate a row. `updated_at`, `created_at` and `deleted_at` are
  left to the server.
- **Updates** use `PATCH ?id=eq.<id>`. For a card that isn't linked, the update also carries `customer_id=is.null`, so
  title/body can never overwrite a row QC has just linked; Cardfile then writes notes only. Index lines longer than 39
  characters are cut to 39 when uploaded (the table's limit).
- **Delete** is a soft delete only: Cardfile sets `deleted_at`. There is no DELETE permission.
- **Offline:** changes wait in an outbox in localStorage. The status bar shows `Offline · N changes waiting`,
  `Synced 9:41 AM`, `QC sync not available yet`, or `Sync problem` with the reason in plain words.
- **Table not created yet** (404): automatic syncs check again every 10 minutes; the Sync button checks right away.

### Who owns what

- **QC owns** `title`, `body`, and `customer_id` of linked rows. A card with a `customer_id` shows *Linked to QC customer*;
  its index line and text are read-only (edit them in QC) and follow QC. QC's body is plain `Label: value` lines (Contact,
  Phone, Email, Address, Notes) and is shown as-is. Bodies of cards made in Cardfile stay free text.
- **Cardfile owns** `notes` ("My notes", under the card text, on every card; QC never writes it), `deleted_at`, and `file`.
  Notes changed in two places: the later `updated_at` wins.
- **QC links a Cardfile card** ("Find in card file"): the card gets the badge and becomes QC-owned; notes stay yours.
- **Unlinked cards:** the later change wins (by `updated_at`); changes to different fields are merged.
- **QC deletes a customer:** QC only sets `customer_id = NULL`, and the row stays.
  - A card with notes is kept, marked *No longer in QC*. It is editable again and still tied to its row, so notes keep
    syncing, and if QC links the row again it becomes linked again.
  - A QC card without notes is removed from Cardfile (the row is left alone).
  - A card that came from Cardfile stays as a normal card.
- **Row removed by an admin:** if a row vanishes on a full resync, a linked card with notes is kept the same way.
- Search, Go To, Find, Search All Files, Print, and JSON backup all include notes.

### Database (from the QC migration)

```sql
create table public.customer_cards (
  id uuid primary key default gen_random_uuid(),
  customer_id text unique references public.customers(id) on delete set null,
  title text not null check (char_length(title) <= 39),
  body text not null default '',
  notes text,                                   -- Cardfile-owned
  source text not null default 'qc' check (source in ('qc', 'cardfile')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), -- trigger: clock_timestamp() on every insert/update
  deleted_at timestamptz                        -- soft delete, set only by Cardfile
  -- file text                                  -- optional, Cardfile-owned; may be added later (alter table … add column file text)
);
-- RLS: signed-in members only; SELECT / INSERT / UPDATE, no DELETE; anon gets nothing
create policy cards_select on public.customer_cards for select to authenticated using (public.is_member());
create policy cards_insert on public.customer_cards for insert to authenticated with check (public.is_member());
create policy cards_update on public.customer_cards for update to authenticated using (public.is_member()) with check (public.is_member());
revoke all on public.customer_cards from public, anon, authenticated;
grant select, insert, update on public.customer_cards to authenticated;
```

### Testing

- `tools/test_sync.py` runs the real supabase-js against an in-memory mock of the contract (`tools/mock_supabase.py`,
  routed by Playwright). It covers:
  - Username/PIN sign-in (including a non-ASCII username), activate-then-retry, and wrong PIN.
  - First pull, QC updates that keep notes, new QC customers, notes round-trip.
  - Sharing; unshared files never uploaded.
  - Offline edits, offline startup, errors, sign-out.
  - Soft delete via `deleted_at`, Undo.
  - QC linking, and QC clearing `customer_id`.
  - `file` column present, absent, and added later.
  - The missing-table state, the 39-character limit, and mismatched column names.
- Every test context blocks the real project and checks that nothing reached it. The tests run at the end of
  `tools/test_app.py`, or alone: `python3 tools/test_sync.py http://127.0.0.1:8765/` (needs cdn.jsdelivr.net for supabase-js).
- **Live end-to-end check** (once the migration is applied): `RG_USERNAME=<username> RG_PIN=<pin> python3 tools/live_check.py`.
  It signs in (activating if needed), checks that anon can't read, probes `file`, inserts a test row
  `ZZ CARDFILE LIVE CHECK <time>`, reads it back (also with the incremental query), patches notes, soft-deletes it, and
  checks that DELETE is refused. The test row stays soft-deleted. It uses the URL and publishable key from `config.js`
  unless `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` are set.

- **Seeding the table:** `RG_USERNAME=<username> RG_PIN=<pin> python3 tools/upload_cards.py` is a dry run;
  add `--apply` to insert. Ids are deterministic (uuid5 of source file + index + title), so a rerun inserts nothing.
  The script only INSERTs and SELECTs, never touches QC rows, then verifies the counts per file and runs a sample search.

## Repository layout

| Path | What |
|---|---|
| `index.html`, `style.css`, `app.js` | The app |
| `config.js` | QC sync settings: Supabase URL, publishable key, table, column mapping, auth method |
| `sync.js` | QC sync (`CardSync`): sign-in, pull/push, outbox, ownership rules, status display |
| `scan.js` | Scan business card: camera/photo input, preprocessing, Tesseract.js OCR (lazy CDN load), parser (`CardScanParser`), review form |
| `crd.js` | `.CRD` reader/writer used by the app (Import/Export) |
| `tools/extract_crd.py` | Extracts `.CRD` files → `cards.json`, `images/` in a folder **outside** the repo: `python3 tools/extract_crd.py <crd-folder> <out-folder>` |
| `tools/upload_cards.py` | One-time upload of an extracted `cards.json` (`CARDS_JSON=…`) into the shared table |
| `tools/make_fixture.py` | Made-up test cards (`tools/testdata/fixture_cards.json`) and a made-up `.CRD` for the import test |
| `tools/test_app.py` | Headless-browser test (Playwright/Chromium). Serve the app first and pass its URL. Uses made-up cards only. Includes the scan flow end to end: real OCR when cdn.jsdelivr.net is reachable, otherwise (or with `SCAN_MOCK=1`) the OCR step is mocked |
| `tools/test_sync.py`, `tools/mock_supabase.py` | QC sync tests against a mock of the QC contract (also run by `test_app.py`; `SKIP_SYNC=1` skips them) |
| `tools/live_check.py` | End-to-end check against the real project once the migration is live (`RG_USERNAME`, `RG_PIN`) |
| `tools/test_scan_parser.js` | Parser unit checks, no browser needed: `node tools/test_scan_parser.js` |
| `tools/make_scan_testcards.py` | Renders the synthetic business-card test images in `tools/testdata/scan/` (fictional people, 555-01xx numbers, example.com) |
| `tools/crd_dump.py`, `tools/ne_*.py` | Reverse-engineering helpers (dump a .CRD; read resources from the original CARDFILE.EXE) |
| `docs/notes.md` | Analysis notes: original program, .CRD file format, data findings |

The original `.CRD` files and the 1993 executables are intentionally **not** in this repository.
