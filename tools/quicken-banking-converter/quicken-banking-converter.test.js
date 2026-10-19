// Unit tests for the Quicken Banking Converter core (the <script id="core"> block in index.html).
// Run:  node --test tools/quicken-banking-converter/quicken-banking-converter.test.js
// All data below is made up — never paste a real export into this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const core = /<script id="core">([\s\S]*?)<\/script>/.exec(html)[1];
const Q = vm.runInNewContext(core + ';({ HEADER_LINE, FIELDS, parseCSV, toObjects, convert, combine, buildOutput, toCSV, toQFX, encode1252, hash128, ofxAcctId })', {});

/* vm objects come from another realm; round-trip through JSON so deepEqual compares plain data */
const plain = v => JSON.parse(JSON.stringify(v));

const H = 'effective_date,effective_time,settlement_date,account_id,account_type,activity_type,activity_sub_type,description,direction,symbol,name,currency,quantity,unit_price,commission,net_cash_amount';
const exp = (...lines) => Q.toObjects(Q.parseCSV([H, ...lines].join('\n')));
const ROWS = [
  '2026-01-05,10:00:00,,ACC1,Chequing,MoneyMovement,AFT_IN,Direct deposit received,,,,CAD,50,,,50',
  '2026-01-05,10:00:00,,ACC1,Chequing,MoneyMovement,AFT_IN,Direct deposit received,,,,CAD,50,,,50',
  '2026-01-09,09:00:00,,ACC1,Chequing,MoneyMovement,TRANSFER,Money transfer out of the account (executed at 2026-01-10),,,,CAD,-25,,,-25',
  '2026-01-31,22:00:00,,ACC1,Chequing,Interest,-,Interest received (executed at 2026-02-01),,,,CAD,0.03,,,0.03',
  '2026-01-12,11:00:00,,ACC2,TFSA,Trade,BUY,Bought XYZ,,XYZ,Example ETF,CAD,1,10,,-10',
  '2026-01-15,11:00:00,,ACC2,TFSA,MoneyMovement,CONT,Contribution,,,,CAD,10,,,10',
];
const OPTS = { dateMode: 'executed', kinds: {},
  accounts: { ACC1: { name: 'My Chequing', include: true }, ACC2: { name: 'TFSA', include: false } } };
const load = () => Q.combine([{ id: 1, name: 'a.csv', objs: exp(...ROWS) }]);

test('convert keeps cash rows, skips trades with a warning, and keeps identical rows in one file', () => {
  const { items, warnings } = load();
  assert.equal(items.length, 5);
  assert.equal(items.filter(i => i.kind === 'MoneyMovement|AFT_IN|in').length, 2);
  assert.match(warnings[0], /1 trade row\(s\) with a security symbol skipped/);
});

test('buildOutput: included accounts only, signed amounts, US dates, memo from description', () => {
  const rows = Q.buildOutput(load().items, OPTS);
  assert.deepEqual(plain(rows.map(r => [r.date, r.payee, r.amount, r.account, r.memo])), [
    ['01/05/2026', 'Direct deposit', '50.00', 'My Chequing', 'Direct deposit received'],
    ['01/05/2026', 'Direct deposit', '50.00', 'My Chequing', 'Direct deposit received'],
    ['01/10/2026', 'Transfer out', '-25.00', 'My Chequing', 'Money transfer out of the account'],
    ['02/01/2026', 'Interest', '0.03', 'My Chequing', 'Interest received'],
  ]);
});

test('effective-date mode uses the effective_date column', () => {
  const rows = Q.buildOutput(load().items, { ...OPTS, dateMode: 'effective' });
  assert.deepEqual(plain(rows.map(r => r.date)), ['01/05/2026', '01/05/2026', '01/09/2026', '01/31/2026']);
});

test('per-kind payee and category overrides apply to every row of that kind', () => {
  const rows = Q.buildOutput(load().items, { ...OPTS, kinds: { 'Interest|-|in': {}, 'Interest||in': { payee: 'Bank', category: 'Interest Inc' } } });
  const interest = rows.find(r => r.memo === 'Interest received');
  assert.equal(interest.payee, 'Bank');
  assert.equal(interest.category, 'Interest Inc');
});

test('combine sorts exports oldest first and drops rows repeated across files', () => {
  const feb = exp('2026-02-02,10:00:00,,ACC1,Chequing,MoneyMovement,AFT_IN,Direct deposit received,,,,CAD,60,,,60');
  const { items, warnings } = Q.combine([
    { id: 1, name: 'feb.csv', objs: feb },
    { id: 2, name: 'jan.csv', objs: exp(...ROWS) },
    { id: 3, name: 'jan-again.csv', objs: exp(...ROWS) },
  ]);
  assert.equal(items.length, 6);
  assert.equal(items[items.length - 1].effDate, '2026-02-02');
  assert.ok(warnings.some(w => /5 row\(s\) appeared in more than one export/.test(w)));
});

test('a file that is not an activities export is rejected with a warning', () => {
  const { items, warnings } = Q.convert(Q.toObjects(Q.parseCSV('date,transaction,description,amount\n2026-01-01,FEE,x,-1')));
  assert.equal(items.length, 0);
  assert.match(warnings[0], /doesn't look like a Wealthsimple activities export/);
});

test('toCSV writes Quicken\'s banking header verbatim and quotes fields that need it', () => {
  const rows = Q.buildOutput(load().items, { ...OPTS, kinds: { 'MoneyMovement|AFT_IN|in': { payee: 'Pay, Inc.' } } });
  const lines = Q.toCSV(rows).split('\r\n');
  assert.equal(lines[0], 'date, payee, fipayee-unused,amount,debit/credit,category, account, tag, memo, chknum');
  assert.equal(lines[1], '01/05/2026,"Pay, Inc.",,50.00,,,My Chequing,,Direct deposit received,');
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

test('toQFX: a balanced bank statement with signed amounts, INT for interest, and the closing balance', () => {
  const rows = Q.buildOutput(load().items, { ...OPTS, kinds: { 'MoneyMovement|AFT_IN|in': { payee: 'Pay & Co <Ltd> with a very long payee name' } } });
  const qfx = Q.toQFX(rows, { bid: '00002', accountId: 'ACC1', balance: '123.4', now: NOW });
  assertBalanced(qfx);
  assert.deepEqual(plain(tag(qfx, 'FID')), ['00002']);
  assert.deepEqual(plain(tag(qfx, 'INTU.BID')), ['00002']);
  assert.match(tag(qfx, 'DTSERVER')[0], /^20261019093000\.000\[-?\d+(\.\d\d)?\]$/);
  assert.deepEqual(plain(tag(qfx, 'ACCTID')), [Q.ofxAcctId('ACC1')]);
  assert.deepEqual(plain(tag(qfx, 'TRNTYPE')), ['CREDIT', 'CREDIT', 'DEBIT', 'INT']);
  assert.deepEqual(plain(tag(qfx, 'TRNAMT')), ['50.00', '50.00', '-25.00', '0.03']);
  assert.deepEqual(plain(tag(qfx, 'DTPOSTED')), ['20260105120000', '20260105120000', '20260110120000', '20260201120000']);
  assert.equal(tag(qfx, 'NAME')[0], 'Pay &amp; Co &lt;Ltd&gt; with a very long');   // cut to 32, then escaped
  assert.deepEqual(plain(tag(qfx, 'DTSTART').concat(tag(qfx, 'DTEND'), tag(qfx, 'BALAMT'), tag(qfx, 'DTASOF'))),
    ['20260105120000', '20260201120000', '123.40', '20260201120000']);
});

test('FITIDs: unique, kept apart for identical rows, and unchanged by the date choice or extra files', () => {
  const ids = rows => rows.map(r => r._fitid);
  const a = ids(Q.buildOutput(load().items, OPTS));
  assert.equal(new Set(a).size, a.length);
  assert.match(a[0], /^[0-9a-f]{32}$/);
  const eff = Q.buildOutput(load().items, { ...OPTS, dateMode: 'effective' });
  assert.deepEqual(plain(ids(eff)).sort(), plain(a).sort());
  const feb = exp('2026-02-02,10:00:00,,ACC1,Chequing,MoneyMovement,AFT_IN,Direct deposit received,,,,CAD,60,,,60');
  const both = ids(Q.buildOutput(Q.combine([{ id: 7, name: 'b.csv', objs: feb }, { id: 9, name: 'a.csv', objs: exp(...ROWS) }]).items, OPTS));
  assert.deepEqual(plain(a).filter(x => both.includes(x)), plain(a));
});
