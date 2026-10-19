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
const Q = vm.runInNewContext(core + ';({ HEADER, parseCSV, toObjects, csvField, convert, combine, buildOutput, toCSV, toQFX, encode1252, hash128, ofxAcctId, cleanAcctNum, defaultAcctNum })', {});

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

// Every aggregate (<TAG> on its own line) must be closed in order; leaf elements carry a value.
function assertBalanced(qfx) {
  const [head, body] = qfx.split('\r\n\r\n');
  assert.equal(head, 'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nSECURITY:NONE\r\nENCODING:USASCII\r\nCHARSET:1252\r\nCOMPRESSION:NONE\r\nOLDFILEUID:NONE\r\nNEWFILEUID:NONE');
  assert.ok(body.startsWith('<OFX>\r\n') && body.endsWith('</OFX>\r\n') && !/[^\r]\n/.test(qfx), 'CRLF, <OFX> root');
  const stack = [];
  for (const line of body.split('\r\n').filter(Boolean)) {
    const open = /^<([A-Z0-9.]+)>$/.exec(line), close = /^<\/([A-Z0-9.]+)>$/.exec(line);
    if (open) stack.push(open[1]);
    else if (close) assert.equal(stack.pop(), close[1], 'closing tag order');
    else assert.match(line, /^<[A-Z0-9.]+>\S/, 'leaf element has a value: ' + line);
  }
  assert.equal(stack.length, 0);
}
const NOW = new Date(2026, 9, 19, 9, 30, 0);
const tag = (qfx, t) => [...qfx.matchAll(new RegExp(`<${t.replace('.', '\\.')}>([^\\r]*)`, 'g'))].map(m => m[1]);

test('hash128 and ofxAcctId are frozen (changing them would re-import every past transaction)', () => {
  assert.equal(Q.hash128(''), '811c9dc5050c5d1f9e3779b985ebca6b');
  assert.equal(Q.hash128('WS|row|0'), 'a4e075f3467db61144fbffaf4de584d5');
  assert.equal(Q.ofxAcctId('ACC1'), '2795294097');
  assert.match(Q.ofxAcctId('anything'), /^[1-9]\d{9}$/);
});

test('toQFX: buys, sells, fees and deposits as OFX investment records, with cash from the statement', () => {
  const res = Q.combine([{ id: 1, name: 'Acct-monthly-statement-transactions-AB12CD34CAD-2026-01-01.csv', objs: Q.toObjects(Q.parseCSV(STATEMENT)) }]);
  const rows = Q.buildOutput(res.items, { ...OPTS, secOverrides: { 'XYZ.F': { name: 'My Bond', symbol: 'XYZ' } } });
  const qfx = Q.toQFX(rows, { bid: '03349', accountId: 'AB12CD34CAD', cash: res.cash, now: NOW });
  assertBalanced(qfx);
  assert.equal(res.cash, 1235290.75);   // last statement row's running balance
  assert.deepEqual(plain(tag(qfx, 'INTU.BID')), ['03349']);
  assert.ok(!qfx.includes('<INVPOSLIST>'));
  const body = qfx.slice(qfx.indexOf('<INVTRANLIST>'), qfx.indexOf('</INVTRANLIST>'));
  assert.deepEqual(body.match(/<(INVBANKTRAN|BUYSTOCK|SELLSTOCK|INCOME)>/g), ['<INVBANKTRAN>', '<BUYSTOCK>', '<SELLSTOCK>', '<INVBANKTRAN>']);
  assert.deepEqual(plain(tag(body, 'UNITS')), ['10.5', '-1000']);
  assert.deepEqual(plain(tag(body, 'TOTAL')), ['-210.00', '1234500.00']);
  assert.deepEqual(plain(tag(body, 'TRNTYPE')), ['CREDIT', 'FEE']);
  assert.deepEqual(plain(tag(body, 'TRNAMT')), ['1000.00', '-0.25']);
  assert.deepEqual(plain(tag(body, 'DTTRADE')), ['20260104120000', '20260105120000']);
  assert.deepEqual(plain(tag(qfx, 'AVAILCASH')), ['1235290.75']);
  // SECLIST: keyed by the original symbol, shown with the names set in the Securities table
  const sec = qfx.slice(qfx.indexOf('<SECLIST>'));
  assert.deepEqual(plain(tag(sec, 'UNIQUEID')), ['XYZ.F', 'ABC']);
  assert.deepEqual(plain(tag(sec, 'SECNAME')), ['My Bond', 'Example Equity ETF – UNITS']);
  assert.deepEqual(plain(tag(sec, 'TICKER')), ['XYZ', 'ABC']);
});

test('toQFX: dividends as INCOME DIV, lending interest as INT, withdrawals negative', () => {
  const objs = month(
    '"2026-04-06","DIV","XYZ - Example ETF: Cash dividend distribution, received on 2026-04-06, record date of 2026-03-30","1.23","1.23","CAD"',
    '"2026-04-15","FPLINT","Stock lending monthly interest payment","0.02","1.25","CAD"',
    '"2026-04-20","TRFOUT","Money transfer out of the account (executed at 2026-04-20)","-1.0","0.25","CAD"');
  const res = Q.combine([{ id: 1, name: 'x.csv', objs }]);
  const qfx = Q.toQFX(Q.buildOutput(res.items, OPTS), { bid: '03349', accountId: 'Test Account', cash: res.cash, now: NOW });
  assertBalanced(qfx);
  assert.match(qfx, /<INCOME>\r\n<INVTRAN>\r\n<FITID>[0-9a-f]{32}\r\n<DTTRADE>20260406120000\r\n<\/INVTRAN>\r\n<SECID>\r\n<UNIQUEID>XYZ\r\n<UNIQUEIDTYPE>TICKER\r\n<\/SECID>\r\n<INCOMETYPE>DIV\r\n<TOTAL>1\.23\r\n/);
  assert.deepEqual(plain(tag(qfx, 'TRNTYPE')), ['INT', 'DEBIT']);
  assert.deepEqual(plain(tag(qfx, 'TRNAMT')), ['0.02', '-1.00']);
  assert.deepEqual(plain(tag(qfx, 'AVAILCASH')), ['0.25']);
});

test('investment FITIDs are unique and do not depend on the date choice', () => {
  const items = Q.combine([{ id: 1, name: 'x-AB12CD34CAD-2026-01-01.csv', objs: Q.toObjects(Q.parseCSV(STATEMENT)) }]).items;
  const a = Q.buildOutput(items, OPTS).map(r => r._fitid), b = Q.buildOutput(items, { ...OPTS, dateMode: 'statement' }).map(r => r._fitid);
  assert.equal(new Set(a).size, a.length);
  assert.deepEqual(plain(b).sort(), plain(a).sort());
});

test('encode1252 writes Windows-1252 bytes: accents as single bytes, smart punctuation mapped, others "?"', () => {
  assert.deepEqual([...Q.encode1252('Aé–€✓')], [0x41, 0xE9, 0x96, 0x80, 0x3F]);
});

test('closing cash ignores a trailing stock-lending row (its balance is a share count, not cash)', () => {
  const objs = month(
    '"2026-05-01","CONT","Contribution (executed at 2026-05-01)","30.0","30.0","CAD"',
    '"2026-05-11","LOAN","XYZ - Example ETF: 2.0000 Shares on loan (executed at 2026-05-11)","0.0","0.0","XYZ"');
  assert.equal(Q.combine([{ id: 1, name: 'x.csv', objs }]).cash, 30);
});

test('investment toQFX uses a typed account number instead of the generated one', () => {
  const res = Q.combine([{ id: 1, name: 'x.csv', objs: Q.toObjects(Q.parseCSV(STATEMENT)) }]);
  const qfx = Q.toQFX(Q.buildOutput(res.items, OPTS), { bid: '03349', accountId: 'X', acctNum: 'AB 1234', cash: 0, now: NOW });
  assert.deepEqual(plain(tag(qfx, 'ACCTID')), ['AB1234']);
});
