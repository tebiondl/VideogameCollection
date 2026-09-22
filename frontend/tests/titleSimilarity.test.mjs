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
const { compareTitles, findProbableDuplicate, normalizeTitle, parseTitle, searchTitleCandidates, titleSimilarity } = exports;

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

test('roman, Arabic and written sequel numbers are equivalent', () => {
  for (const [first, second] of [
    ['Trails of Cold Steel II', 'Trails of Cold Steel 2'],
    ['Etrian Odyssey Two', 'Etrian Odyssey II'],
    ['Half-Life 2: Episode One', 'Half Life II Episode I'],
  ]) {
    const match = compareTitles(first, second);
    assert.equal(match.compatible, true);
    assert.equal(match.automatic, true);
    assert.ok(match.score >= 0.98);
  }
});

test('different installments are excluded from duplicate decisions', () => {
  for (const [first, second] of [
    ['Trails of Cold Steel', 'Trails of Cold Steel II'],
    ['Trails of Cold Steel II', 'Trails of Cold Steel III'],
    ['Borderlands 2', 'Borderlands 3'],
    ['Portal', 'Portal 2'],
    ['Half-Life 2', 'Half-Life 2: Episode One'],
    ['Trails of Cold Steel II: The Erebonian Civil War', 'Trails of Cold Steel III: The Erebonian Civil War'],
    ['One Piece Pirate Warriors 3', 'One Piece Pirate Warriors 4'],
    ['F1 2023', 'F1 2024'],
  ]) {
    const match = compareTitles(first, second);
    assert.equal(match.compatible, false);
    assert.equal(match.relation, 'different_installment');
    assert.equal(match.score, 0);
  }
});

test('a missing first-installment marker is reviewable, not automatic', () => {
  const match = compareTitles('Trails of Cold Steel', 'Trails of Cold Steel I');
  assert.equal(match.compatible, true);
  assert.equal(match.automatic, false);
  assert.equal(match.relation, 'implicit_first_installment');
  const alias = compareTitles('Skyrim', 'The Elder Scrolls V: Skyrim');
  assert.equal(alias.compatible, true);
  assert.equal(alias.automatic, false);
  assert.equal(alias.relation, 'ambiguous_numbered_alias');
});

test('number words in names are not blindly interpreted as sequel markers', () => {
  assert.deepEqual(Array.from(parseTitle('One Piece Pirate Warriors 3').installments), ['3']);
  assert.match(parseTitle('One Piece Pirate Warriors 3').base, /one piece/);
  assert.deepEqual(Array.from(parseTitle('I Am Setsuna').installments), []);
  assert.deepEqual(Array.from(parseTitle('Trails of Cold Steel II: A New Chapter').installments), ['2']);
});

test('years, editions and separate releases are distinguished', () => {
  assert.equal(compareTitles('Final Fantasy VII', 'Final Fantasy VII (2013)').automatic, true);
  assert.equal(compareTitles('Football Manager 2023', 'Football Manager 2024').compatible, false);
  assert.equal(compareTitles('Final Fantasy VII', 'Final Fantasy VII Remake').compatible, false);
  const edition = compareTitles('Skyrim', 'Skyrim Special Edition');
  assert.equal(edition.compatible, true);
  assert.equal(edition.automatic, false);
});

test('duplicate search does not offer another numbered installment by default', () => {
  const current = { id: 1, name: 'Trails of Cold Steel I' };
  const sequel = { id: 2, name: 'Trails of Cold Steel II' };
  assert.equal(findProbableDuplicate(current, [current, sequel]), null);
  assert.deepEqual(searchTitleCandidates(current.id, current.name, [current, sequel]), []);
});
