from sqlalchemy import Column, Integer, String, Float, Boolean, ForeignKey, Enum
from sqlalchemy.orm import relationship
from .database import Base
import enum


class GameStatus(str, enum.Enum):
    BACKLOG = "backlog"
    FINISHED = "finished"


class GameProgress(str, enum.Enum):
    STARTED = "Empezado"
    HALFWAY = "A mitad"
    ADVANCED = "Avanzado"
    FINISHED = "Terminado"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    password_hash = Column(String)

    games = relationship("Game", back_populates="owner")


class Game(Base):
    __tablename__ = "games"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    status = Column(Enum(GameStatus), default=GameStatus.BACKLOG)

    # Backlog specific
    hype_score = Column(Integer, nullable=True)  # "Ganas"

    # Finished specific
    rating = Column(Float, nullable=True)  # "Nota"
    progress = Column(Enum(GameProgress), nullable=True)
    playtime_hours = Column(Float, nullable=True)
    finish_year = Column(Integer, nullable=True)
    release_year = Column(Integer, nullable=True)

    # Common
    price = Column(Float, nullable=True)
    platform = Column(String, nullable=True)
    steam_deck = Column(Boolean, default=False)
    notes = Column(String, nullable=True)

    user_id = Column(Integer, ForeignKey("users.id"))
    owner = relationship("User", back_populates="games")
