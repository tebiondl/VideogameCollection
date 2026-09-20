import { fetchWithAuth } from './api';

export interface WantedGame {
  id: number; name: string; description: string | null; comments: string | null; image_url: string | null;
  platform: string; format: string; status: string; hype: number | null; target_price: number | null;
  currency: string; release_date: string | null; publication_year: number | null; tags: string | null;
  dlcs: string | null; is_dlc: boolean; parent_game_name: string | null; igdb_id: number | null;
  steam_appid: number | null; store_url: string | null; source: string; created_at: string;
  updated_at: string; collection_game_id: number | null; steam_wishlist_missing: boolean;
}
export type WantedDraft = Omit<WantedGame, 'id' | 'source' | 'created_at' | 'updated_at' | 'collection_game_id' | 'steam_wishlist_missing'>;
export interface AcquireDraft {
  name: string; description: string | null; comments: string | null; image_url: string | null;
  status: string; playtime_hours: number | null; mark: number | null; hype: number | null;
  completion_date: string | null; publication_year: number | null; release_date: string | null;
  completion_percentage: number | null; tags: string | null; dlcs: string | null;
  is_dlc: boolean; parent_game_name: string | null; platform: string; format: string;
  source: string; store_url: string | null; steam_appid: number | null; igdb_id: number | null;
  price: number | null; currency: string;
  parent_game_id: number | null;
}
export const emptyWanted = (): WantedDraft => ({ name: '', description: '', comments: '', image_url: '', platform: '', format: 'Any',
  status: 'Wanted', hype: null, target_price: null, currency: 'EUR', release_date: null, publication_year: null,
  tags: '', dlcs: '', is_dlc: false, parent_game_name: '', igdb_id: null, steam_appid: null, store_url: '' });
export interface DiscoverySettings {
  steam_id: string | null; steam_api_key_configured: boolean; sync_enabled: boolean; sync_hours: number; region: string;
  sync_wishlist: boolean; sync_collection: boolean;
  last_sync_at: string | null; next_sync_at: string | null; sync_started_at: string | null;
  sync_error: string | null; sync_warning: string | null; last_import_count: number; last_owned_import_count: number;
  last_igdb_match_count: number;
}
export interface SteamMatchReview {
  id: number; steam_appid: number; steam_name: string; candidate_game_id: number;
  candidate_name: string; confidence: number; candidates: SteamMatchCandidate[]; created_at: string;
  match_kind: 'game' | 'dlc_parent';
}
export interface SteamAuditEntry {
  id: number; action: string; steam_appid: number | null; collection_game_id: number | null;
  copy_id: string | null; details: Record<string, unknown> | null; created_at: string;
}
export interface SteamIntegrity {
  games: number; copies: number; steam_entitlements: number; healthy: boolean; repaired: number;
  issues: Record<string, number>;
}
export interface SteamMatchCandidate { game_id: number; name: string; confidence: number }
export interface CopyOptions {
  platforms: string[];
  sources: string[];
  types: string[];
  old_consoles: string[];
  platform_sources: Record<string, string[]>;
  source_types: Record<string, string[]>;
}

export const EMPTY_COPY_OPTIONS: CopyOptions = {
  platforms: [], sources: [], types: [], old_consoles: [], platform_sources: {}, source_types: {},
};
export interface Release {
  id: string; name: string; release_date: string; image_url: string | null; source_url: string;
  region: string; source: string; platform?: string; notes?: string | null; description?: string; owned: boolean; saved: boolean;
}
export interface Timeline { games: Release[]; months: string[]; region: string; coverage: string; warning: string | null; updated_at: string | null }
export interface IgdbGame { igdb_id: number; name: string; summary: string; cover_url: string; genres: string[]; release_year: number | null; release_date: string | null; is_dlc: boolean; parent_game_name: string | null; platforms: string[] }

export async function discoveryApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetchWithAuth(path.startsWith('/igdb') ? path : `/discovery${path}`, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = data.detail;
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((item: { loc: string[]; msg: string }) => `${item.loc.slice(1).join('.')}: ${item.msg}`).join('; ') : `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
export const timestamp = (value: string | null) => value ? new Date(value.endsWith('Z') ? value : `${value}Z`).toLocaleString() : 'Not yet';
export const syncIsRunning = (value: string | null | undefined) => !!value && Date.now() - new Date(value.endsWith('Z') ? value : `${value}Z`).getTime() < 3600000;
export function fromIgdb(game: IgdbGame, current = emptyWanted()): WantedDraft {
  return { ...current, name: game.name, description: game.summary || '', image_url: game.cover_url || '',
    publication_year: game.release_year, release_date: game.release_date,
    is_dlc: game.is_dlc, parent_game_name: game.parent_game_name, igdb_id: game.igdb_id,
    platform: current.platform || (game.platforms.length === 1 ? game.platforms[0] : '') };
}
export function toAcquireDraft(game: WantedGame): AcquireDraft {
  return {
    name: game.name, description: game.description, comments: game.comments, image_url: game.image_url,
    status: 'Not Started', playtime_hours: null, mark: null, hype: game.hype,
    completion_date: null, publication_year: game.publication_year, release_date: game.release_date,
    completion_percentage: null, tags: game.tags, dlcs: game.dlcs, is_dlc: game.is_dlc,
    parent_game_name: game.parent_game_name, platform: game.platform, format: game.format,
    source: game.source === 'steam' ? 'Steam' : game.source, store_url: game.store_url, steam_appid: game.steam_appid, igdb_id: game.igdb_id,
    price: game.target_price, currency: game.currency, parent_game_id: null,
  };
}
export function payload(draft: WantedDraft): WantedDraft {
  // Send only editable fields, even when the editor was opened with a full server row.
  return Object.fromEntries(Object.keys(emptyWanted()).map(key => [key, draft[key as keyof WantedDraft]])) as unknown as WantedDraft;
}
