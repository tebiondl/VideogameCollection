"""Explicit domain operations only. No filesystem, backups, secrets or admin routes."""
import hashlib
import json
from dataclasses import dataclass
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from .. import models, schemas
from ..integration_database import get_integration_db
from ..discovery_models import WantedGame
from ..discovery_schemas import WantedInput, WantedResponse
from ..integration_auth import IntegrationAccess, integration_access
from ..integration_models import IntegrationAudit
from ..services import copy_store
from . import videogames_router as vg, boardgames_router as bg, discovery_router as discovery

router = APIRouter(prefix="/api/integration/v1", tags=["integration"])
IntegrationDB = Depends(get_integration_db, scope="function")
Resource = Literal["videogames", "wanted_games", "boardgames", "boardgame_players", "boardgame_matches"]


@dataclass(frozen=True)
class ResourceSpec:
    model: type
    input: type[BaseModel]
    output: type[BaseModel]
    create: object
    update: object
    delete: object


RESOURCES = {
    "videogames": ResourceSpec(models.Videogame, schemas.VideogameCreate, schemas.VideogameResponse,
        lambda p, u, d: vg.create_videogame(p, u, d), lambda i, p, u, d: vg.update_videogame(i, p, u, d), lambda i, u, d: vg.delete_videogame(i, u, d)),
    "wanted_games": ResourceSpec(WantedGame, WantedInput, WantedResponse,
        lambda p, u, d: discovery.create_game(p, d, u), lambda i, p, u, d: discovery.edit_game(i, p, d, u), lambda i, u, d: discovery.delete_game(i, d, u)),
    "boardgames": ResourceSpec(models.Boardgame, schemas.BoardgameCreate, schemas.BoardgameResponse,
        lambda p, u, d: bg.create_boardgame(p, u, d), lambda i, p, u, d: bg.update_boardgame(i, p, u, d), lambda i, u, d: bg.delete_boardgame(i, u, d)),
    "boardgame_players": ResourceSpec(models.BoardgamePlayer, schemas.BoardgamePlayerCreate, schemas.BoardgamePlayerResponse,
        lambda p, u, d: bg.create_player(p, u, d), lambda i, p, u, d: bg.update_player(i, p, u, d), lambda i, u, d: bg.delete_player(i, u, d)),
    "boardgame_matches": ResourceSpec(models.BoardgameMatch, schemas.BoardgameMatchCreate, schemas.BoardgameMatchResponse,
        lambda p, u, d: bg.create_match(p, u, d), lambda i, p, u, d: bg.update_match(i, p, u, d), lambda i, u, d: bg.delete_match(i, u, d)),
}


class CreateRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: dict


class UpdateRecord(CreateRecord):
    expected_revision: str = Field(min_length=64, max_length=64)


class DeleteRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: str = Field(min_length=64, max_length=64)


def record_query(db, resource, user_id):
    spec = RESOURCES[resource]
    query = db.query(spec.model).filter(spec.model.user_id == user_id)
    if resource == "wanted_games":
        query = query.filter(WantedGame.deleted.is_(False))
    return query


def serialize(db, resource, row):
    if resource == "videogames":
        # Read the authoritative copy rows, without modifying or backfilling on a GET.
        result = schemas.VideogameResponse.model_validate(row).model_dump(mode="json")
        copies = db.query(copy_store.OwnedCopy).filter_by(user_id=row.user_id, collection_game_id=row.id).order_by(copy_store.OwnedCopy.position, copy_store.OwnedCopy.id).all()
        if copies:
            result["copies"] = json.dumps([copy_store.copy_dict(db, copy) for copy in copies])
    else:
        value = bg._match_response(row) if resource == "boardgame_matches" else bg._player_response(row) if resource == "boardgame_players" else row
        result = RESOURCES[resource].output.model_validate(value).model_dump(mode="json")
    # Native JSON arrays make copies/history easy for tools to inspect and edit.
    for field in ("copies", "old_copies", "dlcs", "expansions", "tags", "played_with"):
        if isinstance(result.get(field), str):
            try:
                result[field] = json.loads(result[field])
            except ValueError:
                pass  # Legacy comma-separated tags remain strings.
    revision = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {**result, "revision": revision}


def find_record(db, resource, user_id, record_id):
    row = record_query(db, resource, user_id).filter(RESOURCES[resource].model.id == record_id).first()
    if row is None:
        raise HTTPException(404, "Record not found in your collection.")
    return row


def lock_record(db, resource, user_id, record_id, revision):
    spec = RESOURCES[resource]
    # A no-op UPDATE acquires a write lock on SQLite too, closing the gap between
    # revision validation and the existing domain handler's commit.
    count = record_query(db, resource, user_id).filter(spec.model.id == record_id).update({spec.model.id: record_id}, synchronize_session=False)
    if count != 1:
        raise HTTPException(404, "Record not found in your collection.")
    db.expire_all()
    row = find_record(db, resource, user_id, record_id)
    before = serialize(db, resource, row)
    if before["revision"] != revision:
        raise HTTPException(409, "Record changed. Read it again and review the changes before retrying.")
    return row, before


def validated_data(resource, data):
    spec = RESOURCES[resource]
    unknown = set(data) - set(spec.input.model_fields)
    if unknown:
        raise HTTPException(422, f"Unsupported fields: {', '.join(sorted(unknown))}")
    values = dict(data)
    for field in ("copies", "old_copies", "dlcs", "expansions", "tags", "played_with"):
        if isinstance(values.get(field), list):
            values[field] = json.dumps(values[field])
    for field in ("mark", "hype"):
        if values.get(field) is not None and (type(values[field]) is not int or not 1 <= values[field] <= 10):
            raise HTTPException(422, f"{field} must be an integer from 1 to 10.")
    if "name" in values and (not isinstance(values["name"], str) or not values["name"].strip()):
        raise HTTPException(422, "Name cannot be empty.")
    try:
        return spec.input.model_validate(values)
    except ValidationError as error:
        raise HTTPException(422, json.loads(error.json(include_input=False, include_url=False))) from error


def audit(db, access, operation, resource, record_id=None, before=None, changes=None):
    row = IntegrationAudit(user_id=access.user.id, token_id=access.token.id,
        operation=operation, resource=resource, record_id=record_id,
        before_json=json.dumps(before) if before else None, changes_json=json.dumps(changes) if changes else None)
    db.add(row)
    return row


@router.get("/access")
def get_access(access: IntegrationAccess = Depends(integration_access)):
    return {"username": access.user.username, "mode": access.token.mode, "expires_at": access.token.expires_at.isoformat() + "Z", "resources": list(RESOURCES)}


@router.get("/options")
def get_options(access: IntegrationAccess = Depends(integration_access), db: Session = IntegrationDB):
    return discovery.copy_options(db, access.user.id)


@router.get("/schemas/{resource}")
def get_schema(resource: Resource, access: IntegrationAccess = Depends(integration_access)):
    return {"resource": resource, "schema": RESOURCES[resource].input.model_json_schema(), "notes": "JSON list fields also accept native arrays. Updates are partial and require the revision returned by get_record. IDs, user_id and revision are not editable."}


@router.get("/records/{resource}")
def list_records(resource: Resource, search: str = "", limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
                 min_rating: int | None = Query(None, ge=1, le=10), missing_platform: str | None = None,
                 missing_format: str | None = None, include_hidden: bool = False,
                 access: IntegrationAccess = Depends(integration_access), db: Session = IntegrationDB):
    spec = RESOURCES[resource]
    query = record_query(db, resource, access.user.id)
    if resource != "videogames" and (missing_platform is not None or missing_format is not None):
        raise HTTPException(422, "Missing-copy filters apply to videogames only.")
    if missing_format is not None and not missing_platform:
        raise HTTPException(422, "missing_format requires missing_platform.")
    if resource == "videogames":
        query = query.filter(models.Videogame.is_dlc.is_(False), models.Videogame.merged_into_game_id.is_(None))
        if not include_hidden:
            query = query.filter(models.Videogame.hidden.is_(False))
    if search:
        field = getattr(spec.model, "name", None)
        if field is None:
            raise HTTPException(422, "This resource does not have a searchable name.")
        query = query.filter(field.contains(search, autoescape=True))
    if min_rating is not None:
        field = getattr(spec.model, "mark", None)
        if field is None:
            raise HTTPException(422, "This resource does not have ratings.")
        query = query.filter(field >= min_rating)
    if hasattr(spec.model, "mark"):
        query = query.order_by(spec.model.mark.desc().nullslast(), spec.model.id)
    else:
        query = query.order_by(spec.model.id)
    # Filter before pagination. Never treat historical copies as owned copies.
    if missing_platform:
        matches = []
        for row in query:
            value = serialize(db, resource, row)
            if any(str(copy.get("platform", "")).strip().casefold() == missing_platform.strip().casefold()
                   and (missing_format is None or str(copy.get("format", "")).casefold() == missing_format.casefold())
                   for copy in value.get("copies") or []):
                continue
            matches.append(value)
        return {"items": matches[offset:offset + limit], "total": len(matches), "offset": offset, "limit": limit}
    total = query.count()
    return {"items": [serialize(db, resource, row) for row in query.offset(offset).limit(limit)], "total": total, "offset": offset, "limit": limit}


@router.get("/records/{resource}/{record_id}")
def get_record(resource: Resource, record_id: int, access: IntegrationAccess = Depends(integration_access), db: Session = IntegrationDB):
    return serialize(db, resource, find_record(db, resource, access.user.id, record_id))


@router.post("/records/{resource}", status_code=201)
def create_record(resource: Resource, body: CreateRecord, access: IntegrationAccess = Depends(integration_access), db: Session = IntegrationDB):
    payload = validated_data(resource, body.data)
    audit_row = audit(db, access, "create", resource, changes=body.data)
    result = RESOURCES[resource].create(payload, access.user, db)
    record_id = result["id"] if isinstance(result, dict) else result.id
    audit_row.record_id = record_id
    db.commit()
    return get_record(resource, record_id, access, db)


@router.patch("/records/{resource}/{record_id}")
def update_record(resource: Resource, record_id: int, body: UpdateRecord, access: IntegrationAccess = Depends(integration_access), db: Session = IntegrationDB):
    _, before = lock_record(db, resource, access.user.id, record_id, body.expected_revision)
    fields = RESOURCES[resource].input.model_fields
    # Wishlist/match handlers replace all fields; merging preserves unspecified data.
    values = {key: value for key, value in before.items() if key in fields}
    if "version" in body.data:
        raise HTTPException(422, "Use expected_revision; version cannot be edited.")
    values.update(body.data)
    payload = validated_data(resource, values)
    audit(db, access, "update", resource, record_id, before, body.data)
    RESOURCES[resource].update(record_id, payload, access.user, db)
    return get_record(resource, record_id, access, db)


@router.delete("/records/{resource}/{record_id}")
def delete_record(resource: Resource, record_id: int, body: DeleteRecord, access: IntegrationAccess = Depends(integration_access), db: Session = IntegrationDB):
    _, before = lock_record(db, resource, access.user.id, record_id, body.expected_revision)
    audit(db, access, "delete", resource, record_id, before)
    result = RESOURCES[resource].delete(record_id, access.user, db)
    if isinstance(result, dict) and result.get("game") is not None:
        result["game"] = serialize(db, resource, result["game"])
    return result or {"status": "deleted"}


@router.post("/videogames/{game_id}/copies/{copy_id}/move-to-history")
def move_copy(game_id: int, copy_id: str, body: DeleteRecord, access: IntegrationAccess = Depends(integration_access), db: Session = IntegrationDB):
    _, before = lock_record(db, "videogames", access.user.id, game_id, body.expected_revision)
    copies, old = before.get("copies") or [], before.get("old_copies") or []
    copy = next((copy for copy in copies if copy.get("id") == copy_id), None)
    if copy is None:
        raise HTTPException(404, "Owned copy not found.")
    if not str(copy.get("platform") or "").strip():
        raise HTTPException(422, "Choose a platform before moving this copy.")
    historical_id = copy_id if not any(item.get("id") == copy_id for item in old) else str(uuid4())
    changes = {"copies": [item for item in copies if item.get("id") != copy_id] or None,
               "old_copies": [*old, {**copy, "id": historical_id, "console": copy["platform"]}]}
    return update_record("videogames", game_id, UpdateRecord(data=changes, expected_revision=body.expected_revision), access, db)
