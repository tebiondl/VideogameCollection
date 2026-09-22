export const PROBABLE_DUPLICATE_THRESHOLD = 0.95;

export interface TitleCandidate {
  id: number;
  name: string;
  hidden?: boolean;
  is_dlc?: boolean;
}

export interface ParsedTitle {
  normalized: string;
  base: string;
  installments: string[];
  variants: Set<string>;
}

export interface TitleMatch {
  score: number;
  compatible: boolean;
  automatic: boolean;
  relation: 'same_title_family' | 'same_installment' | 'implicit_first_installment' | 'ambiguous_numbered_alias' | 'different_installment' | 'different_edition' | 'different_release';
  left: ParsedTitle;
  right: ParsedTitle;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4,
  five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8,
  nine: 9, ninth: 9, ten: 10, tenth: 10, eleven: 11, eleventh: 11, twelve: 12,
  twelfth: 12, thirteen: 13, thirteenth: 13, fourteen: 14, fourteenth: 14,
  fifteen: 15, fifteenth: 15, sixteen: 16, sixteenth: 16, seventeen: 17,
  seventeenth: 17, eighteen: 18, eighteenth: 18, nineteen: 19, nineteenth: 19,
  twenty: 20, twentieth: 20,
};
const NUMBER_MARKERS = new Set(['part', 'pt', 'episode', 'ep', 'chapter', 'season', 'volume', 'vol', 'book']);
const EDITION_TOKENS = new Set(['anniversary', 'classic', 'complete', 'definitive', 'deluxe', 'edition', 'enhanced', 'goty', 'hd', 'remaster', 'remastered', 'redux', 'special', 'ultimate', 'collection']);
const SEPARATE_RELEASE_TOKENS = new Set(['remake', 'demake', 'reboot']);
const CONTENT_VARIANT_TOKENS = new Set(['alpha', 'beta', 'demo', 'network', 'playtest', 'server', 'soundtrack', 'test']);
const ALL_VARIANT_TOKENS = new Set([...EDITION_TOKENS, ...SEPARATE_RELEASE_TOKENS, ...CONTENT_VARIANT_TOKENS]);
const REVIEW_STOPWORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'the', 'to', 'with']);

export function normalizeTitle(value: string): string {
  return (value || '')
    .replace(/\(\s*(?:tm|r|c)\s*\)\s*$/i, ' ')
    .replace(/[™®©]/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function romanNumber(token: string): number | null {
  if (!/^(?=[ivxlcdm]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/.test(token)) return null;
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  let previous = 0;
  for (const character of [...token].reverse()) {
    const current = values[character];
    if (current < previous) total -= current;
    else { total += current; previous = current; }
  }
  return total > 0 && total <= 50 ? total : null;
}

function numberToken(token: string, allowWords: boolean, allowRoman: boolean): string | null {
  const decimal = token.match(/^(\d+)decimal(\d+)$/);
  if (decimal) return `${Number(decimal[1])}.${decimal[2].replace(/0+$/, '') || '0'}`;
  if (/^\d+$/.test(token)) return String(Number(token));
  if (allowWords && NUMBER_WORDS[token]) return String(NUMBER_WORDS[token]);
  if (allowRoman) {
    const value = romanNumber(token);
    if (value !== null) return String(value);
  }
  return null;
}

export function parseTitle(value: string): ParsedTitle {
  const raw = (value || '')
    .replace(/\(\s*(?:tm|r|c)\s*\)\s*$/i, ' ')
    .replace(/[™®©]/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/\((?:19|20)\d{2}\)/g, ' ')
    .replace(/(?<=\d)\.(?=\d)/g, 'decimal');
  const tokens = raw.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  const variants = new Set(tokens.filter(token => ALL_VARIANT_TOKENS.has(token)));
  const ignored = new Set(tokens.flatMap((token, index) => ALL_VARIANT_TOKENS.has(token) ? [index] : []));
  const numbered: Array<[number, string]> = [];

  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!NUMBER_MARKERS.has(tokens[index])) continue;
    const number = numberToken(tokens[index + 1], true, true);
    if (number !== null) {
      numbered.push([index + 1, number]);
      ignored.add(index);
      ignored.add(index + 1);
    }
  }
  const significant = tokens.map((_, index) => index).filter(index => !ignored.has(index) && !NUMBER_MARKERS.has(tokens[index]));
  const lastSignificant = significant.at(-1) ?? -1;
  const alreadyNumbered = new Set(numbered.map(([index]) => index));
  for (const index of significant) {
    if (alreadyNumbered.has(index)) continue;
    const romanValue = romanNumber(tokens[index]);
    const wordValue = NUMBER_WORDS[tokens[index]];
    const number = numberToken(
      tokens[index],
      index === lastSignificant || wordValue >= 2,
      index === lastSignificant || (romanValue !== null && romanValue >= 2),
    );
    if (number !== null) {
      numbered.push([index, number]);
      ignored.add(index);
    }
  }
  numbered.sort((first, second) => first[0] - second[0]);
  return {
    normalized: normalizeTitle(value),
    base: tokens.filter((token, index) => !ignored.has(index) && !NUMBER_MARKERS.has(token)).join(' '),
    installments: numbered.map(([, number]) => number),
    variants,
  };
}

function rawSimilarity(left: string, right: string): number {
  if (left === right) return left ? 1 : 0;
  if (!left || !right) return 0;
  const distances = Array.from({ length: left.length + 1 }, (_, leftIndex) =>
    Array.from({ length: right.length + 1 }, (_, rightIndex) => leftIndex === 0 ? rightIndex : rightIndex === 0 ? leftIndex : 0));
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      distances[leftIndex][rightIndex] = Math.min(
        distances[leftIndex - 1][rightIndex] + 1,
        distances[leftIndex][rightIndex - 1] + 1,
        distances[leftIndex - 1][rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      if (leftIndex > 1 && rightIndex > 1 && left[leftIndex - 1] === right[rightIndex - 2] && left[leftIndex - 2] === right[rightIndex - 1]) {
        distances[leftIndex][rightIndex] = Math.min(distances[leftIndex][rightIndex], distances[leftIndex - 2][rightIndex - 2] + 1);
      }
    }
  }
  return 1 - distances[left.length][right.length] / Math.max(left.length, right.length);
}

function baseSimilarity(left: string, right: string): number {
  let score = rawSimilarity(left, right);
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return score;
  const shared = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const shortest = Math.min(leftTokens.size, rightTokens.size);
  const coverage = shared / shortest;
  if (coverage === 1 && shortest >= 2) score = Math.max(score, 0.86);
  else if (coverage >= 2 / 3) score = Math.max(score, 0.76);
  else if (coverage === 1 && shortest === 1) score = Math.max(score, 0.74);
  return score;
}

export function compareTitles(first: string, second: string): TitleMatch {
  const left = parseTitle(first);
  const right = parseTitle(second);
  if (left.normalized && left.normalized === right.normalized) {
    return { score: 1, compatible: true, automatic: true, relation: left.installments.length ? 'same_installment' : 'same_title_family', left, right };
  }
  const baseScore = baseSimilarity(left.base, right.base);
  const sameNumbers = left.installments.join('|') === right.installments.join('|');
  let relation: TitleMatch['relation'];
  let score: number;
  let automatic: boolean;

  if (left.installments.length && right.installments.length && !sameNumbers) {
    return { score: 0, compatible: false, automatic: false, relation: 'different_installment', left, right };
  }
  if (!!left.installments.length !== !!right.installments.length) {
    const present = left.installments.length ? left.installments : right.installments;
    if (present.join('|') === '1' && baseScore >= 0.94) {
      relation = 'implicit_first_installment';
      score = Math.min(baseScore, 0.96);
      automatic = false;
    } else if (present.join('|') !== '1' && baseScore >= 0.72 && baseScore < 0.94) {
      relation = 'ambiguous_numbered_alias';
      score = baseScore;
      automatic = false;
    } else {
      return { score: 0, compatible: false, automatic: false, relation: 'different_installment', left, right };
    }
  } else {
    relation = left.installments.length ? 'same_installment' : 'same_title_family';
    score = baseScore;
    automatic = true;
  }

  const variantDifference = new Set([
    ...[...left.variants].filter(token => !right.variants.has(token)),
    ...[...right.variants].filter(token => !left.variants.has(token)),
  ]);
  if ([...variantDifference].some(token => SEPARATE_RELEASE_TOKENS.has(token) || CONTENT_VARIANT_TOKENS.has(token))) {
    return { score: 0, compatible: false, automatic: false, relation: 'different_release', left, right };
  }
  if (variantDifference.size) {
    score = Math.max(0, score - 0.18);
    automatic = false;
    relation = 'different_edition';
  }
  return { score, compatible: true, automatic, relation, left, right };
}

export function titleSimilarity(first: string, second: string): number {
  return compareTitles(first, second).score;
}

export function isReviewableTitleMatch(match: TitleMatch): boolean {
  if (!match.compatible) return false;
  if (match.score >= 0.9) return true;
  if (match.relation === 'different_edition' && match.score >= 0.8) return true;
  const leftTokens = match.left.base.split(' ').filter(Boolean);
  const rightTokens = match.right.base.split(' ').filter(Boolean);
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const shared = [...leftSet].filter(token => rightSet.has(token) && !REVIEW_STOPWORDS.has(token));
  const contained = [...leftSet].every(token => rightSet.has(token)) || [...rightSet].every(token => leftSet.has(token));
  if (match.score >= 0.82 && shared.length >= 2 && shared.reduce((total, token) => total + token.length, 0) >= 8 && contained) return true;
  const [shorter, longer] = leftTokens.length <= rightTokens.length
    ? [leftTokens, rightTokens]
    : [rightTokens, leftTokens];
  return match.relation === 'ambiguous_numbered_alias'
    && shorter.length === 1
    && longer.length >= 4
    && shorter[0] === longer.at(-1);
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
    const match = compareTitles(current.name, game.name);
    if (!match.compatible) continue;
    const similarity = match.score;
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
  const parsedQuery = parseTitle(query);
  return games
    .filter(game => game.id !== currentId && !game.hidden && !game.is_dlc)
    .map(game => ({ game, match: compareTitles(query, game.name) }))
    .filter(({ game, match }) => !normalizedQuery || (
      (parsedQuery.installments.length === 0 || match.compatible) &&
      (normalizeTitle(game.name).includes(normalizedQuery) || match.score >= fuzzyThreshold)
    ))
    .map(({ game, match }) => ({ game, similarity: match.score }))
    .sort((first, second) => second.similarity - first.similarity || first.game.name.localeCompare(second.game.name))
    .map(({ game }) => game);
}
