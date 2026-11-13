import { analyticsPlaytimeHours, parseCopies, parseOldCopies } from './ownedCopies';
import { tagNames, type StatsGame } from './videogameStats';

export type RewindGame = StatsGame;

/** A game in a rewind, with the hours the statistics page would count for it. */
export interface RewindEntry {
  game: RewindGame;
  hours: number;
}

export interface RewindBreakdownRow {
  name: string;
  games: number;
  hours: number;
}

export interface RewindOptions {
  /** Used to decide which year undated games that are being played belong to. */
  now?: Date;
  /** The user's personal ranking, best first. Breaks ties between equal ratings. */
  rankingIds?: number[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Statuses that mean the game was actually played. 'Not Started' and 'Viewed' never count.
const PLAYED_STATUSES = new Set(['Finished', 'Playing', 'Infinite', 'Stopped']);
const ACTIVE_STATUSES = new Set(['Playing', 'Infinite']);

export function rewindDateYear(value?: string | null): number | null {
  const match = value?.trim().match(/^(\d{4})(?:$|-)/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1950 && year <= 2100 ? year : null;
}

/** Zero-based month of a completion date, or null when the date only has a year. */
export function rewindDateMonth(value?: string | null): number | null {
  const match = value?.trim().match(/^\d{4}-(\d{1,2})(?:$|-)/);
  if (!match) return null;
  const month = Number(match[1]) - 1;
  return month >= 0 && month < 12 ? month : null;
}

const isVisible = (game: RewindGame) => !game.hidden && !game.merged_into_game_id;
const validMark = (game: RewindGame): number | null =>
  typeof game.mark === 'number' && game.mark >= 1 && game.mark <= 10 ? game.mark : null;

/**
 * The year a game belongs to, or null when it has no place in any rewind.
 * A dated game belongs to the year of its date only. An undated game counts for the
 * current year while it is being played; any other undated game is left out.
 */
export function rewindYearOf(game: RewindGame, currentYear: number): number | null {
  if (!isVisible(game) || !game.status || !PLAYED_STATUSES.has(game.status)) return null;
  const dated = rewindDateYear(game.completion_date);
  if (dated != null) return dated;
  return ACTIVE_STATUSES.has(game.status) ? currentYear : null;
}

/** Years that have something to show, newest first. The current year is always offered. */
export function rewindYears(games: RewindGame[], now = new Date()): number[] {
  const currentYear = now.getFullYear();
  const years = new Set<number>([currentYear]);
  games.forEach(game => {
    const year = rewindYearOf(game, currentYear);
    if (year != null && year <= currentYear) years.add(year);
  });
  return [...years].sort((a, b) => b - a);
}

function breakdown(rows: Array<{ name: string; hours: number }>): RewindBreakdownRow[] {
  const totals = new Map<string, RewindBreakdownRow>();
  rows.forEach(row => {
    const key = row.name.toLocaleLowerCase();
    const entry = totals.get(key) || { name: row.name, games: 0, hours: 0 };
    entry.games += 1;
    entry.hours += row.hours;
    totals.set(key, entry);
  });
  return [...totals.values()]
    .map(row => ({ ...row, hours: Math.round(row.hours * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours || b.games - a.games || a.name.localeCompare(b.name));
}

/** Distinct values per game, so two copies on one platform count the game once. */
function distinct(values: Array<string | null | undefined>): string[] {
  const seen = new Map<string, string>();
  values.forEach(value => {
    const name = value?.trim();
    if (name && !seen.has(name.toLocaleLowerCase())) seen.set(name.toLocaleLowerCase(), name);
  });
  return [...seen.values()];
}

export function buildYearlyRewind(allGames: RewindGame[], year: number, options: RewindOptions = {}) {
  const currentYear = (options.now || new Date()).getFullYear();
  const rankPosition = new Map((options.rankingIds || []).map((id, index) => [id, index]));
  const rankOf = (game: RewindGame) => rankPosition.get(game.id) ?? Number.MAX_SAFE_INTEGER;

  const inYear = allGames.filter(game => rewindYearOf(game, currentYear) === year);
  // Hours follow the statistics page: the game's playtime mode decides the source, copies that
  // do not count toward totals are skipped and a Steam app shared by two cards is counted once.
  const seenSteamApps = new Set<number>();
  const withHours = (game: RewindGame): RewindEntry => ({ game, hours: analyticsPlaytimeHours(game, seenSteamApps) || 0 });
  const played = inYear.filter(game => !game.is_dlc).map(withHours);
  const dlcPlayed = inYear.filter(game => game.is_dlc).map(withHours);
  const watched = allGames.filter(game => isVisible(game) && !game.is_dlc && game.status === 'Viewed' && rewindDateYear(game.completion_date) === year);

  const byName = (a: RewindEntry, b: RewindEntry) => a.game.name.localeCompare(b.game.name);
  const timed = played.filter(entry => entry.hours > 0);
  const finished = played.filter(entry => entry.game.status === 'Finished');
  const rated = played.filter(entry => validMark(entry.game) != null);
  const totalHours = timed.reduce((sum, entry) => sum + entry.hours, 0);

  const mostPlayed = [...timed].sort((a, b) => b.hours - a.hours || byName(a, b));
  const topRated = [...rated].sort((a, b) =>
    validMark(b.game)! - validMark(a.game)! || rankOf(a.game) - rankOf(b.game) || b.hours - a.hours || byName(a, b));
  const gameOfTheYear = topRated[0] || mostPlayed[0] || null;
  // The worst of the year only means something next to a better one.
  const lowestRated = topRated.length > 1 && validMark(topRated.at(-1)!.game)! < validMark(topRated[0].game)!
    ? [...rated].sort((a, b) => validMark(a.game)! - validMark(b.game)! || rankOf(b.game) - rankOf(a.game) || byName(a, b))[0]
    : null;

  // --- Expectations ---------------------------------------------------------
  const hyped = rated.filter(entry => typeof entry.game.hype === 'number')
    .map(entry => ({ ...entry, delta: validMark(entry.game)! - entry.game.hype! }));
  const surprises = hyped.filter(row => row.delta > 0).sort((a, b) => b.delta - a.delta || validMark(b.game)! - validMark(a.game)! || byName(a, b));
  const letdowns = hyped.filter(row => row.delta < 0).sort((a, b) => a.delta - b.delta || validMark(a.game)! - validMark(b.game)! || byName(a, b));

  // --- Length ---------------------------------------------------------------
  const finishedTimed = finished.filter(entry => entry.hours > 0).sort((a, b) => b.hours - a.hours || byName(a, b));
  const longestFinish = finishedTimed[0] || null;
  const shortestFinish = finishedTimed.length > 1 && finishedTimed.at(-1)!.hours < finishedTimed[0].hours ? finishedTimed.at(-1)! : null;

  // --- Calendar -------------------------------------------------------------
  const monthly = MONTHS.map(month => ({ month, games: 0 }));
  finished.forEach(entry => {
    const month = rewindDateMonth(entry.game.completion_date);
    if (month != null) monthly[month].games += 1;
  });
  const monthlyTotal = monthly.reduce((sum, row) => sum + row.games, 0);
  const busiestMonth = monthlyTotal ? [...monthly].sort((a, b) => b.games - a.games)[0] : null;
  const datedFinishes = finished.filter(entry => rewindDateMonth(entry.game.completion_date) != null)
    .sort((a, b) => (a.game.completion_date || '').localeCompare(b.game.completion_date || '') || byName(a, b));

  // --- Release dates --------------------------------------------------------
  const released = played.filter(entry => typeof entry.game.publication_year === 'number' && entry.game.publication_year > 1950)
    .sort((a, b) => a.game.publication_year! - b.game.publication_year! || byName(a, b));
  const oldestGame = released[0] || null;
  const newestGame = released.length > 1 && released.at(-1)!.game.publication_year! > released[0].game.publication_year! ? released.at(-1)! : null;
  // A release year later than the year played is a remaster or a typo, so it says nothing about age.
  const ages = released.map(entry => year - entry.game.publication_year!).filter(age => age >= 0);
  const decadeMap = new Map<number, number>();
  released.forEach(entry => {
    const decade = Math.floor(entry.game.publication_year! / 10) * 10;
    decadeMap.set(decade, (decadeMap.get(decade) || 0) + 1);
  });
  const decades = [...decadeMap].sort((a, b) => a[0] - b[0]).map(([decade, games]) => ({ name: `${decade}s`, games }));

  // --- Tags, platforms, formats ----------------------------------------------
  const tags = breakdown(played.flatMap(entry => distinct(tagNames(entry.game.tags)).map(name => ({ name, hours: entry.hours }))));
  const platformsOf = (game: RewindGame) => distinct([
    ...parseCopies(game.copies).map(copy => copy.platform),
    ...parseOldCopies(game.old_copies).map(copy => copy.console || copy.platform),
  ]);
  const platforms = breakdown(played.flatMap(entry => platformsOf(entry.game).map(name => ({ name, hours: entry.hours }))));
  const formatsOf = (game: RewindGame) => distinct(parseCopies(game.copies).map(copy => copy.format))
    .filter(format => ['physical', 'digital'].includes(format.toLocaleLowerCase()));
  const formats = breakdown(played.flatMap(entry => formatsOf(entry.game).map(name => ({ name, hours: entry.hours }))))
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));

  // --- Statuses ---------------------------------------------------------------
  const statusOrder = ['Finished', 'Playing', 'Infinite', 'Stopped'];
  const statuses = statusOrder.map(name => ({ name, value: played.filter(entry => entry.game.status === name).length })).filter(row => row.value);

  // --- Spending ---------------------------------------------------------------
  // Copies carry no purchase date, so this is what the games of the year cost, not what was paid during it.
  const priced = played.flatMap(entry => parseCopies(entry.game.copies)
    .filter(copy => typeof copy.price === 'number' && copy.price > 0)
    .map(copy => ({ entry, price: copy.price as number, currency: copy.currency || 'EUR' })));
  const currencyTotals = new Map<string, number>();
  priced.forEach(row => currencyTotals.set(row.currency, (currencyTotals.get(row.currency) || 0) + row.price));
  const mainCurrency = [...currencyTotals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
  const costByGame = new Map<number, { entry: RewindEntry; cost: number }>();
  priced.filter(row => row.currency === mainCurrency).forEach(row => {
    const current = costByGame.get(row.entry.game.id) || { entry: row.entry, cost: 0 };
    current.cost += row.price;
    costByGame.set(row.entry.game.id, current);
  });
  const costs = [...costByGame.values()];
  const costedWithHours = costs.filter(row => row.entry.hours > 0);
  const costedHours = costedWithHours.reduce((sum, row) => sum + row.entry.hours, 0);
  const spending = mainCurrency && costs.length ? {
    currency: mainCurrency,
    total: Math.round(costs.reduce((sum, row) => sum + row.cost, 0) * 100) / 100,
    pricedGames: costs.length,
    costPerHour: costedHours > 0 ? costedWithHours.reduce((sum, row) => sum + row.cost, 0) / costedHours : null,
    mostExpensive: [...costs].sort((a, b) => b.cost - a.cost || byName(a.entry, b.entry))[0],
    // At least an hour played, so a five-minute test does not look like a bargain or a rip-off.
    bestValue: costedWithHours.filter(row => row.entry.hours >= 1)
      .map(row => ({ ...row, perHour: row.cost / row.entry.hours }))
      .sort((a, b) => a.perHour - b.perHour || byName(a.entry, b.entry))[0] || null,
  } : null;

  // --- Curiosities -----------------------------------------------------------
  const marathons = timed.filter(entry => entry.hours >= 50).length;
  const completionists = played.filter(entry => (entry.game.completion_percentage ?? 0) >= 100);

  let persona = 'The Explorer';
  let personaCopy = 'You kept your year varied and made room for different kinds of adventures.';
  if (tags[0]) {
    persona = `The ${tags[0].name} Specialist`;
    personaCopy = `${tags[0].name} led your year across ${tags[0].games} ${tags[0].games === 1 ? 'game' : 'games'}.`;
  }
  if (marathons >= Math.max(2, played.length / 2)) {
    persona = 'The Deep Diver';
    personaCopy = `You went long: ${marathons} games crossed the 50-hour mark.`;
  } else if (finished.length >= 12) {
    persona = 'The Finisher';
    personaCopy = `${finished.length} finishes made this a year of rolling credits.`;
  } else if (completionists.length >= 3) {
    persona = 'The Completionist';
    personaCopy = `${completionists.length} games taken all the way to 100%.`;
  }

  return {
    year,
    played,
    finished,
    totalHours: Math.round(totalHours * 10) / 10,
    timedGames: timed.length,
    ratedGames: rated.length,
    averageRating: rated.length ? rated.reduce((sum, entry) => sum + validMark(entry.game)!, 0) / rated.length : null,
    gameOfTheYear,
    mostPlayed,
    topRated,
    lowestRated,
    biggestSurprise: surprises[0] || null,
    biggestLetdown: letdowns[0] || null,
    longestFinish,
    shortestFinish,
    oldestGame,
    newestGame,
    monthly: monthlyTotal ? monthly : [],
    busiestMonth,
    firstFinish: datedFinishes[0] || null,
    lastFinish: datedFinishes.length > 1 ? datedFinishes.at(-1)! : null,
    decades,
    tags,
    platforms,
    formats,
    statuses,
    spending,
    marathons,
    quickWins: finished.filter(entry => entry.hours > 0 && entry.hours < 12).length,
    perfectScores: rated.filter(entry => validMark(entry.game) === 10).length,
    deepCuts: ages.filter(age => age >= 10).length,
    sameYearReleases: ages.filter(age => age === 0).length,
    averageAge: ages.length ? ages.reduce((sum, age) => sum + age, 0) / ages.length : null,
    averageHours: timed.length ? totalHours / timed.length : null,
    completionists,
    abandoned: played.filter(entry => entry.game.status === 'Stopped'),
    dlcPlayed,
    watched,
    persona,
    personaCopy,
  };
}

export type YearlyRewindData = ReturnType<typeof buildYearlyRewind>;
