import { emptyWanted } from './discovery';
import type { WantedDraft } from './discovery';

// RFC 4180-style CSV: escaped quotes, commas and newlines inside quoted fields.
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (char === '\n') { rows.push(row); row = []; }
    } else field += char;
  }
  if (quoted) throw new Error('CSV contains an unclosed quote.');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(row => row.some(value => value.trim()));
}

export function parseWantedImport(text: string, format: string): WantedDraft[] {
  let entries: unknown[];
  if (format === 'json') {
    entries = JSON.parse(text);
    if (!Array.isArray(entries)) throw new Error('JSON must be an array of game objects.');
  } else if (format === 'csv') {
    const [headers, ...rows] = csvRows(text.replace(/^\uFEFF/, ''));
    if (!headers?.some(header => header.trim().toLowerCase() === 'name')) throw new Error('CSV needs a name column.');
    entries = rows.map(row => Object.fromEntries(headers.map((header, index) => [header.trim().toLowerCase(), row[index]?.trim() || null])));
  } else entries = text.split(/\r?\n/).map(name => name.trim()).filter(Boolean).map(name => ({ name }));
  if (!entries.length || entries.length > 500) throw new Error('Import between 1 and 500 games at a time.');
  const numeric = ['hype', 'target_price', 'publication_year', 'igdb_id', 'steam_appid'];
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Row ${index + 1} must be a game object.`);
    const values = { ...emptyWanted() } as Record<string, unknown>;
    for (const [key, value] of Object.entries(entry)) {
      if (!(key in values)) throw new Error(`Row ${index + 1}: unknown field “${key}”.`);
      if (value === null || value === '') continue;
      if (numeric.includes(key)) {
        if (!Number.isFinite(Number(value))) throw new Error(`Row ${index + 1}: ${key} must be a number.`);
        values[key] = Number(value);
      } else if (key === 'is_dlc') {
        if (![true, false, 'true', 'false', '1', '0'].includes(value)) throw new Error(`Row ${index + 1}: is_dlc must be true or false.`);
        values[key] = value === true || value === 'true' || value === '1';
      } else if (key === 'dlcs' && Array.isArray(value)) values[key] = JSON.stringify(value);
      else if (typeof value === 'string') values[key] = value.trim();
      else throw new Error(`Row ${index + 1}: ${key} must be text.`);
    }
    if (!values.name) throw new Error(`Row ${index + 1} needs a name.`);
    return values as unknown as WantedDraft;
  });
}
