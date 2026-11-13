export interface CatalogGame {
  id: number; name: string; platform: string; format: string;
  release_date: string | null; release_label: string | null; publisher: string | null;
  image_url: string | null; source: string; source_url: string; added_at: string;
  owned: boolean; owned_platforms: string[]; saved: boolean; hidden: boolean;
}
export interface CatalogStatus {
  running: boolean; phase: string | null; listing_at: string | null; finished_at: string | null;
  error: string | null; pending_details: number;
}
export interface CatalogResponse { games: CatalogGame[]; status: CatalogStatus }

export type CatalogSort = 'newest' | 'oldest' | 'title' | 'title-desc' | 'added' | 'publisher';
export interface CatalogFilters {
  query: string;
  platform: 'all' | 'Nintendo Switch' | 'Nintendo Switch 2';
  format: 'all' | 'Game Card' | 'Game-Key Card';
  release: 'all' | 'released' | 'upcoming';
  year: string;
  showOwned: boolean;
  hideSaved: boolean;
  sort: CatalogSort;
}
export const DEFAULT_CATALOG_FILTERS: CatalogFilters = {
  query: '', platform: 'all', format: 'all', release: 'all', year: '', showOwned: false, hideSaved: false, sort: 'newest',
};
export const CATALOG_SORTS: Array<{ value: CatalogSort; label: string }> = [
  { value: 'newest', label: 'Release date (newest)' },
  { value: 'oldest', label: 'Release date (oldest)' },
  { value: 'title', label: 'Title (A–Z)' },
  { value: 'title-desc', label: 'Title (Z–A)' },
  { value: 'added', label: 'Recently added to the catalog' },
  { value: 'publisher', label: 'Publisher' },
];

/** Lower-case, accent-free, punctuation-free text so "pokemon" finds "Pokémon". */
export function searchKey(value: string | null | undefined): string {
  return (value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function releaseYear(game: CatalogGame): string {
  return game.release_date?.slice(0, 4) || game.release_label?.match(/\b(20\d{2})\b/)?.[1] || '';
}

/** A game with only a year or "TBA" has not been released as far as the catalog knows. */
export function isReleased(game: CatalogGame, today: string): boolean {
  return !!game.release_date && game.release_date <= today;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byTitle = (a: CatalogGame, b: CatalogGame) => collator.compare(a.name, b.name);

function byDate(direction: 1 | -1) {
  return (a: CatalogGame, b: CatalogGame) => {
    // Undated games always go last, whichever direction is chosen.
    if (!a.release_date || !b.release_date) return a.release_date ? -1 : b.release_date ? 1 : byTitle(a, b);
    return a.release_date === b.release_date ? byTitle(a, b) : (a.release_date < b.release_date ? -direction : direction);
  };
}

const SORTERS: Record<CatalogSort, (a: CatalogGame, b: CatalogGame) => number> = {
  newest: byDate(-1),
  oldest: byDate(1),
  title: byTitle,
  'title-desc': (a, b) => byTitle(b, a),
  added: (a, b) => a.added_at === b.added_at ? byTitle(a, b) : (a.added_at < b.added_at ? 1 : -1),
  publisher: (a, b) => {
    if (!a.publisher || !b.publisher) return a.publisher ? -1 : b.publisher ? 1 : byTitle(a, b);
    return collator.compare(a.publisher, b.publisher) || byTitle(a, b);
  },
};

export function filterCatalog(games: CatalogGame[], filters: CatalogFilters, today: string): CatalogGame[] {
  const tokens = searchKey(filters.query).split(' ').filter(Boolean);
  const result = games.filter(game => {
    if (game.hidden) return false;
    if (!filters.showOwned && game.owned) return false;
    if (filters.hideSaved && game.saved) return false;
    if (filters.platform !== 'all' && game.platform !== filters.platform) return false;
    if (filters.format !== 'all' && game.format !== filters.format) return false;
    if (filters.release !== 'all' && isReleased(game, today) !== (filters.release === 'released')) return false;
    if (filters.year && releaseYear(game) !== filters.year) return false;
    if (tokens.length) {
      const haystack = `${searchKey(game.name)} ${searchKey(game.publisher)}`;
      if (!tokens.every(token => haystack.includes(token))) return false;
    }
    return true;
  });
  return result.sort(SORTERS[filters.sort] || SORTERS.newest);
}

export function activeFilterCount(filters: CatalogFilters): number {
  return (['platform', 'format', 'release', 'year', 'showOwned', 'hideSaved'] as const)
    .filter(key => filters[key] !== DEFAULT_CATALOG_FILTERS[key]).length;
}
