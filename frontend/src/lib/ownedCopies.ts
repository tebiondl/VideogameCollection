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

export function parseCopies(value: string | null | undefined): OwnedCopy[] {
  if (!value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
