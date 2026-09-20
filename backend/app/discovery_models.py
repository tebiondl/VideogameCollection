"""Discovery has its own library; owned-game queries never include wishlist rows."""
from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, Float, DateTime, ForeignKey, UniqueConstraint
from .database import Base


class WantedGame(Base):
    __tablename__ = "wanted_games"
    __table_args__ = (UniqueConstraint("user_id", "steam_appid", name="uq_wanted_steam_user"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    description = Column(String)
    comments = Column(String)
    image_url = Column(String)
    platform = Column(String, nullable=False, default="")
    format = Column(String, nullable=False, default="Any")
    status = Column(String, nullable=False, default="Wanted")
    hype = Column(Integer)
    target_price = Column(Float)
    currency = Column(String, nullable=False, default="EUR")
    release_date = Column(String)
    publication_year = Column(Integer)
    tags = Column(String)
    dlcs = Column(String)
    is_dlc = Column(Boolean, nullable=False, default=False)
    parent_game_name = Column(String)
    igdb_id = Column(Integer)
    steam_appid = Column(Integer)
    store_url = Column(String)
    source = Column(String, nullable=False, default="manual")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    deleted = Column(Boolean, nullable=False, default=False)
    collection_game_id = Column(Integer, ForeignKey("videogames.id"))
    steam_wishlist_missing = Column(Boolean, nullable=False, default=False)


class DiscoverySettings(Base):
    __tablename__ = "discovery_settings"
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    steam_id = Column(String)
    steam_api_key = Column(String)
    sync_enabled = Column(Boolean, nullable=False, default=False)
    sync_wishlist = Column(Boolean, nullable=False, default=True)
    sync_collection = Column(Boolean, nullable=False, default=True)
    sync_hours = Column(Integer, nullable=False, default=6)
    last_sync_at = Column(DateTime)
    next_sync_at = Column(DateTime)
    sync_started_at = Column(DateTime)
    sync_error = Column(String)
    last_import_count = Column(Integer, nullable=False, default=0)
    last_owned_import_count = Column(Integer, nullable=False, default=0)
    last_igdb_match_count = Column(Integer, nullable=False, default=0)
    region = Column(String, nullable=False, default="Europe")

    @property
    def steam_api_key_configured(self):
        return bool(self.steam_api_key)


class SteamCollectionLink(Base):
    """A Steam identity belongs to one owned copy, not to the whole game card."""
    __tablename__ = "steam_copy_links"
    __table_args__ = (UniqueConstraint("user_id", "collection_game_id", "copy_id", name="uq_steam_copy_link_user_copy"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    steam_appid = Column(Integer, nullable=False)
    collection_game_id = Column(Integer, ForeignKey("videogames.id", ondelete="CASCADE"), nullable=False, index=True)
    copy_id = Column(String, nullable=False)
    igdb_id = Column(Integer)
    created_collection_game = Column(Boolean, nullable=False, default=False)
    user_selected = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class SteamOwnedGame(Base):
    """Last successful Steam library snapshot used for manual linking and duplicate choices."""
    __tablename__ = "steam_owned_games"
    __table_args__ = (UniqueConstraint("user_id", "steam_appid", name="uq_steam_owned_game_user_app"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    steam_appid = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    playtime_hours = Column(Float)
    image_url = Column(String)
    store_url = Column(String)
    igdb_id = Column(Integer)
    is_dlc = Column(Boolean, nullable=False, default=False)
    parent_game_name = Column(String)
    duplicate_of_appid = Column(Integer)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class SteamMatchReview(Base):
    """A possible Steam/collection match that requires the user's decision."""
    __tablename__ = "steam_match_reviews"
    __table_args__ = (UniqueConstraint("user_id", "steam_appid", name="uq_steam_match_review_user_app"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    steam_appid = Column(Integer, nullable=False)
    steam_name = Column(String, nullable=False)
    candidate_game_id = Column(Integer, ForeignKey("videogames.id", ondelete="CASCADE"), nullable=False, index=True)
    candidate_name = Column(String, nullable=False)
    confidence = Column(Float, nullable=False)
    candidates = Column(String)
    rejected_candidate_ids = Column(String)
    steam_data = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class CopyOption(Base):
    __tablename__ = "copy_options"
    __table_args__ = (UniqueConstraint("user_id", "kind", "name", name="uq_copy_option_user_kind_name"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    kind = Column(String, nullable=False)  # platform | source
    name = Column(String, nullable=False)
    position = Column(Integer, nullable=False, default=0)


class DiscoveryCache(Base):
    __tablename__ = "discovery_cache"
    key = Column(String, primary_key=True)
    payload = Column(String, nullable=False)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PhysicalRelease(Base):
    __tablename__ = "physical_releases"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    release_date = Column(String, nullable=False)
    region = Column(String, nullable=False, default="Europe")
    image_url = Column(String)
    source_url = Column(String, nullable=False)
    notes = Column(String)
