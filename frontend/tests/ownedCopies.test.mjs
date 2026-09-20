import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/ownedCopies.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports });
const { matchesOwnedCopyFilters } = exports;

const copies = JSON.stringify([
  { id: 'switch', platform: 'Nintendo Switch', format: 'Physical', source: 'Retail' },
  { id: 'pc', platform: 'PC', format: 'Digital', source: 'Steam', steam_appid: 42 },
]);

test('copy filters match platform, source and format values', () => {
  assert.equal(matchesOwnedCopyFilters(copies, { platforms: ['Nintendo Switch'], sources: [], formats: [] }), true);
  assert.equal(matchesOwnedCopyFilters(copies, { platforms: [], sources: ['Steam'], formats: ['Digital'] }), true);
  assert.equal(matchesOwnedCopyFilters(copies, { platforms: ['PlayStation 5'], sources: [], formats: [] }), false);
});

test('all active copy categories must match the same owned copy', () => {
  assert.equal(matchesOwnedCopyFilters(copies, {
    platforms: ['Nintendo Switch'], sources: ['Steam'], formats: [],
  }), false);
});

test('steam app identity matches the Steam source even when legacy source is empty', () => {
  const legacy = JSON.stringify([{ platform: 'PC', format: 'Digital', steam_appid: 10 }]);
  assert.equal(matchesOwnedCopyFilters(legacy, { platforms: [], sources: ['Steam'], formats: [] }), true);
});
