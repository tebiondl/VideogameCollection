export const PROBABLE_DUPLICATE_THRESHOLD = 0.95;

export interface TitleCandidate {
  id: number;
  name: string;
  hidden?: boolean;
  is_dlc?: boolean;
}

export function normalizeTitle(value: string): string {
  return (value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function titleSimilarity(first: string, second: string): number {
  const left = normalizeTitle(first);
  const right = normalizeTitle(second);
  if (left === right) return left ? 1 : 0;
  if (!left || !right) return 0;

  // Normalized Levenshtein similarity keeps the percentage intuitive: one
  // changed character in a twenty-character title is a 95% match.
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      const substitution = diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        substitution,
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

export function findProbableDuplicate<T extends TitleCandidate>(
  current: T | null | undefined,
  games: T[],
  threshold = PROBABLE_DUPLICATE_THRESHOLD,
): { game: T; similarity: number } | null {
  if (!current?.name) return null;
  let best: { game: T; similarity: number } | null = null;
  for (const game of games) {
    if (game.id === current.id || game.hidden || game.is_dlc) continue;
    const similarity = titleSimilarity(current.name, game.name);
    if (similarity + Number.EPSILON < threshold) continue;
    if (!best || similarity > best.similarity) best = { game, similarity };
  }
  return best;
}

export function searchTitleCandidates<T extends TitleCandidate>(
  currentId: number,
  query: string,
  games: T[],
  fuzzyThreshold = 0.6,
): T[] {
  const normalizedQuery = normalizeTitle(query);
  return games
    .filter(game => game.id !== currentId && !game.hidden && !game.is_dlc)
    .map(game => ({ game, similarity: titleSimilarity(query, game.name) }))
    .filter(({ game, similarity }) => !normalizedQuery ||
      normalizeTitle(game.name).includes(normalizedQuery) || similarity >= fuzzyThreshold)
    .sort((first, second) => second.similarity - first.similarity || first.game.name.localeCompare(second.game.name))
    .map(({ game }) => game);
}
