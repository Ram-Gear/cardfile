# CARDFILE.EXE: reverse-engineering notes (first pass)

> Note: paths in this document (`/workspace/card-file/...`, `app/`, `screens/`, `crd/`, `sample/`) refer to the original analysis workspace. In this repository the app lives at the root, data in `data/`, and scripts in `tools/`. The original .CRD files, screenshots and executables are not included.

Analyzed 2026-10-05. Source file: `/workspace/card-file/gcp2/CARDFILE.EXE` (93,184 bytes, dated 1 Nov 1993).
This was analysis only. No GitHub repo was created or touched.

## 1. Overview: the main finding

**CARDFILE.EXE is not a custom DOS program. It is Microsoft's own Windows 3.1 "Cardfile"**,
the index-card app that came with Windows 3.1 and Windows for Workgroups 3.11. Evidence:

- The DOS stub says `This program requires Microsoft Windows.`, and the real header is a 16-bit Windows **NE** executable
  (module name `CARDFILE`, description `Index Card Handler`, linker 5.20).
- Version resource: `CompanyName=Microsoft Corporation`, `FileDescription=Windows Cardfile application file`,
  `FileVersion=3.10`, `ProductName=Microsoft Windows(TM) Operating System`, `Copyright Microsoft Corp. 1991-1992`.
- It imports KERNEL, GDI, USER, KEYBOARD, OLECLI (OLE 1.0 client), COMMDLG and SHELL. Its help file is `cardfile.hlp`.
- 93,184 bytes with a 1-Nov-1993 date fits the Windows for Workgroups 3.11 copy of Cardfile 3.10
  (WfW 3.11 files carry 11/01/93 timestamps). The zip shows 02:11; that hour is probably shifted by time zone or DST from 03:11. *Likely, not proven.*
- At 93,184 bytes it is about the same size as the GCP2 modules, but it has nothing to do with them (see §8).
  Someone probably copied it onto the GCP2 floppy, or it ended up in the same folder by accident.

So the "rebuild" target is a well-documented Microsoft app. We know its workflow and its `.CRD` file format exactly,
and we checked both by **actually running it** (under Wine, see §9).

**Practical implication for Gary:** any real business data would be in `*.CRD` files, which are **not** in this zip.
If Ram-Gear has old `.CRD` files (supplier lists, customer contacts, part notes), the web app can import them losslessly
(text plus index lines). A parser is already in `tools/crd_dump.py`.

## 2. Compiler / language

- Microsoft C (MS C 6.x/7.x era) for 16-bit Windows, linked with the Microsoft linker 5.20 as an NE executable.
  Evidence: MS C runtime messages `<<NMSG>>`, `R6000 - stack overflow`, `R6003 - integer divide by 0`, `R6009`, and `_C_FILE_INFO=`.
  This is the standard Windows 3.1 SDK toolchain. *Confidence: high.*
- It is not packed. LZEXE/PKLITE/UPX don't apply, and every resource (menus, dialogs, string table, accelerators) is readable directly.
- Other files: **GCP2.EXE is Turbo Pascal** (`Runtime error ... at`, TP-style RTL). It is an unrelated DOS menu program.

## 3. Screens and menus (from the MENU resource, confirmed on screen)

Main window title: `Cardfile - <FILE>.CRD`, or `Cardfile - (Untitled)`.
Below the menu is a status strip: view name (`Card View` / `List View`), **◄ ►** arrow buttons, and a count (`1 Card`, `N Cards`).

```
File:   New | Open... | Save | Save As... | Print | Print All | Page Setup... | Print Setup... | Merge... | Exit
Edit:   Undo Ctrl+Z | Cut Ctrl+X | Copy Ctrl+C | Paste Ctrl+V | Paste Link | Paste Special... |
        Index... F6 | Restore | (•)Text / Picture | Link... | Object | Insert Object...
View:   Card | List
Card:   Add... F7 | Delete | Duplicate | Autodial... F5
Search: Go To... F4 | Find... | Find Next F3
Help:   Contents | Search for Help On... | How to Use Help | About Cardfile...
```

Dialogs (resource IDs, controls):
| Dialog | Contents |
|---|---|
| **Index** (F6) | `Index Line:` [edit], OK, Cancel. Edits the current card's title line |
| **Add** (F7) | `Add:` [edit], OK, Cancel. Creates a new card with this index line |
| **Go To** (F4) | `Go To:` [edit], OK, Cancel |
| **Find** | Common Find dialog: `Find What:`, `Match Case`, Direction `Up`/`Down`, `Find Next`, `Cancel`. (`Match Whole Word Only` exists in the template but is placed off-screen, i.e. hidden) |
| **Autodial** (F5) | `Number:`, `Prefix:` (default `9-`), `Use Prefix`, OK/Cancel/`Setup >>`. Setup adds Dial Type Tone/Pulse, Port COM1–4, Baud 110–19200 |
| **Page Setup** | `Header:` (default `&f`), `Footer:` (default `Page &p`), Margins Left/Right `.75`, Top/Bottom `1.00` |
| Now Printing | "Now Printing / <file>", Cancel |
| Open / Save As / Merge | Common file dialogs. Filter `Card File (*.CRD)`, `All Files (*.*)`, and on save also `3.0 Card File (*.CRD)`. A `Validate` checkbox is added |
| Link, Paste Special, Insert New Object | OLE 1.0 object linking/embedding (pictures etc.) |

Screenshots: see `screens/` (§10).

## 4. Key bindings

From the ACCELERATOR resource (all confirmed by the menu text):
| Key | Action |
|---|---|
| F1 | Help contents |
| F3 | Find Next |
| F4 | Go To |
| F5 | Autodial |
| F6 | Index (edit index line) |
| F7 | Add card |
| Ctrl+Z, Alt+Backspace | Undo |
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / Copy / Paste |
| Ctrl+Insert | Copy |

Handled in code, not in the accelerator table. These are documented Win 3.1 Cardfile behavior that I did **not** re-verify:
PgDn / PgUp = next / previous card; Ctrl+Home / Ctrl+End = first / last card; **Ctrl+Shift+<letter>** = jump to the first card whose
index line starts with that letter; clicking a card's visible title in the cascade brings it to the front; double-clicking the index line = Index dialog.
Plain typing edits the front card's body.

Page header/footer codes (string `fFpPtTdDcCrRlL`): `&f` filename, `&p` page number, `&t` time, `&d` date,
`&l` / `&c` / `&r` = left / center / right align.

## 5. Card data model

A card has just **two user fields plus an optional picture**. There are no typed fields (no date, phone, or category fields):

| Field | Type / limit | Notes |
|---|---|---|
| **Index line** | Text, max 39 chars (40-byte NUL-terminated field in the file) | The card's "title". All sorting and Go To use it. The UI edit box has no autoscroll, so in practice you also can't type more than fits the box width (observed 38 chars of mixed text, 34 'K's in Wine). |
| **Body text** | Free text, ANSI, CR LF line breaks, **11 lines × ~40 chars** (≈440 chars) | Fixed-size card. Typing that would overflow the card is refused, and pasting too much gives "Cannot paste text onto the card. The text on the Clipboard is too long to fit on a Cardfile card." Observed: an 11th Return was refused, and a single unbroken run stopped at 430 chars. Word-wraps inside the card. |
| Picture / object (optional) | 3.0: a bitmap with x/y position. 3.1: an OLE 1.0 object (embedded/linked/static) plus a position RECT | Edit > Picture mode lets you move it. Probably not needed for Ram-Gear. |

- **Number of cards:** a 16-bit count in the header (max 65,535). Otherwise limited only by memory. Status shows `N Cards`.
- **Ordering:** cards are kept **sorted alphabetically by index line**, both in memory and on disk. This was confirmed: a card added later
  ("A…") was stored before an existing "B…" card. Under Wine the sort came out case-sensitive (`KKK…` before `apple…`). Real Win 3.1 `lstrcmp`
  is locale/dictionary-aware (≈case-insensitive), so on genuine Windows "apple" most likely sorts first. Wine's 16-bit `lstrcmp` is plain strcmp.
  *Treat the case rule as open; recommend a case-insensitive sort for the rebuild.*
- Duplicate index lines are allowed (Card > Duplicate creates exactly that).

## 6. Workflow

- **New file**: starts with one blank card (count shows `1 Card`).
- **Create**: Card > Add (F7) → type the index line → OK. The new card goes to the front, its body is empty and has focus, and you just type.
  On a blank card, F6 sets the index line.
- **Edit**: the body is always editable in place (no edit mode). Edit > Index (F6) changes the title, and the card re-sorts.
  Edit > Restore reverts the current card to how it was when you brought it to the front. Undo covers the last edit.
- **Delete**: Card > Delete → `Delete "<index line>"?` [OK] [Cancel] (confirmed on screen).
- **Duplicate**: Card > Duplicate copies the current card (index plus body).
- **Browse, Card View**: overlapping cascade of cards. The front card is current, and the cards behind are the *next* ones in sorted order,
  wrapping around. ◄ ► buttons and PgUp/PgDn step through them.
- **Browse, List View**: a list of index lines only, sorted, with the current one highlighted (confirmed on screen).
- **Search 1, Go To (F4)**: searches **index lines only**, **case-insensitive substring** (partial, anywhere in the line). It starts from
  the card after the current one and wraps around. Confirmed: `orks` → "Chicago Gear Works", and `BEARINGS` → "apple bearings" (lowercase), the next match in order.
- **Search 2, Find… / Find Next (F3)**: searches **card body text**, substring, Match Case option, direction Up/Down, wraps through all cards.
  Confirmed: `jim` found "Contact: Jim Smith" on a test card.
- **Print**: prints the current card. **Print All** prints every card (drawn as card outlines with header/footer per Page Setup).
  (Whether List View's Print All prints only the index list wasn't verified.)
- **Merge**: File > Merge… pulls all cards from another .CRD into the current file (re-sorted).
- **Autodial (F5)**: pre-fills `Number:` with the first phone-number-looking text on the card (confirmed: picked `555-1212` from the body),
  optional prefix (`9-`), and dials through a Hayes modem (`ATDT…`, `ATH0`) on COMx. Settings live in WIN.INI (`Modem`, `Prefix`, `UsePrefix`, port string `COM1,T,2`).
- **Exit / New / Open with unsaved changes**: `<file> This file has changed. Save current changes?`

## 7. Storage format (.CRD)

The program reads and writes **only `*.CRD` files** that you pick in the file dialogs (default extension `CRD`, default name `(Untitled)`).
It saves by writing a temp file `~CRxxxx.tmp` and then replacing the original. We saw this directly: under Wine a save failed with
"Cannot save Z:\tmp\cf\TEST.CRD because Z:\~CR1429.tmp cannot be created", because the temp file goes in the drive root.
Settings go to WIN.INI. There is no fixed data filename and no separate index file.

All integers are little-endian. Text is 8-bit ANSI (Windows-1252). **Verified byte-for-byte against the file Cardfile wrote (`sample/TEST.CRD`)**
and matches Microsoft KB Q99340.

**Header**
| Sig | Layout | When used |
|---|---|---|
| `MGC` | `"MGC"` + uint16 cardCount → index starts at byte 5 | No OLE objects (also the "3.0" format). **What we observed for text-only cards.** |
| `RRG` | `"RRG"` + uint32 lastObjectID + uint16 cardCount → index starts at byte 9 | File contains OLE objects (3.1) |
| `DKO` | Unicode variant (Windows NT Cardfile) | Not produced by this exe |

**Index entry** (52 bytes each, `cardCount` of them, in sorted order):
| Offset | Size | Field |
|---|---|---|
| 0 | 6 | reserved, zeros |
| 6 | 4 | uint32 absolute file offset of this card's data |
| 10 | 1 | flag (0) |
| 11 | 40 | index line, NUL-terminated (≤39 chars) |
| 51 | 1 | NUL |

**Card data** (at the offset; records are packed back to back with no terminator):
- MGC: `uint16 bitmapLen` (0 = none); if non-zero, `uint16 w, h, x, y` + bitmap bytes; then `uint16 textLen` + `textLen` bytes of text (no NUL).
- RRG: `uint16 objectFlag` (0 = none); if set, `uint32 objectID`, OLE 1.0 object stream (variable, must be parsed to skip),
  `uint16 charW, charH`, `RECT (4×int16)`, `uint16 objType (0 embedded / 1 linked / 2 static)`; then `uint16 textLen` + text.
- A blank card is 4 zero bytes.

Sample written by the real program (first bytes):
```
4d 47 43 05 00 | 00×6 09 01 00 00 | 00 | "ACME GEARBOX CO 1234567890123456789012\0" ...
"MGC", 5 cards | reserved, data@0x109 | flag | index text
```
`python3 tools/crd_dump.py <file.CRD>` dumps any MGC/RRG file (text-only cards. OLE objects aren't skipped yet).

**X2873 is NOT a Cardfile file.** It is 60 bytes of ASCII: `2691854123630186912` + 33 spaces + `0x08` + `19023128`. No MGC/RRG signature.
READ.ME says it's GCP's "encrypted registration data". GCP2.EXE opens `X2873` and prints `Invalid registration` / `Serial number`.

## 8. Relationship to the GCP2 gear modules

- GCP2.EXE (Turbo Pascal menu) launches only EXT, INT, WORM, RACK, SPL, HELIX, INHEL (`.EXE` appended). It has **no reference to CARDFILE**.
  (READ.ME still calls the menu "GCP1".)
- None of the gear modules contain "cardfile" or ".CRD", and CARDFILE contains nothing about gears or X2873. **They're independent.**

## 9. How it was run

- DOSBox/dosemu would need a licensed Windows 3.1 install, so I used **Wine 10.0 (Debian, wine32 for 16-bit NE support)**
  under a private Xvfb display, with `WINEPREFIX=~/.wine-cardfile`. It runs fully: menus, dialogs, add/edit/save/search/list all work.
- Known emulation artifact: **the card body text doesn't render** (the body area paints grey), but the typing is real.
  It is saved to the file correctly and Find/Autodial see it. Index lines, the list view and all dialogs render fine.
- Save to `Z:\…` fails because of the temp-in-drive-root behavior. Saving to `C:\TEST.CRD` works.
- To re-run: `Xvfb :55 & DISPLAY=:55 WINEPREFIX=~/.wine-cardfile wine explorer /desktop=cf,800x600 'C:\CARDFILE.EXE' 'C:\TEST.CRD'`

## 10. Files produced

- `notes.md`: this file
- `screens/01-startup.png` … `18-reopened-test-crd.png`: startup, Index/Add/Go To/Find/Save As dialogs, cascade view,
  list view, delete confirmation, Page Setup, Autodial, "card full" and save errors
- `sample/TEST.CRD`: a 5-card file written by the real CARDFILE.EXE (test data)
- `tools/crd_dump.py`: .CRD parser. `tools/ne_*.py`: NE resource/menu/dialog/string/accelerator/import dumpers

## 11. Open questions (from the first pass)

1. ~~**Does Ram-Gear have real `.CRD` data files?**~~ Answered: yes, 88 files (see §13). They're the actual asset. The app is generic, and the content is whatever Gary's people typed.
   If yes, get copies so we can see their conventions (e.g. index = company name, body = contact/phone/parts) and test the import.
2. Was Cardfile actually used for shop records, or did it just land on the GCP2 disk? (It has no connection to the gear programs.)
3. Sort collation on genuine Windows 3.1 (case-insensitive vs. ASCII). This would only matter for exact order fidelity.
4. Do any of their cards hold pictures/OLE objects (RRG files)? If so, the importer needs the OLE 1.0 skip/extract logic (KB Q99340).
5. Print layout details (cards per page in Print All) weren't verified. They need a real printer driver or the help file.

## 12. Proposed browser rebuild: feature list matching the original workflow

**Core (must have)**
- File model: one "card file" = a named collection of cards {indexLine ≤ 39 chars (allow longer optionally), body text, optional image}.
  Multiple files (File New/Open/Save/Save As), with a dirty-flag "Save current changes?" prompt. Autosave to the server/IndexedDB, plus explicit Save.
- Always sorted by index line (case-insensitive, natural order). Duplicates allowed.
- **Card View**: cascaded stack showing the front card plus the next few titles behind it. Click a title to bring it forward. ◄ ► buttons,
  PgUp/PgDn, Ctrl+Home/End, Ctrl+Shift+letter to jump to the first title with that letter. Body is edited directly on the card.
- **List View**: sorted list of index lines. Click to select, double-click to edit the index. Toggle between views from the View menu.
- Status strip: view name and `N Cards`.
- **Add (F7)** dialog → new card in front, cursor in body. **Index (F6)** dialog to rename (re-sorts). **Delete** with
  `Delete "<title>"?` confirmation. **Duplicate**. **Restore** (revert current card). Undo.
- **Go To (F4)**: case-insensitive substring search on index lines, forward from the current card, wrapping.
- **Find / Find Next (F3)**: substring search in body text, Match Case, Up/Down, wrapping.
- Same menu layout and F-key bindings as the original (File/Edit/View/Card/Search/Help), so long-time users feel at home.
- **Import .CRD** (MGC and RRG, text and index; images if present) and **Export .CRD** (MGC), plus CSV/JSON export.
- **Merge** another card file into the current one.
- **Print / Print All** to the browser's print dialog, with card-shaped layout, header/footer codes (&f &d &t &p &l &c &r), and margins.

**Decisions to make (where to keep or relax the 1993 limits)**
- Keep the 11×40 body limit for fidelity, or allow longer bodies with scrolling (recommended: soft warning, not a hard stop).
- Global search across index *and* body at once (a modern convenience the original lacks). Keep F4/Find semantics as they are.
- Autodial → replace with `tel:` links (click-to-call on phones) for numbers detected in the card.
- Multi-user access, login, and backups (the original was single-user, file-on-disk).
- Picture support: paste/upload an image onto a card (replaces OLE).


---

## 13. The shop's real data (cardfile2, 88 files), analyzed 2026-10-05

Source: `crd/` (unzipped from `cardfile2.zip`, originally `Z:\pricebook\PROGRAMS\cardfile2`). The originals were only read,
and all 88 were checked byte-identical to the zip afterwards.

### Formats found
| Signature | Files | What it is |
|---|---|---|
| `MGC` | 85 | Cardfile text-only format (§7). Parsed with no leftover bytes, and every header count matched. |
| `RRG` | 1 (`AUTO.CRD`, 19 cards) | Cardfile 3.1 with OLE. Cards 1–3 each embed an **MS ClipArt Gallery** object (a 32×32 car icon, METAFILEPICT presentation with an embedded DIB), placed at the card's top right. I extracted them to PNG. |
| `LCP` | 2 (`OILUNIT.CRD`, `ramunit.CRD`) | **Not** NT Unicode Cardfile (that would be `DKO`). It's a third-party *card-layout/designer* format: a Delphi object stream with classes `TCardPage`, `TCardPanel`, `TCard`, `TTextObject`, `TPictureObject`. Each file is one designed card (a sign or business card): two text objects (Arial 36 and Arial 18) and a 450×324 8-bit bitmap. I couldn't identify the program. |

**LCP layout (as far as needed):** `"LCP" u16 ver(2) u32 offsetOfClassTable`, then objects. A text object is
`FF FF 01, rect(4×u16), 00 00 00 01 00 00, u16 len, text, pstring fontName, 00×4, u16 size…`. A picture object is
`FF FF 01, rect(4×u16), 00 00 01 00, u32 size, BMP file`. The class-name table sits at the end of the file.
OILUNIT and ramunit differ only in 539 bitmap bytes (palette index 0xFB vs 0xFF). Rendered, the images are pixel-identical, so the files are functionally identical.

### Totals and data observations
**88 files, 546 cards** (544 Cardfile cards + 2 LCP layout cards). The per-file details, duplicate-file analysis and the
sensitive-content review were kept out of the repo on purpose (they quoted card contents).
- **Encoding:** pure ASCII plus TAB characters. Text is decoded as cp1252 anyway, and CR LF is normalized to `\n`.
- **Index-line slack:** in many entries the bytes after the NUL in the 40-byte title field hold leftovers of older/longer titles.
  The reader stops at the NUL. Ignoring that slack, the MGC writer reproduces all 85 MGC files byte-for-byte.
- **Titles:** most start with 3 spaces (the shop's convention); the longest is 38 chars. The app sorts on the trimmed,
  case-insensitive title.
- **Bodies:** at most 11 lines / 313 chars. Some cards are blank, some have an empty index line, some have no body.
- Some files are near-duplicates of each other and about 50 cards appear in 2–3 files. Nothing was deduplicated.
- The files contain personal data (employee home addresses and numbers, account numbers). **That is why no card data is kept in this
  repository:** the cards were uploaded once (Oct 2026, Gary's decision) to the shared Supabase table `customer_cards` and the app
  loads them only after sign-in.

### Output files (not in the repo)
- `tools/extract_crd.py <crd-folder> <out-folder>` writes `cards.json` (`{name, sourceFile, format, headerCount, modified, sha1,
  cards:[{title, body, image?}]}`), `cards.txt` and `images/` to a folder **outside** the repo.
- `tools/upload_cards.py` (CARDS_JSON=…/cards.json) was the one-time upload into the shared table.
- Tests use made-up cards only: `tools/make_fixture.py` → `tools/testdata/fixture_cards.json`.

## 14. Browser app (`app/`)

Static HTML/CSS/JS with no dependencies or build step (`app/README.md`). It works from GitHub Pages or file://.
Tested locally on `python3 -m http.server` with headless Chromium (Playwright, `tools/test_app.py`): 38/38 checks pass and no JS errors.
Screenshots are in `app-screens/`.

**Implemented (matching the original workflow):**
- Title bar `Cardfile - STEEL.CRD`. Menus File / Edit / View / Card / Search / Help with the original F-key labels. The status strip shows
  Card View/List View, ◄ ►, and `N Cards`.
- **Open** (Ctrl+O, File menu) picks one of the card files, with a filter, card counts and dates. A file dropdown in the status strip does the same.
  **(All files)** merges all cards into one sorted stack with a file tag on each card.
- **Card view:** cascaded stack (front card plus up to 7 behind it, showing titles; click a title to bring it forward). The front card shows the
  index line (double-click = Index) and an editable body. The body scrolls, with **no hard 11-line limit**. Monospace font, tab stops 8,
  pictures shown at their original position.
- **List view:** sorted index lines. Click selects, double-click/Enter opens the card, arrow keys move, typing a letter jumps.
- **Add (F7)** (in All-files mode it asks which file). **Index/rename (F6)** limited to **39 chars**, re-sorts.
  **Delete** with `Delete "<title>"?`. **Duplicate**. **Restore** (current card back to how it was when it came forward).
  **Undo** (app-level, 40 steps; Ctrl+Z outside the text box, native undo inside it).
- **Go To (F4):** case-insensitive substring on index lines, forward from the current card, wrapping.
  **Find / Find Next (F3):** body text, Match Case, Up/Down, starts at the caret and wraps, then selects the match.
  **Search All Files** (Ctrl+Shift+F / search box): titles plus bodies across every file, with a clickable result list.
- **Navigation:** PgUp/PgDn (wrap), Ctrl+Home/End, Ctrl+Shift+letter, plus an A–Z letter bar (for touch screens, and because browsers
  reserve some Ctrl+Shift combinations, e.g. Ctrl+Shift+T/N/W/Q).
- **Phones:** every number on the card is shown as a `tel:` link under the card. **F5** opens an Autodial list. 7-digit numbers get a
  configurable area code (default 361; File > Phone settings).
- **Print** (current card) and **Print All** (file or all files): card-shaped boxes, file name and date header, via the browser print dialog.
- **Persistence:** localStorage, autosaved. **Import .CRD** (MGC/RRG/LCP via the JS port `crd.js`, which matches the Python output for all 546 cards).
  **Export .CRD** (MGC/Cardfile 3.0, text only, with a warning if pictures are dropped), **Export/Restore Backup (JSON)**, **New card file**,
  **Delete card file**, **Reset (reload cards)**.

**Deviations / limits:** no OLE editing (pictures are view-only); exported .CRD files drop pictures; data lives per browser, so there is
no multi-user sync yet; there is no Page Setup dialog (fixed header). The original's case-sensitive ASCII sort is replaced by a case-insensitive
sort that ignores leading spaces.

**Publishing:** the repo holds no card data (history rewritten Oct 2026). The app on GitHub Pages shows a sign-in screen; after
signing in with a QC username and PIN, the cards are read from Supabase (Row Level Security: members only) and cached in localStorage.
