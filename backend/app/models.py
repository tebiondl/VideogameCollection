from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, Float, DateTime, Table, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
from .database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    avatar_url = Column(String, nullable=True) # E.g., URL or base64
    is_admin = Column(Boolean, nullable=False, default=False)

    videogames = relationship("Videogame", back_populates="owner")
    boardgames = relationship("Boardgame", back_populates="owner")
    boardgame_matches = relationship("BoardgameMatch", back_populates="owner", cascade="all, delete-orphan")
    boardgame_players = relationship("BoardgamePlayer", back_populates="owner", cascade="all, delete-orphan")

class Videogame(Base):
    __tablename__ = "videogames"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, index=True, nullable=False)
    description = Column(String, nullable=True)
    comments = Column(String, nullable=True)
    image_url = Column(String, nullable=True)
    status = Column(String, nullable=False, default="Not Started") # 'Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'
    time_spent = Column(String, nullable=True) # DEPRECATED
    playtime_hours = Column(Float, nullable=True)
    mark = Column(Integer, nullable=True)  # 1 to 10 — only for Finished/Stopped
    hype = Column(Integer, nullable=True)  # 1 to 10 — anticipation for not-yet-played
    completion_date = Column(String, nullable=True) # string to support just '2024' or '2024-05'
    publication_year = Column(Integer, nullable=True)
    completion_percentage = Column(Integer, nullable=True)
    tags = Column(String, nullable=True) # JSON encoded string or comma separated
    dlcs = Column(String, nullable=True) # JSON array: [{name, state: not_owned|not_started|finished}]

    owner = relationship("User", back_populates="videogames")

class SmartImportSession(Base):
    __tablename__ = "smart_import_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(String, nullable=False, default="processing") # processing, pending_review, completed, failed
    created_at = Column(DateTime, default=datetime.utcnow)
    raw_ai_response = Column(String, nullable=True)
    
    items = relationship("SmartImportItem", back_populates="session", cascade="all, delete-orphan")

class SmartImportItem(Base):
    __tablename__ = "smart_import_items"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("smart_import_sessions.id"), nullable=False)
    review_status = Column(String, nullable=False, default="pending") # pending, accepted, rejected
    
    # Same fields as Videogame
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    comments = Column(String, nullable=True)
    image_url = Column(String, nullable=True)
    status = Column(String, nullable=False, default="Not Started")
    time_spent = Column(String, nullable=True) # DEPRECATED
    playtime_hours = Column(Float, nullable=True)
    mark = Column(Integer, nullable=True)
    hype = Column(Integer, nullable=True)
    completion_date = Column(String, nullable=True)
    publication_year = Column(Integer, nullable=True)
    completion_percentage = Column(Integer, nullable=True)
    tags = Column(String, nullable=True)
    dlcs = Column(String, nullable=True) # JSON array: [{name, state: not_owned|not_started|finished}]

    session = relationship("SmartImportSession", back_populates="items")

class Tag(Base):
    __tablename__ = "tags"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True) # Null means global default tag

class SavedFilter(Base):
    __tablename__ = "saved_filters"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    filter_data = Column(String, nullable=False) # JSON blob of the filter state

class Boardgame(Base):
    __tablename__ = "boardgames"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, index=True, nullable=False)
    description = Column(String, nullable=True)
    comments = Column(String, nullable=True)
    image_url = Column(String, nullable=True)
    status = Column(String, nullable=False, default="Not Started")
    mark = Column(Integer, nullable=True)  # 1 to 10
    hype = Column(Integer, nullable=True)  # 1 to 10
    publication_year = Column(Integer, nullable=True)
    tags = Column(String, nullable=True)
    game_type = Column(String, nullable=True) # competitive, cooperative, solo (comma separated)
    bgg_link = Column(String, nullable=True)
    library_section = Column(String, nullable=False, default="owned") # wishlist | owned | external (played, not owned)
    bgg_id = Column(Integer, nullable=True)
    bgg_rank = Column(Integer, nullable=True)
    price = Column(Float, nullable=True)
    expansions = Column(String, nullable=True) # JSON array of manually entered expansion names
    is_expansion = Column(Boolean, nullable=False, default=False)
    parent_game_name = Column(String, nullable=True)

    owner = relationship("User", back_populates="boardgames")
    matches = relationship("BoardgameMatch", back_populates="boardgame", cascade="all, delete-orphan")


boardgame_match_players = Table(
    "boardgame_match_players",
    Base.metadata,
    Column("match_id", Integer, ForeignKey("boardgame_matches.id", ondelete="CASCADE"), primary_key=True),
    Column("player_id", Integer, ForeignKey("boardgame_players.id", ondelete="CASCADE"), primary_key=True),
)


class BoardgamePlayer(Base):
    __tablename__ = "boardgame_players"
    __table_args__ = (UniqueConstraint("user_id", "normalized_name", name="uq_boardgame_player_user_name"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    normalized_name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("User", back_populates="boardgame_players")
    matches = relationship("BoardgameMatch", secondary=boardgame_match_players, back_populates="players")


class BoardgameMatch(Base):
    __tablename__ = "boardgame_matches"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    boardgame_id = Column(Integer, ForeignKey("boardgames.id"), nullable=False)
    played_with = Column(String, nullable=True) # JSON array of player names
    mode = Column(String, nullable=False) # cooperative | competitive | solo
    result = Column(String, nullable=True) # victory | defeat | winner | incomplete
    winner_name = Column(String, nullable=True)
    comments = Column(String, nullable=True)
    played_date = Column(String, nullable=True) # YYYY-MM-DD; legacy imports use an empty value when unknown
    import_key = Column(String, nullable=True, index=True) # Stable workbook row key for idempotent imports
    created_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("User", back_populates="boardgame_matches")
    boardgame = relationship("Boardgame", back_populates="matches")
    players = relationship("BoardgamePlayer", secondary=boardgame_match_players, back_populates="matches")

class BoardgameSmartImportSession(Base):
    __tablename__ = "boardgame_smart_import_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(String, nullable=False, default="processing")
    created_at = Column(DateTime, default=datetime.utcnow)
    raw_ai_response = Column(String, nullable=True)
    
    items = relationship("BoardgameSmartImportItem", back_populates="session", cascade="all, delete-orphan")

class BoardgameSmartImportItem(Base):
    __tablename__ = "boardgame_smart_import_items"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("boardgame_smart_import_sessions.id"), nullable=False)
    review_status = Column(String, nullable=False, default="pending")
    
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    comments = Column(String, nullable=True)
    image_url = Column(String, nullable=True)
    status = Column(String, nullable=False, default="Not Started")
    mark = Column(Integer, nullable=True)
    hype = Column(Integer, nullable=True)
    publication_year = Column(Integer, nullable=True)
    tags = Column(String, nullable=True)
    game_type = Column(String, nullable=True)
    bgg_link = Column(String, nullable=True)

    session = relationship("BoardgameSmartImportSession", back_populates="items")

class BoardgameTag(Base):
    __tablename__ = "boardgame_tags"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)

class BoardgameSavedFilter(Base):
    __tablename__ = "boardgame_saved_filters"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    filter_data = Column(String, nullable=False)

