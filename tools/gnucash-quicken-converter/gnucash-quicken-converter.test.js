// Unit tests for the GnuCash to Quicken core (the <script id="core"> block in index.html).
// Run:  node --test tools/gnucash-quicken-converter/gnucash-quicken-converter.test.js
// All data below is made up — never paste a real export into this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const core = /<script id="core">([\s\S]*?)<\/script>/.exec(html)[1];
const Q = vm.runInNewContext(core + ';({ HEADER_LINE, parseCSV, toObjects, convert, combine, buildOutput, toCSV, defaultCategory, readQuickenExport, quickenRows, matchExisting })', {});

/* vm objects come from another realm; round-trip through JSON so deepEqual compares plain data */
const plain = v => JSON.parse(JSON.stringify(v));

const H = 'Date,Transaction ID,Number,Description,Notes,Commodity/Currency,Void Reason,Action,Memo,Full Account Name,Account Name,Amount With Sym,Amount Num.,Value With Sym,Value Num.,Reconcile,Reconcile Date,Rate/Price';
const CHQ = 'Assets:Current Assets:My Chequing';
const row = (date, id, desc, memo, full, amt, num = '') =>
  [date, id, num, `"${desc}"`, '', 'CURRENCY::CAD', '', '', memo, `"${full}"`, `"${full.split(':').pop()}"`, '', amt, '', amt, 'n', '', '1.00'].join(',');
const gnc = (...lines) => Q.toObjects(Q.parseCSV([H, ...lines].join('\n')));
const SAMPLE = [
  row('2026-01-05', 'aaa1', 'PAYROLL   CO', '', CHQ, '1000.00'),
  row('2026-01-05', 'aaa1', 'PAYROLL   CO', '', 'Income:Salary:Job', '-1000.00'),
  row('2026-01-08', 'bbb2', 'Phone bill', 'ACME MOBILE', 'Expenses:Bills:Phone', '30.00'),
  row('2026-01-08', 'bbb2', 'Phone bill', 'ACME MOBILE', CHQ, '-30.00', '101'),
  row('2026-01-10', 'ccc3', 'To savings', '', 'Assets:Current Assets:Savings', '200.00'),
  row('2026-01-10', 'ccc3', 'To savings', '', CHQ, '-200.00'),
  row('2026-01-12', 'ddd4', 'Groceries & more', '', CHQ, '-50.00'),
  row('2026-01-12', 'ddd4', 'Groceries & more', '', 'Expenses:Food:Groceries', '40.00'),
  row('2026-01-12', 'ddd4', 'Groceries & more', '', 'Expenses:Household', '10.00'),
  row('2026-01-15', 'eee5', 'Cash', '', CHQ, '-20.00'),
  row('2026-01-15', 'eee5', 'Cash', '', 'Assets:Current Assets:Cash', '20.00'),
  row('2026-01-15', 'fff6', 'Cash', '', CHQ, '-20.00'),
  row('2026-01-15', 'fff6', 'Cash', '', 'Assets:Current Assets:Cash', '20.00'),
];
const ACC = { [CHQ]: { name: 'Chequing', include: true } };
const load = () => Q.combine([{ id: 1, name: 'chq.csv', objs: gnc(...SAMPLE) }]);

test('the file\'s own account is the one in every transaction; one row per own split', () => {
  const { items, warnings } = load();
  assert.equal(warnings.length, 0);
  assert.ok(items.every(i => i.accountId === CHQ && i.accountType === 'My Chequing'));
  assert.deepEqual(plain(items.map(i => i.amt)), [1000, -30, -200, -50, -20, -20]);
});

test('categories: Income/Expenses lose their top level; transfers, splits and imbalance default blank', () => {
  assert.equal(Q.defaultCategory('Expenses:Bills:Phone'), 'Bills:Phone');
  assert.equal(Q.defaultCategory('Income:Gifts'), 'Gifts');
  assert.equal(Q.defaultCategory('Assets:Current Assets:Savings'), '');
  assert.equal(Q.defaultCategory('Liabilities:Credit Card:Visa'), '');
  assert.equal(Q.defaultCategory('Imbalance-CAD'), '');
  assert.equal(Q.defaultCategory('Split'), '');
});

test('categories are matched to the Quicken list: whole path first, then a unique last part', () => {
  const qc = ['Bills:Telephone', 'Phone', 'Salary', 'Auto:Insurance', 'Home:Insurance'];
  assert.equal(Q.defaultCategory('Income:Salary', qc), 'Salary');
  assert.equal(Q.defaultCategory('Expenses:Bills:Phone', qc), 'Phone');                 // unique leaf match
  assert.equal(Q.defaultCategory('Expenses:Car:Insurance', qc), 'Car:Insurance');       // ambiguous leaf → GnuCash path
  assert.equal(Q.defaultCategory('Expenses:auto:insurance', qc), 'Auto:Insurance');     // whole path, any case
});

test('buildOutput: payee, signed amount, category, memo notes for transfers and splits, cheque number', () => {
  const rows = Q.buildOutput(load().items, { dateFmt: 'ymd', accounts: ACC, cats: { 'Income:Salary:Job': 'Wages' } });
  assert.deepEqual(plain(rows.map(r => [r.date, r.payee, r.amount, r.category, r.memo, r.chknum])), [
    ['2026-01-05', 'PAYROLL CO', '1000.00', 'Wages', '', ''],
    ['2026-01-08', 'Phone bill', '-30.00', 'Bills:Phone', 'ACME MOBILE', '101'],
    ['2026-01-10', 'To savings', '-200.00', '', 'Transfer: Savings', ''],
    ['2026-01-12', 'Groceries & more', '-50.00', '', 'Split: Groceries -40.00; Household -10.00', ''],
    ['2026-01-15', 'Cash', '-20.00', '', 'Transfer: Cash', ''],
    ['2026-01-15', 'Cash', '-20.00', '', 'Transfer: Cash', ''],
  ]);
});

test('overlapping exports of the same account keep each Transaction ID once; same-day look-alikes stay', () => {
  const later = [row('2026-02-01', 'ggg7', 'Interest', '', CHQ, '0.50'), row('2026-02-01', 'ggg7', 'Interest', '', 'Income:Interest', '-0.50')];
  const res = Q.combine([{ id: 1, name: 'jan.csv', objs: gnc(...SAMPLE) }, { id: 2, name: 'jan-feb.csv', objs: gnc(...SAMPLE, ...later) }]);
  assert.equal(res.items.length, 7);
  assert.equal(res.dropped.length, 6);
  assert.equal(res.items.filter(i => i.desc === 'Cash').length, 2);   // two separate GnuCash transactions
});

test('a file that isn\'t a GnuCash transaction export is rejected; day-first dates are read', () => {
  assert.match(Q.convert(Q.toObjects(Q.parseCSV('date,amount\n2026-01-01,1'))).warnings[0], /doesn't look like a GnuCash/);
  const dmy = gnc(row('25/01/2026', 'h1', 'X', '', CHQ, '5.00'), row('25/01/2026', 'h1', 'X', '', 'Income:Other', '-5.00'));
  assert.equal(Q.convert(dmy).items[0].effDate, '2026-01-25');
});

test('toCSV writes the 10-column banking layout Quicken accepts, quoting fields with commas', () => {
  const rows = Q.buildOutput(load().items, { dateFmt: 'ymd', accounts: ACC, cats: { 'Expenses:Bills:Phone': 'Bills, Phone' } });
  const lines = Q.toCSV(rows).split('\n');
  assert.equal(lines[0], 'date, payee, fipayee-unused,amount,debit/credit,category, account, tag, memo, chknum');
  assert.equal(lines[2], '2026-01-08,Phone bill,,-30.00,,"Bills, Phone",Chequing,,ACME MOBILE,101');
});

test('Already in Quicken: rows matching a QIF export are found by date and amount', () => {
  const rows = Q.buildOutput(load().items, { dateFmt: 'ymd', accounts: ACC, cats: {} });
  const qx = Q.readQuickenExport(['!Account', 'NChequing', 'TBank', '^', '!Type:Bank', "D1/ 5'26", 'T1,000.00', '^', "D1/16'26", 'T-20.00', '^'].join('\r\n'));
  const m = Q.matchExisting(rows.map(r => ({ id: r._id, iso: r._iso, amount: Number(r.amount) })), Q.quickenRows(qx, qx.map, qx.order), { days: 3 });
  assert.equal(m.size, 2);   // the pay, and one of the two $20 cash withdrawals
});
