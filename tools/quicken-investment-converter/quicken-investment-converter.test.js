// Unit tests for the Quicken Investment Converter core (the <script id="core"> block in index.html).
// Run:  node --test tools/quicken-investment-converter/quicken-investment-converter.test.js
// All data below is made up — never paste a real statement into this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const core = /<script id="core">([\s\S]*?)<\/script>/.exec(html)[1];
const Q = vm.runInNewContext(core + ';({ HEADER, parseCSV, toObjects, csvField, convert, buildOutput, toCSV })', {});

/* vm objects come from another realm; round-trip through JSON so deepEqual compares plain data */
const plain = v => JSON.parse(JSON.stringify(v));

const STATEMENT = [
  '"date","transaction","description","amount","balance","currency"',
  '"2026-01-02","TRFIN","Money transfer into the account (executed at 2026-01-02)","1000.0","1000.0","CAD"',
  '"2026-01-05","BUY","XYZ.F - Example Bond ETF - Hedged: Bought 10.5 shares at $20.00 per share (executed at 2026-01-04)","-210.0","790.0","CAD"',
  '"2026-01-06","SELL","ABC - Example Equity ETF – UNITS : Sold 1,000 shares at $1,234.50 per share (executed at 2026-01-05)","1234500.0","1235290.0","CAD"',
  '"2026-01-31","FEE","Management fees (executed at 2026-01-31)","-0.25","1235289.75","CAD"',
  '"2026-01-31","WEIRD","Something new","1.0","1235290.75","CAD"',
].join('\r\n');

const OPTS = { account: 'Test Account', xfer: 'Chequing', dateMode: 'executed', secOverrides: {}, xferByRow: {} };
const load = () => Q.convert(Q.toObjects(Q.parseCSV(STATEMENT)));

test('parseCSV handles quotes, escaped quotes, CRLF, BOM and blank lines', () => {
  const rows = plain(Q.parseCSV('﻿a,b\r\n"x,1","say ""hi"""\r\n\r\n3,4'));
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'say "hi"'], ['3', '4']]);
});

test('convert maps each statement type to a Quicken action', () => {
  const { items } = load();
  assert.deepEqual(plain(items.map(i => i.action)), ['XIn', 'Bought', 'Sold', 'MiscExp']);
  const buy = items[1];
  assert.equal(buy.symbol, 'XYZ.F');
  assert.equal(buy.name, 'Example Bond ETF - Hedged');
  assert.equal(buy.shares, '10.5');
  assert.equal(buy.price, '20.00');
  assert.equal(buy.execDate, '2026-01-04');
  assert.equal(buy.stmtDate, '2026-01-05');
});

test('trade parsing strips thousands separators and trailing spaces before the colon', () => {
  const sell = load().items[2];
  assert.equal(sell.name, 'Example Equity ETF – UNITS');
  assert.equal(sell.shares, '1000');
  assert.equal(sell.price, '1234.50');
});

test('unsupported rows are skipped with a warning naming the line', () => {
  const { warnings } = load();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Line 6: unsupported transaction type "WEIRD"/);
});

test('buildOutput signs amounts, picks dates and fills transfer accounts', () => {
  const rows = Q.buildOutput(load().items, OPTS);
  assert.deepEqual(plain(rows.map(r => r.amount)), ['1000.00', '210.00', '1234500.00', '-0.25']);
  assert.equal(rows[1].date, '2026-01-04');
  assert.equal(rows[0].transferAccount, 'Chequing');
  assert.equal(rows[3].memo, 'Management fees');
  assert.ok(rows.every(r => r.account === 'Test Account'));

  const stmt = Q.buildOutput(load().items, { ...OPTS, dateMode: 'statement' });
  assert.equal(stmt[1].date, '2026-01-05');
});

test('per-row transfer and security overrides win over defaults', () => {
  const rows = Q.buildOutput(load().items, { ...OPTS,
    xferByRow: { 0: '  Savings ' }, secOverrides: { 'XYZ.F': { name: 'My Bond', symbol: 'XYZ' } } });
  assert.equal(rows[0].transferAccount, 'Savings');
  assert.equal(rows[1].security, 'My Bond');
  assert.equal(rows[1].optionalSymbol, 'XYZ');
});

test('toCSV writes the Quicken header and quotes fields that need it', () => {
  const out = Q.toCSV(Q.buildOutput(load().items, OPTS));
  const lines = out.split('\r\n');
  assert.equal(lines[0], Q.HEADER.join(','));
  assert.equal(lines.length, 6);  // header + 4 rows + trailing newline
  assert.equal(Q.csvField('a,"b"'), '"a,""b"""');
  assert.equal(Q.csvField(null), '');
});
