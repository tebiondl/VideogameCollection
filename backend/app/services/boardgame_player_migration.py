import json
import re
import unicodedata

from sqlalchemy.orm import Session

from .. import models


def clean_player_name(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def normalize_player_name(value: str) -> str:
    cleaned = clean_player_name(value)
    decomposed = unicodedata.normalize("NFKD", cleaned)
    without_accents = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", without_accents.casefold()).strip()


def parse_legacy_players(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    try:
        decoded = json.loads(raw_value)
        if isinstance(decoded, list):
            values = [str(value.get("name", "")) if isinstance(value, dict) else str(value) for value in decoded]
        else:
            values = [str(decoded)]
    except (json.JSONDecodeError, TypeError):
        values = re.split(r"[,;]", raw_value)

    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        name = clean_player_name(value)
        key = normalize_player_name(name)
        if name and key and key not in seen:
            result.append(name)
            seen.add(key)
    return result


def get_or_create_player(db: Session, user_id: int, name: str) -> models.BoardgamePlayer:
    cleaned = clean_player_name(name)
    normalized = normalize_player_name(cleaned)
    if not normalized:
        raise ValueError("Player name cannot be empty")
    player = db.query(models.BoardgamePlayer).filter(
        models.BoardgamePlayer.user_id == user_id,
        models.BoardgamePlayer.normalized_name == normalized,
    ).first()
    if player:
        return player
    player = models.BoardgamePlayer(user_id=user_id, name=cleaned, normalized_name=normalized)
    db.add(player)
    db.flush()
    return player


def sync_match_players_from_legacy(db: Session, match: models.BoardgameMatch) -> int:
    existing_ids = {player.id for player in match.players}
    added = 0
    for name in parse_legacy_players(match.played_with):
        player = get_or_create_player(db, match.user_id, name)
        if player.id not in existing_ids:
            match.players.append(player)
            existing_ids.add(player.id)
            added += 1
    if match.players:
        match.played_with = json.dumps([player.name for player in match.players], ensure_ascii=False)
    return added


def migrate_legacy_match_players(db: Session) -> dict[str, int]:
    matches = db.query(models.BoardgameMatch).all()
    before = db.query(models.BoardgamePlayer).count()
    linked = 0
    for match in matches:
        linked += sync_match_players_from_legacy(db, match)
    db.commit()
    return {
        "matches_scanned": len(matches),
        "players_created": db.query(models.BoardgamePlayer).count() - before,
        "links_created": linked,
    }
