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
const { analyticsPlaytimeHours, copyPlaytimeHours, displayPlaytimeHours, matchesOwnedCopyFilters } = exports;

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

test('playtime mode selects user, copy, or combined hours', () => {
  const timedCopies = JSON.stringify([{ playtime_hours: 12.5 }, { playtime_hours: 3 }]);
  assert.equal(copyPlaytimeHours(timedCopies), 15.5);
  assert.equal(displayPlaytimeHours({ copies: timedCopies, playtime_hours: 4, playtime_mode: 'user' }), 4);
  assert.equal(displayPlaytimeHours({ copies: timedCopies, playtime_hours: 4, playtime_mode: 'copies' }), 15.5);
  assert.equal(displayPlaytimeHours({ copies: timedCopies, playtime_hours: 4, playtime_mode: 'combined' }), 19.5);
});

test('old-copy hours count as copy time without becoming current copies', () => {
  const current = JSON.stringify([{ platform: 'PC', format: 'Digital', source: 'Steam', playtime_hours: 12 }]);
  const oldCopies = JSON.stringify([{ console: 'Nintendo DS', playtime_hours: 8.5 }]);
  assert.equal(copyPlaytimeHours(current, oldCopies), 20.5);
  assert.equal(displayPlaytimeHours({ copies: current, old_copies: oldCopies, playtime_mode: 'copies' }), 20.5);
  assert.equal(displayPlaytimeHours({ copies: current, old_copies: oldCopies, playtime_hours: 2, playtime_mode: 'combined' }), 22.5);
});

test('shared Steam entitlements count once in account analytics', () => {
  const seen = new Set();
  const primary = { copies: JSON.stringify([{ steam_appid: 42, playtime_hours: 12, counts_toward_totals: true }]), playtime_mode: 'copies' };
  const shared = { copies: JSON.stringify([{ steam_appid: 42, playtime_hours: 12, counts_toward_totals: false }]), playtime_mode: 'copies' };
  assert.equal(analyticsPlaytimeHours(primary, seen), 12);
  assert.equal(analyticsPlaytimeHours(shared, seen), null);
});
