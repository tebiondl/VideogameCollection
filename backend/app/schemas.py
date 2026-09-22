import json
from pydantic import BaseModel, Field, field_validator
from typing import List, Literal

class UserCreate(BaseModel):
    username: str
    password: str
    confirm_password: str

class UserLogin(BaseModel):
    username: str
    password: str

class UserResponse(BaseModel):
    id: int
    username: str
    avatar_url: str | None = None
    is_admin: bool = False

    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    username: str | None = None

class VideogameBase(BaseModel):
    name: str
    description: str | None = None
    comments: str | None = None
    image_url: str | None = None
    status: str = "Not Started"
    time_spent: str | None = None
    playtime_hours: float | None = None
    playtime_mode: Literal["user", "copies", "combined"] = "user"
    mark: int | None = None
    hype: int | None = None
    completion_date: str | None = None
    publication_year: int | None = None
    release_date: str | None = None
    igdb_id: int | None = None
    completion_percentage: int | None = None
    tags: str | None = None
    dlcs: str | None = None
    is_dlc: bool = False
    parent_game_name: str | None = None
    parent_game_id: int | None = Field(default=None, gt=0)
    copies: str | None = None
    old_copies: str | None = None
    hidden: bool = False
    version: int | None = None

    @field_validator("dlcs")
    @classmethod
    def valid_dlcs(cls, value):
        if not value:
            return None
        items = json.loads(value)
        valid_states = {"not_owned", "not_started", "playing", "finished", "stopped"}
        if not isinstance(items, list) or len(items) > 500:
            raise ValueError("DLCs must be a list of at most 500 entries")
        for item in items:
            if not isinstance(item, dict) or not str(item.get("name") or "").strip():
                raise ValueError("Each DLC needs a name")
            if item.get("state", "not_owned") not in valid_states:
                raise ValueError("Invalid DLC state")
            standalone_id = item.get("standalone_game_id")
            if standalone_id is not None and int(standalone_id) <= 0:
                raise ValueError("Invalid standalone DLC game")
        return json.dumps(items)

    @field_validator("copies")
    @classmethod
    def valid_copies(cls, value):
        if not value:
            return None
        items = json.loads(value)
        if not isinstance(items, list) or len(items) > 100:
            raise ValueError("Copies must be a list of at most 100 entries")
        copy_ids: set[str] = set()
        steam_appids: set[int] = set()
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("platform"), str):
                raise ValueError("Each copy needs a platform")
            if not isinstance(item.get("format", "Any"), str) or not item.get("format", "Any").strip():
                raise ValueError("Each copy needs a type")
            if item.get("id"):
                copy_id = str(item["id"])
                if copy_id in copy_ids:
                    raise ValueError("Every copy needs a unique ID")
                copy_ids.add(copy_id)
            if item.get("steam_appid"):
                appid = int(item["steam_appid"])
                if appid <= 0 or appid in steam_appids:
                    raise ValueError("A Steam app can only appear once on a game")
                steam_appids.add(appid)
            if item.get("playtime_hours") is not None and float(item["playtime_hours"]) < 0:
                raise ValueError("Copy playtime cannot be negative")
        return json.dumps(items)

    @field_validator("old_copies")
    @classmethod
    def valid_old_copies(cls, value):
        if not value:
            return None
        items = json.loads(value)
        if not isinstance(items, list) or len(items) > 100:
            raise ValueError("Old copies must be a list of at most 100 entries")
        ids: set[str] = set()
        for item in items:
            if not isinstance(item, dict) or not str(item.get("console") or "").strip():
                raise ValueError("Each old copy needs a console")
            item_id = str(item.get("id") or "")
            if item_id and item_id in ids:
                raise ValueError("Every old copy needs a unique ID")
            if item_id:
                ids.add(item_id)
            hours = item.get("playtime_hours")
            if hours is not None and float(hours) < 0:
                raise ValueError("Old-copy playtime cannot be negative")
        return json.dumps(items)

class VideogameCreate(VideogameBase):
    reviewed: bool = False

class VideogameUpdate(VideogameBase):
    id: int
    reviewed: bool = False

class VideogameResponse(VideogameBase):
    id: int
    user_id: int
    reviewed: bool = False

    class Config:
        from_attributes = True

# Smart Import Schemas
class SmartImportItemResponse(VideogameBase):
    id: int
    session_id: int
    review_status: str

    class Config:
        from_attributes = True

class SmartImportSessionResponse(BaseModel):
    id: int
    status: str
    items: list[SmartImportItemResponse] = []

    class Config:
        from_attributes = True

class SmartImportItemUpdate(VideogameBase):
    review_status: str

class TagCreate(BaseModel):
    name: str

class TagUpdate(BaseModel):
    name: str

class TagReassignment(BaseModel):
    replacement_name: str

class TagGameUsage(BaseModel):
    id: int
    name: str
    user_id: int
    username: str
    image_url: str | None = None
    status: str

class TagUsageResponse(BaseModel):
    tag: "TagResponse"
    games: list[TagGameUsage]

class TagResponse(BaseModel):
    id: int
    name: str
    user_id: int | None = None

    class Config:
        from_attributes = True

class SavedFilterCreate(BaseModel):
    name: str
    filter_data: str

class SavedFilterResponse(BaseModel):
    id: int
    name: str
    filter_data: str

    class Config:
        from_attributes = True

class AutoFillPayload(BaseModel):
    game_ids: List[int]
    overwrite: bool


class PaginationSettings(BaseModel):
    page_sizes: list[int] = Field(default_factory=lambda: [5, 10, 20, 50])

class BoardgameBase(BaseModel):
    name: str
    description: str | None = None
    comments: str | None = None
    image_url: str | None = None
    status: str = "Not Started"
    mark: int | None = None
    hype: int | None = None
    publication_year: int | None = None
    tags: str | None = None
    game_type: str | None = None
    bgg_link: str | None = None
    library_section: str = "owned"
    bgg_id: int | None = None
    bgg_rank: int | None = None
    price: float | None = None
    expansions: str | None = None
    is_expansion: bool = False
    parent_game_name: str | None = None

class BoardgameCreate(BoardgameBase):
    pass

class BoardgameCollectionCreate(BaseModel):
    game: BoardgameCreate
    source_game_ids: list[int] = Field(default_factory=list)

class BoardgameUpdate(BoardgameBase):
    id: int


class BoardgameExpansionAttach(BaseModel):
    parent_game_id: int

class BoardgameResponse(BoardgameBase):
    id: int
    user_id: int

    class Config:
        from_attributes = True

class BoardgameCollectionLinkResponse(BaseModel):
    game: BoardgameResponse
    matches_linked: int
    sources_merged: int

class BoardgameDeleteResponse(BaseModel):
    status: str
    game: BoardgameResponse | None = None
    matches_preserved: int = 0

class BoardgameSmartImportItemResponse(BoardgameBase):
    id: int
    session_id: int
    review_status: str

    class Config:
        from_attributes = True

class BoardgameSmartImportSessionResponse(BaseModel):
    id: int
    status: str
    items: list[BoardgameSmartImportItemResponse] = []

    class Config:
        from_attributes = True

class BoardgameSmartImportItemUpdate(BoardgameBase):
    review_status: str

class BoardgameTagCreate(BaseModel):
    name: str

class BoardgameTagUpdate(BaseModel):
    name: str

class BoardgameTagReassignment(BaseModel):
    replacement_name: str

class BoardgameTagGameUsage(BaseModel):
    id: int
    name: str
    user_id: int
    username: str
    image_url: str | None = None
    status: str

class BoardgameTagUsageResponse(BaseModel):
    tag: "BoardgameTagResponse"
    games: list[BoardgameTagGameUsage]

class BoardgameTagResponse(BaseModel):
    id: int
    name: str
    user_id: int | None = None

    class Config:
        from_attributes = True

class BoardgameSavedFilterCreate(BaseModel):
    name: str
    filter_data: str

class BoardgameSavedFilterResponse(BaseModel):
    id: int
    name: str
    filter_data: str

    class Config:
        from_attributes = True


class BoardgamePlayerCreate(BaseModel):
    name: str


class BoardgamePlayerMerge(BaseModel):
    replacement_player_id: int


class BoardgamePlayerResponse(BaseModel):
    id: int
    user_id: int
    name: str
    normalized_name: str
    match_count: int = 0

    class Config:
        from_attributes = True


class BoardgamePlayerMatchUsage(BaseModel):
    id: int
    boardgame_id: int
    game_name: str
    played_date: str | None = None
    mode: str
    winner_name: str | None = None


class BoardgamePlayerUsageResponse(BaseModel):
    player: BoardgamePlayerResponse
    matches: list[BoardgamePlayerMatchUsage]


class BoardgamePlayerMergeResponse(BaseModel):
    player: BoardgamePlayerResponse
    matches_transferred: int


class BoardgameMatchBase(BaseModel):
    boardgame_id: int
    player_ids: list[int] = Field(default_factory=list)
    played_with: str | None = None
    mode: str
    result: str | None = None
    winner_name: str | None = None
    comments: str | None = None
    played_date: str | None = None


class BoardgameMatchCreate(BoardgameMatchBase):
    pass


class BoardgameMatchResponse(BoardgameMatchBase):
    id: int
    user_id: int
    game_name: str
    game_image_url: str | None = None
    game_tags: str | None = None
    players: list[BoardgamePlayerResponse] = Field(default_factory=list)

    class Config:
        from_attributes = True


class BggSearchResult(BaseModel):
    id: int
    name: str
    year_published: int | None = None
    item_type: str | None = None


class BggGameMetadata(BaseModel):
    id: int
    name: str
    description: str | None = None
    image_url: str | None = None
    thumbnail_url: str | None = None
    year_published: int | None = None
    rank: int | None = None
    bgg_link: str
    is_expansion: bool = False
