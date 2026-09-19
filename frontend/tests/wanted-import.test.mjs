import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual TS parser without adding a browser/test framework dependency.
function moduleFrom(path, dependencies) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports;
}
const types = moduleFrom('../src/lib/discovery.ts', { './api': { fetchWithAuth: () => { throw new Error('No network in parser tests'); } } });
const { parseWantedImport } = moduleFrom('../src/lib/wantedImport.ts', { './discovery': types });

test('plain titles are trimmed and blank lines ignored', () => {
  const result = parseWantedImport('  One\r\n\r\nTwo  ', 'names');
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'One');
  assert.equal(result[1].status, 'Wanted');
});
test('CSV handles BOM, escaped quotes, commas, multiline notes, numbers and false DLC', () => {
  const result = parseWantedImport('\uFEFFname,comments,hype,is_dlc\r\n"Game, deluxe","A ""quote""\nand a newline",8,false\r\n', 'csv');
  assert.equal(result[0].name, 'Game, deluxe');
  assert.equal(result[0].comments, 'A "quote"\nand a newline');
  assert.equal(result[0].hype, 8);
  assert.equal(result[0].is_dlc, false);
});
test('JSON nested DLCs and zero prices round trip', () => {
  const result = parseWantedImport(JSON.stringify([{ name: 'DLC', target_price: 0, is_dlc: true, dlcs: [{ name: 'Bonus', state: 'not_owned' }] }]), 'json');
  assert.equal(result[0].target_price, 0);
  assert.equal(result[0].is_dlc, true);
  assert.equal(JSON.parse(result[0].dlcs)[0].name, 'Bonus');
  assert.equal(parseWantedImport(JSON.stringify(result), 'json')[0].name, 'DLC');
});
test('invalid structures and conversions are rejected before import', () => {
  for (const [input, format] of [['{}', 'json'], ['[{"name":"a","is_dlc":"yes"}]', 'json'], ['[{"name":"a","hype":"no"}]', 'json'], ['[{"name":"a","typo":"data"}]', 'json'], ['title\nA', 'csv'], ['name\n"open', 'csv'], ['', 'names']]) {
    assert.throws(() => parseWantedImport(input, format));
  }
  assert.throws(() => parseWantedImport(Array(501).fill('A').join('\n'), 'names'));
});
