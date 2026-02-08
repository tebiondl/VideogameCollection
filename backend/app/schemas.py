from pydantic import BaseModel
from typing import Optional, List
from .models import GameStatus, GameProgress


# Token
class Token(BaseModel):
    access_token: str
    token_type: str


class TokenData(BaseModel):
    username: str | None = None


# User
class UserBase(BaseModel):
    username: str


class UserCreate(UserBase):
    password: str


class User(UserBase):
    id: int

    class Config:
        from_attributes = True


# Game
class GameBase(BaseModel):
    title: str
    status: GameStatus = GameStatus.BACKLOG
    hype_score: Optional[int] = None
    rating: Optional[float] = None
    progress: Optional[GameProgress] = None
    playtime_hours: Optional[float] = None
    finish_year: Optional[int] = None
    release_year: Optional[int] = None
    price: Optional[float] = None
    platform: Optional[str] = None
    steam_deck: bool = False
    notes: Optional[str] = None


class GameCreate(GameBase):
    pass


class GameUpdate(GameBase):
    title: Optional[str] = None
    status: Optional[GameStatus] = None


class Game(GameBase):
    id: int
    user_id: int

    class Config:
        from_attributes = True
