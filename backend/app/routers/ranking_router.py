"""Saved personal ranking and snapshot-based videogame tier lists."""
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import GameRankingEntry, GameTierList, GameTierListEntry, User, Videogame
from .auth_router import get_current_user

router = APIRouter(prefix="/api/ranking", tags=["ranking"])
TIERS = ("S", "A", "B", "C", "D", "F")


class TierFilters(BaseModel):
    statuses: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    platforms: list[str] = Field(default_factory=list)
    min_rating: int | None = Field(default=None, ge=1, le=10)
    max_rating: int | None = Field(default=None, ge=1, le=10)
    min_year: int | None = Field(default=None, ge=1950, le=2100)
    max_year: int | None = Field(default=None, ge=1950, le=2100)
    rated_only: bool = False
    include_dlc: bool = False


class RankingOrder(BaseModel):
    game_ids: list[int]


class RatingChange(BaseModel):
    mark: int = Field(ge=1, le=10)


class TierListCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    filters: TierFilters = Field(default_factory=TierFilters)


class TierListChange(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    filters: TierFilters | None = None


class TierOrder(BaseModel):
    buckets: dict[str, list[int]]


def _active_games(db: Session, user_id: int) -> list[Videogame]:
    return db.query(Videogame).filter_by(user_id=user_id, hidden=False, merged_into_game_id=None).all()


def _names(value: str | None) -> set[str]:
    if not value:
        return set()
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return {str(item).strip().casefold() for item in parsed if str(item).strip()}
    except (TypeError, ValueError):
        pass
    return {part.strip().casefold() for part in value.split(",") if part.strip()}


def _platforms(game: Videogame) -> set[str]:
    result: set[str] = set()
    for raw, key in ((game.copies, "platform"), (game.old_copies, "console")):
        try:
            entries = json.loads(raw or "[]")
        except (TypeError, ValueError):
            entries = []
        if isinstance(entries, list):
            result.update(str(item.get(key, "")).strip().casefold() for item in entries if isinstance(item, dict))
    return result


def _matches(game: Videogame, filters: TierFilters) -> bool:
    if game.is_dlc and not filters.include_dlc:
        return False
    if filters.statuses and game.status not in filters.statuses:
        return False
    if filters.rated_only and game.mark is None:
        return False
    if filters.min_rating is not None and (game.mark is None or game.mark < filters.min_rating):
        return False
    if filters.max_rating is not None and (game.mark is None or game.mark > filters.max_rating):
        return False
    if filters.min_year is not None and (game.publication_year is None or game.publication_year < filters.min_year):
        return False
    if filters.max_year is not None and (game.publication_year is None or game.publication_year > filters.max_year):
        return False
    if filters.tags and not _names(game.tags).intersection(tag.casefold() for tag in filters.tags):
        return False
    if filters.platforms and not _platforms(game).intersection(platform.casefold() for platform in filters.platforms):
        return False
    return True


def _validate_filters(filters: TierFilters) -> None:
    if filters.min_rating is not None and filters.max_rating is not None and filters.min_rating > filters.max_rating:
        raise HTTPException(422, "Minimum rating exceeds maximum rating")
    if filters.min_year is not None and filters.max_year is not None and filters.min_year > filters.max_year:
        raise HTTPException(422, "Minimum year exceeds maximum year")


def _list_or_404(db: Session, user_id: int, list_id: int) -> GameTierList:
    tier_list = db.query(GameTierList).filter_by(id=list_id, user_id=user_id).first()
    if tier_list is None:
        raise HTTPException(404, "Tier list not found")
    return tier_list


def _game_or_404(db: Session, user_id: int, game_id: int) -> Videogame:
    game = db.query(Videogame).filter_by(id=game_id, user_id=user_id, hidden=False, merged_into_game_id=None).first()
    if game is None:
        raise HTTPException(404, "Game not found in the active collection")
    return game


def _serialize(tier_list: GameTierList) -> dict:
    return {
        "id": tier_list.id,
        "name": tier_list.name,
        "filters": json.loads(tier_list.filters_json),
        "entries": [
            {"game_id": entry.game_id, "tier": entry.tier, "position": entry.position, "deleted": entry.deleted}
            for entry in sorted(tier_list.entries, key=lambda entry: (entry.tier or "", entry.position, entry.id))
        ],
    }


@router.get("")
def get_ranking(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    games = [game for game in _active_games(db, user.id) if game.mark is not None]
    entries = db.query(GameRankingEntry).filter_by(user_id=user.id).order_by(GameRankingEntry.position).all()
    by_id = {game.id: game for game in games}
    ordered = [entry.game_id for entry in entries if entry.game_id in by_id]
    used = set(ordered)
    ordered.extend(game.id for game in sorted(games, key=lambda game: (-game.mark, game.name.casefold(), game.id)) if game.id not in used)
    return {"game_ids": ordered}


@router.put("/order")
def save_ranking(payload: RankingOrder, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rated_ids = {game.id for game in _active_games(db, user.id) if game.mark is not None}
    if len(payload.game_ids) != len(set(payload.game_ids)) or set(payload.game_ids) != rated_ids:
        raise HTTPException(409, "Rated games changed. Reload the ranking before saving its order.")
    existing = {entry.game_id: entry for entry in db.query(GameRankingEntry).filter_by(user_id=user.id).all()}
    for position, game_id in enumerate(payload.game_ids):
        if game_id in existing:
            existing[game_id].position = position
        else:
            db.add(GameRankingEntry(user_id=user.id, game_id=game_id, position=position))
    db.commit()
    return {"game_ids": payload.game_ids}


@router.patch("/games/{game_id}/rating")
def change_rating(game_id: int, payload: RatingChange, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    game = _game_or_404(db, user.id, game_id)
    if game.mark is None:
        raise HTTPException(409, "Only rated games appear in the ranking")
    game.mark = payload.mark
    game.user_modified_at = datetime.utcnow()
    game.version = (game.version or 1) + 1
    db.commit()
    return {"game_id": game.id, "mark": game.mark, "version": game.version}


@router.get("/tier-lists")
def get_tier_lists(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lists = db.query(GameTierList).filter_by(user_id=user.id).order_by(GameTierList.created_at.desc(), GameTierList.id.desc()).all()
    return [_serialize(tier_list) for tier_list in lists]


@router.post("/tier-lists", status_code=201)
def create_tier_list(payload: TierListCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _validate_filters(payload.filters)
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "Enter a tier list name")
    tier_list = GameTierList(user_id=user.id, name=name, filters_json=payload.filters.model_dump_json())
    db.add(tier_list)
    db.flush()
    for position, game in enumerate(_active_games(db, user.id)):
        if _matches(game, payload.filters):
            db.add(GameTierListEntry(tier_list_id=tier_list.id, game_id=game.id, position=position))
    db.commit()
    db.refresh(tier_list)
    return _serialize(tier_list)


@router.patch("/tier-lists/{list_id}")
def change_tier_list(list_id: int, payload: TierListChange, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    tier_list = _list_or_404(db, user.id, list_id)
    if "name" in payload.model_fields_set:
        name = (payload.name or "").strip()
        if not name:
            raise HTTPException(422, "Enter a tier list name")
        tier_list.name = name
    if "filters" in payload.model_fields_set:
        if payload.filters is None:
            raise HTTPException(422, "Filters cannot be empty")
        _validate_filters(payload.filters)
        tier_list.filters_json = payload.filters.model_dump_json()
    tier_list.updated_at = datetime.utcnow()
    db.commit()
    return _serialize(tier_list)


@router.delete("/tier-lists/{list_id}", status_code=204)
def delete_tier_list(list_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    tier_list = _list_or_404(db, user.id, list_id)
    db.delete(tier_list)
    db.commit()


@router.post("/tier-lists/{list_id}/refresh")
def refresh_tier_list(list_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    tier_list = _list_or_404(db, user.id, list_id)
    filters = TierFilters.model_validate_json(tier_list.filters_json)
    known = {entry.game_id for entry in tier_list.entries}  # Includes deliberately removed games.
    position = max((entry.position for entry in tier_list.entries), default=-1) + 1
    added = 0
    for game in _active_games(db, user.id):
        if game.id not in known and _matches(game, filters):
            db.add(GameTierListEntry(tier_list_id=list_id, game_id=game.id, position=position))
            position += 1
            added += 1
    tier_list.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(tier_list)
    return {"added": added, "tier_list": _serialize(tier_list)}


@router.post("/tier-lists/{list_id}/games/{game_id}")
def add_game(list_id: int, game_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    tier_list = _list_or_404(db, user.id, list_id)
    _game_or_404(db, user.id, game_id)
    existing = next((entry for entry in tier_list.entries if entry.game_id == game_id), None)
    if existing and existing.deleted:
        raise HTTPException(409, "Restore this game from the removed games list")
    if existing is None:
        position = max((entry.position for entry in tier_list.entries), default=-1) + 1
        db.add(GameTierListEntry(tier_list_id=list_id, game_id=game_id, position=position))
        tier_list.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(tier_list)
    return _serialize(tier_list)


@router.delete("/tier-lists/{list_id}/games/{game_id}")
def remove_game(list_id: int, game_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    tier_list = _list_or_404(db, user.id, list_id)
    entry = next((entry for entry in tier_list.entries if entry.game_id == game_id), None)
    if entry is None:
        raise HTTPException(404, "Game is not in this tier list")
    entry.deleted = True
    tier_list.updated_at = datetime.utcnow()
    db.commit()
    return _serialize(tier_list)


@router.post("/tier-lists/{list_id}/games/{game_id}/restore")
def restore_game(list_id: int, game_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    tier_list = _list_or_404(db, user.id, list_id)
    _game_or_404(db, user.id, game_id)
    entry = next((entry for entry in tier_list.entries if entry.game_id == game_id), None)
    if entry is None or not entry.deleted:
        raise HTTPException(404, "Game is not in the removed games list")
    entry.deleted = False
    tier_list.updated_at = datetime.utcnow()
    db.commit()
    return _serialize(tier_list)


@router.put("/tier-lists/{list_id}/order")
def save_tier_order(list_id: int, payload: TierOrder, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    tier_list = _list_or_404(db, user.id, list_id)
    if set(payload.buckets) != {"unranked", *TIERS}:
        raise HTTPException(422, "Include every tier and the unranked pool")
    submitted = [game_id for ids in payload.buckets.values() for game_id in ids]
    active = {entry.game_id for entry in tier_list.entries if not entry.deleted}
    if len(submitted) != len(set(submitted)) or set(submitted) != active:
        raise HTTPException(409, "Available games changed. Reload the tier list before saving.")
    by_id = {entry.game_id: entry for entry in tier_list.entries}
    for tier, ids in payload.buckets.items():
        for position, game_id in enumerate(ids):
            by_id[game_id].tier = None if tier == "unranked" else tier
            by_id[game_id].position = position
    tier_list.updated_at = datetime.utcnow()
    db.commit()
    return _serialize(tier_list)
