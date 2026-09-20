export interface OwnedCopy {
  id?: string;
  platform: string;
  format: string;
  source?: string | null;
  store_url?: string | null;
  steam_appid?: number | null;
  igdb_id?: number | null;
  price?: number | null;
  currency?: string;
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
