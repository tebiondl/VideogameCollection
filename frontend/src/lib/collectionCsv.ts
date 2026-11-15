import { effectiveCompletionDate, effectiveStoppedDate } from './completionDate';
import { displayPlaytimeHours, parseCopies, parseOldCopies, type OwnedCopy } from './ownedCopies';

/** The fields of a collection game the CSV reads. Everything is optional because older rows may lack them. */
export interface CsvGame {
  name: string;
  status?: string | null;
  is_dlc?: boolean | null;
  parent_game_name?: string | null;
  mark?: number | null;
  hype?: number | null;
  completion_percentage?: number | null;
  playtime_hours?: number | null;
  playtime_mode?: string | null;
  release_date?: string | null;
  publication_year?: number | null;
  completion_date?: string | null;
  stopped_date?: string | null;
  copies?: string | null;
  old_copies?: string | null;
  tags?: string | null;
  dlcs?: string | null;
  play_next?: boolean | null;
  comments?: string | null;
}

/** Column headers, in order. Kept in English so any tool or AI reads them without translation. */
export const COLLECTION_CSV_HEADERS = [
  'Name',
  'Type',
  'Parent Game',
  'Status',
  'Rating (1-10)',
  'Hype (1-10)',
  'Completion %',
  'Playtime (hours)',
  'Release Date',
  'Completion Date',
  'Stopped Date',
  'Platforms',
  'Formats',
  'Copy Count',
  'Copies',
  'Purchase Price',
  'Previously Owned On',
  'Tags',
  'DLCs',
  'Play Next',
  'Notes',
] as const;

const DLC_STATE_LABELS: Record<string, string> = {
  not_owned: 'Not Owned',
  not_started: 'Not Started',
  playing: 'Playing',
  finished: 'Finished',
  viewed: 'Viewed',
  stopped: 'Stopped',
};

const LIST_SEPARATOR = '; ';

function uniqueValues(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw?.trim();
    if (!value || seen.has(value.toLocaleLowerCase())) continue;
    seen.add(value.toLocaleLowerCase());
    result.push(value);
  }
  return result;
}

/** Up to two decimals, without trailing zeros, and always with a dot as decimal separator. */
function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function formatPrice(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

function describeCopy(copy: OwnedCopy): string {
  const details = uniqueValues([
    copy.format,
    copy.source,
    copy.region,
    copy.name && copy.name !== copy.platform ? copy.name : null,
  ]);
  if (copy.price != null && Number.isFinite(Number(copy.price))) details.push(formatPrice(Number(copy.price), copy.currency || 'EUR'));
  if (copy.playtime_hours != null && Number(copy.playtime_hours) > 0) details.push(`${formatNumber(Number(copy.playtime_hours))} h`);
  const platform = copy.platform?.trim() || 'Unknown platform';
  return details.length ? `${platform} (${details.join(', ')})` : platform;
}

/** Adds up what was paid for the owned copies, one total per currency so amounts are never mixed. */
function purchasePrice(copies: OwnedCopy[]): string {
  const totals = new Map<string, number>();
  for (const copy of copies) {
    const amount = Number(copy.price);
    if (copy.price == null || !Number.isFinite(amount)) continue;
    const currency = copy.currency || 'EUR';
    totals.set(currency, (totals.get(currency) || 0) + amount);
  }
  return [...totals].map(([currency, amount]) => formatPrice(amount, currency)).join(LIST_SEPARATOR);
}

function dlcSummary(value: string | null | undefined): string {
  if (!value) return '';
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return ''; }
  if (!Array.isArray(parsed)) return '';
  return parsed
    .filter((dlc): dlc is { name: string; state?: string } => !!dlc && typeof dlc.name === 'string' && dlc.name.trim() !== '')
    .map(dlc => `${dlc.name.trim()} (${DLC_STATE_LABELS[dlc.state || ''] || dlc.state || 'Unknown'})`)
    .join(LIST_SEPARATOR);
}

function tagList(value: string | null | undefined): string {
  return uniqueValues((value || '').split(',')).join(LIST_SEPARATOR);
}

/** One CSV row per game, as plain strings in the order of COLLECTION_CSV_HEADERS. */
export function collectionCsvRow(game: CsvGame): string[] {
  const copies = parseCopies(game.copies);
  const oldCopies = parseOldCopies(game.old_copies);
  const playtime = displayPlaytimeHours(game);
  return [
    game.name || '',
    game.is_dlc ? 'DLC' : 'Game',
    game.is_dlc ? game.parent_game_name || '' : '',
    game.status || '',
    game.mark != null ? String(game.mark) : '',
    game.hype != null ? String(game.hype) : '',
    game.completion_percentage != null ? String(game.completion_percentage) : '',
    playtime != null ? formatNumber(playtime) : '',
    game.release_date || (game.publication_year != null ? String(game.publication_year) : ''),
    effectiveCompletionDate(game) || '',
    effectiveStoppedDate(game) || '',
    uniqueValues(copies.map(copy => copy.platform)).join(LIST_SEPARATOR),
    uniqueValues(copies.map(copy => copy.format)).join(LIST_SEPARATOR),
    String(copies.length),
    copies.map(describeCopy).join(LIST_SEPARATOR),
    purchasePrice(copies),
    uniqueValues(oldCopies.map(copy => copy.console || copy.platform)).join(LIST_SEPARATOR),
    tagList(game.tags),
    dlcSummary(game.dlcs),
    game.play_next ? 'Yes' : 'No',
    game.comments || '',
  ];
}

/** Quotes a value only when needed (separator, quote, line break or leading/trailing space). */
export function escapeCsvField(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Builds the CSV text for the given games, in the given order. Starts with a UTF-8
 * byte order mark so Excel shows accents correctly, and uses CRLF line endings (RFC 4180).
 */
export function buildCollectionCsv(games: CsvGame[]): string {
  const lines = [COLLECTION_CSV_HEADERS as readonly string[], ...games.map(collectionCsvRow)]
    .map(fields => fields.map(escapeCsvField).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** File name with the local date, e.g. collection-2026-11-15.csv. */
export function collectionCsvFilename(now = new Date()): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `collection-${date}.csv`;
}
