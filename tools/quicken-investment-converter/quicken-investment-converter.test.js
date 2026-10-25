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
const Q = vm.runInNewContext(core + ';({ HEADER, parseCSV, toObjects, csvField, convert, combine, buildOutput, toCSV, readQuickenExport, quickenRows, matchExisting })', {});

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

const H = '"date","transaction","description","amount","balance","currency"';
const month = (...lines) => Q.toObjects(Q.parseCSV([H, ...lines].join('\n')));
const FEB = month(
  '"2026-02-03","TRFIN","Money transfer into the account (executed at 2026-02-03)","50.0","1050.0","CAD"',
  '"2026-02-03","TRFIN","Money transfer into the account (executed at 2026-02-03)","50.0","1100.0","CAD"');
const JAN = month(
  '"2026-01-31","FEE","Management fees (executed at 2026-01-31)","-0.25","1000.0","CAD"');

test('combine joins months oldest first whatever order the files were added', () => {
  const { items, warnings } = Q.combine([{ id: 1, name: 'feb.csv', objs: FEB }, { id: 2, name: 'jan.csv', objs: JAN }]);
  assert.deepEqual(plain(items.map(i => i.stmtDate)), ['2026-01-31', '2026-02-03', '2026-02-03']);
  assert.deepEqual(plain(items.map(i => i.id)), ['2:0', '1:0', '1:1']);   // ids stay unique across files
  assert.equal(warnings.length, 0);
});

test('combine keeps same-day repeats within a file but drops rows repeated across files', () => {
  const { items, warnings } = Q.combine([{ id: 1, name: 'feb.csv', objs: FEB }, { id: 2, name: 'feb-again.csv', objs: FEB }]);
  assert.equal(items.length, 2);
  assert.match(warnings[0], /2 row\(s\) appeared in more than one statement/);
});

test('combine prefixes per-file warnings with the file name when there are several files', () => {
  const bad = month('"2026-03-01","WEIRD","x","1.0","1.0","CAD"');
  const { warnings } = Q.combine([{ id: 1, name: 'jan.csv', objs: JAN }, { id: 2, name: 'mar.csv', objs: bad }]);
  assert.match(warnings[0], /^mar\.csv — Line 2: unsupported/);
});

test('buildOutput sorts by the chosen date, keeping statement order within a day', () => {
  const items = Q.combine([{ id: 1, name: 's.csv', objs: Q.toObjects(Q.parseCSV(STATEMENT)) }]).items;
  // with statement dates the buy (stmt 01-05) and sell (stmt 01-06) keep order; with trade dates too
  for (const dateMode of ['executed', 'statement']) {
    const dates = Q.buildOutput(items, { ...OPTS, dateMode }).map(r => r.date);
    assert.deepEqual(plain(dates), plain([...dates].sort()));
  }
});

test('CONT (registered-account contribution) becomes an XIn with a memo', () => {
  const objs = month('"2026-03-02","CONT","Contribution (executed at 2026-03-02)","200.0","200.0","CAD"');
  const { items, warnings } = Q.convert(objs);
  assert.equal(warnings.length, 0);
  const [r] = Q.buildOutput(items, OPTS);
  assert.equal(r.action, 'XIn');
  assert.equal(r.amount, '200.00');
  assert.equal(r.memo, 'Contribution');
  assert.equal(r.transferAccount, 'Chequing');
});

test('DIV in Wealthsimple wording becomes a Div for the right security, with no warning', () => {
  const objs = month('"2026-04-06","DIV","XYZ - Example Equity ETF Portfolio: Cash dividend distribution, received on 2026-04-06, record date of 2026-03-30","1.23","101.23","CAD"');
  const { items, warnings } = Q.combine([{ id: 1, name: 'x.csv', objs }]);
  assert.equal(warnings.length, 0);
  const [r] = Q.buildOutput(items, OPTS);
  assert.equal(r.action, 'Div');
  assert.equal(r.date, '2026-04-06');
  assert.equal(r.security, 'Example Equity ETF Portfolio');
  assert.equal(r.optionalSymbol, 'XYZ');
  assert.equal(r.amount, '1.23');
});

test('stock lending: zero-amount LOAN / RECALL are left out with a note; FPLINT is interest income', () => {
  const objs = month(
    '"2026-05-11","LOAN","XYZ - Example ETF: 2.0000 Shares on loan (executed at 2026-05-11)","0.0","0.0","XYZ"',
    '"2026-05-13","RECALL","XYZ - Example ETF: Loan of 2.0000 shares terminated (executed at 2026-05-13)","0.0","0.0","XYZ"',
    '"2026-05-15","FPLINT","Stock lending monthly interest payment","0.02","0.02","CAD"');
  const { items, warnings, notes } = Q.combine([{ id: 1, name: 'x.csv', objs }]);
  assert.equal(warnings.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^2 stock-lending row/);
  const rows = Q.buildOutput(items, OPTS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'IntInc');
  assert.equal(rows[0].amount, '0.02');
  assert.equal(rows[0].memo, 'Stock lending monthly interest payment');
  assert.equal(rows[0].security, '');
});

test('a LOAN that moves cash is not silently dropped', () => {
  const objs = month('"2026-05-11","LOAN","XYZ - Example ETF: odd","5.0","5.0","CAD"');
  const { warnings } = Q.combine([{ id: 1, name: 'x.csv', objs }]);
  assert.match(warnings[0], /unsupported transaction type "LOAN"/);
});

test('TRFINTF (tax-free cash transfer in) becomes an XIn with a memo', () => {
  const objs = month('"2026-06-02","TRFINTF","Tax-free money transfer into the account (executed at 2026-06-02)","5.0","5.0","CAD"');
  const { items, warnings } = Q.combine([{ id: 1, name: 'x.csv', objs }]);
  assert.equal(warnings.length, 0);
  const [r] = Q.buildOutput(items, OPTS);
  assert.equal(r.action, 'XIn');
  assert.equal(r.amount, '5.00');
  assert.equal(r.memo, 'Tax-free money transfer into the account');
  assert.equal(r.transferAccount, 'Chequing');
});

test('Already in Quicken: investment rows match a QIF export by date and amount, ignoring sign', () => {
  const items = Q.combine([{ id: 1, name: 's.csv', objs: Q.toObjects(Q.parseCSV(STATEMENT)) }]).items;
  const rows = Q.buildOutput(items, OPTS);
  const qx = Q.readQuickenExport(['!Account', 'NTest Account', 'TInvst', '^', '!Type:Invst',
    'D01/04/2026', 'NBuy', 'YExample Bond ETF - Hedged', 'T210.00', '^',
    "D1/31'26", 'NMiscExp', 'T-0.25', '^'].join('\r\n'));
  const m = Q.matchExisting(rows.map(r => ({ id: r._id, iso: r.date, amount: Number(r.amount) })),
    Q.quickenRows(qx, qx.map, qx.order), { days: 3, absolute: true });
  assert.deepEqual(plain(rows.filter(r => m.has(r._id)).map(r => r.action)), ['Bought', 'MiscExp']);
});

test('TRFOUTTF (tax-free cash transfer out) becomes an XOut', () => {
  const { items, warnings } = Q.convert(month('"2026-03-17","TRFOUTTF","Transfer out","-600.0","0.0","CAD"'));
  assert.equal(warnings.length, 0);
  const [r] = Q.buildOutput(items, OPTS);
  assert.deepEqual(plain([r.action, r.amount, r.memo, r.transferAccount]), ['XOut', '600.00', 'Transfer out', 'Chequing']);
});

test('NRT (non-resident tax on a foreign dividend) becomes a MiscExp with a memo', () => {
  const { items, warnings } = Q.convert(month('"2026-09-30","NRT","Non-resident tax (executed at 2026-09-30)","-0.06","5.03","CAD"'));
  assert.equal(warnings.length, 0);
  const [r] = Q.buildOutput(items, OPTS);
  assert.deepEqual(plain([r.action, r.amount, r.memo, r.security]), ['MiscExp', '-0.06', 'Non-resident tax', '']);
});
