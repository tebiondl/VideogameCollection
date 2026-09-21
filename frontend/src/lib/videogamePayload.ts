export interface EditableCollectionGame {
  name: string;
  description?: string | null;
  comments?: string | null;
  image_url?: string | null;
  status?: string;
  playtime_hours?: number | null;
  playtime_mode?: string | null;
  mark?: number | null;
  hype?: number | null;
  completion_date?: string | null;
  publication_year?: number | null;
  release_date?: string | null;
  igdb_id?: number | null;
  completion_percentage?: number | null;
  tags?: string | null;
  dlcs?: string | null;
  is_dlc?: boolean;
  parent_game_name?: string | null;
  copies?: string | null;
  old_copies?: string | null;
  hidden?: boolean;
  reviewed?: boolean;
  version?: number | null;
}

export function collectionGameUpdatePayload(game: EditableCollectionGame) {
  return {
    name: game.name,
    description: game.description || null,
    comments: game.comments || null,
    image_url: game.image_url || null,
    status: game.status || 'Not Started',
    playtime_hours: game.playtime_hours !== undefined ? game.playtime_hours : null,
    playtime_mode: game.playtime_mode || 'user',
    mark: game.mark || null,
    hype: game.hype || null,
    completion_date: game.completion_date || null,
    publication_year: game.publication_year || null,
    release_date: game.release_date || null,
    igdb_id: game.igdb_id || null,
    completion_percentage: game.completion_percentage ?? null,
    tags: game.tags || null,
    dlcs: game.dlcs || null,
    is_dlc: !!game.is_dlc,
    parent_game_name: game.parent_game_name || null,
    copies: game.copies || null,
    old_copies: game.old_copies || null,
    hidden: !!game.hidden,
    reviewed: !!game.reviewed,
    version: game.version ?? null,
  };
}
