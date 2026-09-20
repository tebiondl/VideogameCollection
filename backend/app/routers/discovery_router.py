import json
from uuid import uuid4
from collections import Counter
from datetime import datetime
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func
from ..database import get_db
from ..models import AppSetting, User, Videogame
from ..discovery_models import (
    WantedGame, PhysicalRelease, CopyOption, CopyCompatibility, SteamCollectionLink, SteamCopyTrash,
    SteamMatchReview, SteamOwnedGame, SteamContentLink, GameMergeRedirect, SteamAuditLog,
)
from ..discovery_schemas import (
    WantedInput, WantedResponse, AcquireInput, BatchInput, SettingsInput, SettingsResponse,
    CopyOptionsInput, CopyOptionsResponse, ReleaseInput, SteamMatchReviewResponse,
    SteamMatchDecision, SteamGameLinkInput, CollectionDuplicateInput,
)
from ..services import discovery as service
from ..services import copy_store
from ..services.secrets import protect_secret, reveal_secret
from .auth_router import get_current_user

router = APIRouter(prefix="/api/discovery", tags=["discovery"])

DEFAULT_COPY_OPTIONS = {
    "platforms": ["PC", "Nintendo Switch", "Nintendo Switch 2", "PlayStation 5", "PlayStation 4", "Xbox Series X|S", "Xbox One", "Steam Deck"],
    "sources": ["Steam", "Nintendo eShop", "PlayStation Store", "Xbox Store", "Retail", "Gift", "Subscription", "Other"],
    "types": ["Any", "Physical", "Digital"],
    "old_consoles": ["PC", "Nintendo Switch", "Nintendo Switch 2", "Nintendo 3DS", "Nintendo DS", "Game Boy Advance", "Game Boy Color", "Game Boy", "Wii U", "Wii", "GameCube", "Nintendo 64", "Super Nintendo", "NES", "PlayStation 5", "PlayStation 4", "PlayStation 3", "PlayStation 2", "PlayStation", "PS Vita", "PSP", "Xbox Series X|S", "Xbox One", "Xbox 360", "Xbox", "Steam Deck", "Sega Dreamcast", "Sega Saturn", "Sega Mega Drive / Genesis", "Other"],
}

DEFAULT_PLATFORM_SOURCES = {
    "PC": ["Steam", "Xbox Store", "Retail", "Gift", "Subscription", "Other"],
    "Nintendo Switch": ["Nintendo eShop", "Retail", "Other"],
    "Nintendo Switch 2": ["Nintendo eShop", "Retail", "Other"],
    "PlayStation 5": ["PlayStation Store", "Retail", "Gift", "Subscription", "Other"],
    "PlayStation 4": ["PlayStation Store", "Retail", "Gift", "Subscription", "Other"],
    "Xbox Series X|S": ["Xbox Store", "Retail", "Gift", "Subscription", "Other"],
    "Xbox One": ["Xbox Store", "Retail", "Gift", "Subscription", "Other"],
    "Steam Deck": ["Steam", "Gift", "Subscription", "Other"],
}
DEFAULT_SOURCE_TYPES = {
    "Steam": ["Digital"], "Nintendo eShop": ["Digital"], "PlayStation Store": ["Digital"],
    "Xbox Store": ["Digital"], "Retail": ["Physical"], "Subscription": ["Digital"],
    "Gift": ["Any", "Physical", "Digital"], "Other": ["Any", "Physical", "Digital"],
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
    # Copy vocabularies are system configuration. Prefer the configured admin's
    # rows so every user sees the same dropdowns and compatibility rules.
    owner_marker = db.query(AppSetting).filter_by(key="copy_configuration_owner_id").first()
    try:
        owner_id = int(owner_marker.value) if owner_marker else None
    except (TypeError, ValueError):
        owner_id = None
    if owner_id is None:
        configured_admin = db.query(CopyOption.user_id).join(User, User.id == CopyOption.user_id).filter(
            User.is_admin.is_(True)
        ).order_by(CopyOption.user_id).first()
        owner_id = configured_admin[0] if configured_admin else user_id
    rows = db.query(CopyOption).filter_by(user_id=owner_id).order_by(CopyOption.position, CopyOption.id).all()
    has_admin_compatibility_config = any(row.kind in ("type", "old_console") for row in rows)
    result = {"platforms": [], "sources": [], "types": [], "old_consoles": []}
    for row in rows:
        target = "old_consoles" if row.kind == "old_console" else f"{row.kind}s"
        if target in result:
            result[target].append(row.name)
    result = {key: result[key] or values for key, values in DEFAULT_COPY_OPTIONS.items()}
    rules = db.query(CopyCompatibility).filter_by(user_id=owner_id).order_by(
        CopyCompatibility.position, CopyCompatibility.id
    ).all()
    platform_sources = {platform: [] for platform in result["platforms"]}
    source_types = {source: [] for source in result["sources"]}
    for rule in rules:
        target = platform_sources if rule.relation == "platform_source" else source_types
        if rule.left_name in target:
            target[rule.left_name].append(rule.right_name)
    if not any(platform_sources.values()) and not has_admin_compatibility_config:
        platform_sources = {platform: [source for source in DEFAULT_PLATFORM_SOURCES.get(platform, result["sources"]) if source in result["sources"]] for platform in result["platforms"]}
    if not any(source_types.values()) and not has_admin_compatibility_config:
        source_types = {source: [copy_type for copy_type in DEFAULT_SOURCE_TYPES.get(source, result["types"]) if copy_type in result["types"]] for source in result["sources"]}
    return {**result, "platform_sources": platform_sources, "source_types": source_types}


@router.get("/games", response_model=list[WantedResponse])
def list_games(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return db.query(WantedGame).filter_by(user_id=user.id, deleted=False).order_by(WantedGame.created_at.desc(), WantedGame.id.desc()).all()


@router.post("/games", response_model=WantedResponse, status_code=201)
def create_game(payload: WantedInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    fields = payload.model_dump()
    if fields.get("steam_appid"):
        fields["steam_id"] = copy_store.steam_scope(db, user.id)
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
        if fields.get("steam_appid"):
            fields["steam_id"] = copy_store.steam_scope(db, user.id)
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
    game.steam_id = copy_store.steam_scope(db, user.id) if game.steam_appid else None
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
    if payload.is_dlc:
        if not payload.parent_game_id:
            raise HTTPException(422, "Choose the collection game that this expansion belongs to.")
        parent = db.query(Videogame).filter_by(id=payload.parent_game_id, user_id=user.id, is_dlc=False).first()
        if parent is None:
            raise HTTPException(404, "The selected base game is no longer in the collection.")
        try:
            dlcs = json.loads(parent.dlcs or "[]")
        except (TypeError, ValueError):
            dlcs = []
        entry = next((row for row in dlcs if payload.steam_appid and row.get("steam_appid") == payload.steam_appid), None)
        if entry is None:
            entry = next((row for row in dlcs if service.normalized(row.get("name")) == service.normalized(payload.name)), None)
        if entry is None:
            entry = {"name": payload.name, "state": "not_started"}
            dlcs.append(entry)
        entry.update({
            "steam_appid": payload.steam_appid, "igdb_id": payload.igdb_id,
            "platform": payload.platform, "format": payload.format, "source": payload.source,
            "store_url": payload.store_url, "price": payload.price, "currency": payload.currency,
            "playtime_hours": payload.playtime_hours, "image_url": payload.image_url,
        })
        parent.dlcs = json.dumps(dlcs)
        if payload.steam_appid:
            scope = copy_store.steam_scope(db, user.id)
            content = db.query(SteamContentLink).filter_by(
                user_id=user.id, steam_id=scope, steam_appid=payload.steam_appid,
            ).first()
            if content is None:
                content = SteamContentLink(
                    user_id=user.id, steam_id=scope, steam_appid=payload.steam_appid,
                    parent_game_id=parent.id, name=payload.name,
                )
                db.add(content)
            content.parent_game_id, content.name = parent.id, payload.name
            content.igdb_id, content.user_selected = payload.igdb_id, True
            db.query(SteamCopyTrash).filter_by(
                user_id=user.id, steam_id=scope, steam_appid=payload.steam_appid, kind="dlc",
            ).delete(synchronize_session=False)
            copy_store.record_audit(
                db, user.id, "dlc_parent_selected", steam_id=scope,
                steam_appid=payload.steam_appid, game_id=parent.id,
            )
        game.status, game.collection_game_id = "Acquired", parent.id
        game.steam_wishlist_missing, game.updated_at = False, datetime.utcnow()
        commit(db)
        return {"collection_game_id": parent.id}
    existing = db.query(Videogame).filter_by(id=game.collection_game_id, user_id=user.id).first() if game.collection_game_id else None
    if existing is None:
        existing = next((row for row in db.query(Videogame).filter_by(user_id=user.id, hidden=False, is_dlc=False).all() if not row.merged_into_game_id and service.normalized(row.name) == service.normalized(payload.name)), None)
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
        "name": payload.name,
        "platform": payload.platform,
        "format": payload.format,
        "source": payload.source,
        "store_url": copy_store_url,
        "steam_appid": payload.steam_appid if steam_copy else None,
        "igdb_id": payload.igdb_id,
        "price": payload.price,
        "currency": payload.currency,
    }
    scope = copy_store.steam_scope(db, user.id)
    steam_catalog = db.query(SteamOwnedGame).filter_by(user_id=user.id, steam_id=scope, steam_appid=payload.steam_appid, active=True).first() if steam_copy and payload.steam_appid else None
    if steam_catalog:
        copy.update({"name": steam_catalog.name, "source": "Steam", "playtime_hours": steam_catalog.playtime_hours})
    if existing is None:
        tags = [tag.strip() for tag in (payload.tags or "").split(",") if tag.strip()]
        if payload.is_dlc and "DLC" not in tags:
            tags.append("DLC")
        existing = Videogame(
            user_id=user.id, name=payload.name, description=payload.description, comments=payload.comments,
            image_url=payload.image_url, status=payload.status, playtime_hours=payload.playtime_hours,
            playtime_mode="copies" if steam_copy and payload.playtime_hours is None else "user",
            mark=payload.mark, hype=payload.hype, completion_date=payload.completion_date,
            publication_year=payload.publication_year, release_date=payload.release_date,
            completion_percentage=payload.completion_percentage, tags=", ".join(tags) or None,
            dlcs=payload.dlcs, is_dlc=payload.is_dlc, parent_game_name=payload.parent_game_name,
            igdb_id=payload.igdb_id, user_modified_at=datetime.utcnow(),
        )
        db.add(existing)
        db.flush()
    if steam_copy and payload.steam_appid:
        service.attach_steam_copy(db, existing, {
            "appid": payload.steam_appid,
            "name": steam_catalog.name if steam_catalog else payload.name,
            "playtime_hours": steam_catalog.playtime_hours if steam_catalog else payload.playtime_hours,
            "store_url": steam_catalog.store_url if steam_catalog else payload.store_url,
            "igdb_id": payload.igdb_id,
        }, payload.igdb_id, steam_id=scope)
        owned_copy = db.query(SteamCollectionLink).filter_by(
            user_id=user.id, steam_id=scope, collection_game_id=existing.id,
            steam_appid=payload.steam_appid,
        ).one()
        owned_copy.user_selected = True
        db.query(SteamCopyTrash).filter_by(
            user_id=user.id, steam_id=scope, steam_appid=payload.steam_appid, kind="copy",
        ).delete(synchronize_session=False)
        copy_store.record_audit(
            db, user.id, "copy_linked", steam_id=scope, steam_appid=payload.steam_appid,
            game_id=existing.id, copy_id=owned_copy.copy_id, details={"source": "wanted_acquisition"},
        )
    else:
        copies = copy_store.project_game(db, existing, copy_store.ensure_copies(db, existing))
        identity = (copy["platform"].casefold(), copy["format"], copy["steam_appid"], copy["store_url"])
        matched_copy = next((item for item in copies if (
            str(item.get("platform", "")).casefold(), item.get("format", "Any"),
            item.get("steam_appid"), item.get("store_url")
        ) == identity), None)
        if matched_copy is None:
            copies.append(copy)
            copy_store.replace_from_payload(db, existing, copies)
        else:
            copy = matched_copy
    if existing is not None:
        for key in ("description", "comments", "image_url", "publication_year", "release_date", "dlcs", "parent_game_name"):
            if getattr(existing, key, None) in (None, "") and getattr(payload, key, None) not in (None, ""):
                setattr(existing, key, getattr(payload, key))
        existing.is_dlc = existing.is_dlc or payload.is_dlc
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
    admin(user)
    owner_marker = db.query(AppSetting).filter_by(key="copy_configuration_owner_id").first()
    if owner_marker is None:
        db.add(AppSetting(key="copy_configuration_owner_id", value=str(user.id)))
    else:
        owner_marker.value = str(user.id)
    db.query(CopyOption).filter_by(user_id=user.id).delete()
    db.query(CopyCompatibility).filter_by(user_id=user.id).delete()
    for kind, values in (("platform", payload.platforms), ("source", payload.sources), ("type", payload.types), ("old_console", payload.old_consoles)):
        db.add_all(CopyOption(user_id=user.id, kind=kind, name=name, position=index) for index, name in enumerate(values))
    for relation, mapping, left_values, right_values in (
        ("platform_source", payload.platform_sources, payload.platforms, payload.sources),
        ("source_type", payload.source_types, payload.sources, payload.types),
    ):
        allowed_left, allowed_right = set(left_values), set(right_values)
        for left_position, left in enumerate(left_values):
            for right_position, right in enumerate(mapping.get(left, [])):
                if left not in allowed_left or right not in allowed_right:
                    raise HTTPException(422, f"Unknown value in {relation.replace('_', ' ')} mapping.")
                db.add(CopyCompatibility(
                    user_id=user.id, relation=relation, left_name=left, right_name=right,
                    position=left_position * 1000 + right_position,
                ))
    commit(db)
    return copy_options(db, user.id)


@router.put("/settings", response_model=SettingsResponse)
def save_settings(payload: SettingsInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    settings = service.get_settings(db, user.id)
    previous_steam_id = settings.steam_id or ""
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
        settings.steam_api_key = protect_secret(payload.steam_api_key.strip())
    if changed:
        if previous_steam_id:
            for wanted in db.query(WantedGame).filter_by(user_id=user.id, steam_id=previous_steam_id).all():
                if service.normalized(wanted.source) == "steam":
                    wanted.deleted = True
                wanted.steam_appid = None
                wanted.steam_id = None
        settings.last_sync_at, settings.sync_error, settings.last_import_count, settings.last_owned_import_count, settings.last_igdb_match_count = None, None, 0, 0, 0
        db.query(SteamMatchReview).filter_by(user_id=user.id, steam_id=steam_id or "").delete(synchronize_session=False)
        copy_store.record_audit(
            db, user.id, "steam_account_changed", steam_id=steam_id or "",
            details={"previous_steam_id": previous_steam_id or None},
        )
    settings.next_sync_at = (datetime.utcnow() if changed or modes_changed or enabled_now or not settings.last_sync_at else settings.last_sync_at + service.timedelta(hours=settings.sync_hours)) if settings.sync_enabled else None
    commit(db)
    return settings


@router.post("/steam/sync", status_code=202)
def sync_now(background: BackgroundTasks, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    settings = service.get_settings(db, user.id)
    if not settings.steam_id:
        raise HTTPException(422, "Connect your public Steam profile in User Settings first.")
    if not (settings.sync_wishlist or settings.sync_collection):
        raise HTTPException(422, "Choose wishlist sync, collection sync, or both in User Settings first.")
    if settings.sync_collection:
        try:
            configured_key = reveal_secret(settings.steam_api_key)
        except Exception:
            raise HTTPException(422, "The saved Steam Web API key cannot be read. Enter it again in User Settings.")
        if not configured_key:
            raise HTTPException(422, "Collection sync needs a Steam Web API key. Add one in User Settings, or turn off collection sync.")
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
    rows = db.query(SteamMatchReview).filter_by(user_id=user.id, steam_id=copy_store.steam_scope(db, user.id)).order_by(
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


@router.get("/steam/collection-games/{game_id}/copies/{copy_id}/candidates")
def steam_link_candidates(game_id: int, copy_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    game = db.query(Videogame).filter_by(id=game_id, user_id=user.id, is_dlc=False).first()
    if game is None:
        raise HTTPException(404, "Collection game not found.")
    copy_store.ensure_copies(db, game)
    scope = copy_store.adopt_legacy_scope(db, user.id)
    row_copy = db.query(SteamCollectionLink).filter_by(
        user_id=user.id, collection_game_id=game.id, copy_id=copy_id,
    ).first()
    owned_copy = copy_store.copy_dict(db, row_copy) if row_copy else None
    if owned_copy is None:
        raise HTTPException(404, "Save this copy before linking it to Steam.")
    current = row_copy if row_copy and row_copy.steam_appid else None
    linked_counts = dict(db.query(SteamCollectionLink.steam_appid, func.count(SteamCollectionLink.id)).filter_by(
        user_id=user.id, steam_id=scope
    ).group_by(SteamCollectionLink.steam_appid).all())
    rows = db.query(SteamOwnedGame).filter_by(user_id=user.id, steam_id=scope, is_dlc=False, active=True).all()
    candidates = []
    for row in rows:
        score = service.SequenceMatcher(None, service._collection_title_key(game.name), service._collection_title_key(row.name)).ratio()
        candidates.append({
            "steam_appid": row.steam_appid, "name": row.name, "playtime_hours": row.playtime_hours,
            "image_url": row.image_url, "store_url": row.store_url, "similarity": round(score, 4),
            "current": bool(current and current.steam_appid == row.steam_appid),
            "linked_collection_count": int(linked_counts.get(row.steam_appid, 0)),
            "duplicate_of_appid": row.duplicate_of_appid,
        })
    candidates.sort(key=lambda row: (not row["current"], -row["similarity"], row["name"].casefold()))
    return {"current_steam_appid": current.steam_appid if current else None, "copy": owned_copy, "candidates": candidates}


@router.post("/steam/collection-games/{game_id}/copies/{copy_id}/link")
def link_collection_game_to_steam(
    game_id: int, copy_id: str, payload: SteamGameLinkInput,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    game = db.query(Videogame).filter_by(id=game_id, user_id=user.id, is_dlc=False).first()
    if game is not None:
        copy_store.ensure_copies(db, game)
    scope = copy_store.adopt_legacy_scope(db, user.id)
    steam = db.query(SteamOwnedGame).filter_by(user_id=user.id, steam_id=scope, steam_appid=payload.steam_appid, active=True).first()
    if game is None or steam is None:
        raise HTTPException(404, "The collection or Steam game is no longer available.")
    current = db.query(SteamCollectionLink).filter_by(
        user_id=user.id, collection_game_id=game.id, copy_id=copy_id,
    ).first()
    if current is None:
        raise HTTPException(404, "Save this copy before linking it to Steam.")
    collision = db.query(SteamCollectionLink).filter_by(
        user_id=user.id, steam_id=scope, collection_game_id=game.id,
        steam_appid=steam.steam_appid,
    ).filter(SteamCollectionLink.id != current.id).first()
    if collision:
        raise HTTPException(409, "This Steam game is already linked to another copy on this collection card.")
    old_appid, old_scope = current.steam_appid, current.steam_id
    if old_appid and (old_appid != steam.steam_appid or old_scope != scope):
        copy_store.suppress_copy(db, game, current, reason="link_changed")
    has_counted_link = db.query(SteamCollectionLink).filter_by(
        user_id=user.id, steam_id=scope, steam_appid=steam.steam_appid,
        counts_toward_totals=True,
    ).filter(SteamCollectionLink.id != current.id).first()
    current.steam_id, current.steam_appid, current.igdb_id = scope, steam.steam_appid, steam.igdb_id
    current.user_selected = True
    current.created_collection_game = False
    current.name, current.platform, current.format, current.source = steam.name, "PC", "Digital", "Steam"
    current.playtime_hours, current.store_url = steam.playtime_hours, steam.store_url
    current.counts_toward_totals = not bool(has_counted_link) or bool(
        old_appid == steam.steam_appid and old_scope == scope and current.counts_toward_totals
    )
    db.query(SteamCopyTrash).filter_by(
        user_id=user.id, steam_id=scope, steam_appid=steam.steam_appid,
        collection_game_id=game.id, kind="copy",
    ).delete(synchronize_session=False)
    copy_store.project_game(db, game)
    copy_store.record_audit(
        db, user.id, "copy_link_changed" if old_appid else "copy_linked",
        steam_id=scope, steam_appid=steam.steam_appid, game_id=game.id, copy_id=copy_id,
        details={"previous_steam_appid": old_appid},
    )
    commit(db)
    db.refresh(game)
    return game


@router.post("/steam/collection-games/{game_id}/merge-duplicate")
def merge_collection_duplicate(
    game_id: int, payload: CollectionDuplicateInput,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    current_game = db.query(Videogame).filter_by(id=game_id, user_id=user.id, is_dlc=False).first()
    other_game = db.query(Videogame).filter_by(id=payload.other_game_id, user_id=user.id, is_dlc=False).first()
    if current_game is None or other_game is None:
        raise HTTPException(404, "One of the collection games is no longer available.")
    if current_game.id == other_game.id:
        raise HTTPException(422, "Choose a different collection game.")

    if payload.direction == "current_into_other":
        duplicate_game, retained_game = current_game, other_game
    else:
        duplicate_game, retained_game = other_game, current_game

    merge_fields = (
        "description", "comments", "image_url", "status", "playtime_hours", "playtime_mode",
        "mark", "hype", "completion_date", "publication_year", "release_date",
        "completion_percentage", "tags", "dlcs", "old_copies", "reviewed", "igdb_id",
    )
    for field in merge_fields:
        default_source = "current" if retained_game.id == current_game.id else "other"
        source_name = payload.field_sources.get(field, default_source)
        source_game = current_game if source_name == "current" else other_game
        setattr(retained_game, field, getattr(source_game, field))

    duplicate_rows = copy_store.ensure_copies(db, duplicate_game)
    retained_rows = copy_store.ensure_copies(db, retained_game)
    if not duplicate_rows:
        raise HTTPException(409, f"{duplicate_game.name} has no copies to merge.")

    retained_appids = {row.steam_appid for row in retained_rows if row.steam_appid}
    duplicate_appids = {row.steam_appid for row in duplicate_rows if row.steam_appid}
    overlap = retained_appids & duplicate_appids
    if overlap:
        raise HTTPException(409, "Both collection games already contain the same Steam copy.")

    used_ids = {row.copy_id for row in retained_rows}
    copy_id_map = {}
    for owned_copy in retained_rows:
        if not owned_copy.name:
            owned_copy.name = retained_game.name
    next_position = len(retained_rows)
    for owned_copy in duplicate_rows:
        old_id = owned_copy.copy_id
        new_id = old_id
        while new_id in used_ids:
            new_id = f"copy:{uuid4().hex}"
        used_ids.add(new_id)
        copy_id_map[old_id] = new_id
        owned_copy.copy_id = new_id
        # Preserve the first card this copy was merged from. If cards are
        # merged repeatedly, undo should still recover the copy's own card.
        if owned_copy.merged_from_game_id is None:
            owned_copy.merged_from_game_id = duplicate_game.id
        owned_copy.collection_game_id = retained_game.id
        owned_copy.position = next_position
        next_position += 1
        if not owned_copy.name:
            owned_copy.name = duplicate_game.name
        if owned_copy.steam_appid:
            owned_copy.created_collection_game = False
            owned_copy.user_selected = True

    all_rows = retained_rows + duplicate_rows
    steam_rows = [row for row in all_rows if row.steam_appid]
    if steam_rows:
        available_appids = {row.steam_appid for row in steam_rows}
        if payload.primary_steam_appid and payload.primary_steam_appid not in available_appids:
            raise HTTPException(422, "Choose a primary Steam copy that belongs to one of these games.")
        retained_primary = next((row.steam_appid for row in retained_rows if row.steam_appid), None)
        primary_appid = payload.primary_steam_appid or retained_primary or min(available_appids)
        scope = copy_store.steam_scope(db, user.id)
        for link in steam_rows:
            catalog = db.query(SteamOwnedGame).filter_by(
                user_id=user.id, steam_id=link.steam_id or scope, steam_appid=link.steam_appid,
            ).first()
            if catalog:
                catalog.duplicate_of_appid = None if link.steam_appid == primary_appid else primary_appid

    db.flush()
    copy_store.project_game(db, retained_game, all_rows)
    retained_game.hidden = False
    copy_store.project_game(db, duplicate_game, [])
    duplicate_game.hidden = True
    duplicate_game.merged_into_game_id = retained_game.id
    redirect = db.query(GameMergeRedirect).filter_by(user_id=user.id, merged_game_id=duplicate_game.id).first()
    if redirect is None:
        redirect = GameMergeRedirect(
            user_id=user.id, merged_game_id=duplicate_game.id, retained_game_id=retained_game.id,
        )
        db.add(redirect)
    else:
        redirect.retained_game_id = retained_game.id
    for suppression in db.query(SteamCopyTrash).filter_by(
        user_id=user.id, collection_game_id=duplicate_game.id,
    ).all():
        suppression.collection_game_id = retained_game.id
        suppression.collection_game_name = retained_game.name
        suppression.copy_id = copy_id_map.get(suppression.copy_id, suppression.copy_id)
    db.query(SteamContentLink).filter_by(user_id=user.id, parent_game_id=duplicate_game.id).update(
        {"parent_game_id": retained_game.id}, synchronize_session=False,
    )
    db.query(WantedGame).filter_by(user_id=user.id, collection_game_id=duplicate_game.id).update(
        {"collection_game_id": retained_game.id}, synchronize_session=False
    )
    for review in db.query(SteamMatchReview).filter_by(user_id=user.id, candidate_game_id=duplicate_game.id).all():
        review.candidate_game_id = retained_game.id
        review.candidate_name = retained_game.name
    copy_store.record_audit(
        db, user.id, "games_merged", game_id=retained_game.id,
        details={"merged_game_id": duplicate_game.id, "primary_steam_appid": payload.primary_steam_appid},
    )

    commit(db)
    db.refresh(retained_game)
    return {"collection_game": retained_game, "duplicate_game_id": duplicate_game.id}


@router.post("/steam/collection-games/{game_id}/copies/{copy_id}/restore-duplicate")
def restore_duplicate_copy(
    game_id: int, copy_id: str,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    source_game = db.query(Videogame).filter_by(
        id=game_id, user_id=user.id, is_dlc=False,
    ).first()
    if source_game is None:
        raise HTTPException(404, "Collection game not found.")

    owned_copy = db.query(SteamCollectionLink).filter_by(
        user_id=user.id, collection_game_id=source_game.id, copy_id=copy_id,
    ).first()
    if owned_copy is None or not owned_copy.steam_appid:
        raise HTTPException(404, "Linked Steam copy not found.")

    scope = owned_copy.steam_id or copy_store.steam_scope(db, user.id)
    catalog = db.query(SteamOwnedGame).filter_by(
        user_id=user.id, steam_id=scope, steam_appid=owned_copy.steam_appid,
    ).first()
    if catalog is None:
        raise HTTPException(409, "The Steam game is no longer available in the synced account.")
    if catalog.duplicate_of_appid is None and owned_copy.merged_from_game_id is None:
        raise HTTPException(409, "This copy is not recorded as a merged duplicate.")

    original_game = None
    if owned_copy.merged_from_game_id:
        candidate = db.query(Videogame).filter_by(
            id=owned_copy.merged_from_game_id, user_id=user.id, is_dlc=False,
        ).first()
        # Reuse the exact source card while it has not subsequently been
        # merged into some unrelated game. It retains the user's old fields.
        if candidate and candidate.id != source_game.id and candidate.merged_into_game_id in (None, source_game.id):
            original_game = candidate

    if original_game is None:
        original_game = Videogame(
            user_id=user.id,
            name=catalog.name,
            image_url=catalog.image_url,
            status="Not Started",
            playtime_mode="copies",
            igdb_id=catalog.igdb_id,
            hidden=False,
        )
        db.add(original_game)
        db.flush()
    else:
        original_game.name = catalog.name
        original_game.hidden = False
        original_game.merged_into_game_id = None
        original_game.version = (original_game.version or 1) + 1

    target_rows = copy_store.ensure_copies(db, original_game)
    if any(row.steam_appid == owned_copy.steam_appid for row in target_rows):
        raise HTTPException(409, "The restored game already contains this Steam copy.")
    used_ids = {row.copy_id for row in target_rows}
    while owned_copy.copy_id in used_ids:
        owned_copy.copy_id = f"copy:{uuid4().hex}"

    owned_copy.collection_game_id = original_game.id
    owned_copy.position = len(target_rows)
    owned_copy.name = catalog.name
    owned_copy.platform = "PC"
    owned_copy.format = "Digital"
    owned_copy.source = "Steam"
    owned_copy.store_url = catalog.store_url
    owned_copy.igdb_id = catalog.igdb_id
    owned_copy.playtime_hours = catalog.playtime_hours
    owned_copy.created_collection_game = False
    owned_copy.user_selected = True
    owned_copy.merged_from_game_id = None
    owned_copy.updated_at = datetime.utcnow()
    catalog.duplicate_of_appid = None
    catalog.updated_at = datetime.utcnow()

    remaining_rows = db.query(SteamCollectionLink).filter_by(
        user_id=user.id, collection_game_id=source_game.id,
    ).filter(SteamCollectionLink.id != owned_copy.id).order_by(
        SteamCollectionLink.position, SteamCollectionLink.id,
    ).all()
    for position, row in enumerate(remaining_rows):
        row.position = position

    db.query(GameMergeRedirect).filter_by(
        user_id=user.id, merged_game_id=original_game.id, retained_game_id=source_game.id,
    ).delete(synchronize_session=False)
    db.query(WantedGame).filter_by(
        user_id=user.id, steam_id=scope, steam_appid=owned_copy.steam_appid,
    ).update({"collection_game_id": original_game.id}, synchronize_session=False)
    for suppression in db.query(SteamCopyTrash).filter_by(
        user_id=user.id, steam_id=scope, steam_appid=owned_copy.steam_appid,
        collection_game_id=source_game.id,
    ).all():
        suppression.collection_game_id = original_game.id
        suppression.collection_game_name = original_game.name

    db.flush()
    copy_store.project_game(db, source_game, remaining_rows)
    copy_store.project_game(db, original_game, target_rows + [owned_copy])
    source_game.version = (source_game.version or 1) + 1
    copy_store.record_audit(
        db, user.id, "duplicate_copy_restored", steam_id=scope,
        steam_appid=owned_copy.steam_appid, game_id=original_game.id,
        copy_id=owned_copy.copy_id, details={"restored_from_game_id": source_game.id},
    )
    commit(db)
    db.refresh(source_game)
    db.refresh(original_game)
    return {"source_game": source_game, "restored_game": original_game}


@router.get("/steam/trash")
def steam_copy_trash(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    scope = copy_store.steam_scope(db, user.id)
    catalog = {row.steam_appid: row for row in db.query(SteamOwnedGame).filter_by(user_id=user.id, steam_id=scope).all()}
    result = []
    for row in db.query(SteamCopyTrash).filter_by(user_id=user.id, steam_id=scope).order_by(SteamCopyTrash.deleted_at.desc()).all():
        steam = catalog.get(row.steam_appid)
        result.append({
            "id": row.id, "steam_appid": row.steam_appid, "name": row.name,
            "image_url": row.image_url or (steam.image_url if steam else None),
            "collection_game_name": row.collection_game_name,
            "playtime_hours": steam.playtime_hours if steam else None,
            "owned_on_steam": bool(steam and steam.active), "deleted_at": row.deleted_at,
            "kind": row.kind, "copy_id": row.copy_id,
        })
    return result


@router.get("/steam/audit")
def steam_audit(limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    scope = copy_store.steam_scope(db, user.id)
    rows = db.query(SteamAuditLog).filter_by(user_id=user.id, steam_id=scope).order_by(
        SteamAuditLog.created_at.desc(), SteamAuditLog.id.desc(),
    ).limit(limit).all()
    return [{
        "id": row.id, "action": row.action, "steam_appid": row.steam_appid,
        "collection_game_id": row.collection_game_id, "copy_id": row.copy_id,
        "details": json.loads(row.details) if row.details else None,
        "created_at": row.created_at,
    } for row in rows]


@router.get("/steam/integrity")
def steam_integrity(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return copy_store.integrity_report(db, user.id)


@router.post("/steam/integrity/repair")
def repair_steam_integrity(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = copy_store.integrity_report(db, user.id, repair=True)
    copy_store.record_audit(db, user.id, "integrity_repaired", details=result)
    commit(db)
    return copy_store.integrity_report(db, user.id)


@router.post("/steam/trash/{trash_id}/restore")
def restore_steam_copy(trash_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = db.query(SteamCopyTrash).filter_by(
        id=trash_id, user_id=user.id, steam_id=copy_store.steam_scope(db, user.id),
    ).first()
    if row is None:
        raise HTTPException(404, "Trashed Steam copy not found.")
    steam = db.query(SteamOwnedGame).filter_by(
        user_id=user.id, steam_id=row.steam_id, steam_appid=row.steam_appid, active=True,
    ).first()
    if steam is None:
        raise HTTPException(409, "This game is not in the latest Steam library snapshot. Run a sync before restoring it.")
    target_game_id = copy_store.resolve_game_id(db, user.id, row.collection_game_id)
    game = db.query(Videogame).filter_by(id=target_game_id, user_id=user.id, is_dlc=False).first()
    if row.kind == "dlc" and game is None:
        game = service.find_parent_game(
            db.query(Videogame).filter_by(user_id=user.id, is_dlc=False, hidden=False).all(),
            steam.parent_game_name,
        )
        if game is None:
            raise HTTPException(409, "Choose this DLC's parent from Doubtful Steam matches before restoring it.")
    if game is None:
        try:
            snapshot = json.loads(row.game_data or "{}")
        except (TypeError, ValueError):
            snapshot = {}
        allowed = {
            "name", "description", "comments", "image_url", "status", "playtime_hours",
            "playtime_mode", "mark", "hype", "completion_date", "publication_year",
            "release_date", "completion_percentage", "tags", "dlcs", "old_copies", "hidden", "reviewed", "igdb_id",
        }
        fields = {key: value for key, value in snapshot.items() if key in allowed}
        fields.update({"name": fields.get("name") or row.collection_game_name or row.name,
                       "is_dlc": False, "copies": None, "hidden": False})
        game = Videogame(user_id=user.id, **fields)
        db.add(game)
        db.flush()
    if row.kind == "dlc":
        try:
            item = json.loads(row.copy_data or "{}")
        except (TypeError, ValueError):
            raise HTTPException(409, "The trashed DLC data is invalid.")
        service.attach_owned_dlc(game, {
            **item, "appid": row.steam_appid, "name": steam.name,
            "playtime_hours": steam.playtime_hours, "store_url": steam.store_url,
            "igdb_id": steam.igdb_id,
        })
        link = db.query(SteamContentLink).filter_by(
            user_id=user.id, steam_id=row.steam_id, steam_appid=row.steam_appid,
        ).first()
        if link is None:
            link = SteamContentLink(
                user_id=user.id, steam_id=row.steam_id, steam_appid=row.steam_appid,
                parent_game_id=game.id, name=steam.name,
            )
            db.add(link)
        link.parent_game_id, link.igdb_id, link.user_selected = game.id, steam.igdb_id, True
        db.delete(row)
        copy_store.record_audit(
            db, user.id, "dlc_restored", steam_id=row.steam_id,
            steam_appid=row.steam_appid, game_id=game.id,
        )
        commit(db)
        return game
    try:
        saved_copy = json.loads(row.copy_data)
    except (TypeError, ValueError):
        raise HTTPException(409, "The trashed copy data is invalid.")
    existing = db.query(SteamCollectionLink).filter_by(
        user_id=user.id, steam_id=row.steam_id, collection_game_id=game.id,
        steam_appid=row.steam_appid,
    ).first()
    if existing is None:
        used_ids = {copy.copy_id for copy in copy_store.ensure_copies(db, game)}
        copy_id = str(saved_copy.get("id") or f"steam:{row.steam_appid}")
        while copy_id in used_ids:
            copy_id = f"copy:{uuid4().hex}"
        existing = SteamCollectionLink(
            user_id=user.id, steam_id=row.steam_id, steam_appid=row.steam_appid,
            collection_game_id=game.id, copy_id=copy_id,
            position=len(used_ids), counts_toward_totals=copy_store.next_shared_playtime_flag(
                db, user.id, row.steam_id, row.steam_appid,
            ),
        )
        db.add(existing)
    else:
        copy_id = existing.copy_id
    existing.name, existing.platform, existing.format, existing.source = steam.name, "PC", "Digital", "Steam"
    existing.playtime_hours, existing.store_url, existing.igdb_id = steam.playtime_hours, steam.store_url, steam.igdb_id
    existing.user_selected = True
    db.flush()
    copy_store.project_game(db, game)
    db.delete(row)
    copy_store.record_audit(
        db, user.id, "copy_restored", steam_id=row.steam_id,
        steam_appid=row.steam_appid, game_id=game.id, copy_id=copy_id,
    )
    commit(db)
    db.refresh(game)
    return game


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
