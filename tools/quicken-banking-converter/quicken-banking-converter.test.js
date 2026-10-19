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
const Q = vm.runInNewContext(core + ';({ HEADER_LINE, FIELDS, parseCSV, toObjects, convert, combine, buildOutput, toCSV, parseMoney, detectDateOrder, toIsoDate, readQuickenExport, quickenRows, matchExisting, nearMisses })', {});

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

test('a file that is neither an activities export nor a statement is rejected with a warning', () => {
  const { items, warnings } = Q.convert(Q.toObjects(Q.parseCSV('date, payee, fipayee-unused,amount\n02/15/2026,Someone,,-1.00')));
  assert.equal(items.length, 0);
  assert.match(warnings[0], /doesn't look like a Wealthsimple activities export or monthly statement/);
});

test('toCSV writes Quicken\'s banking header verbatim and quotes fields that need it', () => {
  const rows = Q.buildOutput(load().items, { ...OPTS, kinds: { 'MoneyMovement|AFT_IN|in': { payee: 'Pay, Inc.' } } });
  const lines = Q.toCSV(rows).split('\r\n');
  assert.equal(lines[0], 'date, payee, fipayee-unused,amount,debit/credit,category, account, tag, memo, chknum');
  assert.equal(lines[1], '01/05/2026,"Pay, Inc.",,50.00,,,My Chequing,,Direct deposit received,');
});

/* ----- Already in Quicken ----- */

test('parseMoney reads Quicken amount styles', () => {
  assert.deepEqual([' $1,234.56 ', '-1,000.00', '(25.00)', '12.50-', '$-3', '', 'Total'].map(Q.parseMoney).map(v => Number.isNaN(v) ? 'NaN' : v),
    [1234.56, -1000, -25, -12.5, -3, 'NaN', 'NaN']);
});

test('date order is detected from the values, and dates become ISO', () => {
  assert.equal(Q.detectDateOrder(['1/5/2026', '1/27/2026']), 'mdy');
  assert.equal(Q.detectDateOrder(['27/01/2026', '05/01/2026']), 'dmy');
  assert.equal(Q.detectDateOrder(['2026-01-27']), 'ymd');
  assert.equal(Q.detectDateOrder(['1/5/2026', '2/6/2026']), null);
  assert.equal(Q.toIsoDate('1/5/26', 'mdy'), '2026-01-05');
  assert.equal(Q.toIsoDate('27/01/2026', 'dmy'), '2026-01-27');
  assert.equal(Q.toIsoDate('Total', 'mdy'), null);
});

test('a CSV report: title lines and totals skipped, Payment/Deposit pair or Amount column', () => {
  const report = [
    '"Transaction Report"', '"1/1/2026 through 2/28/2026"', '',
    '"","Date","Account","Num","Description","Memo","Category","Clr","Amount"',
    '"","1/27/2026","Chequing","","Pay Co","","Salary","R","1,200.00"',
    '"","1/28/2026","Chequing","","Rent","","Housing","","(950.00)"',
    '"","1/28/2026","Savings","","Move","","[Chequing]","","-50.00"',
    '"","","","","","","","Total","200.00"'].join('\r\n');
  const qx = Q.readQuickenExport(report);
  assert.deepEqual(plain(qx.map), { date: 1, payee: 4, account: 2, amount: 8 });
  assert.deepEqual(plain(Q.quickenRows(qx, qx.map, qx.order)), [
    { iso: '2026-01-27', amount: 1200, payee: 'Pay Co', account: 'Chequing' },
    { iso: '2026-01-28', amount: -950, payee: 'Rent', account: 'Chequing' },
    { iso: '2026-01-28', amount: -50, payee: 'Move', account: 'Savings' }]);
  const pair = Q.readQuickenExport('Date,Payee,Payment,Deposit\n05/02/2026,A,10.00,\n06/02/2026,B,,4.50\n13/02/2026,C,1.00,');
  assert.equal(pair.order, 'dmy');
  assert.deepEqual(plain(Q.quickenRows(pair, pair.map, pair.order).map(r => [r.iso, r.amount])),
    [['2026-02-05', -10], ['2026-02-06', 4.5], ['2026-02-13', -1]]);
});

test('a QIF export: only transaction sections, tagged by account; memorized payees, prices and lists ignored', () => {
  const qif = ['!Type:Cat', 'NSalary', 'I', '^',
    '!Option:AutoSwitch', '!Account', 'NChequing', 'TBank', '^', '!Account', 'NTFSA', 'TInvst', '^', '!Clear:AutoSwitch',
    '!Account', 'NChequing', 'TBank', '^', '!Type:Bank ',
    "D1/ 5'26", 'U1,200.00', 'T1,200.00', 'PPay Co', 'LSalary', '^',
    "D1/28'26", 'T-50.00', 'MMove', 'L[TFSA]', 'S[TFSA]', '$-50.00', '^',
    '!Account', 'NTFSA', 'TInvst', '^', '!Type:Invst',
    'D01/29/2026', 'NBuy', 'YExample ETF', 'I10', 'Q2', 'T20.00', '^',
    '!Type:Memorized', 'PPay Co', 'T1,200.00', '^',
    '!Type:Prices', '"XYZ",10.5,"1/30\'26"', '^'].join('\r\n');
  const qx = Q.readQuickenExport(qif);
  assert.ok(qx.qif);
  assert.deepEqual(plain(Q.quickenRows(qx, qx.map, qx.order)), [
    { iso: '2026-01-05', amount: 1200, payee: 'Pay Co', account: 'Chequing' },
    { iso: '2026-01-28', amount: -50, payee: 'Move', account: 'Chequing' },
    { iso: '2026-01-29', amount: 20, payee: 'Buy Example ETF', account: 'TFSA' }]);
});

test('matchExisting: same amount within the window, one Quicken row per download row, closest date first', () => {
  const ours = [
    { id: 'a', iso: '2026-06-25', amount: 200 }, { id: 'b', iso: '2026-06-25', amount: 200 },
    { id: 'c', iso: '2026-06-28', amount: -100 }, { id: 'd', iso: '2026-07-10', amount: -100 }, { id: 'e', iso: '2026-07-01', amount: 0.17 }];
  const theirs = [{ iso: '2026-06-25', amount: 200 }, { iso: '2026-06-26', amount: -100 }, { iso: '2026-07-01', amount: -0.17 }];
  const m = Q.matchExisting(ours, theirs, { days: 3 });
  assert.deepEqual([...m.keys()].sort(), ['a', 'c']);     // one $200 in Quicken → only one of the two deposits
  assert.equal(Q.matchExisting(ours, theirs, { days: 1 }).has('c'), false);   // 2 days apart
  assert.equal(Q.matchExisting(ours, theirs, { days: 3, absolute: true }).has('e'), true);
});

test('a cash account monthly statement: account from the filename, kinds by code, trades and lending skipped', () => {
  const st = (...lines) => Q.toObjects(Q.parseCSV(['"date","transaction","description","amount","balance","currency"', ...lines].join('\n')));
  const name = '__My_savings-monthly-statement-transactions-AB12CD34CAD-2026-03-01.csv';
  const { items, warnings } = Q.combine([{ id: 1, name, objs: st(
    '"2026-03-01","INT","Interest earned","0.04","10.04","CAD"',
    '"2026-03-17","TRFINTF","Transfer in","50.0","60.04","CAD"',
    '"2026-03-17","TRFINTF","Transfer in","50.0","110.04","CAD"',
    '"2026-03-18","TRFOUTTF","Transfer out (executed at 2026-03-19)","-100.0","10.04","CAD"',
    '"2026-03-20","LOAN","XYZ - Example ETF: 1.0000 Shares on loan","0.0","0.0","XYZ"') }]);
  assert.equal(warnings.length, 0);
  assert.equal(items.length, 4);
  assert.deepEqual(plain([...new Set(items.map(i => [i.accountId, i.accountType].join(' / ')))]), ['AB12CD34CAD / My savings']);
  const rows = Q.buildOutput(items, { dateMode: 'executed', kinds: {}, accounts: { AB12CD34CAD: { name: 'Savings', include: true } } });
  assert.deepEqual(plain(rows.map(r => [r.date, r.payee, r.amount])), [
    ['03/01/2026', 'Interest', '0.04'], ['03/17/2026', 'Transfer in', '50.00'], ['03/17/2026', 'Transfer in', '50.00'],
    ['03/19/2026', 'Transfer out', '-100.00']]);
  const trades = Q.convert(st('"2026-03-02","BUY","XYZ - Example ETF: Bought 1 shares at $10.00 per share","-10.0","0.0","CAD"'), name);
  assert.match(trades.warnings[0], /use the Quicken Investment Converter/);
});

test('warns when one account comes from both an activities export and a monthly statement', () => {
  const st = Q.toObjects(Q.parseCSV('"date","transaction","description","amount","balance","currency"\n"2026-01-05","INT","Interest earned","0.03","10.03","CAD"'));
  const act = exp(ROWS[0].replace('ACC1', 'AB12CD34CAD'));
  const { warnings } = Q.combine([{ id: 1, name: 'a.csv', objs: act },
    { id: 2, name: 'Chq-monthly-statement-transactions-AB12CD34CAD-2026-01-01.csv', objs: st }]);
  assert.ok(warnings.some(w => /AB12CD34CAD is in both an activities export and a monthly statement/.test(w)));
  assert.ok(!Q.combine([{ id: 1, name: 'a.csv', objs: exp(ROWS[0]) }]).warnings.length);
});

test('nearMisses: an unmatched row with the same amount just outside the window is reported, closest first', () => {
  const ours = [{ id: 'a', iso: '2026-01-28', amount: -100 }, { id: 'b', iso: '2026-03-01', amount: 5 }, { id: 'c', iso: '2026-06-01', amount: 7 }];
  const theirs = [{ iso: '2026-02-03', amount: -100 }, { iso: '2026-02-01', amount: -100 }, { iso: '2026-03-01', amount: 5 }, { iso: '2026-07-01', amount: 7 }];
  const m = Q.matchExisting(ours, theirs, { days: 3 });
  const n = Q.nearMisses(ours, theirs, m, { days: 3 });
  assert.deepEqual([...m.keys()], ['b']);
  assert.equal(n.get('a').gap, 4);               // Feb 1 beats Feb 3
  assert.equal(n.get('a').t.iso, '2026-02-01');
  assert.ok(!n.has('b') && !n.has('c'));          // b matched; c is 30 days off, past the 14-day reach
});

test('combine returns the rows it dropped as repeats, naming the file they were already in', () => {
  const feb = exp('2026-02-02,10:00:00,,ACC1,Chequing,MoneyMovement,AFT_IN,Direct deposit received,,,,CAD,60,,,60');
  const res = Q.combine([{ id: 1, name: 'jan.csv', objs: exp(...ROWS) }, { id: 2, name: 'jan-again.csv', objs: exp(...ROWS) }, { id: 3, name: 'feb.csv', objs: feb }]);
  assert.equal(res.dropped.length, 5);   // the 6th sample row is a trade, skipped
  assert.ok(res.dropped.every(d => d.dupOf === 'jan.csv' && d.id.startsWith('2:')));
});

test('a QIF export also yields its category list and account names', () => {
  const qx = Q.readQuickenExport(['!Type:Cat', 'NSalary', 'DPay', 'I', '^', 'NHousing:Rent', 'E', '^', 'NAuto', 'E', '^',
    '!Option:AutoSwitch', '!Account', 'NChequing', 'TBank', '^', '!Account', 'NMy TFSA', 'TInvst', '^', '!Clear:AutoSwitch',
    '!Account', 'NChequing', 'TBank', '^', '!Type:Bank', "D1/ 5'26", 'T10.00', 'LSalary', '^',
    '!Type:Memorized', 'NNot a category', 'T1', '^'].join('\r\n'));
  assert.deepEqual(plain(qx.categories), ['Auto', 'Housing:Rent', 'Salary']);
  assert.deepEqual(plain(qx.accounts), [{ name: 'Chequing', type: 'Bank' }, { name: 'My TFSA', type: 'Invst' }]);
});

test('a CSV report yields the categories and accounts its rows use, without transfers or totals', () => {
  const qx = Q.readQuickenExport(['Date,Account,Description,Category,Amount', '1/2/2026,Chq,A,Groceries,-5', '1/3/2026,Chq,B,[Savings],-9',
    '1/4/2026,Savings,C,Salary,10', ',,,Grand Total,-4'].join('\n'));
  assert.deepEqual(plain(qx.categories), ['Groceries', 'Salary']);
  assert.deepEqual(plain(qx.accounts.map(a => a.name)), ['Chq', 'Savings']);
});
