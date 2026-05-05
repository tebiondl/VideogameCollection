from pydantic import BaseModel
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

class BoardgameCreate(BoardgameBase):
    pass

class BoardgameUpdate(BoardgameBase):
    id: int

class BoardgameResponse(BoardgameBase):
    id: int
    user_id: int

    class Config:
        from_attributes = True

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
