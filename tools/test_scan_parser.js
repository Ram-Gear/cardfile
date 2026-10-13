// Unit checks for the business-card parser in scan.js (runs in Node, no browser needed):
//   node tools/test_scan_parser.js
// Uses the exact text of the synthetic test cards (testdata/scan/truth.json) plus OCR-noise fixtures
// (testdata/scan/parser_fixtures.json). The same fixtures are also run in the browser by tools/test_app.py.
const fs = require('fs'), path = require('path');
const P = require(path.join(__dirname, '..', 'scan.js'));
const dir = path.join(__dirname, 'testdata', 'scan');
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
const fixtures = Object.entries(truth).map(([k, v]) => ({ name: 'exact text of ' + k, text: v.text, expected: v.expected }))
  .concat(JSON.parse(fs.readFileSync(path.join(dir, 'parser_fixtures.json'), 'utf8')));
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,]+$/, '').trim();
function fieldsOf(text) { const f = P.parseCard(text); return Object.assign({}, f, P.phoneSlots(f.phones)); }
let pass = 0, total = 0;
for (const fx of fixtures) {
  const got = fieldsOf(fx.text), bad = [];
  for (const [k, v] of Object.entries(fx.expected)) { total++; if (norm(got[k]) === norm(v)) pass++; else bad.push(`${k}: got "${got[k]}" want "${v}"`); }
  console.log((bad.length ? 'FAIL ' : 'PASS ') + fx.name + (bad.length ? '\n     ' + bad.join('\n     ') : ''));
}
// formatting checks
const card = P.formatCard({ company: 'Bayview Bearing Supply, Inc.', name: 'Kevin Smith', title: 'Inside Sales Manager', office: '361-555-0142', cell: '361-555-0199', fax: '361-555-0143', email: 'Kevin.Smith@Example.com', website: 'www.example.com', address: '1234 Industrial Blvd, Suite 200', city: 'Corpus Christi', state: 'TX', zip: '78405' });
const want = '  1234 INDUSTRIAL BLVD, SUITE 200\n  CORPUS CHRISTI TX 78405\n\n  KEVIN SMITH (INSIDE SALES MANAGER)  361-555-0142\n  CELL  361-555-0199\n  FAX  361-555-0143\n  kevin.smith@example.com\n  www.example.com\n';
total += 3;
if (card.title === 'BAYVIEW BEARING SUPPLY, INC.') pass++; else console.log('FAIL format title', card.title);
if (card.body === want) pass++; else console.log('FAIL format body\n' + JSON.stringify(card.body) + '\n' + JSON.stringify(want));
const long = P.formatCard({ company: 'A VERY LONG COMPANY NAME THAT GOES PAST THIRTY NINE CHARS LLC', name: 'Pat Doe' });
if (long.title.length === 39 && long.body.includes('PAST THIRTY NINE CHARS LLC')) pass++; else console.log('FAIL long title', long);
const noCo = P.formatCard({ name: 'Pat Doe', cell: '361-555-0100' });
total++; if (noCo.title === 'PAT DOE') pass++; else console.log('FAIL fallback title', noCo.title);
console.log(`\n${pass}/${total} parser checks passed`);
process.exit(pass === total ? 0 : 1);
