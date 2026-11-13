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
const rewind = load('../src/lib/yearlyRewind.ts', { './ownedCopies': ownedCopies, './videogameStats': stats });

const NOW = new Date('2026-11-13');
const build = (games, year = 2026, options = {}) => rewind.buildYearlyRewind(games, year, { now: NOW, ...options });
const names = entries => Array.from(entries, entry => (entry.game || entry).name);
const plain = value => JSON.parse(JSON.stringify(value));

test('completion dates are read as a year with an optional month', () => {
  assert.equal(rewind.rewindDateYear('2026'), 2026);
  assert.equal(rewind.rewindDateYear('2026-03-10'), 2026);
  assert.equal(rewind.rewindDateYear('20260310'), null);
  assert.equal(rewind.rewindDateYear('0000'), null);
  assert.equal(rewind.rewindDateYear(''), null);
  assert.equal(rewind.rewindDateMonth('2026'), null);
  assert.equal(rewind.rewindDateMonth('2026-3'), 2);
  assert.equal(rewind.rewindDateMonth('2026-13'), null);
});

test('only games really played in the year make it into the rewind', () => {
  const games = [
    { id: 1, name: 'Finished this year', status: 'Finished', completion_date: '2026-02' },
    { id: 2, name: 'Playing since this year', status: 'Playing', completion_date: '2026' },
    { id: 3, name: 'Playing without a date', status: 'Playing' },
    { id: 4, name: 'Endless without a date', status: 'Infinite' },
    { id: 5, name: 'Stopped this year', status: 'Stopped', completion_date: '2026' },
    // Everything below used to leak into the rewind.
    { id: 10, name: 'Playing since 2008', status: 'Playing', completion_date: '2008' },
    { id: 11, name: 'Endless since 2016', status: 'Infinite', completion_date: '2016' },
    { id: 12, name: 'Backlog with a date', status: 'Not Started', completion_date: '2026', mark: 9 },
    { id: 13, name: 'Watched', status: 'Viewed', completion_date: '2026', mark: 9 },
    { id: 14, name: 'Hidden', status: 'Finished', completion_date: '2026', hidden: true },
    { id: 15, name: 'Merged', status: 'Finished', completion_date: '2026', merged_into_game_id: 1 },
    { id: 16, name: 'Finished without a date', status: 'Finished' },
    { id: 17, name: 'Stopped without a date', status: 'Stopped' },
    { id: 18, name: 'Finished last year', status: 'Finished', completion_date: '2025-12-31' },
    { id: 19, name: 'No status', completion_date: '2026' },
    { id: 20, name: 'Expansion', status: 'Finished', completion_date: '2026', is_dlc: true },
  ];
  const result = build(games);
  assert.deepEqual(names(result.played).sort(), ['Endless without a date', 'Finished this year', 'Playing since this year', 'Playing without a date', 'Stopped this year']);
  assert.deepEqual(names(result.finished), ['Finished this year']);
  assert.deepEqual(names(result.dlcPlayed), ['Expansion']);
  assert.deepEqual(names(result.watched), ['Watched']);
  assert.deepEqual(names(result.abandoned), ['Stopped this year']);
  assert.deepEqual(plain(result.statuses), [{ name: 'Finished', value: 1 }, { name: 'Playing', value: 2 }, { name: 'Infinite', value: 1 }, { name: 'Stopped', value: 1 }]);
  // Dated active games stay in their own year, and undated ones never show up in a past year.
  assert.deepEqual(names(build(games, 2008).played), ['Playing since 2008']);
  assert.deepEqual(names(build(games, 2025).played), ['Finished last year']);
  assert.deepEqual(Array.from(rewind.rewindYears(games, NOW)), [2026, 2025, 2016, 2008]);
  assert.deepEqual(Array.from(rewind.rewindYears([{ id: 1, name: 'Future', status: 'Finished', completion_date: '2031' }], NOW)), [2026]);
});

test('hours follow the playtime mode and count shared Steam time once', () => {
  const steam = hours => JSON.stringify([{ platform: 'PC', format: 'Digital', steam_appid: 42, playtime_hours: hours }]);
  const games = [
    { id: 1, name: 'Copy hours', status: 'Finished', completion_date: '2026', playtime_mode: 'copies', playtime_hours: 999, copies: steam(10) },
    { id: 2, name: 'Same Steam app', status: 'Playing', completion_date: '2026', playtime_mode: 'copies', copies: steam(10) },
    { id: 3, name: 'Excluded copy', status: 'Playing', completion_date: '2026', playtime_mode: 'copies',
      copies: JSON.stringify([{ platform: 'PC', format: 'Digital', steam_appid: 7, playtime_hours: 50, counts_toward_totals: false }]) },
    { id: 4, name: 'Own hours', status: 'Finished', completion_date: '2026', playtime_hours: 4, copies: steam(30) },
    { id: 5, name: 'No hours', status: 'Finished', completion_date: '2026' },
  ];
  const result = build(games);
  assert.equal(result.totalHours, 14);
  assert.equal(result.timedGames, 2);
  assert.equal(result.averageHours, 7);
  // Games without recorded time never enter an hours ranking.
  assert.deepEqual(names(result.mostPlayed), ['Copy hours', 'Own hours']);
  assert.equal(result.longestFinish.game.name, 'Copy hours');
  assert.equal(result.shortestFinish.game.name, 'Own hours');
  assert.equal(result.quickWins, 2);
  assert.equal(result.marathons, 0);
});

test('rating categories ignore unrated games and break ties with the personal ranking', () => {
  const games = [
    { id: 1, name: 'Ten A', status: 'Finished', completion_date: '2026', mark: 10, hype: 10 },
    { id: 2, name: 'Ten B', status: 'Finished', completion_date: '2026', mark: 10, hype: 6 },
    { id: 3, name: 'Seven', status: 'Finished', completion_date: '2026', mark: 7, hype: 10 },
    { id: 4, name: 'Unrated', status: 'Finished', completion_date: '2026', hype: 9, playtime_hours: 200 },
    { id: 5, name: 'Zero mark', status: 'Finished', completion_date: '2026', mark: 0 },
    { id: 6, name: 'Four', status: 'Stopped', completion_date: '2026', mark: 4 },
  ];
  const result = build(games, 2026, { rankingIds: [2, 1, 3] });
  assert.deepEqual(names(result.topRated), ['Ten B', 'Ten A', 'Seven', 'Four']);
  assert.equal(result.gameOfTheYear.game.name, 'Ten B');
  assert.equal(result.lowestRated.game.name, 'Four');
  assert.equal(result.averageRating, 7.75);
  assert.equal(result.ratedGames, 4);
  assert.equal(result.perfectScores, 2);
  assert.equal(result.biggestSurprise.game.name, 'Ten B');
  assert.equal(result.biggestSurprise.delta, 4);
  assert.equal(result.biggestLetdown.game.name, 'Seven');
  // Without ratings the most played game takes the crown, and there is no worst of the year.
  const unrated = build([games[3]]);
  assert.equal(unrated.gameOfTheYear.game.name, 'Unrated');
  assert.equal(unrated.averageRating, null);
  assert.equal(unrated.lowestRated, null);
  assert.equal(build([games[0], games[1]]).lowestRated, null);
  assert.equal(build([games[0]]).biggestSurprise, null);
});

test('calendar categories need a month and are hidden for year-only dates', () => {
  const yearOnly = build([
    { id: 1, name: 'A', status: 'Finished', completion_date: '2026' },
    { id: 2, name: 'B', status: 'Finished', completion_date: '2026' },
  ]);
  assert.equal(yearOnly.monthly.length, 0);
  assert.equal(yearOnly.busiestMonth, null);
  assert.equal(yearOnly.firstFinish, null);
  const dated = build([
    { id: 1, name: 'March one', status: 'Finished', completion_date: '2026-03-10' },
    { id: 2, name: 'March two', status: 'Finished', completion_date: '2026-03' },
    { id: 3, name: 'January', status: 'Finished', completion_date: '2026-01-05' },
    { id: 4, name: 'Year only', status: 'Finished', completion_date: '2026' },
    { id: 5, name: 'Still playing', status: 'Playing', completion_date: '2026-06' },
  ]);
  assert.equal(dated.monthly.length, 12);
  assert.equal(dated.monthly.reduce((sum, row) => sum + row.games, 0), 3);
  assert.deepEqual(plain(dated.busiestMonth), { month: 'Mar', games: 2 });
  assert.equal(dated.firstFinish.game.name, 'January');
  assert.equal(dated.lastFinish.game.name, 'March one');
});

test('release, tag, platform and completion categories', () => {
  const games = [
    { id: 1, name: 'Classic', status: 'Finished', completion_date: '2026', publication_year: 1998, tags: 'RPG, rpg, Retro', playtime_hours: 60, completion_percentage: 100,
      copies: JSON.stringify([{ platform: 'Nintendo Switch', format: 'Physical' }, { platform: 'Nintendo Switch', format: 'Digital' }]),
      old_copies: JSON.stringify([{ console: 'PlayStation', playtime_hours: 5 }]) },
    { id: 2, name: 'Fresh', status: 'Playing', completion_date: '2026', publication_year: 2026, tags: '["RPG","Indie"]', playtime_hours: 10,
      copies: JSON.stringify([{ platform: 'PC', format: 'Digital' }]) },
    { id: 3, name: 'Remaster', status: 'Finished', completion_date: '2026', publication_year: 2030, completion_percentage: 40 },
    { id: 4, name: 'Undated release', status: 'Finished', completion_date: '2026' },
  ];
  const result = build(games);
  assert.equal(result.oldestGame.game.name, 'Classic');
  assert.equal(result.newestGame.game.name, 'Remaster');
  assert.equal(result.deepCuts, 1);
  assert.equal(result.sameYearReleases, 1);
  // The 2030 release is newer than the year played, so it is left out of the age average.
  assert.equal(result.averageAge, 14);
  assert.deepEqual(plain(result.decades), [{ name: '1990s', games: 1 }, { name: '2020s', games: 1 }, { name: '2030s', games: 1 }]);
  assert.deepEqual(plain(result.tags), [{ name: 'RPG', games: 2, hours: 70 }, { name: 'Retro', games: 1, hours: 60 }, { name: 'Indie', games: 1, hours: 10 }]);
  assert.deepEqual(plain(result.platforms), [
    { name: 'Nintendo Switch', games: 1, hours: 60 }, { name: 'PlayStation', games: 1, hours: 60 }, { name: 'PC', games: 1, hours: 10 },
  ]);
  assert.deepEqual(plain(result.formats.map(row => [row.name, row.games])), [['Digital', 2], ['Physical', 1]]);
  assert.deepEqual(names(result.completionists), ['Classic']);
  assert.equal(result.marathons, 1);
  assert.equal(result.persona, 'The RPG Specialist');
  assert.equal(build([games[0]]).newestGame, null);
});

test('spending uses the main currency and needs prices', () => {
  const games = [
    { id: 1, name: 'Bargain', status: 'Finished', completion_date: '2026', playtime_hours: 50,
      copies: JSON.stringify([{ platform: 'PC', format: 'Digital', price: 10, currency: 'EUR' }, { platform: 'Switch', format: 'Physical', price: 40, currency: 'EUR' }]) },
    { id: 2, name: 'Pricey', status: 'Finished', completion_date: '2026', playtime_hours: 0.5,
      copies: JSON.stringify([{ platform: 'PC', format: 'Digital', price: 70, currency: 'EUR' }]) },
    { id: 3, name: 'Dollars', status: 'Finished', completion_date: '2026', playtime_hours: 5,
      copies: JSON.stringify([{ platform: 'PC', format: 'Digital', price: 20, currency: 'USD' }]) },
    { id: 4, name: 'Free', status: 'Finished', completion_date: '2026', playtime_hours: 30,
      copies: JSON.stringify([{ platform: 'PC', format: 'Digital', price: 0, currency: 'EUR' }]) },
    { id: 5, name: 'Other year', status: 'Finished', completion_date: '2025', playtime_hours: 1,
      copies: JSON.stringify([{ platform: 'PC', format: 'Digital', price: 500, currency: 'EUR' }]) },
  ];
  const { spending } = build(games);
  assert.equal(spending.currency, 'EUR');
  assert.equal(spending.total, 120);
  assert.equal(spending.pricedGames, 2);
  assert.equal(spending.costPerHour, 120 / 50.5);
  assert.equal(spending.mostExpensive.entry.game.name, 'Pricey');
  // Half an hour is too little to judge value, so Pricey is not a candidate.
  assert.equal(spending.bestValue.entry.game.name, 'Bargain');
  assert.equal(spending.bestValue.perHour, 1);
  assert.equal(build([games[3]]).spending, null);
});

test('an empty year has nothing to show', () => {
  const result = build([{ id: 1, name: 'Backlog', status: 'Not Started' }]);
  assert.equal(result.played.length, 0);
  assert.equal(result.gameOfTheYear, null);
  assert.equal(result.averageHours, null);
  assert.equal(result.averageAge, null);
  assert.equal(result.spending, null);
  assert.equal(result.tags.length + result.platforms.length + result.statuses.length + result.decades.length, 0);
});
