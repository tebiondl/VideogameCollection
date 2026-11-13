import { analyticsPlaytimeHours, parseCopies, parseOldCopies } from './ownedCopies';

export interface StatsGame {
  id: number;
  name: string;
  image_url?: string | null;
  status?: string | null;
  mark?: number | null;
  hype?: number | null;
  completion_date?: string | null;
  completion_percentage?: number | null;
  publication_year?: number | null;
  playtime_hours?: number | null;
  playtime_mode?: string | null;
  copies?: string | null;
  old_copies?: string | null;
  tags?: string | null;
  dlcs?: string | null;
  reviewed?: boolean;
  hidden?: boolean;
  is_dlc?: boolean;
  merged_into_game_id?: number | null;
}

export function tagNames(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map(value => value.trim()).filter(Boolean);
  } catch { /* Legacy comma-separated values. */ }
  return raw.split(',').map(value => value.trim()).filter(Boolean);
}

export function topRankedGames(games: StatsGame[], rankedIds: number[]): StatsGame[] {
  const byId = new Map(games.filter(game => !game.hidden && !game.merged_into_game_id && game.mark != null).map(game => [game.id, game]));
  return rankedIds.map(id => byId.get(id)).filter((game): game is StatsGame => !!game).slice(0, 5);
}

function countBy(values: Array<string | number>) {
  const counts = new Map<string, number>();
  values.forEach(value => counts.set(String(value), (counts.get(String(value)) || 0) + 1));
  return [...counts].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

export function calculateVideogameStats(allGames: StatsGame[], now = new Date()) {
  const games = allGames.filter(game => !game.hidden && !game.merged_into_game_id);
  const baseGames = games.filter(game => !game.is_dlc);
  const rated = baseGames.filter(game => game.mark != null && game.mark >= 1 && game.mark <= 10);
  const seenSteamApps = new Set<number>();
  const playtimes = baseGames.map(game => ({ game, hours: analyticsPlaytimeHours(game, seenSteamApps) || 0 }));
  const totalPlaytime = playtimes.reduce((sum, row) => sum + row.hours, 0);
  const ratedMarks = rated.map(game => game.mark!).sort((a, b) => a - b);
  const medianRating = ratedMarks.length ? (ratedMarks[Math.floor((ratedMarks.length - 1) / 2)] + ratedMarks[Math.floor(ratedMarks.length / 2)]) / 2 : null;
  const completed = baseGames.filter(game => game.status === 'Finished');
  const started = baseGames.filter(game => game.status && game.status !== 'Not Started' && game.status !== 'Viewed');
  const completionValues = started.map(game => game.completion_percentage).filter((value): value is number => value != null);
  const currentYear = now.getFullYear();
  const copies = baseGames.flatMap(game => parseCopies(game.copies));
  const oldCopies = baseGames.flatMap(game => parseOldCopies(game.old_copies));
  const dlcs = baseGames.flatMap(game => {
    try { const parsed = JSON.parse(game.dlcs || '[]'); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  });
  const statusOrder = ['Not Started', 'Playing', 'Finished', 'Viewed', 'Stopped', 'Infinite'];
  const statusCounts = statusOrder.map(name => ({ name, value: baseGames.filter(game => game.status === name).length }));
  const ratingCounts = Array.from({ length: 10 }, (_, index) => ({ name: String(index + 1), value: ratedMarks.filter(mark => mark === index + 1).length }));
  const completionYears = countBy(completed.map(game => Number(game.completion_date?.slice(0, 4))).filter(year => year >= 1950 && year <= 2100)).sort((a, b) => Number(a.name) - Number(b.name));
  const releaseDecades = countBy(baseGames.map(game => game.publication_year && Math.floor(game.publication_year / 10) * 10).filter((value): value is number => !!value)).sort((a, b) => Number(a.name) - Number(b.name));
  const platformCounts = countBy(copies.map(copy => copy.platform).filter(Boolean));
  const tagCounts = countBy(baseGames.flatMap(game => tagNames(game.tags)));

  // --- Playtime -----------------------------------------------------------
  const played = playtimes.filter(row => row.hours > 0);
  const playtimeByStatus = statusOrder.map(name => ({ name, value: Math.round(played.filter(row => row.game.status === name).reduce((sum, row) => sum + row.hours, 0) * 10) / 10 })).filter(row => row.value > 0);
  const bucketEdges: Array<[string, number, number]> = [['Under 5 h', 0, 5], ['5–20 h', 5, 20], ['20–50 h', 20, 50], ['50–100 h', 50, 100], ['100 h +', 100, Infinity]];
  const playtimeBuckets = bucketEdges.map(([name, from, to]) => ({ name, value: played.filter(row => row.hours >= from && row.hours < to).length }));
  const finishedHours = played.filter(row => row.game.status === 'Finished').map(row => row.hours).sort((a, b) => a - b);
  const sumBy = (rows: Array<{ name: string; value: number }>) => {
    const totals = new Map<string, number>();
    rows.forEach(row => totals.set(row.name, (totals.get(row.name) || 0) + row.value));
    return [...totals].map(([name, value]) => ({ name, value: Math.round(value * 10) / 10 })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  };
  const hoursByTag = sumBy(played.flatMap(row => tagNames(row.game.tags).map(name => ({ name, value: row.hours }))));

  // --- Taste --------------------------------------------------------------
  const averageBy = (rows: Array<{ name: string; value: number }>, minimum: number) => {
    const groups = new Map<string, number[]>();
    rows.forEach(row => groups.set(row.name, [...(groups.get(row.name) || []), row.value]));
    return [...groups].filter(([, values]) => values.length >= minimum)
      .map(([name, values]) => ({ name, value: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100, count: values.length }));
  };
  // A tag needs a few rated games before its average says anything.
  const ratingByTag = averageBy(rated.flatMap(game => tagNames(game.tags).map(name => ({ name, value: game.mark! }))), 3)
    .sort((a, b) => b.value - a.value || b.count - a.count || a.name.localeCompare(b.name));
  const ratingByDecade = averageBy(rated.filter(game => game.publication_year).map(game => ({ name: String(Math.floor(game.publication_year! / 10) * 10), value: game.mark! })), 1)
    .sort((a, b) => Number(a.name) - Number(b.name));
  const hyped = rated.filter(game => game.hype != null).map(game => ({ game, delta: game.mark! - game.hype! }));
  const backlogByHype = baseGames.filter(game => game.status === 'Not Started' && game.hype != null)
    .sort((a, b) => b.hype! - a.hype! || a.name.localeCompare(b.name)).slice(0, 5);

  // --- This year ----------------------------------------------------------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const finishesByMonth = MONTHS.map((name, month) => ({
    name,
    value: completed.filter(game => game.completion_date?.startsWith(currentYear + '-' + String(month + 1).padStart(2, '0'))).length,
  }));

  // --- Shelf & spending ---------------------------------------------------
  const priced = baseGames.flatMap(game => parseCopies(game.copies).filter(copy => typeof copy.price === 'number' && copy.price > 0)
    .map(copy => ({ game, copy, price: copy.price as number, currency: copy.currency || 'EUR' })));
  const spendingByCurrency = sumBy(priced.map(row => ({ name: row.currency, value: row.price })));
  const mainCurrency = spendingByCurrency[0]?.name || 'EUR';
  const mainPriced = priced.filter(row => row.currency === mainCurrency);
  const spendingByPlatform = sumBy(mainPriced.map(row => ({ name: row.copy.platform || 'Unspecified', value: row.price })));
  const sourceCounts = countBy(copies.map(copy => copy.source || (copy.steam_appid ? 'Steam' : '')).filter(Boolean));
  const physicalRegionCounts = countBy(copies.filter(copy => copy.format?.toLowerCase() === 'physical').map(copy => copy.region?.trim() || 'Not set'));
  const multiCopyGames = baseGames.filter(game => parseCopies(game.copies).length > 1).length;

  return {
    playtimeByStatus,
    playtimeBuckets,
    playedWithTime: played.length,
    averageHoursFinished: finishedHours.length ? finishedHours.reduce((sum, hours) => sum + hours, 0) / finishedHours.length : null,
    medianHoursFinished: finishedHours.length ? (finishedHours[Math.floor((finishedHours.length - 1) / 2)] + finishedHours[Math.floor(finishedHours.length / 2)]) / 2 : null,
    longestFinished: played.filter(row => row.game.status === 'Finished').sort((a, b) => b.hours - a.hours).slice(0, 5),
    hoursByTag,
    ratingByTag,
    ratingByDecade,
    hypeComparedCount: hyped.length,
    averageHypeDelta: hyped.length ? hyped.reduce((sum, row) => sum + row.delta, 0) / hyped.length : null,
    surprises: [...hyped].filter(row => row.delta > 0).sort((a, b) => b.delta - a.delta || b.game.mark! - a.game.mark!).slice(0, 5),
    letdowns: [...hyped].filter(row => row.delta < 0).sort((a, b) => a.delta - b.delta || a.game.mark! - b.game.mark!).slice(0, 5),
    backlogByHype,
    finishesByMonth,
    unratedFinished: completed.filter(game => game.mark == null).length,
    pricedCopies: priced.length,
    spendingByCurrency,
    mainCurrency,
    averagePrice: mainPriced.length ? mainPriced.reduce((sum, row) => sum + row.price, 0) / mainPriced.length : null,
    spendingByPlatform,
    mostExpensive: [...mainPriced].sort((a, b) => b.price - a.price).slice(0, 5).map(row => ({ id: row.game.id + ':' + (row.copy.id || row.copy.platform), name: row.game.name, platform: row.copy.platform, price: row.price })),
    sourceCounts,
    physicalRegionCounts,
    multiCopyGames,
    totalGames: baseGames.length,
    dlcGames: games.length - baseGames.length,
    hiddenGames: allGames.filter(game => game.hidden && !game.merged_into_game_id).length,
    totalPlaytime,
    playedGames: started.length,
    finishedGames: completed.length,
    viewedGames: baseGames.filter(game => game.status === 'Viewed').length,
    finishedThisYear: completed.filter(game => game.completion_date?.startsWith(String(currentYear))).length,
    backlogGames: baseGames.filter(game => game.status === 'Not Started').length,
    activeGames: baseGames.filter(game => game.status === 'Playing' || game.status === 'Infinite').length,
    finishRate: started.length ? completed.length / started.length : 0,
    avgRating: rated.length ? ratedMarks.reduce((sum, mark) => sum + mark, 0) / rated.length : null,
    medianRating,
    ratedCount: rated.length,
    highRatedCount: rated.filter(game => game.mark! >= 9).length,
    averageCompletion: completionValues.length ? completionValues.reduce((sum, value) => sum + value, 0) / completionValues.length : null,
    reviewedCount: baseGames.filter(game => game.reviewed).length,
    ownedCopies: copies.length,
    oldCopies: oldCopies.length,
    steamCopies: copies.filter(copy => copy.steam_appid).length,
    physicalCopies: copies.filter(copy => copy.format?.toLowerCase() === 'physical').length,
    digitalCopies: copies.filter(copy => copy.format?.toLowerCase() === 'digital').length,
    dlcCount: dlcs.length,
    ownedDlcs: dlcs.filter(dlc => dlc && dlc.state && dlc.state !== 'not_owned').length,
    statusCounts,
    ratingCounts,
    completionYears,
    releaseDecades,
    platformCounts,
    tagCounts,
    mostPlayed: [...playtimes].filter(row => row.hours > 0).sort((a, b) => b.hours - a.hours).slice(0, 5),
  };
}
