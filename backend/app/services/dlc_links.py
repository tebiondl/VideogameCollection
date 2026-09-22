"""Keep standalone DLC cards and their parent game's nested DLC row in sync."""

import json
import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Videogame


NESTED_TO_GAME_STATUS = {
    "not_owned": "Not Started",
    "not_started": "Not Started",
    "playing": "Playing",
    "finished": "Finished",
    "stopped": "Stopped",
}
GAME_TO_NESTED_STATUS = {
    "Playing": "playing",
    "Finished": "finished",
    "Stopped": "stopped",
}


def _items(game: Videogame) -> list[dict]:
    try:
        values = json.loads(game.dlcs or "[]")
    except (TypeError, ValueError):
        return []
    return [value for value in values if isinstance(value, dict)] if isinstance(values, list) else []


def _save(game: Videogame, values: list[dict]) -> None:
    game.dlcs = json.dumps(values) if values else None


def _title(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").casefold()).strip()


def _steam_appids(game: Videogame) -> set[int]:
    try:
        copies = json.loads(game.copies or "[]")
    except (TypeError, ValueError):
        return set()
    return {
        int(copy["steam_appid"])
        for copy in copies
        if isinstance(copy, dict) and copy.get("steam_appid")
    }


def nested_state_for(game: Videogame) -> str:
    return GAME_TO_NESTED_STATUS.get(game.status, "not_started")


def validate_parent(db: Session, child: Videogame) -> Videogame | None:
    if not child.parent_game_id:
        return None
    parent = db.query(Videogame).filter_by(
        id=child.parent_game_id, user_id=child.user_id, hidden=False,
    ).first()
    if parent is None or parent.merged_into_game_id is not None:
        raise HTTPException(422, "Choose an available parent game from your collection.")
    if parent.id == child.id:
        raise HTTPException(422, "A DLC cannot be its own parent game.")
    cursor = parent
    seen = {child.id}
    while cursor and cursor.parent_game_id:
        if cursor.id in seen or cursor.parent_game_id == child.id:
            raise HTTPException(422, "This parent selection would create a DLC cycle.")
        seen.add(cursor.id)
        cursor = db.query(Videogame).filter_by(
            id=cursor.parent_game_id, user_id=child.user_id,
        ).first()
    return parent


def sync_child_to_parent(db: Session, child: Videogame, previous_parent_id: int | None = None) -> None:
    """Link one standalone card into exactly one parent DLC list."""
    parent = validate_parent(db, child) if child.is_dlc else None
    selected_parent_id = parent.id if parent else None

    # Remove the navigation marker from the former parent without deleting its
    # ordinary DLC row.
    old_parent_ids = {value for value in (previous_parent_id, child.parent_game_id) if value}
    for parent_id in old_parent_ids - ({selected_parent_id} if selected_parent_id else set()):
        old_parent = db.query(Videogame).filter_by(id=parent_id, user_id=child.user_id).first()
        if old_parent:
            values = _items(old_parent)
            changed = False
            for value in values:
                if value.get("standalone_game_id") == child.id:
                    value.pop("standalone_game_id", None)
                    changed = True
            if changed:
                _save(old_parent, values)

    if parent is None:
        child.parent_game_id = None
        if not child.is_dlc:
            child.parent_game_name = None
        return

    child.parent_game_name = parent.name
    values = _items(parent)
    appids = _steam_appids(child)
    linked = next((value for value in values if value.get("standalone_game_id") == child.id), None)
    if linked is None and appids:
        linked = next((value for value in values if value.get("steam_appid") in appids), None)
    if linked is None:
        child_title = _title(child.name)
        linked = next((value for value in values if _title(value.get("name")) == child_title), None)
    if linked is None:
        linked = {"name": child.name}
        values.append(linked)
    linked["standalone_game_id"] = child.id
    linked["state"] = nested_state_for(child)
    _save(parent, values)


def sync_parent_to_children(db: Session, parent: Videogame) -> None:
    """Apply parent-side DLC state changes to linked standalone cards."""
    values = _items(parent)
    for value in values:
        child_id = value.get("standalone_game_id")
        if not child_id:
            continue
        child = db.query(Videogame).filter_by(id=child_id, user_id=parent.user_id).first()
        if child is None or child.id == parent.id:
            value.pop("standalone_game_id", None)
            continue
        child.is_dlc = True
        child.parent_game_id = parent.id
        child.parent_game_name = parent.name
        child.status = NESTED_TO_GAME_STATUS.get(value.get("state"), child.status)
    linked_ids = {value.get("standalone_game_id") for value in values}
    for child in db.query(Videogame).filter_by(user_id=parent.user_id, parent_game_id=parent.id).all():
        if child.id in linked_ids:
            continue
        values.append({
            "name": child.name,
            "state": nested_state_for(child),
            "standalone_game_id": child.id,
        })
    _save(parent, values)


def detach_game(db: Session, game: Videogame) -> None:
    """Remove navigation links before deleting a parent or standalone DLC."""
    if game.parent_game_id:
        parent = db.query(Videogame).filter_by(id=game.parent_game_id, user_id=game.user_id).first()
        if parent:
            values = _items(parent)
            for value in values:
                if value.get("standalone_game_id") == game.id:
                    value.pop("standalone_game_id", None)
            _save(parent, values)
    for child in db.query(Videogame).filter_by(user_id=game.user_id, parent_game_id=game.id).all():
        child.parent_game_id = None
        child.parent_game_name = game.name
