import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/ownedCopies.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports, crypto: webcrypto });
const { analyticsPlaytimeHours, copyPlaytimeHours, displayPlaytimeHours, matchesOwnedCopyFilters, moveCopyToOldCopies } = exports;

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

test('copy platform filters include historical copies', () => {
  const oldCopies = JSON.stringify([{ console: 'Nintendo DS', playtime_hours: 8.5 }]);
  assert.equal(matchesOwnedCopyFilters(copies, {
    platforms: ['Nintendo DS'], sources: [], formats: [],
  }, oldCopies), true);
  assert.equal(matchesOwnedCopyFilters(copies, {
    platforms: ['Nintendo DS'], sources: ['Steam'], formats: [],
  }, oldCopies), false);
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

test('moving a sold copy preserves history, details and total playtime while removing only that copy', () => {
  const sold = { id: 'sold', platform: 'Nintendo Switch', format: 'Physical', name: 'Special edition', price: 49.99, currency: 'EUR', playtime_hours: 42.5 };
  const kept = { id: 'kept', platform: 'PC', format: 'Digital', playtime_hours: 12 };
  const historical = { id: 'older', console: 'Nintendo DS', playtime_hours: 8 };
  const current = JSON.stringify([kept, sold]);
  const old = JSON.stringify([historical]);
  const moved = moveCopyToOldCopies(current, old, 1);
  assert.deepEqual(JSON.parse(moved.copies), [kept]);
  assert.deepEqual(JSON.parse(moved.old_copies), [historical, { ...sold, console: sold.platform }]);
  assert.equal(copyPlaytimeHours(moved.copies, moved.old_copies), copyPlaytimeHours(current, old));
  assert.equal(matchesOwnedCopyFilters(moved.copies, { platforms: ['Nintendo Switch'], sources: [], formats: [] }), false);
  assert.equal(matchesOwnedCopyFilters(moved.copies, { platforms: ['Nintendo Switch'], sources: [], formats: [] }, moved.old_copies), true);
});

test('moving the last copy supports missing IDs and preserves zero or unknown playtime', () => {
  for (const hours of [0, null]) {
    const moved = moveCopyToOldCopies(JSON.stringify([{ platform: 'PS5', format: 'Physical', playtime_hours: hours }]), null, 0);
    assert.equal(moved.copies, null);
    const [old] = JSON.parse(moved.old_copies);
    assert.ok(old.id);
    assert.equal(old.playtime_hours, hours);
  }
});

test('moving a reacquired copy keeps old-copy IDs unique', () => {
  const moved = moveCopyToOldCopies(JSON.stringify([{ id: 'same', platform: 'PC', format: 'Digital' }]), JSON.stringify([{ id: 'same', console: 'PC' }]), 0);
  const old = JSON.parse(moved.old_copies);
  assert.equal(old.length, 2);
  assert.notEqual(old[0].id, old[1].id);
});

test('moving a copy rejects missing platforms and full history before removing it', () => {
  assert.throws(() => moveCopyToOldCopies(null, null, 0), /Choose a platform/);
  assert.throws(() => moveCopyToOldCopies(JSON.stringify([{ platform: ' ' }]), null, 0), /Choose a platform/);
  assert.throws(() => moveCopyToOldCopies(copies, JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: String(i), console: 'PC' }))), 0), /at most 100/);
});

test('shared Steam entitlements count once in account analytics', () => {
  const seen = new Set();
  const primary = { copies: JSON.stringify([{ steam_appid: 42, playtime_hours: 12, counts_toward_totals: true }]), playtime_mode: 'copies' };
  const shared = { copies: JSON.stringify([{ steam_appid: 42, playtime_hours: 12, counts_toward_totals: false }]), playtime_mode: 'copies' };
  assert.equal(analyticsPlaytimeHours(primary, seen), 12);
  assert.equal(analyticsPlaytimeHours(shared, seen), null);
});
