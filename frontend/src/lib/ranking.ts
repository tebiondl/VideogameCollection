import { parseCopies, parseOldCopies } from './ownedCopies';
import { tagNames, type StatsGame } from './videogameStats';

export interface RankingGame extends StatsGame {
  id: number;
  name: string;
  version?: number;
}

export interface TierFilters {
  statuses: string[];
  tags: string[];
  platforms: string[];
  min_rating: number | null;
  max_rating: number | null;
  min_year: number | null;
  max_year: number | null;
  rated_only: boolean;
  include_dlc: boolean;
}

export interface TierListEntry {
  game_id: number;
  tier: string | null;
  position: number;
  deleted: boolean;
}

export interface TierList {
  id: number;
  name: string;
  filters: TierFilters;
  entries: TierListEntry[];
}

export const EMPTY_TIER_FILTERS: TierFilters = {
  statuses: [], tags: [], platforms: [], min_rating: null, max_rating: null,
  min_year: null, max_year: null, rated_only: false, include_dlc: false,
};
export const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'] as const;
export const BUCKETS = [...TIERS, 'unranked'] as const;

export function gamePlatforms(game: RankingGame): string[] {
  return [...new Set([
    ...parseCopies(game.copies).map(copy => copy.platform),
    ...parseOldCopies(game.old_copies).map(copy => copy.console),
  ].filter(Boolean))];
}

export function matchesTierFilters(game: RankingGame, filters: TierFilters): boolean {
  if (game.hidden || game.merged_into_game_id || (game.is_dlc && !filters.include_dlc)) return false;
  if (filters.statuses.length && !filters.statuses.includes(game.status || '')) return false;
  if (filters.rated_only && game.mark == null) return false;
  if (filters.min_rating != null && (game.mark == null || game.mark < filters.min_rating)) return false;
  if (filters.max_rating != null && (game.mark == null || game.mark > filters.max_rating)) return false;
  if (filters.min_year != null && (game.publication_year == null || game.publication_year < filters.min_year)) return false;
  if (filters.max_year != null && (game.publication_year == null || game.publication_year > filters.max_year)) return false;
  if (filters.tags.length && !tagNames(game.tags).some(tag => filters.tags.some(selected => selected.toLowerCase() === tag.toLowerCase()))) return false;
  if (filters.platforms.length && !gamePlatforms(game).some(platform => filters.platforms.some(selected => selected.toLowerCase() === platform.toLowerCase()))) return false;
  return true;
}

export function tierBuckets(entries: TierListEntry[]): Record<string, number[]> {
  const buckets: Record<string, number[]> = Object.fromEntries(BUCKETS.map(tier => [tier, []]));
  [...entries].filter(entry => !entry.deleted).sort((a, b) => a.position - b.position).forEach(entry => {
    buckets[entry.tier && TIERS.includes(entry.tier as typeof TIERS[number]) ? entry.tier : 'unranked'].push(entry.game_id);
  });
  return buckets;
}
