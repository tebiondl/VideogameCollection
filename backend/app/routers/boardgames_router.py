from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks, UploadFile, File, Form
from sqlalchemy.orm import Session
from typing import List, Annotated
import logging
import json
import os
from datetime import datetime
from xml.etree import ElementTree
import httpx
import pandas as pd
from openai import OpenAI
from dotenv import load_dotenv

from .. import schemas, models, database
from ..services.boardgame_excel_import import (
    MAX_WORKBOOK_BYTES,
    build_import_preview,
    commit_boardgame_import,
)
from ..services.boardgame_player_migration import (
    clean_player_name,
    get_or_create_player,
    normalize_player_name,
    parse_legacy_players,
)
from .auth_router import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/boardgames", tags=["boardgames"])


def _read_tag_names(raw_tags: str | None) -> tuple[list[str], bool]:
    if not raw_tags:
        return [], False
    try:
        decoded = json.loads(raw_tags)
        if isinstance(decoded, list) and all(isinstance(value, str) for value in decoded):
            return [value.strip() for value in decoded if value.strip()], True
    except (json.JSONDecodeError, TypeError):
        pass
    return [value.strip() for value in raw_tags.split(",") if value.strip()], False


def _write_tag_names(tag_names: list[str], as_json: bool) -> str | None:
    if not tag_names:
        return None
    return json.dumps(tag_names) if as_json else ",".join(tag_names)


def _has_tag(game: models.Boardgame, tag_name: str) -> bool:
    names, _ = _read_tag_names(game.tags)
    return any(name.casefold() == tag_name.casefold() for name in names)


def _replace_tag(game: models.Boardgame, old_name: str, new_name: str) -> bool:
    names, as_json = _read_tag_names(game.tags)
    replaced = False
    updated: list[str] = []
    seen: set[str] = set()
    for name in names:
        value = new_name if name.casefold() == old_name.casefold() else name
        replaced = replaced or name.casefold() == old_name.casefold()
        if value.casefold() not in seen:
            updated.append(value)
            seen.add(value.casefold())
    if replaced:
        game.tags = _write_tag_names(updated, as_json)
    return replaced


def _clean_tag_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail="Tag name cannot be empty")
    if "," in cleaned:
        raise HTTPException(status_code=422, detail="Tag names cannot contain commas")
    return cleaned


def _validate_library_section(section: str) -> str:
    if section not in {"wishlist", "owned", "external"}:
        raise HTTPException(status_code=422, detail="library_section must be 'wishlist', 'owned', or 'external'")
    return section


def _validate_match_payload(payload: schemas.BoardgameMatchBase) -> None:
    if payload.mode not in {"cooperative", "competitive", "solo"}:
        raise HTTPException(status_code=422, detail="Invalid match mode")
    if not payload.played_date:
        raise HTTPException(status_code=422, detail="A match date is required")
    try:
        datetime.strptime(payload.played_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="played_date must use YYYY-MM-DD")
    if payload.mode in {"cooperative", "solo"} and payload.result not in {"victory", "defeat"}:
        raise HTTPException(status_code=422, detail="Solo and cooperative matches require Victory or Defeat")
    if payload.mode == "competitive" and not (payload.winner_name or "").strip():
        raise HTTPException(status_code=422, detail="Competitive matches require a winner")


def _match_response(match: models.BoardgameMatch) -> dict:
    return {
        "id": match.id,
        "user_id": match.user_id,
        "boardgame_id": match.boardgame_id,
        "player_ids": [player.id for player in match.players],
        "played_with": match.played_with,
        "mode": match.mode,
        "result": match.result,
        "winner_name": match.winner_name,
        "comments": match.comments,
        "played_date": match.played_date,
        "game_name": match.boardgame.name,
        "game_image_url": match.boardgame.image_url,
        "game_tags": match.boardgame.tags,
        "players": match.players,
    }


def _resolve_match_players(
    payload: schemas.BoardgameMatchBase,
    user_id: int,
    db: Session,
) -> list[models.BoardgamePlayer]:
    requested_ids = list(dict.fromkeys(payload.player_ids))
    if requested_ids:
        players = db.query(models.BoardgamePlayer).filter(
            models.BoardgamePlayer.user_id == user_id,
            models.BoardgamePlayer.id.in_(requested_ids),
        ).all()
        if len(players) != len(requested_ids):
            raise HTTPException(status_code=422, detail="One or more selected players are invalid")
        by_id = {player.id: player for player in players}
        return [by_id[player_id] for player_id in requested_ids]
    return [get_or_create_player(db, user_id, name) for name in parse_legacy_players(payload.played_with)]


def _write_match_players(match: models.BoardgameMatch, players: list[models.BoardgamePlayer]) -> None:
    match.players = players
    match.played_with = json.dumps([player.name for player in players], ensure_ascii=False) if players else None


def _bgg_request(path: str, params: dict) -> ElementTree.Element:
    load_dotenv()
    token = os.getenv("BGG_API_TOKEN", "").strip()
    if not token:
        raise HTTPException(
            status_code=503,
            detail=(
                "BGG sync needs an application token. Set BGG_API_TOKEN after registering "
                "at boardgamegeek.com/applications, or enter the BGG fields manually."
            ),
        )
    try:
        response = httpx.get(
            f"https://boardgamegeek.com/xmlapi2/{path}",
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": "EpicTracker/1.0 (personal collection app)",
            },
            timeout=15,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"BGG is currently unavailable: {exc}")
    if response.status_code == 202:
        raise HTTPException(status_code=503, detail="BGG is preparing this result. Please try again in a few seconds.")
    if response.status_code == 401:
        raise HTTPException(
            status_code=503,
            detail="BGG rejected the application token. Check BGG_API_TOKEN, or enter the fields manually.",
        )
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail=f"BGG returned status {response.status_code}")
    try:
        return ElementTree.fromstring(response.content)
    except ElementTree.ParseError:
        raise HTTPException(status_code=502, detail="BGG returned an invalid response")

@router.get("/tags", response_model=List[schemas.BoardgameTagResponse])
def get_tags(
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    global_tags = db.query(models.BoardgameTag).filter(models.BoardgameTag.user_id == None).all()
    user_tags = db.query(models.BoardgameTag).filter(models.BoardgameTag.user_id == current_user.id).all()
    
    # Auto-seed if exactly empty
    if not global_tags and not user_tags:
        default_names = ["Card Game", "Deck Builder", "Worker Placement", "Party Game", "Legacy", "Abstract"]
        for name in default_names:
            tag = models.BoardgameTag(name=name, user_id=None)
            db.add(tag)
        db.commit()
        global_tags = db.query(models.BoardgameTag).filter(models.BoardgameTag.user_id == None).all()
        
    return global_tags + user_tags

@router.post("/tags/global", response_model=schemas.BoardgameTagResponse)
def create_global_tag(
    tag: schemas.BoardgameTagCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to create global tags")
        
    tag_name = _clean_tag_name(tag.name)
    existing = db.query(models.BoardgameTag).filter(models.BoardgameTag.user_id == None).all()
    if any(item.name.casefold() == tag_name.casefold() for item in existing):
        raise HTTPException(status_code=409, detail="A global tag with this name already exists")
    db_tag = models.BoardgameTag(name=tag_name, user_id=None)
    db.add(db_tag)
    db.commit()
    db.refresh(db_tag)
    return db_tag


@router.put("/tags/{tag_id}", response_model=schemas.BoardgameTagResponse)
def update_tag(
    tag_id: int,
    tag_update: schemas.BoardgameTagUpdate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_tag = db.query(models.BoardgameTag).filter(models.BoardgameTag.id == tag_id).first()
    if not db_tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if db_tag.user_id is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to edit global tags")
    if db_tag.user_id is not None and db_tag.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to edit this tag")

    new_name = _clean_tag_name(tag_update.name)
    siblings = db.query(models.BoardgameTag).filter(
        models.BoardgameTag.id != tag_id,
        models.BoardgameTag.user_id == db_tag.user_id,
    ).all()
    if any(item.name.casefold() == new_name.casefold() for item in siblings):
        raise HTTPException(status_code=409, detail="A tag with this name already exists")

    old_name = db_tag.name
    games_query = db.query(models.Boardgame)
    if db_tag.user_id is not None:
        games_query = games_query.filter(models.Boardgame.user_id == db_tag.user_id)
    for game in games_query.all():
        _replace_tag(game, old_name, new_name)
    db_tag.name = new_name
    db.commit()
    db.refresh(db_tag)
    return db_tag


@router.get("/tags/{tag_id}/usage", response_model=schemas.BoardgameTagUsageResponse)
def get_tag_usage(
    tag_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_tag = db.query(models.BoardgameTag).filter(models.BoardgameTag.id == tag_id).first()
    if not db_tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if db_tag.user_id is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to inspect this global tag")
    if db_tag.user_id is not None and db_tag.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to inspect this tag")

    query = db.query(models.Boardgame, models.User.username).join(models.User, models.User.id == models.Boardgame.user_id)
    if db_tag.user_id is not None:
        query = query.filter(models.Boardgame.user_id == db_tag.user_id)
    games = [{
        "id": game.id, "name": game.name, "user_id": game.user_id, "username": username,
        "image_url": game.image_url, "status": game.status,
    } for game, username in query.all() if _has_tag(game, db_tag.name)]
    return {"tag": db_tag, "games": games}


@router.post("/tags/{tag_id}/reassign", response_model=schemas.BoardgameTagResponse)
def reassign_and_delete_tag(
    tag_id: int,
    reassignment: schemas.BoardgameTagReassignment,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_tag = db.query(models.BoardgameTag).filter(models.BoardgameTag.id == tag_id).first()
    if not db_tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if db_tag.user_id is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to delete global tags")
    if db_tag.user_id is not None and db_tag.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this tag")

    replacement_name = _clean_tag_name(reassignment.replacement_name)
    if replacement_name.casefold() == db_tag.name.casefold():
        raise HTTPException(status_code=422, detail="Choose a different replacement tag")
    replacement_tag = next((item for item in db.query(models.BoardgameTag).filter(
        models.BoardgameTag.user_id == db_tag.user_id
    ).all() if item.id != tag_id and item.name.casefold() == replacement_name.casefold()), None)
    if replacement_tag is None:
        replacement_tag = models.BoardgameTag(name=replacement_name, user_id=db_tag.user_id)
        db.add(replacement_tag)
        db.flush()

    games_query = db.query(models.Boardgame)
    if db_tag.user_id is not None:
        games_query = games_query.filter(models.Boardgame.user_id == db_tag.user_id)
    for game in games_query.all():
        _replace_tag(game, db_tag.name, replacement_tag.name)
    db.delete(db_tag)
    db.commit()
    db.refresh(replacement_tag)
    return replacement_tag

@router.delete("/tags/{tag_id}")
def delete_tag(
    tag_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_tag = db.query(models.BoardgameTag).filter(models.BoardgameTag.id == tag_id).first()
    if not db_tag:
        raise HTTPException(status_code=404, detail="Tag not found")
        
    if db_tag.user_id is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to delete global tags")
    elif db_tag.user_id is not None and db_tag.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this tag")
        
    games_query = db.query(models.Boardgame)
    if db_tag.user_id is not None:
        games_query = games_query.filter(models.Boardgame.user_id == db_tag.user_id)
    if any(_has_tag(game, db_tag.name) for game in games_query.all()):
        raise HTTPException(status_code=409, detail="This tag is still assigned to games. Reassign those games before deleting it.")

    db.delete(db_tag)
    db.commit()
    return {"status": "ok"}


@router.get("/bgg/search", response_model=List[schemas.BggSearchResult])
def search_bgg(
    q: str,
    current_user: Annotated[models.User, Depends(get_current_user)],
):
    query = q.strip()
    if len(query) < 2:
        return []
    root = _bgg_request("search", {"query": query, "type": "boardgame,boardgameexpansion"})
    results = []
    for item in list(root.findall("item"))[:20]:
        name_node = item.find("name")
        year_node = item.find("yearpublished")
        if name_node is None:
            continue
        year_value = year_node.get("value") if year_node is not None else None
        results.append({
            "id": int(item.get("id", "0")),
            "name": name_node.get("value", "Unknown game"),
            "year_published": int(year_value) if year_value and year_value.isdigit() else None,
            "item_type": item.get("type"),
        })
    return results


@router.get("/bgg/{bgg_id}", response_model=schemas.BggGameMetadata)
def get_bgg_game(
    bgg_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
):
    root = _bgg_request("thing", {"id": bgg_id, "stats": 1})
    item = root.find("item")
    if item is None:
        raise HTTPException(status_code=404, detail="BGG game not found")
    primary_name = item.find("name[@type='primary']") or item.find("name")
    if primary_name is None:
        raise HTTPException(status_code=404, detail="BGG game has no title")
    year_node = item.find("yearpublished")
    description_node = item.find("description")
    image_node = item.find("image")
    thumbnail_node = item.find("thumbnail")
    rank_node = item.find("statistics/ratings/ranks/rank[@name='boardgame']")
    rank_value = rank_node.get("value") if rank_node is not None else None
    return {
        "id": int(item.get("id", bgg_id)),
        "name": primary_name.get("value", "Unknown game"),
        "description": description_node.text if description_node is not None else None,
        "image_url": image_node.text if image_node is not None else None,
        "thumbnail_url": thumbnail_node.text if thumbnail_node is not None else None,
        "year_published": int(year_node.get("value")) if year_node is not None and (year_node.get("value") or "").isdigit() else None,
        "rank": int(rank_value) if rank_value and rank_value.isdigit() else None,
        "bgg_link": f"https://boardgamegeek.com/boardgame/{bgg_id}",
        "is_expansion": item.get("type") == "boardgameexpansion",
    }


@router.get("/players", response_model=List[schemas.BoardgamePlayerResponse])
def get_players(
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    players = db.query(models.BoardgamePlayer).filter(
        models.BoardgamePlayer.user_id == current_user.id,
    ).order_by(models.BoardgamePlayer.name.asc()).all()
    return [_player_response(player) for player in players]


def _player_response(player: models.BoardgamePlayer) -> dict:
    return {
        "id": player.id,
        "user_id": player.user_id,
        "name": player.name,
        "normalized_name": player.normalized_name,
        "match_count": len(player.matches),
    }


def _get_owned_player(player_id: int, user_id: int, db: Session) -> models.BoardgamePlayer:
    player = db.query(models.BoardgamePlayer).filter(
        models.BoardgamePlayer.id == player_id,
        models.BoardgamePlayer.user_id == user_id,
    ).first()
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    return player


@router.post("/players", response_model=schemas.BoardgamePlayerResponse)
def create_player(
    payload: schemas.BoardgamePlayerCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    name = clean_player_name(payload.name)
    if not name:
        raise HTTPException(status_code=422, detail="Player name cannot be empty")
    player = get_or_create_player(db, current_user.id, name)
    db.commit()
    db.refresh(player)
    return _player_response(player)


@router.put("/players/{player_id}", response_model=schemas.BoardgamePlayerResponse)
def update_player(
    player_id: int,
    payload: schemas.BoardgamePlayerCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    player = _get_owned_player(player_id, current_user.id, db)
    name = clean_player_name(payload.name)
    normalized = normalize_player_name(name)
    if not normalized:
        raise HTTPException(status_code=422, detail="Player name cannot be empty")
    duplicate = db.query(models.BoardgamePlayer).filter(
        models.BoardgamePlayer.user_id == current_user.id,
        models.BoardgamePlayer.normalized_name == normalized,
        models.BoardgamePlayer.id != player_id,
    ).first()
    if duplicate:
        raise HTTPException(status_code=409, detail=f'A player named "{duplicate.name}" already exists')
    old_name = player.name
    player.name = name
    player.normalized_name = normalized
    for match in player.matches:
        match.played_with = json.dumps([entry.name if entry.id != player.id else name for entry in match.players], ensure_ascii=False)
        if match.winner_name and normalize_player_name(match.winner_name) == normalize_player_name(old_name):
            match.winner_name = name
    db.commit()
    db.refresh(player)
    return _player_response(player)


@router.get("/players/{player_id}/usage", response_model=schemas.BoardgamePlayerUsageResponse)
def get_player_usage(
    player_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    player = _get_owned_player(player_id, current_user.id, db)
    matches = sorted(player.matches, key=lambda match: (match.played_date or "", match.id), reverse=True)
    return {
        "player": _player_response(player),
        "matches": [{
            "id": match.id,
            "boardgame_id": match.boardgame_id,
            "game_name": match.boardgame.name,
            "played_date": match.played_date,
            "mode": match.mode,
            "winner_name": match.winner_name,
        } for match in matches],
    }


@router.post("/players/{player_id}/merge", response_model=schemas.BoardgamePlayerMergeResponse)
def merge_and_delete_player(
    player_id: int,
    merge: schemas.BoardgamePlayerMerge,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    source = _get_owned_player(player_id, current_user.id, db)
    replacement = _get_owned_player(merge.replacement_player_id, current_user.id, db)
    if source.id == replacement.id:
        raise HTTPException(status_code=422, detail="Choose a different replacement player")

    affected_matches = list(source.matches)
    source_name = source.name
    for match in affected_matches:
        merged_players: list[models.BoardgamePlayer] = []
        seen_ids: set[int] = set()
        for existing_player in match.players:
            next_player = replacement if existing_player.id == source.id else existing_player
            if next_player.id not in seen_ids:
                merged_players.append(next_player)
                seen_ids.add(next_player.id)
        match.players = merged_players
        match.played_with = json.dumps([player.name for player in merged_players], ensure_ascii=False) if merged_players else None
        if match.winner_name and normalize_player_name(match.winner_name) == normalize_player_name(source_name):
            match.winner_name = replacement.name

    db.delete(source)
    db.commit()
    db.refresh(replacement)
    return {"player": _player_response(replacement), "matches_transferred": len(affected_matches)}


@router.delete("/players/{player_id}")
def delete_player(
    player_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    player = _get_owned_player(player_id, current_user.id, db)
    if player.matches:
        raise HTTPException(status_code=409, detail="This player is used in matches. Merge them into another player before deleting.")
    db.delete(player)
    db.commit()
    return {"status": "ok"}


@router.get("/matches", response_model=List[schemas.BoardgameMatchResponse])
def get_matches(
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    matches = db.query(models.BoardgameMatch).filter(
        models.BoardgameMatch.user_id == current_user.id
    ).order_by(models.BoardgameMatch.played_date.desc(), models.BoardgameMatch.id.desc()).all()
    return [_match_response(match) for match in matches]


@router.post("/matches", response_model=schemas.BoardgameMatchResponse)
def create_match(
    payload: schemas.BoardgameMatchCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    _validate_match_payload(payload)
    game = db.query(models.Boardgame).filter(
        models.Boardgame.id == payload.boardgame_id,
        models.Boardgame.user_id == current_user.id,
    ).first()
    if not game:
        raise HTTPException(status_code=404, detail="Board game not found")
    players = _resolve_match_players(payload, current_user.id, db)
    match = models.BoardgameMatch(**payload.model_dump(exclude={"player_ids", "played_with"}), user_id=current_user.id)
    _write_match_players(match, players)
    if payload.mode != "competitive":
        match.winner_name = None
    else:
        match.result = "winner"
        match.winner_name = (payload.winner_name or "").strip()
    db.add(match)
    db.commit()
    db.refresh(match)
    return _match_response(match)


@router.put("/matches/{match_id}", response_model=schemas.BoardgameMatchResponse)
def update_match(
    match_id: int,
    payload: schemas.BoardgameMatchCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    _validate_match_payload(payload)
    match = db.query(models.BoardgameMatch).filter(
        models.BoardgameMatch.id == match_id,
        models.BoardgameMatch.user_id == current_user.id,
    ).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
    game = db.query(models.Boardgame).filter(
        models.Boardgame.id == payload.boardgame_id,
        models.Boardgame.user_id == current_user.id,
    ).first()
    if not game:
        raise HTTPException(status_code=404, detail="Board game not found")
    players = _resolve_match_players(payload, current_user.id, db)
    for key, value in payload.model_dump(exclude={"player_ids", "played_with"}).items():
        setattr(match, key, value)
    _write_match_players(match, players)
    if payload.mode != "competitive":
        match.winner_name = None
    else:
        match.result = "winner"
        match.winner_name = (payload.winner_name or "").strip()
    db.commit()
    db.refresh(match)
    return _match_response(match)


@router.delete("/matches/{match_id}")
def delete_match(
    match_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    match = db.query(models.BoardgameMatch).filter(
        models.BoardgameMatch.id == match_id,
        models.BoardgameMatch.user_id == current_user.id,
    ).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
    db.delete(match)
    db.commit()
    return {"status": "ok"}

@router.get("/", response_model=List[schemas.BoardgameResponse])
def get_boardgames(
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    games = db.query(models.Boardgame).filter(models.Boardgame.user_id == current_user.id).all()
    return games

@router.post("/", response_model=schemas.BoardgameResponse)
def create_boardgame(
    game: schemas.BoardgameCreate, 
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    payload = game.model_dump()
    payload["library_section"] = _validate_library_section(payload["library_section"])
    new_game = models.Boardgame(**payload, user_id=current_user.id)
    db.add(new_game)
    db.commit()
    db.refresh(new_game)
    return new_game


@router.post("/{expansion_id}/attach", response_model=schemas.BoardgameResponse)
def attach_wishlist_expansion(
    expansion_id: int,
    payload: schemas.BoardgameExpansionAttach,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    expansion = db.query(models.Boardgame).filter(
        models.Boardgame.id == expansion_id,
        models.Boardgame.user_id == current_user.id,
    ).first()
    if not expansion:
        raise HTTPException(status_code=404, detail="Expansion not found")
    if expansion.library_section != "wishlist" or not expansion.is_expansion:
        raise HTTPException(status_code=422, detail="Only wishlist expansions can be attached")

    parent = db.query(models.Boardgame).filter(
        models.Boardgame.id == payload.parent_game_id,
        models.Boardgame.user_id == current_user.id,
        models.Boardgame.library_section == "owned",
        models.Boardgame.is_expansion.is_(False),
    ).first()
    if not parent:
        raise HTTPException(status_code=404, detail="Owned base game not found")

    expansion_names, _ = _read_tag_names(parent.expansions)
    if not any(name.casefold() == expansion.name.casefold() for name in expansion_names):
        expansion_names.append(expansion.name)
    parent.expansions = json.dumps(expansion_names, ensure_ascii=False)
    db.delete(expansion)
    db.commit()
    db.refresh(parent)
    return parent

@router.put("/{game_id}", response_model=schemas.BoardgameResponse)
def update_boardgame(
    game_id: int,
    game_update: schemas.BoardgameCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_game = db.query(models.Boardgame).filter(
        models.Boardgame.id == game_id,
        models.Boardgame.user_id == current_user.id
    ).first()
    
    if not db_game:
        raise HTTPException(status_code=404, detail="Game not found or unauthorized")
        
    update_data = game_update.model_dump(exclude_unset=True)
    if "library_section" in update_data:
        update_data["library_section"] = _validate_library_section(update_data["library_section"])
    for key, value in update_data.items():
        setattr(db_game, key, value)
        
    db.commit()
    db.refresh(db_game)
    return db_game

@router.delete("/{game_id}")
def delete_boardgame(
    game_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_game = db.query(models.Boardgame).filter(
        models.Boardgame.id == game_id,
        models.Boardgame.user_id == current_user.id
    ).first()
    
    if not db_game:
        raise HTTPException(status_code=404, detail="Game not found or unauthorized")
        
    db.delete(db_game)
    db.commit()
    return {"status": "ok"}


async def _read_import_workbook(file: UploadFile) -> tuple[bytes, str]:
    filename = file.filename or "boardgames.xlsx"
    if not filename.casefold().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Please upload an .xlsx workbook")
    content = await file.read(MAX_WORKBOOK_BYTES + 1)
    if len(content) > MAX_WORKBOOK_BYTES:
        raise HTTPException(status_code=413, detail="The workbook is larger than 10 MB")
    return content, filename


@router.post("/bulk-import/preview")
async def preview_boardgame_workbook(
    current_user: Annotated[models.User, Depends(get_current_user)],
    file: UploadFile = File(...),
    db: Session = Depends(database.get_db),
):
    content, filename = await _read_import_workbook(file)
    try:
        return build_import_preview(content, filename, db, current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/bulk-import/commit")
async def commit_boardgame_workbook(
    current_user: Annotated[models.User, Depends(get_current_user)],
    file: UploadFile = File(...),
    db: Session = Depends(database.get_db),
):
    content, filename = await _read_import_workbook(file)
    try:
        return commit_boardgame_import(content, filename, db, current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

# --- Smart Import ---

def process_smart_import(session_id: int, files_payloads: List[dict]):
    db = database.SessionLocal()
    session = db.query(models.BoardgameSmartImportSession).filter(models.BoardgameSmartImportSession.id == session_id).first()
    if not session:
        db.close()
        return

    try:
        from dotenv import load_dotenv
        load_dotenv()
        raw_key = os.getenv("MOONSHOT_API_KEY")
        if not raw_key:
            raise Exception("MOONSHOT_API_KEY is not configured in .env")
        api_key = raw_key.strip()

        client = OpenAI(api_key=api_key, base_url="https://api.moonshot.ai/v1")

        system_instruction = (
            "You are a helpful data extraction assistant. "
            "FIRST, you MUST output your internal thought process inside <think>...</think> XML tags, explicitly explaining how you interpret the file and map it to our schema. "
            "THEN, respond strictly with a valid JSON array of objects wrapped in ```json ... ``` markdown. "
            "Each JSON object MUST contain these exact fields: "
            "'name' (string, required), 'description' (string or null), 'image_url' (string or null), 'status' (string, choices: 'Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'), "
            "'mark' (integer 1-10 or null), 'publication_year' (integer or null), 'tags' (string or null), "
            "'game_type' (string or null, e.g. 'competitive', 'cooperative', 'solo', can be comma separated combinations), 'bgg_link' (string or null). "
            "If the user specifies particular tags, use them. Comma separate tags. If status is unknown, default to 'Not Started'."
        )

        all_items = []
        raw_responses = []
        total_files = len(files_payloads)
        
        for i, payload in enumerate(files_payloads):
            file_name = payload["name"]
            file_text = payload["text"]
            file_prompt = payload.get("prompt", "")

            session.status = f"processing|{i + 1}/{total_files}|Initializing Moonshot stream for {file_name}..."
            db.commit()

            prompt = f"User Instructions:\n{file_prompt}\n\nFile Content:\n{file_text}"

            max_retries = 3
            collected_content = ""
            
            for attempt in range(max_retries):
                try:
                    response = client.chat.completions.create(
                        model="kimi-k2.5",
                        messages=[
                            {"role": "system", "content": system_instruction},
                            {"role": "user", "content": prompt},
                        ],
                        stream=True
                    )
                    chars_since_db_update = 0
                    for chunk in response:
                        if chunk.choices and getattr(chunk.choices[0], "delta", None):
                            delta = chunk.choices[0].delta
                            chunk_text = ""
                            if hasattr(delta, "reasoning_content") and getattr(delta, "reasoning_content"):
                                chunk_text = getattr(delta, "reasoning_content")
                            elif hasattr(delta, "content") and getattr(delta, "content"):
                                chunk_text = delta.content
                                
                            if chunk_text:
                                collected_content += chunk_text
                                chars_since_db_update += len(chunk_text)
                                if chars_since_db_update > 40:
                                    tail = collected_content[-1500:] if len(collected_content) > 1500 else collected_content
                                    session.status = f"processing|{i+1}/{total_files}|{tail}"
                                    db.commit()
                                    chars_since_db_update = 0
                    break
                except Exception as api_e:
                    error_str = str(api_e).lower()
                    if "429" in error_str or "overload" in error_str or "rate" in error_str:
                        if attempt < max_retries - 1:
                            import time
                            delay = (attempt + 1) * 6
                            session.status = f"processing|{i+1}/{total_files}|Moonshot Engine Overloaded. Retrying in {delay}s..."
                            db.commit()
                            time.sleep(delay)
                            continue
                    raise api_e

            content = collected_content.strip()
            raw_responses.append(f"--- RAW OUTPUT FOR {file_name} ---\n{content}\n")
            
            import re
            json_str = content
            json_match = re.search(r"```json\n(.*?)\n```", content, re.DOTALL)
            if json_match:
                json_str = json_match.group(1)
            else:
                fallback_match = re.search(r"```(.*?)```", content, re.DOTALL)
                if fallback_match:
                    json_str = fallback_match.group(1)

            try:
                data_list = json.loads(json_str.strip())
                all_items.extend(data_list)
            except Exception as parse_e:
                logger.error(f"Failed to parse JSON for {file_name}: {parse_e}")

        for item in all_items:
            new_item = models.BoardgameSmartImportItem(
                session_id=session_id,
                name=item.get("name") or "Unknown Boardgame",
                description=item.get("description"),
                image_url=item.get("image_url"),
                status=item.get("status") or "Not Started",
                mark=item.get("mark"),
                publication_year=item.get("publication_year"),
                tags=item.get("tags"),
                game_type=item.get("game_type"),
                bgg_link=item.get("bgg_link")
            )
            db.add(new_item)

        session.raw_ai_response = "\n".join(raw_responses)
        session.status = "pending_review"
        db.commit()

    except Exception as e:
        logger.error(f"Boardgame Smart Import Error: {e}")
        session.status = f"failed: {str(e)}"
        db.commit()
    finally:
        db.close()


@router.post("/smart-import", response_model=schemas.BoardgameSmartImportSessionResponse)
async def start_smart_import(
    background_tasks: BackgroundTasks,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
    config: str = Form(...),
    files: List[UploadFile] = File([]),
):
    if len(files) > 10:
        raise HTTPException(status_code=400, detail="Maximum 10 files allowed")

    try:
        config_data = json.loads(config)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid config JSON")

    new_session = models.BoardgameSmartImportSession(user_id=current_user.id, status="processing")
    db.add(new_session)
    db.commit()
    db.refresh(new_session)

    file_map = {f.filename: f for f in files}
    files_payloads = []

    for item in config_data:
        filename = item.get("filename")
        if filename not in file_map:
            continue
        
        upload_file = file_map[filename]
        file_type = item.get("type", "txt")
        prompt = item.get("prompt", "")
        
        if file_type in ("txt", "word", "csv"):
            text = ""
            name_lower = filename.lower()
            try:
                if name_lower.endswith(".csv"):
                    content = upload_file.file.read().decode("utf-8", errors="ignore")
                    has_cols = item.get("has_named_columns", True)
                    col_info = "The file has named columns." if has_cols else "The file does NOT have named columns."
                    text = f"--- [CSV Data] {col_info} ---\n{content}"
                elif name_lower.endswith((".doc", ".docx")):
                    import docx
                    doc = docx.Document(upload_file.file)
                    text = "\n".join([p.text for p in doc.paragraphs])
                else:
                    text = upload_file.file.read().decode("utf-8", errors="ignore")
            except Exception as e:
                logger.error(f"Error parsing {filename}: {e}")
                continue

            if text.strip():
                files_payloads.append({
                    "name": filename,
                    "text": text,
                    "prompt": prompt
                })

        elif file_type == "excel":
            read_independently = item.get("read_independently", False)
            sheets_config = item.get("sheets", [])
            selected_sheets = [s for s in sheets_config if s.get("selected")]
            
            if not selected_sheets:
                continue

            try:
                xl = pd.ExcelFile(upload_file.file)
                if read_independently:
                    for s in selected_sheets:
                        if s["name"] in xl.sheet_names:
                            df = xl.parse(s["name"])
                            sh_prompt = s.get("prompt") or prompt
                            files_payloads.append({
                                "name": f'{filename} - Sheet: {s["name"]}',
                                "text": df.to_csv(index=False),
                                "prompt": sh_prompt
                            })
                else:
                    combined_text = []
                    for s in selected_sheets:
                        if s["name"] in xl.sheet_names:
                            df = xl.parse(s["name"])
                            combined_text.append(f"--- Sheet: {s['name']} ---\n{df.to_csv(index=False)}")
                    if combined_text:
                        files_payloads.append({
                            "name": filename,
                            "text": "\n\n".join(combined_text),
                            "prompt": prompt
                        })
            except Exception as e:
                logger.error(f"Excel parsing error for {filename}: {e}")

    background_tasks.add_task(process_smart_import, new_session.id, files_payloads)
    return new_session

@router.get("/smart-import/latest", response_model=schemas.BoardgameSmartImportSessionResponse)
def get_latest_session(
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    latest = db.query(models.BoardgameSmartImportSession).filter(models.BoardgameSmartImportSession.user_id == current_user.id).order_by(models.BoardgameSmartImportSession.created_at.desc()).first()
    if not latest:
        raise HTTPException(status_code=404, detail="No sessions found")
    return latest

@router.put("/smart-import/items/{item_id}", response_model=schemas.BoardgameSmartImportItemResponse)
def update_item(
    item_id: int,
    item_update: schemas.BoardgameSmartImportItemUpdate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    item = db.query(models.BoardgameSmartImportItem).join(models.BoardgameSmartImportSession).filter(
        models.BoardgameSmartImportItem.id == item_id,
        models.BoardgameSmartImportSession.user_id == current_user.id,
    ).first()

    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    update_data = item_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(item, key, value)

    db.commit()
    db.refresh(item)
    return item

@router.post("/smart-import/commit/{session_id}")
def commit_session(
    session_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    session = db.query(models.BoardgameSmartImportSession).filter(
        models.BoardgameSmartImportSession.id == session_id,
        models.BoardgameSmartImportSession.user_id == current_user.id,
    ).first()

    if not session or session.status != "pending_review":
        raise HTTPException(status_code=400, detail="Invalid session mode")

    accepted_items = [i for i in session.items if i.review_status == "accepted"]

    for item in accepted_items:
        new_game = models.Boardgame(
            user_id=current_user.id,
            name=item.name,
            description=item.description,
            image_url=item.image_url,
            status=item.status,
            mark=item.mark,
            publication_year=item.publication_year,
            tags=item.tags,
            game_type=item.game_type,
            bgg_link=item.bgg_link
        )
        db.add(new_game)

    session.status = "completed"
    db.commit()

    return {"message": "Success", "games_added": len(accepted_items)}

@router.delete("/smart-import/sessions/{session_id}")
def cancel_session(
    session_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    session = db.query(models.BoardgameSmartImportSession).filter(
        models.BoardgameSmartImportSession.id == session_id,
        models.BoardgameSmartImportSession.user_id == current_user.id,
    ).first()

    if not session:
        raise HTTPException(status_code=404)

    db.delete(session)
    db.commit()
    return {"status": "ok"}
