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
const stats = load('../src/lib/videogameStats.ts', { './ownedCopies': ownedCopies });
const ranking = load('../src/lib/ranking.ts', { './ownedCopies': ownedCopies, './videogameStats': stats });

test('statistics exclude hidden and merged cards and count copy time once', () => {
  const games = [
    { id: 1, name: 'First', status: 'Finished', mark: 9, reviewed: true, completion_date: '2026-04', playtime_mode: 'copies', copies: JSON.stringify([{ platform: 'PC', format: 'Digital', steam_appid: 42, playtime_hours: 10 }]), old_copies: JSON.stringify([{ console: 'Switch', playtime_hours: 3 }]) },
    { id: 2, name: 'Second', status: 'Playing', mark: 7, playtime_mode: 'copies', copies: JSON.stringify([{ platform: 'PC', format: 'Digital', steam_appid: 42, playtime_hours: 10 }]) },
    { id: 3, name: 'Hidden', mark: 10, hidden: true },
    { id: 4, name: 'Merged', mark: 10, merged_into_game_id: 1 },
  ];
  const result = stats.calculateVideogameStats(games, new Date('2026-09-28'));
  assert.equal(result.totalGames, 2);
  assert.equal(result.totalPlaytime, 13);
  assert.equal(result.finishedThisYear, 1);
  assert.equal(result.avgRating, 8);
  assert.equal(result.reviewedCount, 1);
  assert.equal(result.oldCopies, 1);
});

test('tier filters and buckets keep removed games out of the available pool', () => {
  const game = { id: 1, name: 'Favorite', status: 'Finished', mark: 9, tags: 'RPG,Co-op', publication_year: 2021, copies: JSON.stringify([{ platform: 'PC' }]) };
  const filters = { ...ranking.EMPTY_TIER_FILTERS, statuses: ['Finished'], tags: ['rpg'], platforms: ['pc'], min_rating: 8 };
  assert.equal(ranking.matchesTierFilters(game, filters), true);
  assert.equal(ranking.matchesTierFilters({ ...game, mark: 7 }, filters), false);
  const buckets = ranking.tierBuckets([
    { game_id: 1, tier: 'S', position: 0, deleted: false },
    { game_id: 2, tier: 'S', position: 1, deleted: true },
    { game_id: 3, tier: null, position: 0, deleted: false },
  ]);
  assert.deepEqual(Array.from(buckets.S), [1]);
  assert.deepEqual(Array.from(buckets.unranked), [3]);
});

test('ranking drop and direct position controls keep the complete order intact', () => {
  const ids = [1, 2, 3, 4, 5];
  assert.deepEqual(Array.from(ranking.moveRankedGame(ids, 5, 2, 'before')), [1, 5, 2, 3, 4]);
  assert.deepEqual(Array.from(ranking.moveRankedGame(ids, 1, 4, 'after')), [2, 3, 4, 1, 5]);
  assert.deepEqual(Array.from(ranking.moveRankedGameToPosition(ids, 5, 1)), [5, 1, 2, 3, 4]);
  assert.deepEqual(Array.from(ranking.moveRankedGameToPosition(ids, 1, 5)), [2, 3, 4, 5, 1]);
  assert.strictEqual(ranking.moveRankedGame(ids, 1, 1, 'before'), ids);
  assert.strictEqual(ranking.moveRankedGameToPosition(ids, 1, 99), ids);
});

test('statistics top five follow saved ranking order instead of rating order', () => {
  const games = [
    { id: 1, name: 'Higher score', mark: 10 },
    { id: 2, name: 'Personal favorite', mark: 7 },
    { id: 3, name: 'Hidden', mark: 10, hidden: true },
  ];
  assert.deepEqual(Array.from(stats.topRankedGames(games, [2, 3, 1]).map(game => game.id)), [2, 1]);
});
