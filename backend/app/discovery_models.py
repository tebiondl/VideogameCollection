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
    steam_id = Column(String)


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
    sync_warning = Column(String)
    last_import_count = Column(Integer, nullable=False, default=0)
    last_owned_import_count = Column(Integer, nullable=False, default=0)
    last_igdb_match_count = Column(Integer, nullable=False, default=0)
    region = Column(String, nullable=False, default="Europe")
    owned_sync_generation = Column(Integer, nullable=False, default=0)

    @property
    def steam_api_key_configured(self):
        from .services.secrets import steam_api_key_available
        return steam_api_key_available(self.steam_api_key)


class OwnedCopy(Base):
    """Authoritative owned-copy row. ``videogames.copies`` is only an API projection."""
    __tablename__ = "owned_copies"
    __table_args__ = (
        UniqueConstraint("user_id", "collection_game_id", "copy_id", name="uq_owned_copy_user_game_copy"),
        UniqueConstraint("user_id", "steam_id", "collection_game_id", "steam_appid", name="uq_owned_copy_steam_game_app"),
    )
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    collection_game_id = Column(Integer, ForeignKey("videogames.id", ondelete="CASCADE"), nullable=False, index=True)
    copy_id = Column(String, nullable=False)
    position = Column(Integer, nullable=False, default=0)
    name = Column(String)
    platform = Column(String, nullable=False, default="")
    format = Column(String, nullable=False, default="Any")
    source = Column(String)
    store_url = Column(String)
    igdb_id = Column(Integer)
    price = Column(Float)
    currency = Column(String, nullable=False, default="EUR")
    playtime_hours = Column(Float)
    steam_id = Column(String, nullable=False, default="")
    steam_appid = Column(Integer, nullable=True, index=True)
    # The collection card this copy occupied before a duplicate merge. Keeping
    # this on the copy makes a merge reversible without copying or overwriting
    # the user's game-level data.
    merged_from_game_id = Column(Integer, nullable=True, index=True)
    created_collection_game = Column(Boolean, nullable=False, default=False)
    user_selected = Column(Boolean, nullable=False, default=False)
    counts_toward_totals = Column(Boolean, nullable=False, default=True)
    user_modified = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


# Compatibility name retained while callers migrate from the old link-only model.
SteamCollectionLink = OwnedCopy


class SteamOwnedGame(Base):
    """Last successful Steam library snapshot used for manual linking and duplicate choices."""
    __tablename__ = "steam_entitlements"
    __table_args__ = (UniqueConstraint("user_id", "steam_id", "steam_appid", name="uq_steam_entitlement_account_app"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    steam_id = Column(String, nullable=False, default="", index=True)
    steam_appid = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    playtime_hours = Column(Float)
    image_url = Column(String)
    store_url = Column(String)
    igdb_id = Column(Integer)
    is_dlc = Column(Boolean, nullable=False, default=False)
    parent_game_name = Column(String)
    duplicate_of_appid = Column(Integer)
    active = Column(Boolean, nullable=False, default=True)
    # Some played free games are omitted by GetOwnedGames. These rows were
    # independently confirmed against this account's Steam stats APIs and must
    # survive an otherwise-authoritative owned-library refresh.
    stats_verified = Column(Boolean, nullable=False, default=False)
    last_seen_generation = Column(Integer, nullable=False, default=0)
    first_seen_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    last_seen_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class SteamCopyTrash(Base):
    """A deliberately removed Steam copy that collection sync must not recreate."""
    __tablename__ = "steam_copy_suppressions"
    __table_args__ = (UniqueConstraint("user_id", "steam_id", "steam_appid", "collection_game_id", "copy_id", "kind", name="uq_steam_suppression_target"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    steam_id = Column(String, nullable=False, default="", index=True)
    steam_appid = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    image_url = Column(String)
    collection_game_id = Column(Integer, nullable=False, default=0)
    copy_id = Column(String, nullable=False, default="")
    kind = Column(String, nullable=False, default="copy")
    collection_game_name = Column(String)
    copy_data = Column(String, nullable=False)
    game_data = Column(String)
    deleted_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class SteamMatchReview(Base):
    """A possible Steam/collection match that requires the user's decision."""
    __tablename__ = "steam_match_reviews_v2"
    __table_args__ = (UniqueConstraint("user_id", "steam_id", "steam_appid", "match_kind", name="uq_steam_review_account_app_kind"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    steam_id = Column(String, nullable=False, default="", index=True)
    match_kind = Column(String, nullable=False, default="game")
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


class SteamContentLink(Base):
    """Durable identity for a Steam DLC nested below a collection game."""
    __tablename__ = "steam_content_links"
    __table_args__ = (UniqueConstraint("user_id", "steam_id", "steam_appid", name="uq_steam_content_account_app"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    steam_id = Column(String, nullable=False, default="", index=True)
    steam_appid = Column(Integer, nullable=False)
    parent_game_id = Column(Integer, ForeignKey("videogames.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String, nullable=False)
    igdb_id = Column(Integer)
    user_selected = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class GameMergeRedirect(Base):
    __tablename__ = "game_merge_redirects"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    merged_game_id = Column(Integer, nullable=False, index=True)
    retained_game_id = Column(Integer, ForeignKey("videogames.id", ondelete="CASCADE"), nullable=False, index=True)
    merged_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class SteamAuditLog(Base):
    __tablename__ = "steam_audit_log"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    steam_id = Column(String, nullable=False, default="", index=True)
    action = Column(String, nullable=False, index=True)
    steam_appid = Column(Integer)
    collection_game_id = Column(Integer)
    copy_id = Column(String)
    details = Column(String)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)


class CopyOption(Base):
    __tablename__ = "copy_options"
    __table_args__ = (UniqueConstraint("user_id", "kind", "name", name="uq_copy_option_user_kind_name"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    kind = Column(String, nullable=False)  # platform | source | type | old_console
    name = Column(String, nullable=False)
    position = Column(Integer, nullable=False, default=0)


class CopyCompatibility(Base):
    """Admin-managed allowed values between two copy dropdown columns."""
    __tablename__ = "copy_compatibility"
    __table_args__ = (
        UniqueConstraint("user_id", "relation", "left_name", "right_name", name="uq_copy_compatibility"),
    )
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    relation = Column(String, nullable=False)  # platform_source | source_type
    left_name = Column(String, nullable=False)
    right_name = Column(String, nullable=False)
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
