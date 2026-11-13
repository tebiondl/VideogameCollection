import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/steamPurchases.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports });
const { matchPurchasesToCopies, parseMoney, parseSteamPurchaseHistory } = exports;
const plain = value => JSON.parse(JSON.stringify(value));

const row = (date, items, type, total, totalClass = 'wht_total') => `
  <tr class="wallet_table_row">
    <td class="wht_date">${date}</td>
    <td class="wht_items">${items.map(item => `<div>${item}</div>`).join('')}</td>
    <td class="wht_type"><div>${type}</div><div class="wth_payment">Visa</div></td>
    <td class="${totalClass}">${total}</td>
    <td class="wht_wallet_change"></td><td class="wht_wallet_balance"></td>
  </tr>`;
const table = rows => `<table><thead><tr><th>Date</th><th>Items</th><th>Type</th><th>Total</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;

test('money parsing understands European, US and whole-amount formats', () => {
  assert.deepEqual(plain(parseMoney('12,99€')), { amount: 12.99, currency: 'EUR' });
  assert.deepEqual(plain(parseMoney('$1,234.56')), { amount: 1234.56, currency: 'USD' });
  assert.deepEqual(plain(parseMoney('5,--€')), { amount: 5, currency: 'EUR' });
  assert.deepEqual(plain(parseMoney('1.234,50 €')), { amount: 1234.5, currency: 'EUR' });
  assert.deepEqual(plain(parseMoney('¥ 1,200')), { amount: 1200, currency: 'JPY' });
  assert.equal(parseMoney('Free'), null);
});

test('only game purchases are kept', () => {
  const history = parseSteamPurchaseHistory(table([
    row('13 Nov, 2026', ['Hades II'], 'Purchase', '28,99€'),
    row('10 Nov, 2026', ['Steam Community Market'], 'Market Transaction', '0,45€'),
    row('9 Nov, 2026', ['Celeste'], 'Gift Purchase', '4,99€'),
    row('8 nov 2026', ['Hollow Knight', 'Dead Cells'], 'Compra', '20,--€'),
  ]));
  assert.equal(history.skipped, 2);
  assert.deepEqual(plain(history.purchases.map(purchase => [purchase.items, purchase.total])), [
    [['Hades II'], 28.99], [['Hollow Knight', 'Dead Cells'], 20],
  ]);
});

test('refunds cancel the purchase they belong to', () => {
  const history = parseSteamPurchaseHistory(table([
    row('5 Nov, 2026', ['Dead Cells'], 'Refund', '10,--€'),
    row('4 Nov, 2026', ['Hollow Knight', 'Dead Cells'], 'Purchase', '25,--€'),
    row('3 Nov, 2026', ['Struck Through'], 'Purchase', '9,99€', 'wht_total wht_refunded'),
    row('2 Nov, 2026', ['Gone'], 'Refund', '7,--€'),
    row('1 Nov, 2026', ['Gone'], 'Purchase', '7,--€'),
  ]));
  assert.equal(history.refunded, 3);
  assert.deepEqual(plain(history.purchases.map(purchase => [purchase.items, purchase.total])), [[['Hollow Knight'], 15]]);
});

test('purchases are matched to Steam copies and shared totals are flagged', () => {
  const games = [
    { id: 1, name: 'Nier Automata', copies: JSON.stringify([{ id: 'steam:1', name: 'NieR:Automata™', steam_appid: 1, price: null }]) },
    { id: 2, name: 'Hollow Knight', copies: JSON.stringify([
      { id: 'copy:switch', name: 'Hollow Knight', platform: 'Switch', source: 'eShop' },
      { id: 'steam:2', name: 'Hollow Knight', steam_appid: 2, price: 3, currency: 'EUR' },
    ]) },
    { id: 3, name: 'Physical only', copies: JSON.stringify([{ id: 'copy:x', name: 'Dead Cells', source: 'Amazon' }]) },
  ];
  const { proposals, unmatched } = matchPurchasesToCopies([
    { date: '4 Nov, 2026', items: ['Hollow Knight', 'Dead Cells'], type: 'Purchase', total: 25, currency: 'EUR' },
    { date: '1 Nov, 2026', items: ['NieR:Automata'], type: 'Purchase', total: 19.99, currency: 'EUR' },
  ], games);
  assert.deepEqual(plain(proposals.map(row => [row.gameId, row.copyId, row.price, row.sharedWith, row.currentPrice])), [
    [2, 'steam:2', 12.5, 2, 3], [1, 'steam:1', 19.99, 1, null],
  ]);
  assert.deepEqual(plain(unmatched.map(row => [row.name, row.price])), [['Dead Cells', 12.5]]);
});
