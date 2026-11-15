import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(source, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(new URL(source, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => dependencies[name] });
  return exports;
}

const ownedCopies = load('../src/lib/ownedCopies.ts');
const completionDate = load('../src/lib/completionDate.ts');
const csv = load('../src/lib/collectionCsv.ts', { './ownedCopies': ownedCopies, './completionDate': completionDate });
const headers = Array.from(csv.COLLECTION_CSV_HEADERS);

/** Minimal RFC 4180 reader, enough to check that the output parses back to the same fields. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const records = text => {
  const [head, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  return rows.map(row => Object.fromEntries(head.map((name, index) => [name, row[index]])));
};

const copies = list => JSON.stringify(list);

test('starts with a UTF-8 BOM, uses CRLF and writes the header row even with no games', () => {
  const text = csv.buildCollectionCsv([]);
  assert.equal(text.codePointAt(0), 0xFEFF);
  assert.equal(text, `\uFEFF${headers.join(',')}\r\n`);
  assert.ok(headers.includes('Completion Date') && headers.includes('Stopped Date') && headers.includes('Notes'));
});

test('keeps the order of the games it is given', () => {
  const text = csv.buildCollectionCsv([{ name: 'Zelda' }, { name: 'Animal Crossing' }, { name: 'Metroid' }]);
  assert.deepEqual(records(text).map(row => row.Name), ['Zelda', 'Animal Crossing', 'Metroid']);
});

test('quotes commas, quotes, line breaks and edge spaces, and keeps accents', () => {
  const notes = 'Me encantó, de verdad.\nEl "final" es increíble';
  const text = csv.buildCollectionCsv([{ name: 'Pokémon Rojo, Azul', comments: notes }, { name: ' Spaced ' }]);
  assert.ok(text.includes('"Pokémon Rojo, Azul"'));
  assert.ok(text.includes('"Me encantó, de verdad.\nEl ""final"" es increíble"'));
  const [first, second] = records(text);
  assert.equal(first.Name, 'Pokémon Rojo, Azul');
  assert.equal(first.Notes, notes);
  assert.equal(second.Name, ' Spaced ');
  assert.equal(csv.escapeCsvField('plain'), 'plain');
});

test('completion date only for Finished or Viewed games, stopped date only for Stopped games', () => {
  const dates = { completion_date: '2025-03', stopped_date: '2026-01-10' };
  const rows = records(csv.buildCollectionCsv([
    { name: 'Finished', status: 'Finished', ...dates },
    { name: 'Viewed', status: 'Viewed', ...dates },
    { name: 'Stopped', status: 'Stopped', ...dates },
    { name: 'Playing', status: 'Playing', ...dates },
    { name: 'Not Started', status: 'Not Started', ...dates },
  ]));
  assert.deepEqual(rows.map(row => [row.Name, row['Completion Date'], row['Stopped Date']]), [
    ['Finished', '2025-03', ''],
    ['Viewed', '2025-03', ''],
    ['Stopped', '', '2026-01-10'],
    ['Playing', '', ''],
    ['Not Started', '', ''],
  ]);
});

test('describes copies, platforms, formats, prices per currency and old copies', () => {
  const [row] = records(csv.buildCollectionCsv([{
    name: 'Hades',
    status: 'Finished',
    mark: 9,
    completion_percentage: 100,
    playtime_mode: 'copies',
    playtime_hours: 3,
    release_date: '2020-09-17',
    copies: copies([
      { platform: 'PC', format: 'Digital', source: 'Steam', price: 24.99, currency: 'EUR', playtime_hours: 40.256 },
      { platform: 'Nintendo Switch', format: 'Physical', region: 'Spain', price: 30, currency: 'EUR', playtime_hours: 10 },
      { platform: 'pc', format: 'Digital', source: 'Epic', price: 5, currency: 'USD' },
    ]),
    old_copies: copies([{ console: 'PlayStation 4', playtime_hours: 2 }]),
    tags: 'Roguelike, Indie,Roguelike',
    dlcs: JSON.stringify([{ name: 'Bonus Pack', state: 'finished' }, { name: 'Soundtrack', state: 'not_owned' }]),
    play_next: false,
  }]));
  assert.equal(row.Type, 'Game');
  assert.equal(row['Rating (1-10)'], '9');
  assert.equal(row['Completion %'], '100');
  assert.equal(row['Playtime (hours)'], '52.26');
  assert.equal(row['Release Date'], '2020-09-17');
  assert.equal(row.Platforms, 'PC; Nintendo Switch');
  assert.equal(row.Formats, 'Digital; Physical');
  assert.equal(row['Copy Count'], '3');
  assert.equal(row.Copies, 'PC (Digital, Steam, 24.99 EUR, 40.26 h); Nintendo Switch (Physical, Spain, 30.00 EUR, 10 h); pc (Digital, Epic, 5.00 USD)');
  assert.equal(row['Purchase Price'], '54.99 EUR; 5.00 USD');
  assert.equal(row['Previously Owned On'], 'PlayStation 4');
  assert.equal(row.Tags, 'Roguelike; Indie');
  assert.equal(row.DLCs, 'Bonus Pack (Finished); Soundtrack (Not Owned)');
  assert.equal(row['Play Next'], 'No');
});

test('leaves missing values empty and falls back to the publication year', () => {
  const [row] = records(csv.buildCollectionCsv([{
    name: 'Expansion', is_dlc: true, parent_game_name: 'Base Game', status: 'Not Started', hype: 7,
    publication_year: 2027, copies: 'not json', play_next: true,
  }]));
  assert.equal(row.Type, 'DLC');
  assert.equal(row['Parent Game'], 'Base Game');
  assert.equal(row['Hype (1-10)'], '7');
  assert.equal(row['Rating (1-10)'], '');
  assert.equal(row['Playtime (hours)'], '');
  assert.equal(row['Release Date'], '2027');
  assert.equal(row['Copy Count'], '0');
  assert.equal(row['Purchase Price'], '');
  assert.equal(row['Play Next'], 'Yes');
  assert.equal(row.Notes, '');
});

test('file name uses the local date', () => {
  assert.equal(csv.collectionCsvFilename(new Date(2026, 0, 5, 23, 30)), 'collection-2026-01-05.csv');
});
