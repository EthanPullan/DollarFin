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
const Q = vm.runInNewContext(core + ';({ HEADER_LINE, FIELDS, parseCSV, toObjects, convert, combine, buildOutput, toCSV })', {});

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
