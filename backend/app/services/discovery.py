"""Public catalog integrations and persistent, restart-safe wishlist scheduling."""
import asyncio
from difflib import SequenceMatcher
import html
import json
import logging
import os
import re
import time
import xml.etree.ElementTree as ElementTree
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urljoin

import httpx
from dateutil import parser as date_parser
from fastapi import HTTPException
from lxml import html as lxml_html
from sqlalchemy import or_
from ..database import SessionLocal
from ..models import Videogame
from ..discovery_models import DiscoveryCache, DiscoverySettings, SteamCollectionLink, SteamCopyTrash, SteamMatchReview, SteamOwnedGame, WantedGame
from ..discovery_models import SteamContentLink
from . import copy_store, dlc_catalog, dlc_links
from .title_matching import compare_titles, is_reviewable_title_match
from .secrets import resolve_steam_api_key

logger = logging.getLogger(__name__)

IGDB_REGION_IDS = {"Europe": 1, "North America": 2, "Japan": 5}
IGDB_SWITCH_PLATFORM_ID = 130
IGDB_PHYSICAL_FORMAT_ID = 2
IGDB_STEAM_SOURCE_ID = 1
IGDB_DLC_TYPES = {1, 2, 4}
NINTENDO_LIFE_GUIDES_FEED = "https://www.nintendolife.com/feeds/guides"


class UpstreamRateLimit(ValueError):
    pass


def normalized(value):
    return " ".join((value or "").casefold().split())


def platform_key(value):
    value = normalized(value)
    return "pc" if value in ("pc (microsoft windows)", "windows", "steam", "pc") else value


def normalize_steam_id(value):
    if not value or not value.strip():
        return None
    match = re.fullmatch(r"(?:https?://steamcommunity\.com/profiles/)?(7656119\d{10})/?", value.strip())
    if not match:
        raise HTTPException(422, "Enter your 17-digit SteamID64 or a steamcommunity.com/profiles/… URL.")
    return match.group(1)


def get_settings(db, user_id):
    settings = db.get(DiscoverySettings, user_id)
    if settings is None:
        settings = DiscoverySettings(user_id=user_id)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


def find_duplicate(db, user_id, data, exclude_id=None):
    query = db.query(WantedGame).filter(WantedGame.user_id == user_id)
    if exclude_id is not None:
        query = query.filter(WantedGame.id != exclude_id)
    for game in query.all():
        if data.get("steam_appid") and game.steam_appid == data["steam_appid"]:
            return game
        # An acquired row remains for history, but should not block saving a
        # different platform or edition of the same game later.
        if game.status == "Acquired":
            continue
        platforms = (platform_key(game.platform), platform_key(data.get("platform")))
        if not game.deleted and (platforms[0] == platforms[1] or not all(platforms)):
            if data.get("igdb_id") and game.igdb_id == data["igdb_id"]:
                return game
            title_match = compare_titles(game.name, data["name"])
            if title_match.compatible and title_match.automatic and title_match.score >= 0.98:
                return game
    return None


def request_json(client, url, **kwargs):
    response = client.get(url, **kwargs)
    if response.status_code in (401, 403):
        raise ValueError("Steam wishlist is private or unavailable. Make your profile and game details public.")
    if response.status_code == 429:
        raise UpstreamRateLimit("The source is rate limiting requests. The next scheduled sync will retry.")
    response.raise_for_status()
    return response.json()


def steam_wishlist(client, steam_id):
    raw = request_json(client, "https://api.steampowered.com/IWishlistService/GetWishlist/v1/", params={"steamid": steam_id})
    response = raw.get("response")
    # {} is ambiguous (private/unavailable/empty), so never use it to delete data.
    if not isinstance(response, dict) or "items" not in response:
        raise ValueError("Steam returned no readable wishlist. It may be empty or private; saved games are unchanged.")
    items = response["items"]
    if not isinstance(items, list) or any(not isinstance(x, dict) or not isinstance(x.get("appid"), int) or x["appid"] <= 0 for x in items):
        raise ValueError("Steam returned an unexpected wishlist response.")
    return items


def steam_owned_games(client, steam_id, api_key=None):
    """Read Steam's owned library plus recently played games it omits."""
    api_key = (api_key or os.getenv("STEAM_WEB_API_KEY", "")).strip()
    if not api_key:
        raise ValueError("Collection sync needs a Steam Web API key. Add one in User Settings; wishlist sync will continue meanwhile.")
    raw = request_json(client, "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/", params={
        "key": api_key, "steamid": steam_id, "include_appinfo": 1, "include_played_free_games": 1,
    })
    response = raw.get("response")
    if not isinstance(response, dict):
        raise ValueError("Steam returned no readable game library. Make your game details public.")
    owned_games = response.get("games", [])
    if not isinstance(owned_games, list):
        raise ValueError("Steam returned no readable game library. Make your game details public.")

    # GetOwnedGames can omit played free-to-play titles even when
    # include_played_free_games is enabled. RecentlyPlayedGames still exposes
    # those apps, so merge it as a best-effort supplement to the authoritative
    # owned response. A failure here must not discard a valid owned snapshot.
    recently_played = []
    try:
        recent_raw = request_json(client, "https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/", params={
            "key": api_key, "steamid": steam_id, "count": 0,
        })
        recent_response = recent_raw.get("response")
        if not isinstance(recent_response, dict) or not isinstance(recent_response.get("games", []), list):
            raise ValueError("Steam returned no readable recently played games.")
        recently_played = recent_response.get("games", [])
    except (httpx.HTTPError, ValueError, KeyError):
        logger.warning("Steam recently played fallback failed; continuing with the owned library")

    owned_appids = {
        item.get("appid") for item in owned_games
        if isinstance(item, dict) and isinstance(item.get("appid"), int)
    }
    games_by_app = {}
    for source, item in [
        *(("owned", item) for item in owned_games),
        *(("recent", item) for item in recently_played),
    ]:
        appid = item.get("appid")
        if not isinstance(appid, int) or appid <= 0:
            continue
        parsed = {
            "appid": appid, "name": item.get("name") or f"Steam app {appid}",
            # Steam's client total includes offline/disconnected sessions, while
            # these endpoints may expose those minutes in a separate field.
            "playtime_hours": round(((item.get("playtime_forever") or 0) + (item.get("playtime_disconnected") or 0)) / 60, 1),
            "image_url": None, "store_url": f"https://store.steampowered.com/app/{appid}/",
            # Recent-only games are an account-specific exception to an
            # incomplete owned snapshot. Preserve that proof after recency
            # expires instead of deactivating the entitlement on the next sync.
            "stats_verified": source == "recent" and appid not in owned_appids,
        }
        existing = games_by_app.get(appid)
        if existing is None:
            games_by_app[appid] = parsed
        else:
            existing["playtime_hours"] = max(existing["playtime_hours"], parsed["playtime_hours"])
            existing["stats_verified"] = existing["stats_verified"] or parsed["stats_verified"]
            if existing["name"].startswith("Steam app ") and not parsed["name"].startswith("Steam app "):
                existing["name"] = parsed["name"]
    return list(games_by_app.values())


def _steam_account_stats_title(client, steam_id, api_key, appid):
    """Return Steam's title only when this account exposes app-specific stats."""
    endpoints = (
        ("https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/", True),
        ("https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/", False),
    )
    for url, requires_success in endpoints:
        try:
            raw = request_json(client, url, params={
                "key": api_key, "steamid": steam_id, "appid": appid, "l": "english",
            })
        except (httpx.HTTPError, ValueError, KeyError):
            continue
        playerstats = raw.get("playerstats")
        if not isinstance(playerstats, dict):
            continue
        if requires_success and playerstats.get("success") is not True:
            continue
        game_name = playerstats.get("gameName")
        if isinstance(game_name, str) and game_name.strip():
            return game_name.strip()

    # Some older, delisted and family-shared games are omitted by both the
    # owned-library endpoint and the Web API stats endpoints. Their public
    # Steam Community stats XML can still prove that this specific account has
    # a stats page for the app. It often reports zero hours even when the Steam
    # client shows time, so use it for identity only and never overwrite local
    # playtime from this source.
    try:
        response = client.get(
            f"https://steamcommunity.com/profiles/{steam_id}/stats/{appid}/",
            params={"xml": 1},
        )
        response.raise_for_status()
        root = ElementTree.fromstring(response.text)
    except (httpx.HTTPError, ElementTree.ParseError, ValueError, TypeError):
        return None
    if root.tag != "playerstats" or root.findtext("privacyState") != "public":
        return None
    game_name = root.findtext("./game/gameName")
    return game_name.strip() if isinstance(game_name, str) and game_name.strip() else None


def _steam_store_queries(value):
    raw = (value or "").strip()[:200]
    if not raw:
        return []
    words = re.findall(r"[A-Za-z0-9]+", raw)
    generic = {"club", "copy", "dlc", "edition", "game", "pc", "steam"}
    useful = [word for word in words if word.casefold() not in generic]
    values = [raw]
    cleaned = " ".join(useful)
    if cleaned and _collection_title_key(cleaned) != _collection_title_key(raw):
        values.append(cleaned)
    for index, word in enumerate(useful):
        if len(word) > 3 and word.casefold().endswith("s"):
            possessive = useful.copy()
            possessive[index] = f"{word[:-1]}'s"
            values.append(" ".join(possessive))
            break
    if len(useful) >= 3:
        values.append(" ".join(useful[:2]))
        values.append(" ".join(useful[-2:]))
    result = []
    seen = set()
    for query in values:
        key = query.casefold()
        if key not in seen:
            seen.add(key)
            result.append(query)
    return result[:5]


def steam_store_candidates(client, query, country="ES"):
    """Search Steam progressively, accepting an app ID or Store URL too."""
    direct = re.search(r"(?:steampowered\.com/app/)?(\d{3,10})", (query or "").strip())
    if direct and (_collection_title_key(query).isdigit() or "steampowered.com/app/" in query.casefold()):
        appid = int(direct.group(1))
        raw = request_json(client, "https://store.steampowered.com/api/appdetails", params={
            "appids": appid, "l": "english", "cc": country,
        })
        data = raw.get(str(appid), {})
        details = data.get("data", {}) if data.get("success") else {}
        if not details.get("name"):
            return []
        return [{
            "appid": appid, "name": details["name"], "image_url": details.get("header_image"),
            "store_url": f"https://store.steampowered.com/app/{appid}/",
            "is_dlc": details.get("type") == "dlc", "parent_game_name": details.get("fullgame", {}).get("name"),
            "similarity": 1.0,
        }]

    target = _collection_title_key(query)
    searches = _steam_store_queries(query)
    best_candidates = []
    for search_query in searches:
        raw = request_json(client, "https://store.steampowered.com/api/storesearch/", params={
            "term": search_query, "l": "english", "cc": country,
        })
        items = raw.get("items", [])
        if not isinstance(items, list):
            continue
        candidates = []
        seen = set()
        for item in items:
            appid, name = item.get("id"), item.get("name")
            if item.get("type") != "app" or not isinstance(appid, int) or appid <= 0 or not isinstance(name, str):
                continue
            if appid in seen:
                continue
            seen.add(appid)
            candidates.append({
                "appid": appid, "name": name, "image_url": item.get("tiny_image"),
                "store_url": f"https://store.steampowered.com/app/{appid}/",
                "similarity": SequenceMatcher(None, target, _collection_title_key(name)).ratio(),
            })
        if candidates:
            candidates.sort(key=lambda item: (-item["similarity"], item["name"].casefold()))
            if candidates[0]["similarity"] >= 0.95:
                return candidates[:12]
            if not best_candidates or candidates[0]["similarity"] > best_candidates[0]["similarity"]:
                best_candidates = candidates[:12]
    return best_candidates


def find_steam_store_games(db, user_id, query):
    """Return Store candidates, marking the ones Steam can verify to the account."""
    settings = db.get(DiscoverySettings, user_id)
    steam_id = settings.steam_id if settings else None
    try:
        api_key = resolve_steam_api_key(settings.steam_api_key if settings else None)
    except (OSError, ValueError):
        api_key = None
    try:
        with httpx.Client(timeout=20, headers={"User-Agent": "EpicTracker/1.0"}) as client:
            country = {"North America": "US", "Japan": "JP"}.get(settings.region if settings else None, "ES")
            candidates = steam_store_candidates(client, query, country)
            for item in candidates:
                stats_name = None
                # Avoid a burst of account calls for broad fallback searches;
                # only strong matches are plausible automatic verification candidates.
                if steam_id and api_key and item.get("similarity", 0) >= 0.9:
                    stats_name = _steam_account_stats_title(client, steam_id, api_key, item["appid"])
                item["name"] = stats_name or item["name"]
                item["playtime_hours"] = None
                item["stats_verified"] = bool(stats_name)
                item["manual_verification_required"] = not bool(stats_name)
                item["store_query"] = query
            return candidates
    except (httpx.HTTPError, ValueError, KeyError):
        logger.warning("Steam Store lookup failed for user %s", user_id)
        return []


def find_verified_steam_game(db, user_id, title):
    """Return one exact Store title that Steam stats confirm for this account."""
    verified = [
        item for item in find_steam_store_games(db, user_id, title)
        if item.get("stats_verified")
        and (match := compare_titles(title, item.get("name"))).compatible
        and match.automatic and match.score >= 0.98
    ]
    return verified[0] if len(verified) == 1 else None


def resolve_user_verified_steam_game(db, user_id, query, appid):
    """Revalidate an explicit Store selection and load its canonical metadata."""
    selected = next((item for item in find_steam_store_games(db, user_id, query) if item["appid"] == appid), None)
    if selected is None:
        return None
    try:
        with httpx.Client(timeout=20, headers={"User-Agent": "EpicTracker/1.0"}) as client:
            fields = steam_details(db, client, appid)
    except (httpx.HTTPError, ValueError, KeyError):
        return None
    return {
        "appid": appid, "name": fields["name"], "playtime_hours": None,
        "image_url": fields.get("image_url") or selected.get("image_url"),
        "store_url": fields.get("store_url") or selected.get("store_url"),
        "is_dlc": fields.get("is_dlc", False), "parent_game_name": fields.get("parent_game_name"),
        "stats_verified": bool(selected.get("stats_verified")), "user_verified": True,
    }


def _copy_has_steam_app(game, appid):
    try:
        return any(item.get("steam_appid") == appid for item in json.loads(game.copies or "[]"))
    except (TypeError, ValueError):
        return False


def _copy_has_igdb_game(game, igdb_id):
    if not igdb_id:
        return False
    try:
        return any(item.get("igdb_id") == igdb_id for item in json.loads(game.copies or "[]"))
    except (TypeError, ValueError):
        return False


def _collection_title_key(value):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", (value or "").casefold()).split())


def _known_game_igdb_ids(game):
    ids = {int(game.igdb_id)} if game.igdb_id else set()
    try:
        ids.update(int(item["igdb_id"]) for item in json.loads(game.copies or "[]") if item.get("igdb_id"))
    except (TypeError, ValueError, KeyError):
        pass
    return ids


def _igdb_identity_conflicts(game, target_igdb_id):
    known = _known_game_igdb_ids(game)
    return bool(target_igdb_id and known and int(target_igdb_id) not in known)


def _collection_title_matches(collection, names, target_igdb_id=None):
    """Return plausible titles and whether the best is safe to link automatically."""
    targets = [name for name in names if _collection_title_key(name)]
    scored = []
    for game in collection:
        if _igdb_identity_conflicts(game, target_igdb_id):
            continue
        best = None
        for target in targets:
            result = compare_titles(target, game.name)
            if result.compatible and (best is None or result.score > best.score):
                best = result
        if best and is_reviewable_title_match(best):
            scored.append((best.score, game, best.automatic))
    scored.sort(key=lambda item: item[0], reverse=True)
    if not scored:
        return [], False
    ambiguous = len(scored) > 1 and scored[0][0] - scored[1][0] < 0.04
    return (
        [(game, score) for score, game, _automatic in scored[:5]],
        scored[0][0] >= 0.92 and scored[0][2] and not ambiguous,
    )


def steam_review_candidates(review):
    try:
        values = json.loads(review.candidates or "[]")
    except (TypeError, ValueError):
        values = []
    candidates = []
    for value in values:
        if not isinstance(value, dict) or not value.get("game_id") or not value.get("name"):
            continue
        candidates.append({
            "game_id": int(value["game_id"]), "name": str(value["name"]),
            "confidence": float(value.get("confidence") or 0),
        })
    if not candidates:
        candidates.append({
            "game_id": review.candidate_game_id, "name": review.candidate_name,
            "confidence": review.confidence,
        })
    return candidates


def steam_review_response(review):
    return {
        "id": review.id, "steam_appid": review.steam_appid, "steam_name": review.steam_name,
        "candidate_game_id": review.candidate_game_id, "candidate_name": review.candidate_name,
        "confidence": review.confidence, "candidates": steam_review_candidates(review),
        "created_at": review.created_at, "match_kind": review.match_kind,
    }


def steam_copy(item, igdb_id=None, copy_id=None):
    return {
        "id": copy_id or f"steam:{item['appid']}", "name": item.get("name"),
        "platform": "PC", "format": "Digital", "source": "Steam",
        "store_url": item.get("store_url") or f"https://store.steampowered.com/app/{item['appid']}/",
        "steam_appid": item["appid"], "igdb_id": igdb_id or item.get("igdb_id"),
        "playtime_hours": item.get("playtime_hours"), "price": None, "currency": "EUR",
    }


def steam_copy_id(db, game, appid, steam_id=None):
    query = db.query(SteamCollectionLink).filter_by(
        user_id=game.user_id, collection_game_id=game.id, steam_appid=int(appid),
    )
    if steam_id is not None:
        query = query.filter_by(steam_id=steam_id)
    row = query.first()
    return row.copy_id if row else None


def attach_steam_copy(db, game, item, igdb_id=None, copy_id=None, steam_id=None):
    scope = steam_id if steam_id is not None else copy_store.steam_scope(db, game.user_id)
    row = db.query(SteamCollectionLink).filter_by(
        user_id=game.user_id, steam_id=scope, collection_game_id=game.id,
        steam_appid=item["appid"],
    ).first()
    created = row is None
    before = None if row is None else (
        row.name, row.platform, row.format, row.source, row.store_url,
        row.igdb_id, row.playtime_hours,
    )
    if row is None:
        used_ids = {
            value.copy_id for value in copy_store.ensure_copies(db, game)
        }
        public_id = str(copy_id or f"steam:{item['appid']}")
        while public_id in used_ids:
            public_id = f"copy:{__import__('uuid').uuid4().hex}"
        row = SteamCollectionLink(
            user_id=game.user_id, steam_id=scope, collection_game_id=game.id,
            copy_id=public_id, steam_appid=item["appid"],
            position=len(used_ids), counts_toward_totals=copy_store.next_shared_playtime_flag(
                db, game.user_id, scope, item["appid"],
            ),
        )
        db.add(row)
    row.name = item.get("name") or row.name or game.name
    row.platform, row.format, row.source = "PC", "Digital", "Steam"
    row.store_url = item.get("store_url") or row.store_url or f"https://store.steampowered.com/app/{item['appid']}/"
    row.igdb_id = igdb_id or item.get("igdb_id") or row.igdb_id
    if item.get("playtime_hours") is not None:
        row.playtime_hours = item["playtime_hours"]
    row.updated_at = datetime.utcnow()
    after = (
        row.name, row.platform, row.format, row.source, row.store_url,
        row.igdb_id, row.playtime_hours,
    )
    db.flush()
    if created and len(copy_store.ensure_copies(db, game)) == 1 and (game.playtime_hours is None or game.playtime_hours == 0) and getattr(game, "playtime_mode", "user") == "user":
        game.playtime_mode = "copies"
    copy_store.project_game(db, game)
    if created or before != after:
        game.version = (game.version or 1) + 1
    return created


def detach_steam_copy(db, game, appid, steam_id=None):
    query = db.query(SteamCollectionLink).filter_by(
        user_id=game.user_id, collection_game_id=game.id, steam_appid=int(appid),
    )
    if steam_id is not None:
        query = query.filter_by(steam_id=steam_id)
    row = query.first()
    if row is None:
        return False
    db.delete(row)
    db.flush()
    copy_store.project_game(db, game)
    return True


def trash_steam_copy(db, user_id, game, owned_copy):
    """Compatibility entry point for callers that still hold a projected copy dict."""
    appid = int(owned_copy.get("steam_appid") or 0)
    if not appid:
        return None
    copy_id = str(owned_copy.get("id") or "")
    row = db.query(SteamCollectionLink).filter_by(
        user_id=user_id, collection_game_id=game.id, copy_id=copy_id,
    ).first()
    if row is None:
        row = db.query(SteamCollectionLink).filter_by(
            user_id=user_id, collection_game_id=game.id, steam_appid=appid,
        ).first()
    return copy_store.suppress_copy(db, game, row) if row else None


def find_parent_game(collection, parent_name):
    if not parent_name:
        return None
    candidates = [game for game in collection if not game.is_dlc]
    exact = next((game for game in candidates if (
        (match := compare_titles(parent_name, game.name)).compatible
        and match.automatic and match.score >= 0.98
    )), None)
    if exact:
        return exact
    matches, automatic = _collection_title_matches(candidates, [parent_name])
    return matches[0][0] if matches and (automatic or matches[0][1] >= 0.84) else None


def attach_owned_dlc(parent, item):
    try:
        dlcs = json.loads(parent.dlcs or "[]")
    except (TypeError, ValueError):
        dlcs = []
    appid = item["appid"]
    entry = next((row for row in dlcs if int(row.get("steam_appid") or 0) == appid), None)
    if entry is None:
        entry = dlc_catalog.matching_manual_row(dlcs, [item], item, parent.name)
    if entry is None:
        entry = {"name": item.get("name") or f"Steam app {appid}", "state": "not_started"}
        dlcs.append(entry)
    entry.update({
        "steam_appid": appid, "source": "Steam", "platform": "PC", "format": "Digital",
        "store_url": item.get("store_url"), "playtime_hours": item.get("playtime_hours"),
        "image_url": item.get("image_url"), "igdb_id": item.get("igdb_id"),
    })
    parent.dlcs = json.dumps(dlcs)


def upsert_steam_catalog(db, user_id, item, steam_id=None, generation=0):
    scope = steam_id if steam_id is not None else copy_store.steam_scope(db, user_id)
    row = db.query(SteamOwnedGame).filter_by(user_id=user_id, steam_id=scope, steam_appid=item["appid"]).first()
    if row is None:
        row = SteamOwnedGame(user_id=user_id, steam_id=scope, steam_appid=item["appid"])
        db.add(row)
    row.name = item.get("name") or row.name or f"Steam app {item['appid']}"
    for key in ("playtime_hours", "image_url", "store_url", "igdb_id", "parent_game_name"):
        if item.get(key) is not None:
            setattr(row, key, item[key])
    row.is_dlc = bool(item.get("is_dlc", row.is_dlc))
    row.stats_verified = row.stats_verified or bool(item.get("stats_verified"))
    row.user_verified = row.user_verified or bool(item.get("user_verified"))
    row.active = True
    row.last_seen_generation = generation
    row.last_seen_at = datetime.utcnow()
    row.updated_at = datetime.utcnow()
    return row


def reconcile_steam_library(db, user_id, items):
    """Persistently link owned Steam apps while collection fields remain authoritative."""
    scope = copy_store.adopt_legacy_scope(db, user_id)
    settings = db.get(DiscoverySettings, user_id)
    generation = settings.owned_sync_generation if settings else 0
    collection = db.query(Videogame).filter_by(user_id=user_id).all()
    collection_by_id = {game.id: game for game in collection}
    matchable_collection = [game for game in collection if not game.hidden and not game.merged_into_game_id and not game.is_dlc]
    wanted_by_app = {row.steam_appid: row for row in db.query(WantedGame).filter_by(user_id=user_id, deleted=False).all() if row.steam_appid}
    links = db.query(SteamCollectionLink).filter_by(user_id=user_id, steam_id=scope).filter(
        SteamCollectionLink.steam_appid.is_not(None)
    ).all()
    links_by_game = {}
    for link in links:
        links_by_game.setdefault(link.collection_game_id, []).append(link)
    links_by_app = {}
    for link in links:
        links_by_app.setdefault(link.steam_appid, []).append(link)
    reviews_by_app = {row.steam_appid: row for row in db.query(SteamMatchReview).filter_by(user_id=user_id, steam_id=scope, match_kind="game").all()}
    catalog = {row.steam_appid: row for row in db.query(SteamOwnedGame).filter_by(user_id=user_id, steam_id=scope).all()}
    trashed_appids = {
        row.steam_appid for row in db.query(SteamCopyTrash).filter_by(user_id=user_id, steam_id=scope).all()
    }
    for item in items:
        catalog[item["appid"]] = upsert_steam_catalog(db, user_id, item, scope, generation)
    db.flush()
    imported = 0
    for item in items:
        created_collection_game = False
        appid = item["appid"]
        catalog_row = catalog[appid]
        wanted = wanted_by_app.get(appid)
        app_links = links_by_app.get(appid, [])
        if catalog_row.is_dlc or item.get("is_dlc") or (wanted and wanted.is_dlc):
            parent_name = catalog_row.parent_game_name or item.get("parent_game_name") or (wanted.parent_game_name if wanted else None)
            parent = find_parent_game(matchable_collection, parent_name)
            if parent:
                attach_owned_dlc(parent, {**item, "is_dlc": True, "parent_game_name": parent_name,
                                          "igdb_id": catalog_row.igdb_id or item.get("igdb_id")})
                content_link = db.query(SteamContentLink).filter_by(
                    user_id=user_id, steam_id=scope, steam_appid=appid,
                ).first()
                content_created = content_link is None
                if content_link is None:
                    content_link = SteamContentLink(user_id=user_id, steam_id=scope, steam_appid=appid,
                                                    parent_game_id=parent.id, name=item["name"])
                    db.add(content_link)
                content_link.parent_game_id, content_link.name = parent.id, item["name"]
                content_link.igdb_id, content_link.updated_at = catalog_row.igdb_id, datetime.utcnow()
                if content_created:
                    copy_store.record_audit(
                        db, user_id, "dlc_auto_linked", steam_id=scope,
                        steam_appid=appid, game_id=parent.id,
                    )
                if wanted:
                    wanted.status, wanted.collection_game_id = "Acquired", parent.id
                    wanted.steam_wishlist_missing, wanted.updated_at = False, datetime.utcnow()
            # Expansions never become standalone collection cards.
            for link in list(app_links):
                old = collection_by_id.get(link.collection_game_id)
                if old and old.is_dlc:
                    old.hidden = True
                db.delete(link)
            links_by_app.pop(appid, None)
            continue
        if app_links:
            retained_links = []
            repaired_games = set()
            for existing_link in app_links:
                linked_game = collection_by_id.get(existing_link.collection_game_id)
                primary = catalog.get(catalog_row.duplicate_of_appid) if catalog_row.duplicate_of_appid else None
                reference_title = (primary.name if primary else None) or (linked_game.name if linked_game else None)
                identity = compare_titles(item["name"], reference_title)
                target_igdb_id = item.get("igdb_id") or catalog_row.igdb_id
                external_identity_conflict = bool(
                    target_igdb_id and linked_game and linked_game.igdb_id
                    and int(target_igdb_id) != int(linked_game.igdb_id)
                )
                if (
                    linked_game is not None
                    and not existing_link.user_selected
                    and (identity.relation == "different_installment" or external_identity_conflict)
                ):
                    repaired_games.add(linked_game.id)
                    if existing_link in links_by_game.get(linked_game.id, []):
                        links_by_game[linked_game.id].remove(existing_link)
                    db.delete(existing_link)
                    copy_store.record_audit(
                        db, user_id, "external_identity_link_repaired" if external_identity_conflict else "installment_link_repaired", steam_id=scope,
                        steam_appid=appid, game_id=linked_game.id, copy_id=existing_link.copy_id,
                        details={"steam_title": item["name"], "reference_title": reference_title},
                    )
                else:
                    retained_links.append(existing_link)
            if len(retained_links) != len(app_links):
                catalog_row.duplicate_of_appid = None
                links_by_app[appid] = retained_links
                app_links = retained_links
                db.flush()
                for repaired_game_id in repaired_games:
                    repaired_game = collection_by_id.get(repaired_game_id)
                    if repaired_game:
                        copy_store.project_game(db, repaired_game)
        if app_links:
            for link in app_links:
                game = collection_by_id.get(link.collection_game_id)
                if game and attach_steam_copy(db, game, item, link.igdb_id or catalog_row.igdb_id, link.copy_id, scope):
                    imported += 1
            if wanted and app_links:
                wanted.status, wanted.collection_game_id = "Acquired", app_links[0].collection_game_id
                wanted.steam_wishlist_missing, wanted.updated_at = False, datetime.utcnow()
            continue
        if appid in trashed_appids:
            review = reviews_by_app.get(appid)
            if review is not None:
                db.delete(review)
            continue
        if catalog_row.duplicate_of_appid:
            if links_by_app.get(catalog_row.duplicate_of_appid):
                continue
            # A canonical copy may have been removed or moved. Do not let an old
            # duplicate marker make this entitlement disappear permanently.
            catalog_row.duplicate_of_appid = None
        link = None
        game = None
        identity_confirmed = False
        if game is None:
            game = next((row for row in matchable_collection if _copy_has_steam_app(row, appid)), None)
            identity_confirmed = game is not None
        if game is None and wanted and wanted.collection_game_id:
            game = collection_by_id.get(wanted.collection_game_id)
            identity_confirmed = game is not None
        target_igdb_id = ((wanted.igdb_id if wanted else None) or item.get("igdb_id")
                          or catalog_row.igdb_id)
        if game is None and target_igdb_id:
            igdb_candidates = [
                row for row in matchable_collection
                if row.igdb_id == target_igdb_id or _copy_has_igdb_game(row, target_igdb_id)
            ]
            if len(igdb_candidates) == 1:
                game = igdb_candidates[0]
                identity_confirmed = True
        if game is None:
            title_names = [item["name"], wanted.name if wanted else ""]
            exact_candidates = [row for row in matchable_collection if any(
                (match := compare_titles(name, row.name)).compatible
                and match.automatic and match.score >= 0.98
                for name in title_names if name
            ) and not _igdb_identity_conflicts(row, target_igdb_id)]
            if len(exact_candidates) == 1:
                game = exact_candidates[0]
        if game is None:
            review = reviews_by_app.get(appid)
            matches, automatic = _collection_title_matches(
                matchable_collection, [item["name"], wanted.name if wanted else ""], target_igdb_id,
            )
            try:
                rejected = set(json.loads(review.rejected_candidate_ids or "[]")) if review else set()
            except (TypeError, ValueError):
                rejected = set()
            matches = [(candidate, confidence) for candidate, confidence in matches if candidate.id not in rejected]
            if automatic and review is None:
                game = matches[0][0]
                # The automatic identity came from Steam, so Steam supplies its canonical title.
                game.name = item["name"]
                game.version = (game.version or 1) + 1
            elif matches:
                if review is None:
                    review = SteamMatchReview(user_id=user_id, steam_id=scope, steam_appid=appid, match_kind="game")
                    db.add(review)
                    reviews_by_app[appid] = review
                candidate, confidence = matches[0]
                review.steam_name = item["name"]
                review.candidate_game_id = candidate.id
                review.candidate_name = candidate.name
                review.confidence = round(confidence, 4)
                review.candidates = json.dumps([
                    {"game_id": option.id, "name": option.name, "confidence": round(score, 4)}
                    for option, score in matches
                ])
                review.steam_data = json.dumps(item)
                review.updated_at = datetime.utcnow()
                continue
        primary = None
        if game is not None:
            existing_links = links_by_game.get(game.id, [])
            primary = next((row for row in existing_links if row.steam_appid != appid), None)
            if primary:
                # A second Steam app with the same title is not proof that it is
                # another copy of the same release (both Lords of the Fallen
                # games are a real-world counterexample). Require a durable
                # wanted/IGDB/app identity or ask the user before grouping it.
                if not identity_confirmed:
                    review = reviews_by_app.get(appid)
                    try:
                        rejected = set(json.loads(review.rejected_candidate_ids or "[]")) if review else set()
                    except (TypeError, ValueError):
                        rejected = set()
                    if game.id not in rejected:
                        if review is None:
                            review = SteamMatchReview(
                                user_id=user_id, steam_id=scope, steam_appid=appid, match_kind="game",
                            )
                            db.add(review)
                            reviews_by_app[appid] = review
                        review.steam_name = item["name"]
                        review.candidate_game_id = game.id
                        review.candidate_name = game.name
                        review.confidence = 1.0
                        review.candidates = json.dumps([{
                            "game_id": game.id, "name": game.name, "confidence": 1.0,
                        }])
                        review.steam_data = json.dumps(item)
                        review.updated_at = datetime.utcnow()
                        continue
                    game = None
                    primary = None
        review = reviews_by_app.get(appid)
        if review is not None:
            db.delete(review)
            reviews_by_app.pop(appid, None)
        if game is not None:
            if primary:
                catalog_row.duplicate_of_appid = primary.steam_appid
                if attach_steam_copy(db, game, item, target_igdb_id, steam_id=scope):
                    imported += 1
                copy_id = steam_copy_id(db, game, appid, scope)
                duplicate_link = db.query(SteamCollectionLink).filter_by(
                    user_id=user_id, steam_id=scope, collection_game_id=game.id, copy_id=copy_id,
                ).one()
                duplicate_link.igdb_id = target_igdb_id
                duplicate_link.created_collection_game = False
                duplicate_link.user_selected = False
                copy_store.record_audit(
                    db, user_id, "duplicate_copy_auto_linked", steam_id=scope,
                    steam_appid=appid, game_id=game.id, copy_id=copy_id,
                )
                links_by_game.setdefault(game.id, []).append(duplicate_link)
                links_by_app.setdefault(appid, []).append(duplicate_link)
                if wanted:
                    wanted.status, wanted.collection_game_id = "Acquired", game.id
                    wanted.steam_wishlist_missing, wanted.updated_at = False, datetime.utcnow()
                continue
            # Every identity chosen by sync uses Steam's canonical title. Manual
            # linking is handled by a separate endpoint and retains the local title.
            game.name = item["name"]
        if game is None:
            game = Videogame(
                user_id=user_id, name=item["name"],
                description=wanted.description if wanted else None, comments=wanted.comments if wanted else None,
                image_url=(wanted.image_url if wanted else None) or item.get("image_url"), status="Not Started",
                playtime_hours=None, playtime_mode="copies", hype=wanted.hype if wanted else None,
                publication_year=wanted.publication_year if wanted else None,
                release_date=wanted.release_date if wanted else None, tags=wanted.tags if wanted else None,
                dlcs=wanted.dlcs if wanted else None, is_dlc=wanted.is_dlc if wanted else False,
                parent_game_name=wanted.parent_game_name if wanted else None,
                igdb_id=target_igdb_id,
            )
            db.add(game)
            db.flush()
            created_collection_game = True
            collection.append(game)
            collection_by_id[game.id] = game
        if attach_steam_copy(db, game, item, target_igdb_id, steam_id=scope):
            imported += 1
        copy_id = steam_copy_id(db, game, appid, scope)
        link = db.query(SteamCollectionLink).filter_by(
            user_id=user_id, steam_id=scope, collection_game_id=game.id, copy_id=copy_id,
        ).one()
        link.igdb_id = target_igdb_id
        link.created_collection_game = created_collection_game
        link.user_selected = False
        copy_store.record_audit(
            db, user_id, "collection_game_created" if created_collection_game else "copy_auto_linked",
            steam_id=scope, steam_appid=appid, game_id=game.id, copy_id=copy_id,
        )
        links_by_game.setdefault(game.id, []).append(link)
        links_by_app.setdefault(appid, []).append(link)
        if wanted:
            wanted.status = "Acquired"
            wanted.collection_game_id = game.id
            wanted.steam_wishlist_missing = False
            wanted.updated_at = datetime.utcnow()
    # Duplicate apps are represented as extra copies under the canonical app's cards.
    for item in items:
        duplicate = catalog[item["appid"]]
        if (item["appid"] in trashed_appids or links_by_app.get(item["appid"])
                or not duplicate.duplicate_of_appid):
            continue
        for link in links_by_app.get(duplicate.duplicate_of_appid, []):
            game = collection_by_id.get(link.collection_game_id)
            if game:
                if attach_steam_copy(db, game, item, duplicate.igdb_id, steam_id=scope):
                    imported += 1
                copy_id = steam_copy_id(db, game, item["appid"], scope)
                if not any(row.collection_game_id == game.id for row in links_by_app.get(item["appid"], [])):
                    row = db.query(SteamCollectionLink).filter_by(
                        user_id=user_id, steam_id=scope, collection_game_id=game.id, copy_id=copy_id,
                    ).one()
                    row.igdb_id = duplicate.igdb_id
                    links_by_app.setdefault(item["appid"], []).append(row)
    return imported


def resolve_steam_match_review(db, user_id, review_id, decision, candidate_game_id):
    review = db.query(SteamMatchReview).filter_by(
        id=review_id, user_id=user_id, steam_id=copy_store.steam_scope(db, user_id),
    ).first()
    if review is None:
        raise HTTPException(404, "Steam match review not found.")
    try:
        item = json.loads(review.steam_data)
    except (TypeError, ValueError):
        raise HTTPException(409, "This Steam review is invalid. Run the sync again.")
    choices = steam_review_candidates(review)
    candidate = None
    if decision != "none":
        if candidate_game_id not in {choice["game_id"] for choice in choices}:
            raise HTTPException(409, "That collection candidate is no longer available. Reload the review list.")
        candidate = db.query(Videogame).filter_by(id=candidate_game_id, user_id=user_id).first()
        if decision == "same" and candidate is None:
            raise HTTPException(409, "The suggested collection game no longer exists. Run the sync again.")
    if review.match_kind == "dlc_parent":
        if decision == "same" and candidate is not None:
            attach_owned_dlc(candidate, item)
            link = db.query(SteamContentLink).filter_by(
                user_id=user_id, steam_id=review.steam_id, steam_appid=review.steam_appid,
            ).first()
            if link is None:
                link = SteamContentLink(
                    user_id=user_id, steam_id=review.steam_id, steam_appid=review.steam_appid,
                    parent_game_id=candidate.id, name=review.steam_name,
                )
                db.add(link)
            link.parent_game_id, link.name = candidate.id, review.steam_name
            link.igdb_id, link.user_selected = item.get("igdb_id"), True
            copy_store.record_audit(
                db, user_id, "dlc_parent_selected", steam_id=review.steam_id,
                steam_appid=review.steam_appid, game_id=candidate.id,
            )
        else:
            suppression = SteamCopyTrash(
                user_id=user_id, steam_id=review.steam_id, steam_appid=review.steam_appid,
                collection_game_id=0, copy_id="", kind="dlc", name=review.steam_name,
                collection_game_name=None, copy_data=json.dumps(item), game_data=None,
            )
            db.add(suppression)
            copy_store.record_audit(
                db, user_id, "dlc_suppressed", steam_id=review.steam_id,
                steam_appid=review.steam_appid, details={"reason": "no_parent_selected"},
            )
        db.delete(review)
        return {"resolved": True, "collection_game_id": candidate.id if candidate else None, "remaining_candidates": 0}
    if decision == "different":
        try:
            rejected = set(json.loads(review.rejected_candidate_ids or "[]"))
        except (TypeError, ValueError):
            rejected = set()
        rejected.add(candidate_game_id)
        remaining = [choice for choice in choices if choice["game_id"] not in rejected]
        if remaining:
            review.rejected_candidate_ids = json.dumps(sorted(rejected))
            review.candidates = json.dumps(remaining)
            review.candidate_game_id = remaining[0]["game_id"]
            review.candidate_name = remaining[0]["name"]
            review.confidence = remaining[0]["confidence"]
            review.updated_at = datetime.utcnow()
            return {"resolved": False, "collection_game_id": None, "remaining_candidates": len(remaining)}
        candidate = Videogame(user_id=user_id, name=review.steam_name, status="Not Started")
        db.add(candidate)
        db.flush()
    elif decision == "none":
        candidate = Videogame(user_id=user_id, name=review.steam_name, status="Not Started")
        db.add(candidate)
        db.flush()
    else:
        # A confirmed identity uses Steam's canonical title while retaining every
        # other user-owned field on the collection record.
        candidate.name = review.steam_name
    links = db.query(SteamCollectionLink).filter_by(
        user_id=user_id, steam_id=review.steam_id, collection_game_id=candidate.id,
    ).filter(SteamCollectionLink.steam_appid.is_not(None)).all()
    link = next((row for row in links if row.steam_appid == review.steam_appid), None)
    canonical = next((row for row in links if row.steam_appid != review.steam_appid), None)
    if decision == "same" and canonical is not None:
        catalog = upsert_steam_catalog(db, user_id, item, review.steam_id)
        catalog.duplicate_of_appid = canonical.steam_appid
        attach_steam_copy(db, candidate, item, item.get("igdb_id"), steam_id=review.steam_id)
        link = db.query(SteamCollectionLink).filter_by(
            user_id=user_id, steam_id=review.steam_id, collection_game_id=candidate.id,
            steam_appid=review.steam_appid,
        ).one()
        link.user_selected = True
    elif link is None:
        attach_steam_copy(db, candidate, item, item.get("igdb_id"), steam_id=review.steam_id)
        link = db.query(SteamCollectionLink).filter_by(
            user_id=user_id, steam_id=review.steam_id, collection_game_id=candidate.id,
            steam_appid=review.steam_appid,
        ).one()
        link.created_collection_game = decision in ("different", "none")
        link.user_selected = True
    else:
        link.user_selected = True
    db.delete(review)
    copy_store.record_audit(
        db, user_id, "match_resolved", steam_id=review.steam_id,
        steam_appid=review.steam_appid, game_id=candidate.id,
        details={"decision": decision},
    )
    db.flush()
    reconcile_steam_library(db, user_id, [item])
    return {"resolved": True, "collection_game_id": candidate.id, "remaining_candidates": 0}


def remove_steam_imports(db, user_id):
    """Remove synced Steam data while retaining local records and non-Steam copies."""
    scope = copy_store.adopt_legacy_scope(db, user_id)
    for game in db.query(Videogame).filter_by(user_id=user_id).all():
        copy_store.ensure_copies(db, game)
    db.flush()
    links = db.query(SteamCollectionLink).filter_by(user_id=user_id, steam_id=scope).filter(
        SteamCollectionLink.steam_appid.is_not(None)
    ).all()
    linked_appids = {link.steam_appid for link in links}
    created_game_ids = {link.collection_game_id for link in links if link.created_collection_game}
    copies_removed = 0
    games_removed = 0

    content_links = db.query(SteamContentLink).filter_by(user_id=user_id, steam_id=scope).all()
    content_appids_by_game = {}
    for content in content_links:
        content_appids_by_game.setdefault(content.parent_game_id, set()).add(content.steam_appid)

    games = db.query(Videogame).filter_by(user_id=user_id).all()
    games_by_id = {game.id: game for game in games}
    for link in links:
        db.delete(link)
        copies_removed += 1
    db.flush()
    for game in games:
        copy_store.project_game(db, game)
        removed_content = content_appids_by_game.get(game.id, set())
        try:
            dlcs = json.loads(game.dlcs or "[]")
        except (TypeError, ValueError):
            dlcs = []
        retained = []
        for row in dlcs:
            if not isinstance(row, dict) or int(row.get("steam_appid") or 0) in removed_content:
                continue
            if row.get("source") == "Steam catalog":
                if row.get("state") == "not_started":
                    continue
                # A changed play state is personal data; retain it as a manual row.
                row = {key: value for key, value in row.items() if key not in (
                    "steam_appid", "source", "store_url", "image_url",
                )}
            retained.append(row)
        if removed_content or len(retained) != len(dlcs) or any(
            row.get("source") == "Steam catalog" for row in dlcs if isinstance(row, dict)
        ):
            game.dlcs = json.dumps(retained) if retained else None

    wanted_removed = 0
    for wanted in db.query(WantedGame).filter_by(user_id=user_id).all():
        if normalized(wanted.source) == "steam":
            db.delete(wanted)
            wanted_removed += 1
            continue
        if wanted.steam_appid in linked_appids:
            wanted.steam_appid = None
            if wanted.store_url and "steampowered.com" in wanted.store_url.casefold():
                wanted.store_url = None

    db.query(SteamMatchReview).filter_by(user_id=user_id, steam_id=scope).delete(synchronize_session=False)
    db.query(SteamContentLink).filter_by(user_id=user_id, steam_id=scope).delete(synchronize_session=False)
    db.query(SteamOwnedGame).filter_by(user_id=user_id, steam_id=scope).delete(synchronize_session=False)
    db.query(SteamCopyTrash).filter_by(user_id=user_id, steam_id=scope).delete(synchronize_session=False)
    db.query(DiscoveryCache).filter(DiscoveryCache.key.like(f"steam-dlcs-import:{user_id}:%")).delete(synchronize_session=False)
    db.flush()

    for game_id in created_game_ids:
        game = games_by_id.get(game_id)
        if game is None:
            continue
        try:
            remaining = json.loads(game.copies or "[]")
        except (TypeError, ValueError):
            remaining = []
        if remaining:
            continue
        user_data = any((
            game.user_modified_at, game.comments, game.mark is not None, game.hype is not None,
            game.tags, game.playtime_hours is not None, game.description,
        ))
        if user_data:
            game.hidden = False
            continue
        db.query(WantedGame).filter_by(user_id=user_id, collection_game_id=game.id).update(
            {"collection_game_id": None, "status": "Wanted"}, synchronize_session=False
        )
        db.delete(game)
        games_removed += 1

    settings = db.get(DiscoverySettings, user_id)
    if settings:
        settings.sync_enabled = False
        settings.last_sync_at = None
        settings.next_sync_at = None
        settings.sync_started_at = None
        settings.sync_error = None
        settings.last_import_count = 0
        settings.last_owned_import_count = 0
        settings.last_igdb_match_count = 0
    copy_store.record_audit(db, user_id, "steam_unsynced", steam_id=scope, details={
        "copies_removed": copies_removed, "games_removed": games_removed, "wanted_removed": wanted_removed,
    })
    return {
        "collection_games_removed": games_removed,
        "steam_copies_removed": copies_removed,
        "wanted_games_removed": wanted_removed,
    }


def _igdb_match_data(game):
    release_date = datetime.utcfromtimestamp(game["first_release_date"]).date().isoformat() if game.get("first_release_date") else None
    image_id = (game.get("cover") or {}).get("image_id")
    return {
        "igdb_id": game["id"], "name": game.get("name") or "",
        "description": game.get("summary"),
        "image_url": f"https://images.igdb.com/igdb/image/upload/t_cover_big/{image_id}.jpg" if image_id else None,
        "release_date": release_date,
        "publication_year": int(release_date[:4]) if release_date else None,
        "is_dlc": game.get("game_type") in IGDB_DLC_TYPES,
        "parent_game_name": (game.get("parent_game") or {}).get("name"),
    }


def nest_known_steam_dlcs(db, user_id):
    """Register identified Steam expansions under a parent without losing standalone cards."""
    scope = copy_store.steam_scope(db, user_id)
    collection = db.query(Videogame).filter_by(user_id=user_id).all()
    matchable = [game for game in collection if not game.hidden and not game.is_dlc and not game.merged_into_game_id]
    by_id = {game.id: game for game in collection}
    moved = 0
    for catalog in db.query(SteamOwnedGame).filter_by(user_id=user_id, steam_id=scope, is_dlc=True, active=True).all():
        if db.query(SteamCopyTrash).filter_by(
            user_id=user_id, steam_id=scope, steam_appid=catalog.steam_appid, kind="dlc",
        ).first():
            continue
        standalone_links = db.query(SteamCollectionLink).filter_by(
            user_id=user_id, steam_id=scope, steam_appid=catalog.steam_appid,
        ).all()
        # Older releases nested DLCs by hiding their existing card and removing
        # its owned-copy link. Restore that card when the catalog still knows
        # the same expansion, so upgrading does not require manual recreation.
        if not standalone_links:
            restorable = next((game for game in collection if (
                game.merged_into_game_id is None
                and game.id != getattr(catalog, "parent_game_id", None)
                and game.is_dlc
                and (
                    (catalog.igdb_id and game.igdb_id == catalog.igdb_id)
                    or (
                        (match := compare_titles(game.name, catalog.name)).compatible
                        and match.automatic and match.score >= 0.98
                    )
                )
            )), None)
            if restorable:
                attach_steam_copy(db, restorable, {
                    "appid": catalog.steam_appid,
                    "name": catalog.name,
                    "playtime_hours": catalog.playtime_hours,
                    "image_url": catalog.image_url,
                    "store_url": catalog.store_url,
                    "igdb_id": catalog.igdb_id,
                }, steam_id=scope)
                standalone_links = db.query(SteamCollectionLink).filter_by(
                    user_id=user_id, steam_id=scope, steam_appid=catalog.steam_appid,
                ).all()
        for link in standalone_links:
            standalone = by_id.get(link.collection_game_id)
            if standalone:
                standalone.is_dlc = True
                standalone.parent_game_name = catalog.parent_game_name
                standalone.hidden = False
        standalone_ids = {link.collection_game_id for link in standalone_links}
        parent_candidates = [game for game in matchable if game.id not in standalone_ids]
        parent = find_parent_game(parent_candidates, catalog.parent_game_name)
        if not parent:
            matches, _automatic = _collection_title_matches(parent_candidates, [catalog.parent_game_name or catalog.name])
            if matches:
                review = db.query(SteamMatchReview).filter_by(
                    user_id=user_id, steam_id=scope, steam_appid=catalog.steam_appid,
                    match_kind="dlc_parent",
                ).first()
                if review is None:
                    review = SteamMatchReview(
                        user_id=user_id, steam_id=scope, steam_appid=catalog.steam_appid,
                        match_kind="dlc_parent",
                    )
                    db.add(review)
                review.steam_name = catalog.name
                review.candidate_game_id, review.candidate_name = matches[0][0].id, matches[0][0].name
                review.confidence = round(matches[0][1], 4)
                review.candidates = json.dumps([
                    {"game_id": game.id, "name": game.name, "confidence": round(score, 4)}
                    for game, score in matches
                ])
                review.steam_data = json.dumps({
                    "appid": catalog.steam_appid, "name": catalog.name,
                    "playtime_hours": catalog.playtime_hours, "image_url": catalog.image_url,
                    "store_url": catalog.store_url, "igdb_id": catalog.igdb_id,
                    "is_dlc": True, "parent_game_name": catalog.parent_game_name,
                })
                review.updated_at = datetime.utcnow()
            continue
        item = {
            "appid": catalog.steam_appid, "name": catalog.name,
            "playtime_hours": catalog.playtime_hours, "image_url": catalog.image_url,
            "store_url": catalog.store_url, "igdb_id": catalog.igdb_id,
        }
        attach_owned_dlc(parent, item)
        content_link = db.query(SteamContentLink).filter_by(
            user_id=user_id, steam_id=scope, steam_appid=catalog.steam_appid,
        ).first()
        if content_link is None:
            content_link = SteamContentLink(
                user_id=user_id, steam_id=scope, steam_appid=catalog.steam_appid,
                parent_game_id=parent.id, name=catalog.name,
            )
            db.add(content_link)
        content_link.parent_game_id, content_link.name = parent.id, catalog.name
        content_link.igdb_id, content_link.updated_at = catalog.igdb_id, datetime.utcnow()
        for wanted in db.query(WantedGame).filter_by(user_id=user_id, steam_appid=catalog.steam_appid).all():
            wanted.status, wanted.collection_game_id = "Acquired", parent.id
            wanted.steam_wishlist_missing, wanted.updated_at = False, datetime.utcnow()
        for link in standalone_links:
            old = by_id.get(link.collection_game_id)
            if old and old.id != parent.id:
                old.is_dlc = True
                old.parent_game_id = parent.id
                old.parent_game_name = parent.name
                old.hidden = False
                copy_store.project_game(db, old)
                dlc_links.sync_child_to_parent(db, old)
        db.query(SteamMatchReview).filter_by(
            user_id=user_id, steam_id=scope, steam_appid=catalog.steam_appid, match_kind="dlc_parent",
        ).delete(synchronize_session=False)
        moved += 1
    return moved


def _closest_igdb_game(title, expected_dlc, games):
    best, best_score = None, 0.0
    for game in games:
        match = compare_titles(title, game.get("name"))
        if not is_reviewable_title_match(match):
            continue
        score = match.score
        candidate_dlc = game.get("game_type") in IGDB_DLC_TYPES
        score += 0.08 if candidate_dlc == expected_dlc else -0.18
        if match.automatic and score > best_score:
            best, best_score = game, score
    return best if best_score >= 0.82 else None


def enrich_steam_with_igdb(db, client, user_id):
    """Fill missing metadata using exact Steam links first, then a guarded title match."""
    from dotenv import load_dotenv
    from ..routers.igdb_router import _get_twitch_token

    load_dotenv()
    client_id = os.getenv("TWITCH_SECRET_CLIENT_ID", "").strip()
    if not client_id or not os.getenv("TWITCH_SECRET", "").strip():
        return 0, None

    scope = copy_store.steam_scope(db, user_id)
    wanted_rows = db.query(WantedGame).filter_by(user_id=user_id, deleted=False).filter(WantedGame.steam_appid.is_not(None)).all()
    collection_rows = db.query(Videogame).filter_by(user_id=user_id).all()
    catalog_rows = db.query(SteamOwnedGame).filter_by(user_id=user_id, steam_id=scope, active=True).all()
    targets = {}
    for row in wanted_rows:
        if row.igdb_id is None:
            targets.setdefault(row.steam_appid, {"name": row.name, "is_dlc": row.is_dlc})
    for row in collection_rows:
        for owned_copy in db.query(SteamCollectionLink).filter_by(
            user_id=user_id, steam_id=scope, collection_game_id=row.id,
        ).filter(SteamCollectionLink.steam_appid.is_not(None)).all():
            if not owned_copy.igdb_id:
                targets.setdefault(int(owned_copy.steam_appid), {"name": row.name, "is_dlc": row.is_dlc})
    for row in catalog_rows:
        if row.igdb_id is None:
            targets.setdefault(row.steam_appid, {"name": row.name, "is_dlc": row.is_dlc})
    if not targets:
        return 0, None

    try:
        token = _get_twitch_token()
        headers = {"Client-ID": client_id, "Authorization": f"Bearer {token}", "Content-Type": "text/plain"}

        def post(path, body):
            response = client.post(f"https://api.igdb.com/v4/{path}", headers=headers, content=body.encode())
            if response.status_code == 429:
                raise UpstreamRateLimit("IGDB is rate limiting auto-completion; unmatched games will retry next sync.")
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, list):
                raise ValueError("IGDB returned an unexpected auto-completion response.")
            return result

        matches, uncached = {}, []
        for appid in targets:
            cached = db.get(DiscoveryCache, f"igdb-steam:{appid}")
            if cached and cached.updated_at > datetime.utcnow() - timedelta(days=30):
                match = json.loads(cached.payload).get("match")
                if match:
                    matches[appid] = match
            else:
                uncached.append(appid)

        game_ids_by_app = {}
        for offset in range(0, len(uncached), 500):
            appids = uncached[offset:offset + 500]
            quoted = ",".join(json.dumps(str(appid)) for appid in appids)
            body = f"fields uid,game; where external_game_source = {IGDB_STEAM_SOURCE_ID} & uid = ({quoted}); limit 500;"
            for external in post("external_games", body):
                try:
                    game_ids_by_app[int(external["uid"])] = int(external["game"])
                except (KeyError, TypeError, ValueError):
                    continue

        exact_games = {}
        game_ids = sorted(set(game_ids_by_app.values()))
        fields = "id,name,cover.image_id,summary,first_release_date,game_type,parent_game.name"
        for offset in range(0, len(game_ids), 500):
            ids = ",".join(str(value) for value in game_ids[offset:offset + 500])
            for game in post("games", f"fields {fields}; where id = ({ids}); limit 500;"):
                exact_games[game["id"]] = game
        for appid, game_id in game_ids_by_app.items():
            if game_id in exact_games:
                matches[appid] = _igdb_match_data(exact_games[game_id])

        fuzzy_ids = [appid for appid in uncached if appid not in matches][:40]
        for appid in fuzzy_ids:
            target = targets[appid]
            games = post("games", f"search {json.dumps(target['name'])}; fields {fields}; limit 10;")
            closest = _closest_igdb_game(target["name"], target["is_dlc"], games)
            if closest:
                matches[appid] = _igdb_match_data(closest)
            time.sleep(0.27)

        attempted = set(game_ids_by_app) | set(fuzzy_ids)
        for appid in attempted:
            cached = db.get(DiscoveryCache, f"igdb-steam:{appid}")
            if cached is None:
                cached = DiscoveryCache(key=f"igdb-steam:{appid}")
                db.add(cached)
            cached.payload = json.dumps({"match": matches.get(appid)})
            cached.updated_at = datetime.utcnow()

        matched_appids = set()
        wanted_by_app = {row.steam_appid: row for row in wanted_rows}
        for appid, match in matches.items():
            wanted = wanted_by_app.get(appid)
            if wanted and wanted.igdb_id is None:
                wanted.igdb_id = match["igdb_id"]
                for key in ("description", "image_url", "release_date", "publication_year", "parent_game_name"):
                    if getattr(wanted, key) in (None, "") and match.get(key) not in (None, ""):
                        setattr(wanted, key, match[key])
                wanted.is_dlc = wanted.is_dlc or match["is_dlc"]
                wanted.updated_at = datetime.utcnow()
                matched_appids.add(appid)
            catalog = next((row for row in catalog_rows if row.steam_appid == appid), None)
            if catalog:
                catalog.igdb_id = catalog.igdb_id or match["igdb_id"]
                catalog.is_dlc = catalog.is_dlc or match["is_dlc"]
                catalog.parent_game_name = catalog.parent_game_name or match.get("parent_game_name")
                catalog.image_url = catalog.image_url or match.get("image_url")
                catalog.updated_at = datetime.utcnow()
        for row in collection_rows:
            changed = False
            owned_rows = db.query(SteamCollectionLink).filter_by(
                user_id=user_id, steam_id=scope, collection_game_id=row.id,
            ).filter(SteamCollectionLink.steam_appid.is_not(None)).all()
            for owned_copy in owned_rows:
                match = matches.get(owned_copy.steam_appid)
                if match and not owned_copy.igdb_id:
                    owned_copy.igdb_id = match["igdb_id"]
                    changed = True
                    matched_appids.add(owned_copy.steam_appid)
                    row.igdb_id = row.igdb_id or match["igdb_id"]
                    for key in ("description", "image_url", "release_date", "publication_year", "parent_game_name"):
                        if getattr(row, key) in (None, "") and match.get(key) not in (None, ""):
                            setattr(row, key, match[key])
                    row.is_dlc = row.is_dlc or match["is_dlc"]
            if changed:
                copy_store.project_game(db, row, db.query(SteamCollectionLink).filter_by(
                    user_id=user_id, collection_game_id=row.id,
                ).order_by(SteamCollectionLink.position, SteamCollectionLink.id).all())
        if matches:
            for link in db.query(SteamCollectionLink).filter_by(user_id=user_id, steam_id=scope).filter(
                SteamCollectionLink.steam_appid.is_not(None)
            ).all():
                match = matches.get(link.steam_appid)
                if match and link.igdb_id is None:
                    link.igdb_id = match["igdb_id"]
        return len(matched_appids), None
    except (httpx.HTTPError, HTTPException, ValueError, KeyError) as exc:
        logger.warning("IGDB Steam auto-completion failed for user %s: %s", user_id, type(exc).__name__)
        return 0, f"IGDB auto-completion could not finish: {str(exc)[:300]}"


def steam_details(db, client, appid):
    key = f"steam:{appid}"
    cached = db.get(DiscoveryCache, key)
    if cached and cached.updated_at > datetime.utcnow() - timedelta(days=7):
        return json.loads(cached.payload)
    raw = request_json(client, "https://store.steampowered.com/api/appdetails", params={"appids": appid, "l": "english"})
    result = raw.get(str(appid), {})
    if not result.get("success") or not result.get("data", {}).get("name"):
        raise ValueError(f"Metadata for Steam app {appid} is unavailable; it will be retried.")
    data = result["data"]
    release = data.get("release_date", {}).get("date", "")
    release_date = None
    for pattern in ("%d %b, %Y", "%b %d, %Y", "%d %B, %Y", "%B %d, %Y"):
        try:
            release_date = datetime.strptime(release, pattern).date().isoformat()
            break
        except ValueError:
            pass
    fields = {
        "name": data["name"], "description": html.unescape(re.sub(r"<[^>]*>", "", data.get("short_description", ""))),
        "image_url": data.get("header_image"), "platform": "PC", "format": "Digital",
        "release_date": release_date, "publication_year": int(release_date[:4]) if release_date else None,
        # External genres are reference metadata, not the user's personal tags.
        "tags": None,
        "is_dlc": data.get("type") == "dlc", "parent_game_name": data.get("fullgame", {}).get("name"),
        "steam_appid": appid, "store_url": f"https://store.steampowered.com/app/{appid}/",
    }
    if cached is None:
        cached = DiscoveryCache(key=key)
        db.add(cached)
    cached.payload, cached.updated_at = json.dumps(fields), datetime.utcnow()
    # Pace uncached store requests; Steam does not support batching full appdetails.
    time.sleep(0.4)
    return fields


def steam_dlc_catalog(db, client, appid, force_refresh=False):
    """Read a game's public Steam DLC list, including names, in one request."""
    key = f"steam-dlcs:{appid}"
    cached = db.get(DiscoveryCache, key)
    if not force_refresh and cached and cached.updated_at > datetime.utcnow() - timedelta(days=7):
        try:
            entries = json.loads(cached.payload)
            if isinstance(entries, list) and all(
                isinstance(item, dict)
                and isinstance(item.get("appid"), int)
                and isinstance(item.get("name"), str)
                for item in entries
            ):
                return entries
        except (TypeError, ValueError):
            pass
    raw = request_json(client, "https://store.steampowered.com/api/dlcforapp", params={
        "appid": appid, "l": "english",
    })
    if isinstance(raw, dict) and raw.get("status") == 2:
        raw = {"dlc": []}
    if not isinstance(raw, dict) or not isinstance(raw.get("dlc"), list):
        raise ValueError(f"Steam DLC metadata for app {appid} is unavailable; it will be retried.")
    entries = []
    seen = set()
    for item in raw["dlc"]:
        if not isinstance(item, dict):
            continue
        dlc_id, name = item.get("id"), item.get("name")
        if not isinstance(dlc_id, int) or dlc_id <= 0 or not isinstance(name, str) or not name.strip() or dlc_id in seen:
            continue
        seen.add(dlc_id)
        entries.append({"appid": dlc_id, "name": name.strip(), "image_url": item.get("header_image")})
    if cached is None:
        cached = DiscoveryCache(key=key)
        db.add(cached)
    cached.payload, cached.updated_at = json.dumps(entries), datetime.utcnow()
    return entries


def import_steam_dlc_catalogs(db, client, user_id, max_requests=150):
    """Sync public Steam DLCs while retaining manual entries and personal states."""
    scope = copy_store.steam_scope(db, user_id)
    games = {game.id: game for game in db.query(Videogame).filter_by(user_id=user_id).all()
             if not game.hidden and not game.is_dlc and not game.merged_into_game_id}
    links = db.query(SteamCollectionLink).filter_by(user_id=user_id, steam_id=scope).filter(
        SteamCollectionLink.steam_appid.is_not(None)
    ).order_by(SteamCollectionLink.collection_game_id, SteamCollectionLink.id).all()
    sources = {(link.collection_game_id, int(link.steam_appid)) for link in links}
    for game in games.values():
        try:
            rows = json.loads(game.dlcs or "[]")
        except (TypeError, ValueError):
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict) and row.get("steam_parent_appid"):
                try:
                    appid = int(row["steam_parent_appid"])
                except (TypeError, ValueError):
                    continue
                if appid > 0:
                    sources.add((game.id, appid))
    requests, added, pending = 0, 0, 0
    since_commit = 0
    for game_id, appid in sorted(sources):
        game = games.get(game_id)
        if game is None:
            continue
        catalog_key = f"steam-dlcs:{appid}"
        cached = db.get(DiscoveryCache, catalog_key)
        fresh = cached and cached.updated_at > datetime.utcnow() - timedelta(days=7)
        marker_key = f"steam-dlcs-import:{user_id}:{game.id}:{appid}"
        marker = db.get(DiscoveryCache, marker_key)
        if not fresh and requests >= max_requests:
            pending += 1
            continue
        if not fresh:
            requests += 1
            since_commit += 1
        try:
            catalog = steam_dlc_catalog(db, client, appid)
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            logger.warning("Steam DLC catalog lookup failed for app %s: %s", appid, type(exc).__name__)
            pending += 1
            if isinstance(exc, UpstreamRateLimit):
                break
            continue
        try:
            seen = set(json.loads(marker.payload)) if marker else set()
            dlcs = json.loads(game.dlcs or "[]")
            if not isinstance(dlcs, list):
                dlcs = []
        except (TypeError, ValueError):
            seen, dlcs = set(), []
        merged, new_count, seen = dlc_catalog.merge_catalog(dlcs, catalog, appid, game.name, seen)
        added += new_count
        if merged != dlcs:
            game.dlcs = json.dumps(merged)
            game.version = (game.version or 1) + 1
        if marker is None:
            marker = DiscoveryCache(key=marker_key)
            db.add(marker)
        marker.payload, marker.updated_at = json.dumps(sorted(seen)), datetime.utcnow()
        # Release SQLite's writer lock between batches of Store requests.
        if since_commit >= 20:
            db.commit()
            since_commit = 0
    return added, (f"Steam DLC lookup is still pending for {pending} {'game' if pending == 1 else 'games'}; the next sync will continue." if pending else None)


def claim_sync(db, user_id, force=False):
    now = datetime.utcnow()
    settings = db.get(DiscoverySettings, user_id)
    if not settings or not settings.steam_id:
        return False
    query = db.query(DiscoverySettings).filter(
        DiscoverySettings.user_id == user_id,
        or_(DiscoverySettings.sync_started_at.is_(None), DiscoverySettings.sync_started_at < now - timedelta(hours=1)),
    )
    if not force:
        query = query.filter(DiscoverySettings.sync_enabled.is_(True), or_(DiscoverySettings.next_sync_at.is_(None), DiscoverySettings.next_sync_at <= now, DiscoverySettings.sync_started_at < now - timedelta(hours=1)))
    elif settings.last_sync_at and settings.last_sync_at > now - timedelta(minutes=5):
        raise HTTPException(429, "Please wait five minutes between manual Steam syncs.")
    claimed = query.update({"sync_started_at": now, "next_sync_at": now + timedelta(hours=settings.sync_hours), "sync_error": None, "sync_warning": None}, synchronize_session=False)
    db.commit()
    db.refresh(settings)
    return bool(claimed)


def sync_steam(user_id, factory=SessionLocal):
    db = factory()
    stage = "connection setup"
    try:
        settings = db.get(DiscoverySettings, user_id)
        if not settings or not settings.steam_id:
            return
        count, skipped = 0, 0
        steam_id = settings.steam_id
        with httpx.Client(timeout=20, headers={"User-Agent": "EpicTracker/1.0"}) as client:
            stage = "wishlist retrieval"
            items = steam_wishlist(client, steam_id) if settings.sync_wishlist else []
            owned_items, owned_error = [], None
            if settings.sync_collection:
                stage = "owned-library retrieval"
                try:
                    owned_items = steam_owned_games(client, steam_id, resolve_steam_api_key(settings.steam_api_key))
                except (httpx.HTTPError, ValueError, KeyError) as exc:
                    owned_error = str(exc)[:500]
            wanted_rows = db.query(WantedGame).filter_by(user_id=user_id).all()
            existing_ids = {row.steam_appid for row in wanted_rows if row.steam_appid}
            owned_names = {normalized(row.name) for row in db.query(Videogame).filter_by(user_id=user_id).all()}
            wishlist_ids = {item["appid"] for item in items}
            if settings.sync_wishlist:
                for row in wanted_rows:
                    if row.steam_appid and not row.deleted and row.status != "Acquired":
                        row.steam_wishlist_missing = row.steam_appid not in wishlist_ids
            missing = list(dict.fromkeys(item["appid"] for item in items if item["appid"] not in existing_ids))
            deadline = time.monotonic() + 300
            processed = 0
            stage = "wishlist import"
            for appid in missing[:500]:
                if time.monotonic() >= deadline:
                    break
                processed += 1
                try:
                    fields = steam_details(db, client, appid)
                except UpstreamRateLimit:
                    skipped += 1
                    break
                except (httpx.HTTPError, ValueError, KeyError):
                    skipped += 1
                    continue
                duplicate = find_duplicate(db, user_id, fields)
                if duplicate:
                    # Attach the Steam identity without overwriting ANY local field.
                    if duplicate.steam_appid is None:
                        duplicate.steam_appid = appid
                    duplicate.steam_id = steam_id
                    duplicate.steam_wishlist_missing = False
                elif normalized(fields["name"]) not in owned_names:
                    db.add(WantedGame(user_id=user_id, steam_id=steam_id, source="steam", **fields))
                    count += 1
                # Release SQLite's write lock between network requests. Completed
                # rows are durable even if the process stops during a large import.
                db.commit()
            if settings.sync_collection and owned_error is None:
                settings.owned_sync_generation = (settings.owned_sync_generation or 0) + 1
                db.query(SteamOwnedGame).filter_by(user_id=user_id, steam_id=steam_id).filter(
                    SteamOwnedGame.stats_verified.is_(False),
                    SteamOwnedGame.user_verified.is_(False),
                ).update(
                    {"active": False}, synchronize_session=False,
                )
                db.flush()
            stage = "owned-library import"
            owned_count = reconcile_steam_library(db, user_id, owned_items) if settings.sync_collection and owned_error is None else 0
            # Keep the owned snapshot transaction short. IGDB enrichment performs
            # network I/O and must not hold SQLite's writer lock while waiting.
            db.commit()
            stage = "IGDB enrichment"
            igdb_count, igdb_error = enrich_steam_with_igdb(db, client, user_id)
            if settings.sync_collection:
                stage = "known DLC linking"
                nest_known_steam_dlcs(db, user_id)
                db.commit()
                dlc_error = None
                try:
                    _, dlc_error = import_steam_dlc_catalogs(db, client, user_id)
                except Exception:
                    # DLC discovery is supplementary. Keep the committed library
                    # snapshot and retry this step at the next sync.
                    db.rollback()
                    logger.exception("Steam DLC catalog import failed for user %s", user_id)
                    settings = db.get(DiscoverySettings, user_id)
                    dlc_error = "Steam DLC import could not finish; the next sync will retry."
            else:
                dlc_error = None
            stage = "sync status save"
            settings.last_sync_at = datetime.utcnow()
            if settings.sync_wishlist:
                settings.last_import_count = count
            if settings.sync_collection:
                settings.last_owned_import_count = owned_count
            settings.last_igdb_match_count = igdb_count
            pending = skipped + len(missing) - processed
            warnings = [message for message in (
                f"{pending} games still need Steam metadata; they will be retried next sync." if pending else None,
                igdb_error,
                dlc_error,
            ) if message]
            settings.sync_error = owned_error
            settings.sync_warning = " ".join(warnings) or None
            settings.sync_started_at = None
            db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("Steam sync failed for user %s during %s: %s", user_id, stage, type(exc).__name__)
        settings = db.get(DiscoverySettings, user_id)
        if settings:
            if isinstance(exc, ValueError):
                message = str(exc)[:500]
            elif isinstance(exc, httpx.ConnectError):
                message = "Could not reach Steam. Check the backend internet connection; saved games are unchanged and the next sync will retry."
            elif isinstance(exc, httpx.TimeoutException):
                message = "Steam did not respond in time. Saved games are unchanged and the next sync will retry."
            else:
                message = f"Steam sync failed during {stage}. Saved games and completed imports are kept; the next sync will retry."
            settings.sync_error = message
            settings.sync_warning = None
            settings.sync_started_at = None
            db.commit()
    finally:
        db.close()


def sync_due_wishlists():
    with SessionLocal() as db:
        now = datetime.utcnow()
        ids = [row.user_id for row in db.query(DiscoverySettings).filter(
            DiscoverySettings.sync_enabled.is_(True), DiscoverySettings.steam_id.is_not(None),
            or_(DiscoverySettings.next_sync_at.is_(None), DiscoverySettings.next_sync_at <= now, DiscoverySettings.sync_started_at < now - timedelta(hours=1)),
        ).all()]
    for user_id in ids:
        with SessionLocal() as db:
            claimed = claim_sync(db, user_id)
        if claimed:
            sync_steam(user_id)


def sync_due_dlc_catalogs():
    """Refresh public DLC catalogs independently of Steam account synchronization."""
    now = datetime.utcnow()
    with SessionLocal() as db, httpx.Client(timeout=20, headers={"User-Agent": "EpicTracker/1.0"}) as client:
        user_ids = [row[0] for row in db.query(Videogame.user_id).distinct().all()]
        for user_id in user_ids:
            key = f"steam-dlc-user-run:{user_id}"
            marker = db.get(DiscoveryCache, key)
            if marker and marker.updated_at > now - timedelta(days=1):
                continue
            try:
                _, warning = import_steam_dlc_catalogs(db, client, user_id, max_requests=25)
                if marker is None:
                    marker = DiscoveryCache(key=key)
                    db.add(marker)
                marker.payload = "{}"
                # Continue bounded batches hourly, and otherwise check daily.
                marker.updated_at = now - timedelta(hours=23) if warning else now
                db.commit()
            except Exception:
                db.rollback()
                logger.exception("Public Steam DLC sync failed for user %s", user_id)


async def scheduler():
    while True:
        for task in (sync_due_wishlists, sync_due_dlc_catalogs):
            try:
                await asyncio.to_thread(task)
            except Exception:
                logger.exception("Discovery scheduler tick failed during %s", task.__name__)
        await asyncio.sleep(60)


def month_window(today=None):
    today = today or date.today()
    current = today.replace(day=1)
    previous = (current - timedelta(days=1)).replace(day=1)
    following = (current + timedelta(days=32)).replace(day=1)
    return previous, current, following


def _release_platform(value):
    value = value or ""
    if re.search(r"Switch\s*1\s*(?:&|and)\s*2", value, re.I):
        return "Nintendo Switch / Nintendo Switch 2"
    if re.search(r"Switch\s*2", value, re.I):
        return "Nintendo Switch 2"
    return "Nintendo Switch"


def _clean_retail_title(value):
    value = html.unescape(" ".join((value or "").split()))
    value = re.sub(r"\s+for\s+Nintendo\s+Switch(?:\s*[12])?$", "", value, flags=re.I)
    value = re.sub(r"\s*[-–—]\s*(?:Nintendo\s+)?Switch(?:\s*[12])?(?:\s*[,–—-].*)?$", "", value, flags=re.I)
    value = re.sub(r"\s+Nintendo\s+Switch(?:\s*[12])?(?:\s*,\s*Game-Key Card)?$", "", value, flags=re.I)
    return value.strip()


def _release_title_key(value):
    value = html.unescape(value or "").replace("�", " ")
    value = re.sub(r"Nintendo\s+Switch(?:\s*™)?\s*2?\s+Edition", "", value, flags=re.I)
    value = re.sub(r"[^a-z0-9]+", " ", value.casefold())
    return " ".join(value.split())


def _retail_notes(value, platform):
    details = [platform]
    lowered = (value or "").casefold()
    if "game-key card" in lowered or "game key card" in lowered:
        details.append("Game-Key Card")
    elif "code-in-box" in lowered or "code in box" in lowered:
        details.append("Code in box")
    else:
        details.append("Retail physical edition")
    return " | ".join(details)


def _parse_retail_date(value, previous, following):
    value = re.sub(r"(\d)(?:st|nd|rd|th)", r"\1", value or "", flags=re.I)
    if not re.search(r"\b\d{4}\b", value):
        month_probe = date_parser.parse(f"{value} 2000", fuzzy=True, dayfirst=True)
        year = previous.year if month_probe.month == previous.month else (following - timedelta(days=1)).year
        value = f"{value} {year}"
    return date_parser.parse(value, fuzzy=True, dayfirst=True).date()


def _parse_nintendo_life_guide(page_html, source_url, previous, following, catalog_lookup=None):
    """Extract factual retail title/date/platform data from a monthly guide."""
    root = lxml_html.fromstring(page_html)
    games = []

    def add(title, date_text, context, image_url=None):
        try:
            release_date = _parse_retail_date(date_text, previous, following)
        except (ValueError, TypeError, OverflowError):
            return
        if not previous <= release_date < following:
            return
        platform = _release_platform(context)
        name = _clean_retail_title(title)
        if not name:
            return
        games.append({
            "id": f"nintendolife:{normalized(name)}:{release_date}:{normalized(platform)}",
            "name": name,
            "release_date": release_date.isoformat(),
            "image_url": image_url,
            "source_url": source_url,
            "region": "Europe",
            "description": None,
            "source": "Nintendo Life",
            "platform": platform,
            "notes": _retail_notes(context, platform),
        })

    heading_pattern = re.compile(
        r"^(.*?)\s+[-–—]\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\s*(?:\((.*?)\))?$",
        re.I,
    )
    for heading in root.xpath("//h3"):
        text = " ".join(heading.text_content().split())
        match = heading_pattern.match(text)
        if match:
            context_parts = [match.group(3) or "", text]
            for sibling in heading.itersiblings():
                if not isinstance(sibling.tag, str):
                    continue
                if sibling.tag in ("h2", "h3"):
                    break
                if sibling.tag in ("p", "blockquote") or (sibling.tag == "aside" and "article-products" in (sibling.get("class") or "")):
                    context_parts.append(" ".join(sibling.text_content().split()))
            add(match.group(1), match.group(2), " ".join(context_parts))

    more_sections = [node for node in root.xpath("//h2") if "More Upcoming Games" in " ".join(node.text_content().split())]
    if more_sections:
        for sibling in more_sections[0].itersiblings():
            if sibling.tag == "h2":
                break
            for item in sibling.xpath(".//div[contains(concat(' ', normalize-space(@class), ' '), ' item ')]"):
                title_links = item.xpath(".//div[contains(concat(' ', normalize-space(@class), ' '), ' title ')]/a[1]")
                if not title_links:
                    continue
                title = title_links[0].get("title") or title_links[0].text_content()
                images = item.xpath(".//img[1]/@src")
                dates = item.xpath(".//span[contains(concat(' ', normalize-space(@class), ' '), ' date ')]")
                date_text = dates[0].text_content() if dates else None
                if not date_text and catalog_lookup:
                    matches = catalog_lookup.get(_release_title_key(_clean_retail_title(title)), [])
                    expected_platform = _release_platform(title)
                    match = next((row for row in matches if row["platform"] == expected_platform), matches[0] if matches else None)
                    date_text = match["release_date"] if match else None
                if date_text:
                    add(title, date_text, title, images[0] if images else None)

    unique = {}
    for game in games:
        key = (normalized(game["name"]), game["release_date"], game["platform"])
        unique.setdefault(key, game)
    return sorted(unique.values(), key=lambda game: (game["release_date"], game["name"]))


def _nintendo_life_retail_releases(db, previous, current, following):
    key = f"nintendolife-retail:{current:%Y-%m}"
    cached = db.get(DiscoveryCache, key)
    if cached and cached.updated_at > datetime.utcnow() - timedelta(hours=24):
        return json.loads(cached.payload), cached.updated_at

    with httpx.Client(timeout=25, follow_redirects=True, headers={"User-Agent": "EpicTracker/1.0"}) as client:
        feed = client.get(NINTENDO_LIFE_GUIDES_FEED)
        feed.raise_for_status()
        guide_urls = re.findall(r"<link>(https://www\.nintendolife\.com/guides/upcoming-nintendo-switch[^<]+)</link>", feed.text, re.I)
        current_name = current.strftime("%B").casefold()
        current_guides = [url for url in guide_urls if current_name in url.casefold() and str(current.year) in url]
        previous_slug = f"{previous:%B}-and-{current:%B}-{current.year}".casefold()
        if previous.year != current.year:
            previous_slug = f"{previous:%B}-{previous.year}-and-{current:%B}-{current.year}".casefold()
        previous_url = f"https://www.nintendolife.com/guides/upcoming-nintendo-switch-2-games-and-accessories-for-{previous_slug}"
        candidates = list(dict.fromkeys(current_guides + [previous_url]))
        catalog_lookup = {}
        try:
            catalog_response = client.get("https://searching.nintendo-europe.com/en/select", params={
                "q": "*", "fq": f"type:GAME AND system_type:nintendoswitch AND date_from:[{previous}T00:00:00Z TO {following}T00:00:00Z}}",
                "rows": 500, "wt": "json", "sort": "date_from asc, fs_id asc",
            })
            catalog_response.raise_for_status()
            for row in catalog_response.json()["response"]["docs"]:
                if not row.get("title") or not row.get("date_from"):
                    continue
                system_names = " ".join(row.get("system_names_txt") or [])
                platform = "Nintendo Switch 2" if "Switch 2" in system_names else "Nintendo Switch"
                catalog_lookup.setdefault(_release_title_key(row["title"]), []).append({
                    "release_date": row["date_from"][:10], "platform": platform,
                })
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            pass
        games = []
        for source_url in candidates:
            try:
                page = client.get(source_url)
                page.raise_for_status()
                games.extend(_parse_nintendo_life_guide(page.text, source_url, previous, following, catalog_lookup))
            except httpx.HTTPError:
                continue
    if not games:
        raise ValueError("Nintendo Life monthly retail guide contained no dated releases")
    unique = {}
    for game in games:
        unique.setdefault((normalized(game["name"]), game["release_date"], game["platform"]), game)
    games = sorted(unique.values(), key=lambda game: (game["release_date"], game["name"]))
    if cached is None:
        cached = DiscoveryCache(key=key)
        db.add(cached)
    cached.payload, cached.updated_at = json.dumps(games), datetime.utcnow()
    db.commit()
    return games, cached.updated_at


def _igdb_physical_releases(db, region, previous, current, following):
    """Fallback source using IGDB's documented physical-product links.

    IGDB connects release dates to separately curated physical external products.
    Coverage is less complete than Nintendo's catalog, so this is intentionally a
    fallback and its limitation is returned to the UI.
    """
    key = f"igdb-physical:{region}:{current:%Y-%m}"
    cached = db.get(DiscoveryCache, key)
    if cached and cached.updated_at > datetime.utcnow() - timedelta(hours=24):
        return json.loads(cached.payload), cached.updated_at

    from dotenv import load_dotenv
    from ..routers.igdb_router import _get_twitch_token

    load_dotenv()
    client_id = os.getenv("TWITCH_SECRET_CLIENT_ID", "").strip()
    if not client_id:
        raise ValueError("IGDB client ID is not configured")
    headers = {"Client-ID": client_id, "Authorization": f"Bearer {_get_twitch_token()}", "Accept": "application/json"}
    products = {}
    start_timestamp = int(datetime.combine(previous, datetime.min.time(), tzinfo=timezone.utc).timestamp())
    end_timestamp = int(datetime.combine(following, datetime.min.time(), tzinfo=timezone.utc).timestamp())

    with httpx.Client(timeout=25, headers=headers) as client:
        for offset in range(0, 10000, 500):
            body = (
                "fields game,name,url,countries; "
                f"where platform={IGDB_SWITCH_PLATFORM_ID} & game_release_format={IGDB_PHYSICAL_FORMAT_ID}; "
                f"limit 500; offset {offset};"
            )
            response = client.post("https://api.igdb.com/v4/external_games", content=body)
            response.raise_for_status()
            rows = response.json()
            for row in rows:
                if row.get("game"):
                    products.setdefault(row["game"], row)
            if len(rows) < 500:
                break
            time.sleep(0.3)

        release_rows = []
        game_ids = list(products)
        for batch_start in range(0, len(game_ids), 300):
            ids = ",".join(map(str, game_ids[batch_start:batch_start + 300]))
            offset = 0
            while True:
                body = (
                    "fields date,human,release_region,game.name,game.slug,game.cover.image_id,game.summary; "
                    f"where platform={IGDB_SWITCH_PLATFORM_ID} & game=({ids}) "
                    f"& date >= {start_timestamp} & date < {end_timestamp}; "
                    f"sort date asc; limit 500; offset {offset};"
                )
                response = client.post("https://api.igdb.com/v4/release_dates", content=body)
                response.raise_for_status()
                page = response.json()
                release_rows.extend(page)
                if len(page) < 500:
                    break
                offset += len(page)
                time.sleep(0.3)
            time.sleep(0.3)

    region_id = IGDB_REGION_IDS[region]
    selected = {}
    for row in release_rows:
        release_region = row.get("release_region")
        if release_region not in (None, region_id, 8):
            continue
        game = row.get("game") or {}
        game_id = game.get("id")
        if not game_id or not row.get("date"):
            continue
        existing = selected.get(game_id)
        # Prefer a date explicitly assigned to the selected region over worldwide.
        if existing and existing.get("release_region") == region_id:
            continue
        selected[game_id] = row

    games = []
    for game_id, row in selected.items():
        game = row["game"]
        product = products[game_id]
        image_id = (game.get("cover") or {}).get("image_id")
        games.append({
            "id": f"igdb:{game_id}",
            "name": game.get("name") or product.get("name") or "Unknown game",
            "release_date": datetime.fromtimestamp(row["date"], tz=timezone.utc).date().isoformat(),
            "image_url": f"https://images.igdb.com/igdb/image/upload/t_cover_big/{image_id}.jpg" if image_id else None,
            "source_url": product.get("url") or f"https://www.igdb.com/games/{game.get('slug', '')}",
            "region": region,
            "description": game.get("summary"),
            "source": "IGDB",
            "platform": "Nintendo Switch",
            "notes": "Nintendo Switch | Physical format verified by an IGDB external product.",
        })

    if cached is None:
        cached = DiscoveryCache(key=key)
        db.add(cached)
    cached.payload, cached.updated_at = json.dumps(games), datetime.utcnow()
    db.commit()
    return games, cached.updated_at


def nintendo_releases(db, region="Europe"):
    previous, current, following = month_window()
    base = {"start": previous.isoformat(), "end": following.isoformat(), "months": [previous.strftime("%Y-%m"), current.strftime("%Y-%m")],
            "source": "Nintendo Europe catalog", "region": region,
            "coverage": "Nintendo-listed Switch titles with a physical edition. Catalog release dates can differ from retail dates; limited-print and unlisted releases may be missing."}
    if region != "Europe":
        try:
            games, updated_at = _igdb_physical_releases(db, region, previous, current, following)
            return {**base, "source": "IGDB physical products", "games": games, "updated_at": updated_at,
                    "coverage": "IGDB Switch releases linked to a physical external product. Coverage may be incomplete.",
                    "warning": None if games else "IGDB has no physically verified releases for this region and period."}
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return {**base, "games": [], "updated_at": None,
                    "warning": "The physical-release sources are temporarily unavailable."}
    key = f"nintendo:Europe:{current:%Y-%m}"
    cached = db.get(DiscoveryCache, key)
    nintendo_games, source_updates, warnings = [], [], []
    if cached and cached.updated_at > datetime.utcnow() - timedelta(hours=24):
        nintendo_games = json.loads(cached.payload)
        source_updates.append(cached.updated_at)
    else:
        try:
            nintendo_games, offset = [], 0
            with httpx.Client(timeout=20) as client:
                while True:
                    raw = request_json(client, "https://searching.nintendo-europe.com/en/select", params={
                        "q": "*", "fq": f"type:GAME AND system_type:nintendoswitch AND physical_version_b:true AND date_from:[{previous}T00:00:00Z TO {following}T00:00:00Z}}",
                        "rows": 200, "start": offset, "wt": "json", "sort": "date_from asc, fs_id asc",
                    })
                    response = raw["response"]
                    docs = response["docs"]
                    for item in docs:
                        if not item.get("physical_version_b") or not item.get("date_from"):
                            continue
                        system_names = " ".join(item.get("system_names_txt") or [])
                        platform = "Nintendo Switch 2" if "Switch 2" in system_names else "Nintendo Switch"
                        nintendo_games.append({"id": f"nintendo:{item['fs_id']}", "name": item["title"], "release_date": item["date_from"][:10],
                                               "image_url": item.get("image_url_h2x1_s") or item.get("image_url_sq_s"),
                                               "source_url": urljoin("https://www.nintendo.com", item["url"]), "region": "Europe",
                                               "description": item.get("excerpt"), "source": "Nintendo", "platform": platform,
                                               "notes": f"{platform} · Nintendo catalog physical edition"})
                    offset += len(docs)
                    if offset >= response["numFound"]:
                        break
                    if not docs:
                        raise ValueError("Nintendo pagination stopped before the full catalog was read")
            if cached is None:
                cached = DiscoveryCache(key=key)
                db.add(cached)
            cached.payload, cached.updated_at = json.dumps(nintendo_games), datetime.utcnow()
            db.commit()
            source_updates.append(cached.updated_at)
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            if cached:
                nintendo_games = json.loads(cached.payload)
                source_updates.append(cached.updated_at)
                warnings.append("Nintendo could not be refreshed; its last successful data is included.")

    retail_games = []
    try:
        retail_games, retail_updated = _nintendo_life_retail_releases(db, previous, current, following)
        source_updates.append(retail_updated)
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        retail_cache = db.get(DiscoveryCache, f"nintendolife-retail:{current:%Y-%m}")
        if retail_cache:
            retail_games = json.loads(retail_cache.payload)
            source_updates.append(retail_cache.updated_at)
            warnings.append("The retail guide could not be refreshed; its last successful data is included.")
        else:
            warnings.append("The supplemental retail guide is temporarily unavailable, so coverage may be incomplete.")

    combined = {}
    for game in nintendo_games:
        game.setdefault("platform", "Nintendo Switch")
        if not game.get("notes"):
            game["notes"] = "Nintendo Switch | Nintendo catalog physical edition"
    for game in nintendo_games + retail_games:
        dedupe_key = (normalized(game["name"]), game["release_date"], game.get("platform") or "Nintendo Switch")
        combined.setdefault(dedupe_key, game)
    if combined:
        sources = "Nintendo + Nintendo Life retail guide" if nintendo_games and retail_games else ("Nintendo Europe catalog" if nintendo_games else "Nintendo Life retail guide")
        return {**base, "source": sources, "games": list(combined.values()),
                "updated_at": max(source_updates) if source_updates else None,
                "coverage": "Nintendo Switch and Switch 2 retail releases combined from Nintendo's catalog and Nintendo Life's monthly physical-game guide. Game-Key Cards and code-in-box releases are labelled.",
                "warning": " ".join(warnings) or None}

    try:
        games, updated_at = _igdb_physical_releases(db, region, previous, current, following)
        return {**base, "source": "IGDB physical products", "games": games, "updated_at": updated_at,
                "coverage": "IGDB Switch releases linked to a physical external product. Coverage may be incomplete.",
                "warning": "Nintendo and the retail guide could not be reached, so this is the IGDB physical-product fallback."}
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return {**base, "games": [], "updated_at": None,
                "warning": "The Nintendo, retail-guide and IGDB physical-release sources are temporarily unavailable."}
