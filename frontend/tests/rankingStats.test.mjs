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

test('viewed games have their own count without changing played or finished statistics', () => {
  const games = [
    { id: 1, name: 'Played', status: 'Finished', completion_date: '2026-04', completion_percentage: 80 },
    { id: 2, name: 'Watched', status: 'Viewed', completion_date: '2026-05', completion_percentage: 100, mark: 9 },
    { id: 3, name: 'Hidden watched game', status: 'Viewed', hidden: true },
    { id: 4, name: 'Watched expansion', status: 'Viewed', is_dlc: true },
  ];
  const result = stats.calculateVideogameStats(games, new Date('2026-09-28'));
  assert.equal(result.totalGames, 2);
  assert.equal(result.viewedGames, 1);
  assert.equal(result.statusCounts.find(row => row.name === 'Viewed').value, 1);
  assert.equal(result.playedGames, 1);
  assert.equal(result.finishedGames, 1);
  assert.equal(result.finishedThisYear, 1);
  assert.equal(result.finishRate, 1);
  assert.equal(result.averageCompletion, 80);
  assert.equal(result.avgRating, 9);
  assert.equal(ranking.matchesTierFilters(games[1], { ...ranking.EMPTY_TIER_FILTERS, statuses: ['Viewed'] }), true);
  assert.equal(ranking.matchesTierFilters(games[0], { ...ranking.EMPTY_TIER_FILTERS, statuses: ['Viewed'] }), false);
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

test('extended statistics cover playtime, taste, the current year and spending', () => {
  const games = [
    { id: 1, name: 'Long RPG', status: 'Finished', mark: 9, hype: 6, tags: 'RPG', publication_year: 2017, playtime_hours: 120, completion_date: '2026-03-10',
      copies: JSON.stringify([{ id: 'a', platform: 'Nintendo Switch', format: 'Physical', region: 'Spain', source: 'Retail', price: 50, currency: 'EUR' }, { id: 'b', platform: 'PC', format: 'Digital', steam_appid: 5, price: 10, currency: 'EUR' }]) },
    { id: 2, name: 'Short RPG', status: 'Finished', mark: 7, hype: 9, tags: 'RPG, Indie', publication_year: 2021, playtime_hours: 8, completion_date: '2026-03',
      copies: JSON.stringify([{ id: 'c', platform: 'PC', format: 'Digital', source: 'Steam', price: 20, currency: 'USD' }]) },
    { id: 3, name: 'Third RPG', status: 'Stopped', mark: 5, tags: 'RPG', publication_year: 2022, playtime_hours: 3 },
    { id: 4, name: 'Backlog hit', status: 'Not Started', hype: 10 },
    { id: 5, name: 'Backlog maybe', status: 'Not Started', hype: 4 },
    { id: 6, name: 'Unrated', status: 'Finished', completion_date: '2025-12', playtime_hours: 30 },
  ];
  const result = stats.calculateVideogameStats(games, new Date('2026-09-28'));
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(result.playtimeByStatus), [{ name: 'Finished', value: 158 }, { name: 'Stopped', value: 3 }]);
  assert.deepEqual(plain(result.playtimeBuckets.map(row => row.value)), [1, 1, 1, 0, 1]);
  assert.equal(result.medianHoursFinished, 30);
  assert.deepEqual(plain(result.hoursByTag), [{ name: 'RPG', value: 131 }, { name: 'Indie', value: 8 }]);
  // Indie has a single rated game, too few for an average.
  assert.deepEqual(plain(result.ratingByTag), [{ name: 'RPG', value: 7, count: 3 }]);
  assert.deepEqual(plain(result.ratingByDecade.map(row => [row.name, row.value])), [['2010', 9], ['2020', 6]]);
  assert.equal(result.averageHypeDelta, 0.5);
  assert.equal(result.surprises[0].game.name, 'Long RPG');
  assert.equal(result.letdowns[0].game.name, 'Short RPG');
  assert.deepEqual(plain(result.backlogByHype.map(game => game.name)), ['Backlog hit', 'Backlog maybe']);
  assert.equal(result.finishesByMonth[2].value, 2);
  assert.equal(result.finishesByMonth.reduce((sum, row) => sum + row.value, 0), 2);
  assert.equal(result.unratedFinished, 1);
  assert.deepEqual(plain(result.spendingByCurrency), [{ name: 'EUR', value: 60 }, { name: 'USD', value: 20 }]);
  assert.equal(result.mainCurrency, 'EUR');
  assert.equal(result.averagePrice, 30);
  assert.deepEqual(plain(result.spendingByPlatform), [{ name: 'Nintendo Switch', value: 50 }, { name: 'PC', value: 10 }]);
  assert.equal(result.mostExpensive[0].name, 'Long RPG');
  assert.deepEqual(plain(result.sourceCounts), [{ name: 'Steam', value: 2 }, { name: 'Retail', value: 1 }]);
  assert.deepEqual(plain(result.physicalRegionCounts), [{ name: 'Spain', value: 1 }]);
  assert.equal(result.multiCopyGames, 1);
});
