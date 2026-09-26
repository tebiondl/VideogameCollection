export interface GameMetadata {
  source: 'IGDB' | 'Steam';
  name: string;
  description: string | null;
  image_url: string | null;
  publication_year: number | null;
  release_date: string | null;
  is_dlc: boolean;
  parent_game_name: string | null;
  igdb_id?: number;
}

export interface GameMetadataDraft {
  name: string;
  description?: string | null;
  image_url?: string | null;
  publication_year?: number | null;
  release_date?: string | null;
  is_dlc?: boolean;
  parent_game_name?: string | null;
  parent_game_id?: number | null;
  igdb_id?: number | null;
  [key: string]: unknown;
}

export function applyGameMetadata<T extends GameMetadataDraft>(draft: T, metadata: GameMetadata): T {
  const sameParent = !metadata.parent_game_name ||
    draft.parent_game_name?.toLocaleLowerCase() === metadata.parent_game_name.toLocaleLowerCase();
  return {
    ...draft,
    name: metadata.name,
    description: metadata.description || draft.description || null,
    image_url: metadata.image_url || draft.image_url || null,
    publication_year: metadata.publication_year || draft.publication_year || null,
    release_date: metadata.release_date || draft.release_date || null,
    is_dlc: metadata.is_dlc,
    parent_game_name: metadata.is_dlc ? metadata.parent_game_name || draft.parent_game_name || null : null,
    parent_game_id: metadata.is_dlc && sameParent ? draft.parent_game_id || null : null,
    igdb_id: metadata.source === 'IGDB' ? metadata.igdb_id || null : draft.igdb_id || null,
  } as T;
}
