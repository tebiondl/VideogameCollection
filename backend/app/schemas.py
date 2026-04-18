from pydantic import BaseModel

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
    image_url: str | None = None
    status: str = "Not Started"
    time_spent: str | None = None
    mark: int | None = None
    completion_date: str | None = None
    publication_year: int | None = None
    tags: str | None = None

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

class TagResponse(BaseModel):
    id: int
    name: str
    user_id: int | None = None

    class Config:
        from_attributes = True
