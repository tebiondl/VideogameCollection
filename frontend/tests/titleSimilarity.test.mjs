import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/titleSimilarity.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports });
const { findProbableDuplicate, normalizeTitle, searchTitleCandidates, titleSimilarity } = exports;

test('title normalization ignores punctuation, spacing, case and accents', () => {
  assert.equal(normalizeTitle('  HoloCure: Save the Fáns! '), 'holocure save the fans');
  assert.equal(titleSimilarity('HoloCure: Save the Fans!', 'holocure - save the fans'), 1);
});

test('a 95 percent title match is a probable duplicate', () => {
  const current = { id: 1, name: 'abcdefghijklmnopqrst' };
  const probable = findProbableDuplicate(current, [
    current,
    { id: 2, name: 'abcdefghijklmnopqrsx' },
    { id: 3, name: 'completely unrelated' },
  ]);
  assert.equal(probable.game.id, 2);
  assert.equal(probable.similarity, 0.95);
});

test('probable duplicate search ignores hidden games and DLCs', () => {
  const current = { id: 1, name: 'Cuphead' };
  assert.equal(findProbableDuplicate(current, [
    current,
    { id: 2, name: 'Cuphead', hidden: true },
    { id: 3, name: 'Cuphead', is_dlc: true },
  ]), null);
});

test('prefilling the current title keeps a fuzzy duplicate visible and ranks it first', () => {
  const current = { id: 1, name: 'abcdefghijklmnopqrst' };
  const results = searchTitleCandidates(current.id, current.name, [
    current,
    { id: 2, name: 'abcdefghijklmnopqrsx' },
    { id: 3, name: 'abcdefghijklmnopxxxx' },
    { id: 4, name: 'unrelated title' },
  ]);
  assert.deepEqual(results.map(game => game.id), [2, 3]);
});
