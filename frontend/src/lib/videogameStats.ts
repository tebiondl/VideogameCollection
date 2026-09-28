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
  const started = baseGames.filter(game => game.status && game.status !== 'Not Started');
  const completionValues = started.map(game => game.completion_percentage).filter((value): value is number => value != null);
  const currentYear = now.getFullYear();
  const copies = baseGames.flatMap(game => parseCopies(game.copies));
  const oldCopies = baseGames.flatMap(game => parseOldCopies(game.old_copies));
  const dlcs = baseGames.flatMap(game => {
    try { const parsed = JSON.parse(game.dlcs || '[]'); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  });
  const statusOrder = ['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'];
  const statusCounts = statusOrder.map(name => ({ name, value: baseGames.filter(game => game.status === name).length }));
  const ratingCounts = Array.from({ length: 10 }, (_, index) => ({ name: String(index + 1), value: ratedMarks.filter(mark => mark === index + 1).length }));
  const completionYears = countBy(completed.map(game => Number(game.completion_date?.slice(0, 4))).filter(year => year >= 1950 && year <= 2100)).sort((a, b) => Number(a.name) - Number(b.name));
  const releaseDecades = countBy(baseGames.map(game => game.publication_year && Math.floor(game.publication_year / 10) * 10).filter((value): value is number => !!value)).sort((a, b) => Number(a.name) - Number(b.name));
  const platformCounts = countBy(copies.map(copy => copy.platform).filter(Boolean));
  const tagCounts = countBy(baseGames.flatMap(game => tagNames(game.tags)));

  return {
    totalGames: baseGames.length,
    dlcGames: games.length - baseGames.length,
    hiddenGames: allGames.filter(game => game.hidden && !game.merged_into_game_id).length,
    totalPlaytime,
    playedGames: started.length,
    finishedGames: completed.length,
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
