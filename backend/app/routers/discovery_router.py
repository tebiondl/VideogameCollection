import json
from uuid import uuid4
from collections import Counter
from datetime import datetime
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from ..database import get_db
from ..models import User, Videogame
from ..discovery_models import WantedGame, PhysicalRelease, CopyOption, SteamCollectionLink, SteamMatchReview
from ..discovery_schemas import (
    WantedInput, WantedResponse, AcquireInput, BatchInput, SettingsInput, SettingsResponse,
    CopyOptionsInput, CopyOptionsResponse, ReleaseInput, SteamMatchReviewResponse,
    SteamMatchDecision,
)
from ..services import discovery as service
from .auth_router import get_current_user

router = APIRouter(prefix="/api/discovery", tags=["discovery"])

DEFAULT_COPY_OPTIONS = {
    "platforms": ["PC", "Nintendo Switch", "Nintendo Switch 2", "PlayStation 5", "PlayStation 4", "Xbox Series X|S", "Xbox One", "Steam Deck"],
    "sources": ["Steam", "Nintendo eShop", "PlayStation Store", "Xbox Store", "Retail", "Gift", "Subscription", "Other"],
}


def owned_row(db, user, game_id):
    game = db.query(WantedGame).filter_by(id=game_id, user_id=user.id, deleted=False).first()
    if not game:
        raise HTTPException(404, "Wanted game not found")
    return game


def admin(user):
    if not user.is_admin:
        raise HTTPException(403, "Admin access required")


def commit(db):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "This Steam game is already saved in Discovery.")


def copy_options(db, user_id):
    rows = db.query(CopyOption).filter_by(user_id=user_id).order_by(CopyOption.position, CopyOption.id).all()
    result = {"platforms": [], "sources": []}
    for row in rows:
        result[f"{row.kind}s"].append(row.name)
    return {key: result[key] or values for key, values in DEFAULT_COPY_OPTIONS.items()}


@router.get("/games", response_model=list[WantedResponse])
def list_games(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return db.query(WantedGame).filter_by(user_id=user.id, deleted=False).order_by(WantedGame.created_at.desc(), WantedGame.id.desc()).all()


@router.post("/games", response_model=WantedResponse, status_code=201)
def create_game(payload: WantedInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    fields = payload.model_dump()
    duplicate = service.find_duplicate(db, user.id, fields)
    if duplicate:
        if duplicate.deleted:
            duplicate.deleted = False
            for key, value in fields.items():
                setattr(duplicate, key, value)
            duplicate.updated_at = datetime.utcnow()
            commit(db)
            return duplicate
        raise HTTPException(409, "This game is already saved. Edit its existing entry instead.")
    game = WantedGame(user_id=user.id, **fields)
    db.add(game)
    commit(db)
    db.refresh(game)
    return game


@router.post("/import")
def import_games(payload: BatchInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    added, skipped = 0, 0
    for item in payload.games:
        fields = item.model_dump()
        if service.find_duplicate(db, user.id, fields):
            skipped += 1
            continue
        db.add(WantedGame(user_id=user.id, source="import", **fields))
        db.flush()
        added += 1
    commit(db)
    return {"added": added, "skipped": skipped}


@router.put("/games/{game_id}", response_model=WantedResponse)
def edit_game(game_id: int, payload: WantedInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    game = owned_row(db, user, game_id)
    if service.find_duplicate(db, user.id, payload.model_dump(), exclude_id=game_id):
        raise HTTPException(409, "Another entry already uses this identity or game/platform pair.")
    for key, value in payload.model_dump().items():
        setattr(game, key, value)
    game.updated_at = datetime.utcnow()
    commit(db)
    return game


@router.delete("/games/{game_id}", status_code=204)
def delete_game(game_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    game = owned_row(db, user, game_id)
    # Retain Steam identity so scheduled imports don't undo an intentional removal.
    game.deleted = True
    game.updated_at = datetime.utcnow()
    commit(db)


@router.post("/games/{game_id}/acquire")
def acquire_game(game_id: int, payload: AcquireInput | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    game = owned_row(db, user, game_id)
    if payload is None:
        payload = AcquireInput(
            name=game.name, description=game.description, comments=game.comments, image_url=game.image_url,
            hype=game.hype, publication_year=game.publication_year, release_date=game.release_date,
            tags=game.tags, dlcs=game.dlcs, is_dlc=game.is_dlc, parent_game_name=game.parent_game_name,
            platform=game.platform, format=game.format, source=game.source, store_url=game.store_url,
            steam_appid=game.steam_appid, igdb_id=game.igdb_id, price=game.target_price, currency=game.currency,
        )
    existing = db.query(Videogame).filter_by(id=game.collection_game_id, user_id=user.id).first() if game.collection_game_id else None
    if existing is None:
        existing = next((row for row in db.query(Videogame).filter_by(user_id=user.id).all() if service.normalized(row.name) == service.normalized(payload.name)), None)
    steam_copy = service.normalized(payload.source) == "steam" and service.platform_key(payload.platform) in ("pc", "steam deck")
    settings = service.get_settings(db, user.id)
    if game.steam_appid and settings.sync_enabled and settings.sync_collection and steam_copy:
        raise HTTPException(
            409,
            "Steam library sync manages this copy. Add a non-Steam copy, or disable collection sync before moving it manually.",
        )
    copy_store_url = payload.store_url
    if not steam_copy and copy_store_url and "steampowered.com/app/" in copy_store_url.casefold():
        copy_store_url = None
    copy = {
        "id": uuid4().hex,
        "platform": payload.platform,
        "format": payload.format,
        "source": payload.source,
        "store_url": copy_store_url,
        "steam_appid": payload.steam_appid if steam_copy else None,
        "igdb_id": payload.igdb_id,
        "price": payload.price,
        "currency": payload.currency,
    }
    if existing is None:
        tags = [tag.strip() for tag in (payload.tags or "").split(",") if tag.strip()]
        if payload.is_dlc and "DLC" not in tags:
            tags.append("DLC")
        existing = Videogame(
            user_id=user.id, name=payload.name, description=payload.description, comments=payload.comments,
            image_url=payload.image_url, status=payload.status, playtime_hours=payload.playtime_hours,
            mark=payload.mark, hype=payload.hype, completion_date=payload.completion_date,
            publication_year=payload.publication_year, release_date=payload.release_date,
            completion_percentage=payload.completion_percentage, tags=", ".join(tags) or None,
            dlcs=payload.dlcs, is_dlc=payload.is_dlc, parent_game_name=payload.parent_game_name,
            copies=json.dumps([copy]),
        )
        db.add(existing)
        db.flush()
    else:
        copies = json.loads(existing.copies or "[]")
        identity = (copy["platform"].casefold(), copy["format"], copy["steam_appid"], copy["store_url"])
        if not any((str(item.get("platform", "")).casefold(), item.get("format", "Any"), item.get("steam_appid"), item.get("store_url")) == identity for item in copies):
            copies.append(copy)
            existing.copies = json.dumps(copies)
        for key in ("description", "comments", "image_url", "publication_year", "release_date", "dlcs", "parent_game_name"):
            if getattr(existing, key, None) in (None, "") and getattr(payload, key, None) not in (None, ""):
                setattr(existing, key, getattr(payload, key))
        existing.is_dlc = existing.is_dlc or payload.is_dlc
    if steam_copy and payload.steam_appid:
        link = db.query(SteamCollectionLink).filter_by(user_id=user.id, steam_appid=payload.steam_appid).first()
        if link is None:
            db.add(SteamCollectionLink(
                user_id=user.id, steam_appid=payload.steam_appid,
                collection_game_id=existing.id, igdb_id=payload.igdb_id,
            ))
        else:
            link.collection_game_id = existing.id
            if link.igdb_id is None:
                link.igdb_id = payload.igdb_id
    game.status, game.collection_game_id, game.steam_wishlist_missing, game.updated_at = "Acquired", existing.id, False, datetime.utcnow()
    commit(db)
    return {"collection_game_id": existing.id}


@router.get("/settings", response_model=SettingsResponse)
def read_settings(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return service.get_settings(db, user.id)


@router.get("/copy-options", response_model=CopyOptionsResponse)
def read_copy_options(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return copy_options(db, user.id)


@router.put("/copy-options", response_model=CopyOptionsResponse)
def save_copy_options(payload: CopyOptionsInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    db.query(CopyOption).filter_by(user_id=user.id).delete()
    for kind, values in (("platform", payload.platforms), ("source", payload.sources)):
        db.add_all(CopyOption(user_id=user.id, kind=kind, name=name, position=index) for index, name in enumerate(values))
    commit(db)
    return payload


@router.put("/settings", response_model=SettingsResponse)
def save_settings(payload: SettingsInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    settings = service.get_settings(db, user.id)
    steam_id = service.normalize_steam_id(payload.steam_id)
    if payload.sync_enabled and not steam_id:
        raise HTTPException(422, "Connect a Steam profile before enabling sync.")
    if payload.sync_enabled and not (payload.sync_wishlist or payload.sync_collection):
        raise HTTPException(422, "Choose wishlist sync, collection sync, or both before enabling automatic sync.")
    if settings.sync_started_at and settings.sync_started_at > datetime.utcnow() - service.timedelta(hours=1):
        raise HTTPException(409, "A Steam sync is running. Wait for it to finish before changing the connection.")
    changed = settings.steam_id != steam_id
    modes_changed = settings.sync_wishlist != payload.sync_wishlist or settings.sync_collection != payload.sync_collection
    enabled_now = payload.sync_enabled and not settings.sync_enabled
    settings.steam_id = steam_id
    settings.sync_enabled = payload.sync_enabled
    settings.sync_wishlist = payload.sync_wishlist
    settings.sync_collection = payload.sync_collection
    settings.sync_hours = payload.sync_hours
    settings.region = payload.region
    if payload.clear_steam_api_key:
        settings.steam_api_key = None
    elif payload.steam_api_key:
        settings.steam_api_key = payload.steam_api_key.strip()
    if changed:
        settings.last_sync_at, settings.sync_error, settings.last_import_count, settings.last_owned_import_count, settings.last_igdb_match_count = None, None, 0, 0, 0
        db.query(SteamMatchReview).filter_by(user_id=user.id).delete(synchronize_session=False)
    settings.next_sync_at = (datetime.utcnow() if changed or modes_changed or enabled_now or not settings.last_sync_at else settings.last_sync_at + service.timedelta(hours=settings.sync_hours)) if settings.sync_enabled else None
    commit(db)
    return settings


@router.post("/steam/sync", status_code=202)
def sync_now(background: BackgroundTasks, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    settings = service.get_settings(db, user.id)
    if not settings.steam_id:
        raise HTTPException(422, "Connect your public Steam profile in Discovery Admin first.")
    if not (settings.sync_wishlist or settings.sync_collection):
        raise HTTPException(422, "Choose wishlist sync, collection sync, or both in Admin first.")
    if not service.claim_sync(db, user.id, force=True):
        raise HTTPException(409, "A Steam sync is already running.")
    background.add_task(service.sync_steam, user.id)
    return {"message": "Steam sync started. You can leave this page; it runs on the server."}


@router.delete("/steam/imports")
def unsync_steam_imports(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    settings = service.get_settings(db, user.id)
    if settings.sync_started_at and settings.sync_started_at > datetime.utcnow() - service.timedelta(hours=1):
        raise HTTPException(409, "Wait for the current Steam sync to finish before removing its data.")
    result = service.remove_steam_imports(db, user.id)
    commit(db)
    return result


@router.get("/steam/reviews", response_model=list[SteamMatchReviewResponse])
def steam_match_reviews(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(SteamMatchReview).filter_by(user_id=user.id).order_by(
        SteamMatchReview.confidence.desc(), SteamMatchReview.created_at, SteamMatchReview.id
    ).all()
    return [service.steam_review_response(row) for row in rows]


@router.post("/steam/reviews/{review_id}")
def decide_steam_match(
    review_id: int, payload: SteamMatchDecision,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    result = service.resolve_steam_match_review(
        db, user.id, review_id, payload.decision, payload.candidate_game_id
    )
    commit(db)
    return result


@router.get("/timeline")
def timeline(region: str = Query("Europe", pattern="^(Europe|North America|Japan)$"), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = service.nintendo_releases(db, region)
    manual = db.query(PhysicalRelease).filter(PhysicalRelease.region == region, PhysicalRelease.release_date >= result["start"], PhysicalRelease.release_date < result["end"]).all()
    # An admin correction takes precedence over the source catalog for a title.
    overrides = {service.normalized(row.name) for row in manual}
    games = [game for game in result["games"] if service.normalized(game["name"]) not in overrides]
    games += [{"id": f"manual:{row.id}", "name": row.name, "release_date": row.release_date, "image_url": row.image_url,
               "source_url": row.source_url, "notes": row.notes, "region": row.region, "source": "Admin verified"} for row in manual]
    owned = {service.normalized(row.name) for row in db.query(Videogame).filter_by(user_id=user.id).all()}
    wanted = {service.normalized(row.name) for row in db.query(WantedGame).filter_by(user_id=user.id, deleted=False).all()}
    for game in games:
        game["owned"] = service.normalized(game["name"]) in owned
        game["saved"] = service.normalized(game["name"]) in wanted
    result["games"] = sorted(games, key=lambda game: (game["release_date"], game["name"]))
    return result


@router.get("/releases")
def list_releases(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    admin(user)
    return db.query(PhysicalRelease).order_by(PhysicalRelease.release_date.desc()).all()


@router.post("/releases", status_code=201)
def add_release(payload: ReleaseInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    admin(user)
    fields = payload.model_dump(mode="json")
    row = PhysicalRelease(**fields)
    db.add(row)
    commit(db)
    db.refresh(row)
    return row


@router.put("/releases/{release_id}")
def edit_release(release_id: int, payload: ReleaseInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    admin(user)
    row = db.get(PhysicalRelease, release_id)
    if not row:
        raise HTTPException(404, "Release not found")
    for key, value in payload.model_dump(mode="json").items():
        setattr(row, key, value)
    commit(db)
    return row


@router.delete("/releases/{release_id}", status_code=204)
def remove_release(release_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    admin(user)
    row = db.get(PhysicalRelease, release_id)
    if not row:
        raise HTTPException(404, "Release not found")
    db.delete(row)
    commit(db)


@router.get("/analytics")
def analytics(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    games = db.query(WantedGame).filter_by(user_id=user.id, deleted=False).all()
    active = [game for game in games if game.status != "Acquired"]
    budgets = {}
    for game in active:
        if game.target_price is not None:
            budgets[game.currency] = round(budgets.get(game.currency, 0) + game.target_price, 2)
    hype = [game.hype for game in active if game.hype is not None]
    return {"total": len(games), "active": len(active), "acquired": len(games) - len(active),
            "dlcs": sum(game.is_dlc for game in active), "nested_dlcs": sum(len(json.loads(game.dlcs or "[]")) for game in active),
            "average_hype": round(sum(hype) / len(hype), 1) if hype else None, "budgets": budgets,
            "by_platform": dict(Counter(game.platform or "Unspecified" for game in active)),
            "by_status": dict(Counter(game.status for game in games)), "by_source": dict(Counter(game.source for game in active)),
            "by_month": dict(sorted(Counter(game.created_at.strftime("%Y-%m") for game in games).items()))}
