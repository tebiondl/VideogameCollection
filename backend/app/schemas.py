from pydantic import BaseModel, Field
from typing import List

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
    mark: int | None = None
    hype: int | None = None
    completion_date: str | None = None
    publication_year: int | None = None
    completion_percentage: int | None = None
    tags: str | None = None
    dlcs: str | None = None

class VideogameCreate(VideogameBase):
    pass

class VideogameUpdate(VideogameBase):
    id: int

class VideogameResponse(VideogameBase):
    id: int
    user_id: int

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
