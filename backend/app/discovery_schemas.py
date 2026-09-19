import json
from datetime import date, datetime
from typing import Literal
from urllib.parse import urlparse
from pydantic import BaseModel, ConfigDict, Field, field_validator


class WantedInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=20000)
    comments: str | None = Field(default=None, max_length=20000)
    image_url: str | None = None
    platform: str = Field(default="", max_length=100)
    format: Literal["Any", "Physical", "Digital"] = "Any"
    status: Literal["Wanted", "Watching", "Preordered", "Acquired"] = "Wanted"
    hype: int | None = Field(default=None, ge=1, le=10)
    target_price: float | None = Field(default=None, ge=0, le=1000000, allow_inf_nan=False)
    currency: Literal["EUR", "USD", "GBP", "JPY"] = "EUR"
    release_date: str | None = None
    publication_year: int | None = Field(default=None, ge=1970, le=2200)
    tags: str | None = Field(default=None, max_length=2000)
    dlcs: str | None = None
    is_dlc: bool = False
    parent_game_name: str | None = Field(default=None, max_length=300)
    igdb_id: int | None = Field(default=None, gt=0)
    steam_appid: int | None = Field(default=None, gt=0)
    store_url: str | None = None

    @field_validator("release_date")
    @classmethod
    def valid_date(cls, value):
        if not value:
            return None
        return date.fromisoformat(value).isoformat()

    @field_validator("image_url", "store_url")
    @classmethod
    def valid_url(cls, value):
        if not value:
            return None
        parsed = urlparse(value)
        if parsed.scheme not in ("https", "http") or not parsed.netloc:
            raise ValueError("Use an http or https URL")
        return value

    @field_validator("dlcs")
    @classmethod
    def valid_dlcs(cls, value):
        if not value:
            return None
        items = json.loads(value)
        if not isinstance(items, list) or len(items) > 500:
            raise ValueError("DLCs must be a list of at most 500 entries")
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip():
                raise ValueError("Each DLC needs a name")
            if item.get("state") not in ("not_owned", "not_started", "finished"):
                raise ValueError("Invalid DLC state")
        return json.dumps(items)


class WantedResponse(WantedInput):
    model_config = ConfigDict(from_attributes=True)
    id: int
    source: str
    created_at: datetime
    updated_at: datetime
    collection_game_id: int | None = None
    steam_wishlist_missing: bool = False


class AcquireInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=20000)
    comments: str | None = Field(default=None, max_length=20000)
    image_url: str | None = None
    status: Literal["Not Started", "Playing", "Finished", "Stopped", "Infinite"] = "Not Started"
    playtime_hours: float | None = Field(default=None, ge=0)
    mark: int | None = Field(default=None, ge=1, le=10)
    hype: int | None = Field(default=None, ge=1, le=10)
    completion_date: str | None = None
    publication_year: int | None = Field(default=None, ge=1970, le=2200)
    release_date: str | None = None
    completion_percentage: int | None = Field(default=None, ge=0, le=100)
    tags: str | None = Field(default=None, max_length=2000)
    dlcs: str | None = None
    is_dlc: bool = False
    parent_game_name: str | None = Field(default=None, max_length=300)
    platform: str = Field(default="", max_length=100)
    format: Literal["Any", "Physical", "Digital"] = "Any"
    source: str = Field(default="manual", max_length=50)
    store_url: str | None = None
    steam_appid: int | None = Field(default=None, gt=0)
    igdb_id: int | None = Field(default=None, gt=0)
    price: float | None = Field(default=None, ge=0, le=1000000, allow_inf_nan=False)
    currency: Literal["EUR", "USD", "GBP", "JPY"] = "EUR"

    @field_validator("release_date")
    @classmethod
    def valid_release_date(cls, value):
        if not value:
            return None
        return date.fromisoformat(value).isoformat()

    @field_validator("image_url", "store_url")
    @classmethod
    def valid_urls(cls, value):
        if not value:
            return None
        parsed = urlparse(value)
        if parsed.scheme not in ("https", "http") or not parsed.netloc:
            raise ValueError("Use an http or https URL")
        return value

    @field_validator("dlcs")
    @classmethod
    def valid_included_dlcs(cls, value):
        return WantedInput.valid_dlcs(value)


class BatchInput(BaseModel):
    games: list[WantedInput] = Field(min_length=1, max_length=500)


class SettingsInput(BaseModel):
    steam_id: str | None = None
    steam_api_key: str | None = Field(default=None, min_length=32, max_length=64)
    clear_steam_api_key: bool = False
    sync_enabled: bool = False
    sync_wishlist: bool = True
    sync_collection: bool = True
    sync_hours: Literal[6, 8] = 6
    region: Literal["Europe", "North America", "Japan"] = "Europe"


class SettingsResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    steam_id: str | None = None
    steam_api_key_configured: bool = False
    sync_enabled: bool = False
    sync_wishlist: bool = True
    sync_collection: bool = True
    sync_hours: Literal[6, 8] = 6
    region: Literal["Europe", "North America", "Japan"] = "Europe"
    last_sync_at: datetime | None = None
    next_sync_at: datetime | None = None
    sync_started_at: datetime | None = None
    sync_error: str | None = None
    last_import_count: int = 0
    last_owned_import_count: int = 0
    last_igdb_match_count: int = 0


class SteamMatchCandidate(BaseModel):
    game_id: int
    name: str
    confidence: float


class SteamMatchReviewResponse(BaseModel):
    id: int
    steam_appid: int
    steam_name: str
    candidate_game_id: int
    candidate_name: str
    confidence: float
    candidates: list[SteamMatchCandidate]
    created_at: datetime


class SteamMatchDecision(BaseModel):
    decision: Literal["same", "different", "none"]
    candidate_game_id: int | None = Field(default=None, gt=0)


class CopyOptionsInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    platforms: list[str] = Field(min_length=1, max_length=100)
    sources: list[str] = Field(min_length=1, max_length=100)

    @field_validator("platforms", "sources")
    @classmethod
    def valid_options(cls, values):
        cleaned = []
        seen = set()
        for value in values:
            value = value.strip()
            if not value or len(value) > 100:
                raise ValueError("Options must be between 1 and 100 characters")
            key = value.casefold()
            if key not in seen:
                seen.add(key)
                cleaned.append(value)
        if not cleaned:
            raise ValueError("Keep at least one option")
        return cleaned


class CopyOptionsResponse(CopyOptionsInput):
    pass


class ReleaseInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=300)
    release_date: date
    region: Literal["Europe", "North America", "Japan"] = "Europe"
    image_url: str | None = None
    source_url: str = Field(min_length=1)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("image_url", "source_url")
    @classmethod
    def valid_url(cls, value):
        return WantedInput.valid_url(value)
