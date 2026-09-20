export interface OwnedCopy {
  id?: string;
  name?: string | null;
  platform: string;
  format: string;
  source?: string | null;
  store_url?: string | null;
  steam_appid?: number | null;
  igdb_id?: number | null;
  price?: number | null;
  currency?: string;
  playtime_hours?: number | null;
}

export type PlaytimeMode = 'user' | 'copies' | 'combined';

export function copyPlaytimeHours(value: string | null | undefined): number {
  return parseCopies(value).reduce((sum, copy) => sum + Math.max(0, Number(copy.playtime_hours) || 0), 0);
}

export function displayPlaytimeHours(game: { copies?: string | null; playtime_hours?: number | null; playtime_mode?: PlaytimeMode | string | null }): number | null {
  const userHours = Math.max(0, Number(game.playtime_hours) || 0);
  const copiesHours = copyPlaytimeHours(game.copies);
  const mode = game.playtime_mode || 'user';
  const total = mode === 'copies' ? copiesHours : mode === 'combined' ? userHours + copiesHours : userHours;
  return total || (game.playtime_hours != null || copiesHours > 0 ? 0 : null);
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
