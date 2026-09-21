"""Authoritative owned-copy storage and its backwards-compatible JSON projection."""
from __future__ import annotations

import json
from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..discovery_models import (
    DiscoverySettings,
    GameMergeRedirect,
    OwnedCopy,
    SteamAuditLog,
    SteamContentLink,
    SteamCopyTrash,
    SteamOwnedGame,
)
from ..models import Videogame


COPY_FIELDS = (
    "name", "platform", "format", "source", "store_url", "igdb_id", "price",
    "currency", "playtime_hours",
)


def steam_scope(db: Session, user_id: int) -> str:
    settings = db.get(DiscoverySettings, user_id)
    return settings.steam_id if settings and settings.steam_id else ""


def adopt_legacy_scope(db: Session, user_id: int) -> str:
    """Attach pre-account-scoping Steam rows to the user's current account once."""
    scope = steam_scope(db, user_id)
    if not scope:
        return scope
    db.query(OwnedCopy).filter_by(user_id=user_id, steam_id="").filter(
        OwnedCopy.steam_appid.is_not(None)
    ).update({"steam_id": scope}, synchronize_session=False)
    for model in (SteamOwnedGame, SteamCopyTrash, SteamContentLink):
        db.query(model).filter_by(user_id=user_id, steam_id="").update(
            {"steam_id": scope}, synchronize_session=False,
        )
    # Match reviews also existed before account scoping, but importing it here
    # would create a circular model import; update through its mapped table.
    from ..discovery_models import SteamMatchReview
    db.query(SteamMatchReview).filter_by(user_id=user_id, steam_id="").update(
        {"steam_id": scope}, synchronize_session=False,
    )
    return scope


def record_audit(
    db: Session, user_id: int, action: str, *, steam_id: str | None = None,
    steam_appid: int | None = None, game_id: int | None = None,
    copy_id: str | None = None, details: dict | None = None,
) -> SteamAuditLog:
    row = SteamAuditLog(
        user_id=user_id, steam_id=steam_id if steam_id is not None else steam_scope(db, user_id),
        action=action, steam_appid=steam_appid, collection_game_id=game_id,
        copy_id=copy_id, details=json.dumps(details, ensure_ascii=False) if details else None,
    )
    db.add(row)
    return row


def resolve_game_id(db: Session, user_id: int, game_id: int) -> int:
    """Follow merge redirects so trash, wishlist and DLC targets never revive hidden cards."""
    seen: set[int] = set()
    current = game_id
    while current and current not in seen:
        seen.add(current)
        redirect = db.query(GameMergeRedirect).filter_by(user_id=user_id, merged_game_id=current).order_by(
            GameMergeRedirect.id.desc()
        ).first()
        if redirect is None:
            return current
        current = redirect.retained_game_id
    return current


def _legacy_items(game: Videogame) -> list[dict]:
    try:
        values = json.loads(game.copies or "[]")
    except (TypeError, ValueError):
        return []
    return values if isinstance(values, list) else []


def ensure_copies(db: Session, game: Videogame) -> list[OwnedCopy]:
    rows = db.query(OwnedCopy).filter_by(user_id=game.user_id, collection_game_id=game.id).order_by(
        OwnedCopy.position, OwnedCopy.id
    ).all()
    scope = steam_scope(db, game.user_id)
    by_id = {row.copy_id: row for row in rows}
    by_app = {row.steam_appid: row for row in rows if row.steam_appid}
    seen_ids: set[str] = set(by_id)
    seen_apps: set[int] = set(by_app)
    for position, value in enumerate(_legacy_items(game)):
        if not isinstance(value, dict):
            continue
        copy_id = str(value.get("id") or f"copy:{uuid4().hex}")
        appid = int(value.get("steam_appid") or 0) or None
        row = by_id.get(copy_id) or (by_app.get(appid) if appid else None)
        if row is not None:
            # Finish partially migrated rows without replacing relational values.
            for field in COPY_FIELDS:
                if getattr(row, field) in (None, "") and value.get(field) not in (None, ""):
                    setattr(row, field, value.get(field))
            if not row.steam_id and appid:
                row.steam_id = scope
            continue
        while copy_id in seen_ids:
            copy_id = f"copy:{uuid4().hex}"
        seen_ids.add(copy_id)
        if appid in seen_apps:
            appid = None
        if appid:
            seen_apps.add(appid)
        row = OwnedCopy(
            user_id=game.user_id, collection_game_id=game.id, copy_id=copy_id,
            position=position, name=value.get("name"), platform=str(value.get("platform") or ""),
            format=str(value.get("format") or "Any"), source=value.get("source"),
            store_url=value.get("store_url"), igdb_id=value.get("igdb_id"),
            price=value.get("price"), currency=value.get("currency") or "EUR",
            playtime_hours=value.get("playtime_hours"), steam_id=scope if appid else "",
            steam_appid=appid, counts_toward_totals=bool(value.get("counts_toward_totals", True)),
        )
        db.add(row)
        rows.append(row)
    if rows:
        db.flush()
        project_game(db, game, rows)
    return rows


def copy_dict(db: Session, row: OwnedCopy) -> dict:
    result = {
        "id": row.copy_id, "name": row.name, "platform": row.platform,
        "format": row.format, "source": row.source, "store_url": row.store_url,
        "igdb_id": row.igdb_id, "price": row.price, "currency": row.currency,
        "playtime_hours": row.playtime_hours,
        "steam_appid": row.steam_appid,
        "merged_from_game_id": row.merged_from_game_id,
        "counts_toward_totals": bool(row.counts_toward_totals),
    }
    if row.steam_appid:
        entitlement = db.query(SteamOwnedGame).filter_by(
            user_id=row.user_id, steam_id=row.steam_id, steam_appid=row.steam_appid,
        ).first()
        if entitlement:
            result.update({
                "name": entitlement.name, "platform": "PC", "format": "Digital", "source": "Steam",
                "store_url": entitlement.store_url or result.get("store_url"),
                "igdb_id": entitlement.igdb_id or result.get("igdb_id"),
                "playtime_hours": entitlement.playtime_hours
                if entitlement.playtime_hours is not None else result.get("playtime_hours"),
                "steam_active": bool(entitlement.active),
                "duplicate_of_appid": entitlement.duplicate_of_appid,
            })
    return result


def project_game(db: Session, game: Videogame, rows: list[OwnedCopy] | None = None) -> list[dict]:
    if rows is None:
        rows = db.query(OwnedCopy).filter_by(user_id=game.user_id, collection_game_id=game.id).order_by(
            OwnedCopy.position, OwnedCopy.id
        ).all()
    values = [copy_dict(db, row) for row in rows]
    game.copies = json.dumps(values) if values else None
    return values


def _snapshot(game: Videogame) -> str:
    fields = (
        "name", "description", "comments", "image_url", "status", "playtime_hours",
        "playtime_mode", "mark", "hype", "completion_date", "publication_year",
        "release_date", "completion_percentage", "tags", "dlcs", "old_copies", "hidden", "reviewed", "igdb_id",
    )
    return json.dumps({key: getattr(game, key, None) for key in fields})


def suppress_copy(db: Session, game: Videogame, row: OwnedCopy, *, reason: str = "deleted") -> SteamCopyTrash | None:
    if not row.steam_appid:
        return None
    # Build the complete snapshot before adding the required suppression row;
    # otherwise the entitlement lookup inside copy_dict can trigger an early
    # autoflush of a half-populated NOT NULL record.
    value = copy_dict(db, row)
    game_snapshot = _snapshot(game)
    target = db.query(SteamCopyTrash).filter_by(
        user_id=game.user_id, steam_id=row.steam_id, steam_appid=row.steam_appid,
        collection_game_id=game.id, copy_id=row.copy_id, kind="copy",
    ).first()
    if target is None:
        target = SteamCopyTrash(
            user_id=game.user_id, steam_id=row.steam_id, steam_appid=row.steam_appid,
            name=row.name or game.name, collection_game_id=game.id,
            copy_id=row.copy_id, kind="copy", copy_data=json.dumps(value),
            game_data=game_snapshot,
        )
        db.add(target)
    target.name = value.get("name") or game.name
    entitlement = db.query(SteamOwnedGame).filter_by(
        user_id=game.user_id, steam_id=row.steam_id, steam_appid=row.steam_appid,
    ).first()
    target.image_url = (entitlement.image_url if entitlement else None) or game.image_url
    target.collection_game_name = game.name
    target.copy_data = json.dumps(value)
    target.game_data = game_snapshot
    target.deleted_at = datetime.utcnow()
    record_audit(
        db, game.user_id, "copy_suppressed", steam_id=row.steam_id,
        steam_appid=row.steam_appid, game_id=game.id, copy_id=row.copy_id,
        details={"reason": reason, "game_name": game.name},
    )
    return target


def replace_from_payload(db: Session, game: Videogame, values: list[dict]) -> list[OwnedCopy]:
    """Apply a user edit while provider-owned identity fields remain immutable."""
    existing = ensure_copies(db, game)
    by_id = {row.copy_id: row for row in existing}
    incoming_ids: set[str] = set()
    incoming_apps: set[int] = set()
    result: list[OwnedCopy] = []
    for position, value in enumerate(values):
        copy_id = str(value.get("id") or f"copy:{uuid4().hex}")
        if copy_id in incoming_ids:
            raise HTTPException(422, "Every owned copy needs a unique ID.")
        incoming_ids.add(copy_id)
        row = by_id.get(copy_id)
        requested_appid = int(value.get("steam_appid") or 0) or None
        if row is None:
            if requested_appid:
                raise HTTPException(409, "Link new Steam copies with the Steam link button after saving the copy.")
            row = OwnedCopy(user_id=game.user_id, collection_game_id=game.id, copy_id=copy_id)
            db.add(row)
        elif row.steam_appid:
            if requested_appid != row.steam_appid:
                raise HTTPException(409, "A linked Steam copy can only be changed with Change linked Steam game or deleted.")
            if row.steam_appid in incoming_apps:
                raise HTTPException(422, "The same Steam game cannot appear twice on one collection card.")
            incoming_apps.add(row.steam_appid)
            entitlement = db.query(SteamOwnedGame).filter_by(
                user_id=game.user_id, steam_id=row.steam_id, steam_appid=row.steam_appid,
            ).first()
            row.name = entitlement.name if entitlement else row.name
            row.platform, row.format, row.source = "PC", "Digital", "Steam"
            row.store_url = entitlement.store_url if entitlement else row.store_url
            row.igdb_id = (entitlement.igdb_id if entitlement else None) or row.igdb_id
            if entitlement and entitlement.playtime_hours is not None:
                row.playtime_hours = entitlement.playtime_hours
            row.price = value.get("price")
            row.currency = str(value.get("currency") or row.currency or "EUR")
            row.user_modified = True
            row.position, row.updated_at = position, datetime.utcnow()
            result.append(row)
            continue
        for field in COPY_FIELDS:
            setattr(row, field, value.get(field))
        row.platform = str(value.get("platform") or "")
        row.format = str(value.get("format") or "Any")
        row.currency = str(value.get("currency") or "EUR")
        if row.playtime_hours is not None and row.playtime_hours < 0:
            raise HTTPException(422, "Copy playtime cannot be negative.")
        row.position, row.user_modified, row.updated_at = position, True, datetime.utcnow()
        result.append(row)
    for row in existing:
        if row.copy_id in incoming_ids:
            continue
        suppress_copy(db, game, row)
        db.delete(row)
    db.flush()
    project_game(db, game, result)
    return result


def next_shared_playtime_flag(db: Session, user_id: int, steam_id: str, appid: int) -> bool:
    """Only the first game linked to one entitlement counts it in account-wide totals."""
    return not db.query(OwnedCopy).filter_by(
        user_id=user_id, steam_id=steam_id, steam_appid=appid, counts_toward_totals=True,
    ).first()


def protect_linked_dlcs(db: Session, game: Videogame, raw_dlcs: str | None) -> str | None:
    """Lock provider fields and suppress a Steam DLC intentionally removed by the user."""
    try:
        incoming = json.loads(raw_dlcs or "[]")
        original = json.loads(game.dlcs or "[]")
    except (TypeError, ValueError):
        raise HTTPException(422, "DLC data must be a JSON list.")
    if not isinstance(incoming, list):
        raise HTTPException(422, "DLC data must be a JSON list.")
    incoming_by_app = {
        int(value.get("steam_appid")): value for value in incoming
        if isinstance(value, dict) and value.get("steam_appid")
    }
    original_by_app = {
        int(value.get("steam_appid")): value for value in original
        if isinstance(value, dict) and value.get("steam_appid")
    }
    links = db.query(SteamContentLink).filter_by(user_id=game.user_id, parent_game_id=game.id).all()
    linked_appids = {link.steam_appid for link in links}
    unknown = set(incoming_by_app) - linked_appids
    if unknown:
        raise HTTPException(409, "Steam DLC identities can only be changed through Steam synchronization.")
    for link in links:
        value = incoming_by_app.get(link.steam_appid)
        entitlement = db.query(SteamOwnedGame).filter_by(
            user_id=game.user_id, steam_id=link.steam_id, steam_appid=link.steam_appid,
        ).first()
        if value is None:
            saved = original_by_app.get(link.steam_appid) or {
                "steam_appid": link.steam_appid, "name": link.name, "state": "not_started",
            }
            suppression = db.query(SteamCopyTrash).filter_by(
                user_id=game.user_id, steam_id=link.steam_id, steam_appid=link.steam_appid,
                collection_game_id=game.id, copy_id="", kind="dlc",
            ).first()
            if suppression is None:
                suppression = SteamCopyTrash(
                    user_id=game.user_id, steam_id=link.steam_id, steam_appid=link.steam_appid,
                    collection_game_id=game.id, copy_id="", kind="dlc",
                )
                db.add(suppression)
            suppression.name = (entitlement.name if entitlement else None) or link.name
            suppression.image_url = entitlement.image_url if entitlement else game.image_url
            suppression.collection_game_name = game.name
            suppression.copy_data = json.dumps(saved)
            suppression.game_data = _snapshot(game)
            suppression.deleted_at = datetime.utcnow()
            record_audit(
                db, game.user_id, "dlc_suppressed", steam_id=link.steam_id,
                steam_appid=link.steam_appid, game_id=game.id,
            )
            db.delete(link)
            continue
        value.update({
            "name": (entitlement.name if entitlement else None) or link.name,
            "source": "Steam", "platform": "PC", "format": "Digital",
            "steam_appid": link.steam_appid,
            "store_url": entitlement.store_url if entitlement else value.get("store_url"),
            "playtime_hours": entitlement.playtime_hours
            if entitlement and entitlement.playtime_hours is not None else value.get("playtime_hours"),
            "igdb_id": (entitlement.igdb_id if entitlement else None) or link.igdb_id,
        })
    return json.dumps(incoming) if incoming else None


def integrity_report(db: Session, user_id: int, repair: bool = False) -> dict:
    games = db.query(Videogame).filter_by(user_id=user_id).all()
    issues = {
        "projection_mismatches": 0,
        "missing_entitlements": 0,
        "multiple_playtime_primaries": 0,
        "merged_games_with_copies": 0,
    }
    repaired = 0
    for game in games:
        rows = db.query(OwnedCopy).filter_by(user_id=user_id, collection_game_id=game.id).order_by(
            OwnedCopy.position, OwnedCopy.id
        ).all()
        expected = [copy_dict(db, row) for row in rows]
        current = _legacy_items(game)
        if current != expected:
            issues["projection_mismatches"] += 1
            if repair:
                project_game(db, game, rows)
                repaired += 1
        if game.merged_into_game_id and rows:
            issues["merged_games_with_copies"] += 1
        for row in rows:
            if row.steam_appid and not db.query(SteamOwnedGame).filter_by(
                user_id=user_id, steam_id=row.steam_id, steam_appid=row.steam_appid,
            ).first():
                issues["missing_entitlements"] += 1
    groups: dict[tuple[str, int], list[OwnedCopy]] = {}
    for row in db.query(OwnedCopy).filter_by(user_id=user_id).filter(OwnedCopy.steam_appid.is_not(None)).all():
        groups.setdefault((row.steam_id, row.steam_appid), []).append(row)
    for rows in groups.values():
        counted = [row for row in rows if row.counts_toward_totals]
        if len(counted) != 1:
            issues["multiple_playtime_primaries"] += 1
            if repair:
                primary = min(rows, key=lambda row: row.id)
                for row in rows:
                    row.counts_toward_totals = row.id == primary.id
                repaired += 1
    return {
        "games": len(games),
        "copies": db.query(OwnedCopy).filter_by(user_id=user_id).count(),
        "steam_entitlements": db.query(SteamOwnedGame).filter_by(user_id=user_id).count(),
        "issues": issues,
        "healthy": not any(issues.values()),
        "repaired": repaired,
    }
