"""Persistent catalog of physical Nintendo Switch and Switch 2 releases.

Sources, all public and cached in ``switch_catalog_games``:

* Nintendo Life's games browser. Its "Nintendo Switch" system only lists retail
  releases (download-only games live under "Switch eShop"), so every row there
  is physical. Switch 2 has a single system, so each game page is read once for
  its "Physical Release" field (Standard Game Card, Game-Key Card, ...).
* Nintendo Europe's catalog (``physical_version_b``) as a supplement for titles
  the browser misses (many games that reached retail after an eShop launch).
* IGDB's physical external products, when IGDB credentials are configured, for
  retail editions neither of the above lists.

The crawl honours Nintendo Life's 5 second crawl delay, commits as it goes and
is resumable: a restart continues with whatever is still unchecked.
"""
import asyncio
import json
import logging
import os
import re
import threading
import time
from datetime import date, datetime, timedelta

import httpx
from dateutil import parser as date_parser
from lxml import html as lxml_html

from ..database import SessionLocal
from ..discovery_models import DiscoveryCache, SwitchCatalogGame
from .discovery import _release_title_key

logger = logging.getLogger(__name__)

NL_BASE = "https://www.nintendolife.com"
NL_SYSTEMS = (("nintendo-switch", "Nintendo Switch"), ("nintendo-switch-2", "Nintendo Switch 2"))
NINTENDO_EU_SEARCH = "https://searching.nintendo-europe.com/en/select"
USER_AGENT = "EpicTracker/1.0"
CRAWL_DELAY_SECONDS = 5
LISTING_MAX_PAGES = 200
LISTING_REFRESH = timedelta(days=3)
IGDB_REFRESH = timedelta(days=7)
IGDB_PLATFORMS = {130: "Nintendo Switch", 508: "Nintendo Switch 2"}
IGDB_PHYSICAL_FORMAT_ID = 2
DETAIL_RECHECK = timedelta(days=14)
MANUAL_REFRESH_COOLDOWN = timedelta(minutes=30)
STATE_KEY = "switch-catalog:state"

GAME_CARD = "Game Card"
GAME_KEY_CARD = "Game-Key Card"
CODE_IN_BOX = "Code in box"
PHYSICAL_FORMATS = (GAME_CARD, GAME_KEY_CARD)

_run_lock = threading.Lock()
_FULL_DATE = re.compile(r"^\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?\s+\d{4}$")
_REGION_PRIORITY = ("UK/EU", "NA", "JPN")


def classify_physical(value):
    """Map a source's free-text physical description to a catalog format.

    ``""`` means the source lists no physical release; unknown non-empty text is
    treated as a regular card so a real retail release is never dropped.
    """
    text = " ".join((value or "").split())
    lowered = text.casefold()
    if not lowered or lowered in ("none", "no", "n/a", "tba", "tbc", "digital only"):
        return ""
    if "key" in lowered:
        return GAME_KEY_CARD
    if "code" in lowered or "download" in lowered:
        return CODE_IN_BOX
    return GAME_CARD


def parse_release(value):
    """Return (ISO date or None, display label) for a listing date."""
    label = " ".join((value or "").split())
    if not label:
        return None, ""
    if _FULL_DATE.match(label):
        try:
            cleaned = re.sub(r"(\d)(?:st|nd|rd|th)", r"\1", label)
            return date_parser.parse(cleaned, dayfirst=True).date().isoformat(), label
        except (ValueError, OverflowError):
            pass
    return None, label


def is_placeholder_image(url):
    """Nintendo Life serves a generic per-system box for games without cover art."""
    return bool(url) and "/systems/" in url


def parse_listing(page_html, platform):
    """Extract games from one Nintendo Life browse page (cover style)."""
    root = lxml_html.fromstring(page_html)
    games = []
    for item in root.xpath("//li[contains(concat(' ', normalize-space(@class), ' '), ' item-game ')]"):
        subject = (item.get("data-subject") or "").strip("/")
        titles = item.xpath(".//span[contains(concat(' ', normalize-space(@class), ' '), ' title ')]")
        name = " ".join(titles[0].text_content().split()) if titles else ""
        if not subject.startswith("games/") or not name:
            continue
        images = item.xpath(".//div[contains(@class, 'cover')]//img/@src")
        publishers = item.xpath(".//p[contains(@class, 'description')]//a")
        dates = {}
        for entry in item.xpath(".//ul[contains(@class, 'release-dates')]//span[contains(@class, 'date')]"):
            regions = entry.xpath(".//span[contains(@class, 'region')]")
            region = regions[0].text_content().strip(" ()") if regions else ""
            text = entry.text_content()
            if regions:
                text = text.replace(regions[0].text_content(), "")
            dates.setdefault(region, " ".join(text.split()))
        chosen = next((dates[region] for region in _REGION_PRIORITY if dates.get(region)), None)
        if chosen is None:
            chosen = next(iter(dates.values()), "")
        release_date, release_label = parse_release(chosen)
        image_url = images[0] if images else None
        if is_placeholder_image(image_url):
            image_url = None
        games.append({
            "source_key": f"nl:{subject[len('games/'):]}",
            "name": name,
            "platform": platform,
            "publisher": " ".join(publishers[0].text_content().split()) if publishers else None,
            "image_url": image_url,
            "release_date": release_date,
            "release_label": release_label,
            "source": "Nintendo Life",
            "source_url": f"{NL_BASE}/{subject}",
        })
    return games


def parse_physical_release(page_html):
    """Read the "Physical Release" overview field of a Nintendo Life game page."""
    root = lxml_html.fromstring(page_html)
    for term in root.xpath("//dt"):
        if " ".join(term.text_content().split()).casefold() == "physical release":
            definition = term.getnext()
            if definition is not None and definition.tag == "dd":
                return " ".join(definition.text_content().split())
    return ""


def read_state(db):
    row = db.get(DiscoveryCache, STATE_KEY)
    try:
        return json.loads(row.payload) if row else {}
    except (TypeError, ValueError):
        return {}


def write_state(db, **changes):
    row = db.get(DiscoveryCache, STATE_KEY)
    state = read_state(db)
    state.update(changes)
    if row is None:
        row = DiscoveryCache(key=STATE_KEY)
        db.add(row)
    row.payload, row.updated_at = json.dumps(state), datetime.utcnow()
    db.commit()
    return state


def _timestamp(value):
    try:
        return datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def upsert_games(db, games, physical_format=None):
    """Insert or refresh listing rows. Returns the number of new rows."""
    now = datetime.utcnow()
    keys = [game["source_key"] for game in games]
    existing = {
        row.source_key: row
        for row in db.query(SwitchCatalogGame).filter(SwitchCatalogGame.source_key.in_(keys)).all()
    } if keys else {}
    created = 0
    for game in games:
        row = existing.get(game["source_key"])
        if row is None:
            row = SwitchCatalogGame(source_key=game["source_key"], first_seen_at=now)
            db.add(row)
            existing[game["source_key"]] = row
            created += 1
        row.name = game["name"]
        row.title_key = _release_title_key(game["name"])
        row.platform = game["platform"]
        row.source, row.source_url = game["source"], game["source_url"]
        for field in ("publisher", "image_url", "release_date", "release_label"):
            # A listing that temporarily lacks a value must not erase a known one.
            if game.get(field):
                setattr(row, field, game[field])
        if is_placeholder_image(row.image_url):
            row.image_url = None
        if physical_format is not None:
            row.physical_format = physical_format
            row.detail_checked_at = now
        row.last_seen_at = row.updated_at = now
    db.commit()
    return created


def _crawl_listing(db, client, system, platform, sleep):
    total = 0
    for page in range(1, LISTING_MAX_PAGES + 1):
        write_state(db, phase=f"Reading the {platform} list (page {page})")
        response = client.get(f"{NL_BASE}/games/browse", params={"system": system, "sort": "title", "page": page})
        if response.status_code == 404:
            break
        response.raise_for_status()
        games = parse_listing(response.text, platform)
        if not games:
            break
        # Switch 1 retail and eShop games are separate systems upstream, so its
        # listing is physical by definition. Switch 2 needs the per-game check.
        upsert_games(db, games, GAME_CARD if system == "nintendo-switch" else None)
        total += len(games)
        sleep(CRAWL_DELAY_SECONDS)
    return total


def _nintendo_europe_supplement(db, client):
    """Add Nintendo-listed physical titles the browser does not carry."""
    known = {(row.title_key, row.platform) for row in db.query(SwitchCatalogGame.title_key, SwitchCatalogGame.platform).filter(
        SwitchCatalogGame.source == "Nintendo Life"
    ).all()}
    offset, added = 0, []
    while True:
        response = client.get(NINTENDO_EU_SEARCH, params={
            "q": "*", "fq": "type:GAME AND system_type:nintendoswitch* AND physical_version_b:true",
            "rows": 200, "start": offset, "wt": "json", "sort": "fs_id asc",
            "fl": "fs_id,title,url,date_from,publisher,image_url,image_url_sq_s,system_type",
        })
        response.raise_for_status()
        body = response.json()["response"]
        docs = body["docs"]
        for item in docs:
            if not item.get("title") or not item.get("fs_id"):
                continue
            systems = " ".join(item.get("system_type") or [])
            platform = "Nintendo Switch 2" if "nintendoswitch2" in systems and "nintendoswitch_gamecard" not in systems else "Nintendo Switch"
            if (_release_title_key(item["title"]), platform) in known:
                continue
            release_date = (item.get("date_from") or "")[:10] or None
            if release_date and release_date >= "2090":
                release_date = None
            added.append({
                "source_key": f"neu:{item['fs_id']}", "name": item["title"], "platform": platform,
                "publisher": item.get("publisher"),
                "image_url": item.get("image_url") or item.get("image_url_sq_s"),
                "release_date": release_date, "release_label": "",
                "source": "Nintendo", "source_url": f"https://www.nintendo.com{item.get('url') or ''}",
            })
        offset += len(docs)
        if not docs or offset >= body["numFound"]:
            break
    for start in range(0, len(added), 200):
        upsert_games(db, added[start:start + 200], GAME_CARD)
    # A title the browser has since picked up is now a duplicate of that row.
    stale = [row for row in db.query(SwitchCatalogGame).filter(SwitchCatalogGame.source == "Nintendo").all()
             if (row.title_key, row.platform) in known]
    for row in stale:
        db.delete(row)
    db.commit()
    return len(added)


def igdb_games(rows):
    """Turn IGDB physical external products into catalog rows, one per game and platform."""
    games = {}
    for row in rows:
        game, platform = row.get("game") or {}, IGDB_PLATFORMS.get(row.get("platform"))
        if not game.get("id") or not game.get("name") or not platform:
            continue
        product = classify_physical(row.get("name") or "card")
        key = f"igdb:{game['id']}:{row['platform']}"
        if product == CODE_IN_BOX:
            # A boxed download code is not a physical game; a real card listing may still follow.
            games.setdefault(key, None)
            continue
        if games.get(key) is not None and product != GAME_KEY_CARD:
            continue
        dates = [item["date"] for item in game.get("release_dates") or []
                 if isinstance(item, dict) and item.get("platform") == row["platform"] and item.get("date")]
        publishers = [item["company"]["name"] for item in game.get("involved_companies") or []
                      if isinstance(item, dict) and item.get("publisher") and (item.get("company") or {}).get("name")]
        image_id = (game.get("cover") or {}).get("image_id")
        games[key] = {
            "source_key": key, "name": game["name"], "platform": platform,
            "publisher": publishers[0] if publishers else None,
            "image_url": f"https://images.igdb.com/igdb/image/upload/t_cover_big/{image_id}.jpg" if image_id else None,
            "release_date": datetime.utcfromtimestamp(min(dates)).date().isoformat() if dates else None,
            "release_label": "", "source": "IGDB",
            "source_url": f"https://www.igdb.com/games/{game.get('slug') or ''}",
            "physical_format": product,
        }
    return [game for game in games.values() if game]


def _igdb_supplement(db):
    """Add physically sold games that only IGDB knows about. Returns False when not configured."""
    from dotenv import load_dotenv
    from ..routers.igdb_router import _get_twitch_token

    load_dotenv()
    client_id = os.getenv("TWITCH_SECRET_CLIENT_ID", "").strip()
    if not client_id or not os.getenv("TWITCH_SECRET", "").strip():
        return False
    headers = {"Client-ID": client_id, "Authorization": f"Bearer {_get_twitch_token()}", "Accept": "application/json"}
    rows = []
    with httpx.Client(timeout=30, headers=headers) as client:
        for offset in range(0, 50000, 500):
            response = client.post("https://api.igdb.com/v4/external_games", content=(
                "fields name,platform,game.name,game.slug,game.cover.image_id,game.release_dates.date,"
                "game.release_dates.platform,game.involved_companies.publisher,game.involved_companies.company.name; "
                f"where platform=({','.join(map(str, IGDB_PLATFORMS))}) & game_release_format={IGDB_PHYSICAL_FORMAT_ID}; "
                f"sort id asc; limit 500; offset {offset};"
            ))
            response.raise_for_status()
            page = response.json()
            rows.extend(page)
            if len(page) < 500:
                break
            time.sleep(0.3)
    # Another source's verdict (card, key card or code in box) always wins.
    known = {(row.title_key, row.platform) for row in db.query(SwitchCatalogGame.title_key, SwitchCatalogGame.platform).filter(
        SwitchCatalogGame.source != "IGDB", SwitchCatalogGame.physical_format.is_not(None), SwitchCatalogGame.physical_format != "",
    ).all()}
    games = [game for game in igdb_games(rows) if (_release_title_key(game["name"]), game["platform"]) not in known]
    for physical_format in PHYSICAL_FORMATS:
        batch = [game for game in games if game["physical_format"] == physical_format]
        for start in range(0, len(batch), 200):
            upsert_games(db, batch[start:start + 200], physical_format)
    for row in db.query(SwitchCatalogGame).filter(SwitchCatalogGame.source == "IGDB").all():
        if (row.title_key, row.platform) in known:
            db.delete(row)
    db.commit()
    return True


def pending_detail_query(db, today=None):
    """Switch 2 rows whose physical format is unknown or worth re-reading."""
    today = today or date.today()
    recent = (today - timedelta(days=120)).isoformat()
    stale = datetime.utcnow() - DETAIL_RECHECK
    return db.query(SwitchCatalogGame).filter(
        SwitchCatalogGame.source == "Nintendo Life",
        SwitchCatalogGame.platform == "Nintendo Switch 2",
    ).filter(
        (SwitchCatalogGame.physical_format.is_(None))
        # Physical editions are often announced after a game is listed, so
        # upcoming and recent digital-only rows are read again periodically.
        | ((SwitchCatalogGame.physical_format == "") & (SwitchCatalogGame.detail_checked_at < stale)
           & ((SwitchCatalogGame.release_date.is_(None)) | (SwitchCatalogGame.release_date >= recent)))
    )


def _check_details(db, client, sleep):
    rows = pending_detail_query(db).order_by(
        SwitchCatalogGame.physical_format.is_(None).desc(),
        SwitchCatalogGame.release_date.is_(None), SwitchCatalogGame.release_date.desc(),
    ).all()
    for index, row in enumerate(rows):
        if index % 5 == 0:
            write_state(db, phase=f"Checking Switch 2 physical editions ({index}/{len(rows)})", pending_details=len(rows) - index)
        try:
            response = client.get(row.source_url)
            if response.status_code == 404:
                row.physical_format = ""
            else:
                response.raise_for_status()
                row.physical_format = classify_physical(parse_physical_release(response.text))
            row.detail_checked_at = datetime.utcnow()
            db.commit()
        except httpx.HTTPError:
            db.rollback()
            logger.warning("Catalog detail check failed for %s", row.source_key)
        sleep(CRAWL_DELAY_SECONDS)
    return len(rows)


def run_sync(force_listing=False, sleep=time.sleep, session_factory=None):
    """Refresh the catalog. Safe to call concurrently; extra callers return False."""
    if not _run_lock.acquire(blocking=False):
        return False
    db = (session_factory or SessionLocal)()
    try:
        state = read_state(db)
        listing_at = _timestamp(state.get("listing_at"))
        write_state(db, status="running", started_at=datetime.utcnow().isoformat(), error=None, phase="Starting")
        with httpx.Client(timeout=30, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
            if force_listing or listing_at is None or listing_at < datetime.utcnow() - LISTING_REFRESH:
                for system, platform in NL_SYSTEMS:
                    _crawl_listing(db, client, system, platform, sleep)
                try:
                    write_state(db, phase="Adding Nintendo Europe's physical catalog")
                    _nintendo_europe_supplement(db, client)
                except (httpx.HTTPError, ValueError, KeyError, TypeError):
                    db.rollback()
                    logger.warning("Nintendo Europe catalog supplement failed")
                write_state(db, listing_at=datetime.utcnow().isoformat())
            igdb_at = _timestamp(read_state(db).get("igdb_at"))
            if force_listing or igdb_at is None or igdb_at < datetime.utcnow() - IGDB_REFRESH:
                try:
                    write_state(db, phase="Adding IGDB's physical editions")
                    if _igdb_supplement(db):
                        write_state(db, igdb_at=datetime.utcnow().isoformat())
                except Exception:  # noqa: BLE001 - an optional source must not fail the refresh
                    db.rollback()
                    logger.warning("IGDB catalog supplement failed", exc_info=True)
            _check_details(db, client, sleep)
        write_state(db, status="idle", phase=None, pending_details=pending_detail_query(db).count(),
                    finished_at=datetime.utcnow().isoformat())
    except Exception as error:  # noqa: BLE001 - the state row must always leave "running"
        db.rollback()
        logger.exception("Switch catalog sync failed")
        message = "Nintendo Life could not be reached." if isinstance(error, httpx.HTTPError) else "The catalog refresh stopped unexpectedly."
        write_state(db, status="idle", phase=None, error=f"{message} It will retry automatically.",
                    finished_at=datetime.utcnow().isoformat())
    finally:
        db.close()
        _run_lock.release()
    return True


def is_running():
    return _run_lock.locked()


def start_background_sync(force_listing=False):
    if is_running():
        return False
    threading.Thread(target=run_sync, kwargs={"force_listing": force_listing}, name="switch-catalog-sync", daemon=True).start()
    return True


def sync_is_due(db):
    state = read_state(db)
    listing_at = _timestamp(state.get("listing_at"))
    if listing_at is None or listing_at < datetime.utcnow() - LISTING_REFRESH:
        # After a failure, wait before trying the whole listing again.
        finished = _timestamp(state.get("finished_at"))
        return not (state.get("error") and finished and finished > datetime.utcnow() - timedelta(hours=1))
    if pending_detail_query(db).first() is not None:
        return True
    igdb_at = _timestamp(state.get("igdb_at"))
    if igdb_at is None:
        # Without IGDB credentials the stamp never appears; retry daily, not every tick.
        finished = _timestamp(state.get("finished_at"))
        return finished is None or finished < datetime.utcnow() - timedelta(days=1)
    return igdb_at < datetime.utcnow() - IGDB_REFRESH


def status(db):
    state = read_state(db)
    running = is_running()
    return {
        "running": running,
        "phase": state.get("phase") if running else None,
        "listing_at": state.get("listing_at"),
        "finished_at": state.get("finished_at"),
        "error": None if running else state.get("error"),
        "pending_details": pending_detail_query(db).count(),
    }


async def scheduler():
    """Start a catalog refresh whenever one is due; the crawl runs in its own thread."""
    await asyncio.sleep(20)
    while True:
        try:
            if not is_running():
                with SessionLocal() as db:
                    due = sync_is_due(db)
                if due:
                    start_background_sync()
        except Exception:
            logger.exception("Switch catalog scheduler tick failed")
        await asyncio.sleep(600)
