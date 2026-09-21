export interface OwnedCopy {
  id?: string;
  name?: string | null;
  platform: string;
  format: string;
  source?: string | null;
  store_url?: string | null;
  steam_appid?: number | null;
  duplicate_of_appid?: number | null;
  merged_from_game_id?: number | null;
  steam_active?: boolean;
  steam_playtime_available?: boolean;
  igdb_id?: number | null;
  price?: number | null;
  currency?: string;
  playtime_hours?: number | null;
  counts_toward_totals?: boolean;
}

export interface OldCopy {
  id?: string;
  console: string;
  playtime_hours?: number | null;
}

export type PlaytimeMode = 'user' | 'copies' | 'combined';

export function oldCopyPlaytimeHours(value: string | null | undefined): number {
  return parseOldCopies(value).reduce((sum, copy) => sum + Math.max(0, Number(copy.playtime_hours) || 0), 0);
}

export function copyPlaytimeHours(value: string | null | undefined, oldCopies?: string | null): number {
  return parseCopies(value).reduce((sum, copy) => sum + Math.max(0, Number(copy.playtime_hours) || 0), 0) + oldCopyPlaytimeHours(oldCopies);
}

export function displayPlaytimeHours(game: { copies?: string | null; old_copies?: string | null; playtime_hours?: number | null; playtime_mode?: PlaytimeMode | string | null }): number | null {
  const userHours = Math.max(0, Number(game.playtime_hours) || 0);
  const copiesHours = copyPlaytimeHours(game.copies, game.old_copies);
  const mode = game.playtime_mode || 'user';
  const total = mode === 'copies' ? copiesHours : mode === 'combined' ? userHours + copiesHours : userHours;
  return total || (game.playtime_hours != null || copiesHours > 0 ? 0 : null);
}

export function analyticsPlaytimeHours(
  game: { copies?: string | null; old_copies?: string | null; playtime_hours?: number | null; playtime_mode?: PlaytimeMode | string | null },
  seenSteamApps: Set<number>,
): number | null {
  const userHours = Math.max(0, Number(game.playtime_hours) || 0);
  const copyHours = parseCopies(game.copies).reduce((sum, copy) => {
    if (copy.steam_appid) {
      if (copy.counts_toward_totals === false || seenSteamApps.has(copy.steam_appid)) return sum;
      seenSteamApps.add(copy.steam_appid);
    }
    return sum + Math.max(0, Number(copy.playtime_hours) || 0);
  }, 0) + oldCopyPlaytimeHours(game.old_copies);
  const mode = game.playtime_mode || 'user';
  const total = mode === 'copies' ? copyHours : mode === 'combined' ? userHours + copyHours : userHours;
  return total || (game.playtime_hours != null || copyHours > 0 ? 0 : null);
}

export interface OwnedCopyFilters {
  platforms: string[];
  sources: string[];
  formats: string[];
}

export function parseCopies(value: string | null | undefined): OwnedCopy[] {
  if (!value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export function parseOldCopies(value: string | null | undefined): OldCopy[] {
  if (!value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export function moveCopyToOldCopies(
  value: string | null | undefined,
  oldValue: string | null | undefined,
  index: number,
): { copies: string | null; old_copies: string } {
  const copies = parseCopies(value);
  const oldCopies = parseOldCopies(oldValue);
  const copy = copies[index];
  if (!copy?.platform?.trim()) throw new Error('Choose a platform before moving this copy.');
  if (oldCopies.length >= 100) throw new Error('You can keep at most 100 old copies per game.');
  const id = copy.id && !oldCopies.some(oldCopy => oldCopy.id === copy.id) ? copy.id : crypto.randomUUID();
  // Keep the original details in the historical record as well as its editable platform and time.
  const oldCopy = { ...copy, id, console: copy.platform, playtime_hours: copy.playtime_hours ?? null };
  const remaining = copies.filter((_, copyIndex) => copyIndex !== index);
  return {
    copies: remaining.length ? JSON.stringify(remaining) : null,
    old_copies: JSON.stringify([...oldCopies, oldCopy]),
  };
}

const normalizedCopyValue = (value: string | null | undefined) => value?.trim().toLocaleLowerCase() || '';

export function matchesOwnedCopyFilters(value: string | null | undefined, filters: OwnedCopyFilters): boolean {
  if (filters.platforms.length === 0 && filters.sources.length === 0 && filters.formats.length === 0) return true;

  const platforms = new Set(filters.platforms.map(normalizedCopyValue));
  const sources = new Set(filters.sources.map(normalizedCopyValue));
  const formats = new Set(filters.formats.map(normalizedCopyValue));

  // All active categories must match the same copy. This prevents a Switch
  // copy and a separate Steam copy from incorrectly satisfying “Switch + Steam”.
  return parseCopies(value).some(copy => {
    const platformMatches = platforms.size === 0 || platforms.has(normalizedCopyValue(copy.platform));
    const formatMatches = formats.size === 0 || formats.has(normalizedCopyValue(copy.format));
    const sourceValues = new Set([normalizedCopyValue(copy.source)]);
    if (copy.steam_appid) sourceValues.add('steam');
    const sourceMatches = sources.size === 0 || [...sources].some(source => sourceValues.has(source));
    return platformMatches && sourceMatches && formatMatches;
  });
}
