from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from .database import engine, Base
from .database import SessionLocal
from .models import AppSetting, Videogame
from .discovery_models import SteamCollectionLink, SteamOwnedGame, WantedGame
from .routers import auth_router, videogames_router, smart_import_router, filters_router, igdb_router, boardgames_router, settings_router, discovery_router, backups_router
from .services.discovery import scheduler
from .services.backups import scheduler as backup_scheduler
from contextlib import asynccontextmanager, suppress
import asyncio
from .services.boardgame_player_migration import migrate_legacy_match_players
import logging

logger = logging.getLogger(__name__)

# Create db tables (new tables only)
Base.metadata.create_all(bind=engine)

# Safe migration: add new columns to existing tables without data loss
def _run_migrations():
    migrations = [
        "ALTER TABLE videogames ADD COLUMN dlcs TEXT",
        "ALTER TABLE smart_import_items ADD COLUMN dlcs TEXT",
        "ALTER TABLE videogames ADD COLUMN playtime_hours FLOAT",
        "ALTER TABLE smart_import_items ADD COLUMN playtime_hours FLOAT",
        "ALTER TABLE videogames ADD COLUMN release_date VARCHAR",
        "ALTER TABLE videogames ADD COLUMN is_dlc BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE videogames ADD COLUMN parent_game_name VARCHAR",
        "ALTER TABLE videogames ADD COLUMN copies TEXT",
        "ALTER TABLE videogames ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE discovery_settings ADD COLUMN last_owned_import_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE discovery_settings ADD COLUMN steam_api_key VARCHAR",
        "ALTER TABLE discovery_settings ADD COLUMN last_igdb_match_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE discovery_settings ADD COLUMN sync_wishlist BOOLEAN NOT NULL DEFAULT 1",
        "ALTER TABLE discovery_settings ADD COLUMN sync_collection BOOLEAN NOT NULL DEFAULT 1",
        "ALTER TABLE wanted_games ADD COLUMN steam_wishlist_missing BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE steam_collection_links ADD COLUMN created_collection_game BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE steam_match_reviews ADD COLUMN candidates TEXT",
        "ALTER TABLE steam_match_reviews ADD COLUMN rejected_candidate_ids TEXT",
        "ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE boardgames ADD COLUMN library_section VARCHAR NOT NULL DEFAULT 'owned'",
        "ALTER TABLE boardgames ADD COLUMN bgg_id INTEGER",
        "ALTER TABLE boardgames ADD COLUMN bgg_rank INTEGER",
        "ALTER TABLE boardgames ADD COLUMN price FLOAT",
        "ALTER TABLE boardgames ADD COLUMN expansions TEXT",
        "ALTER TABLE boardgames ADD COLUMN is_expansion BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE boardgames ADD COLUMN parent_game_name VARCHAR",
        "ALTER TABLE boardgame_matches ADD COLUMN import_key VARCHAR",
    ]
    with engine.connect() as conn:
        for stmt in migrations:
            try:
                conn.execute(text(stmt))
                conn.commit()
            except Exception:
                pass  # Column already exists — silently skip

_run_migrations()

# Steam genres used to be copied into the personal tag field. Clear that legacy
# import once; future Steam refreshes leave tags entirely user-controlled.
def _clear_legacy_steam_tags():
    with engine.connect() as conn:
        marker = conn.execute(text("SELECT value FROM app_settings WHERE key = 'steam_wanted_tags_cleared_v1'")).first()
        if marker:
            return
        conn.execute(text("UPDATE wanted_games SET tags = NULL WHERE source = 'steam'"))
        conn.execute(text("INSERT INTO app_settings (key, value) VALUES ('steam_wanted_tags_cleared_v1', '1')"))
        conn.commit()

_clear_legacy_steam_tags()

def _backfill_owned_copies():
    db = SessionLocal()
    try:
        if db.query(AppSetting).filter_by(key="owned_copies_backfilled_v1").first():
            return
        import json
        for wanted in db.query(WantedGame).filter(WantedGame.collection_game_id.is_not(None)).all():
            game = db.query(Videogame).filter_by(id=wanted.collection_game_id, user_id=wanted.user_id).first()
            if not game:
                continue
            copies = json.loads(game.copies or "[]")
            candidate = {
                "platform": wanted.platform,
                "format": wanted.format,
                "source": wanted.source,
                "store_url": wanted.store_url,
                "steam_appid": wanted.steam_appid,
                "igdb_id": wanted.igdb_id,
                "price": wanted.target_price,
                "currency": wanted.currency,
            }
            identity = (candidate["platform"].casefold(), candidate["format"], candidate["steam_appid"], candidate["store_url"])
            if not any((str(item.get("platform", "")).casefold(), item.get("format", "Any"), item.get("steam_appid"), item.get("store_url")) == identity for item in copies):
                copies.append(candidate)
                game.copies = json.dumps(copies)
            if not game.release_date:
                game.release_date = wanted.release_date
            game.is_dlc = game.is_dlc or wanted.is_dlc
            if not game.parent_game_name:
                game.parent_game_name = wanted.parent_game_name
        db.add(AppSetting(key="owned_copies_backfilled_v1", value="1"))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Owned-copy backfill failed")
    finally:
        db.close()

_backfill_owned_copies()

def _backfill_steam_collection_links():
    """Turn existing Steam copies/acquisitions into durable sync identities."""
    db = SessionLocal()
    try:
        if db.query(AppSetting).filter_by(key="steam_collection_links_backfilled_v1").first():
            return
        import json
        games = {game.id: game for game in db.query(Videogame).all()}
        linked_apps = {(link.user_id, link.steam_appid) for link in db.query(SteamCollectionLink).all()}
        # A reviewed Games I Want acquisition is the strongest legacy signal.
        for wanted in db.query(WantedGame).filter(
            WantedGame.steam_appid.is_not(None), WantedGame.collection_game_id.is_not(None)
        ).all():
            game = games.get(wanted.collection_game_id)
            key = (wanted.user_id, wanted.steam_appid)
            if not game or game.user_id != wanted.user_id or key in linked_apps:
                continue
            db.add(SteamCollectionLink(
                user_id=wanted.user_id, steam_appid=wanted.steam_appid,
                collection_game_id=game.id, igdb_id=wanted.igdb_id,
            ))
            linked_apps.add(key)
        # Older collection rows already carry the Steam App ID in copy JSON.
        for game in games.values():
            try:
                copies = json.loads(game.copies or "[]")
            except (TypeError, ValueError):
                continue
            for copy in copies:
                appid = copy.get("steam_appid")
                key = (game.user_id, appid)
                if not appid or key in linked_apps:
                    continue
                db.add(SteamCollectionLink(
                    user_id=game.user_id, steam_appid=appid,
                    collection_game_id=game.id, igdb_id=copy.get("igdb_id"),
                ))
                linked_apps.add(key)
        db.add(AppSetting(key="steam_collection_links_backfilled_v1", value="1"))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Steam collection-link backfill failed")
    finally:
        db.close()

_backfill_steam_collection_links()

def _backfill_steam_links_v2():
    """Copy legacy one-app/one-game links into the collection-owned link model."""
    db = SessionLocal()
    try:
        if db.query(AppSetting).filter_by(key="steam_game_links_backfilled_v2").first():
            return
        import json
        existing_games = {(row.user_id, row.collection_game_id) for row in db.query(SteamCollectionLink).all()}
        with engine.connect() as conn:
            try:
                legacy = conn.execute(text(
                    "SELECT user_id, steam_appid, collection_game_id, igdb_id, created_collection_game "
                    "FROM steam_collection_links ORDER BY id"
                )).mappings().all()
            except Exception:
                legacy = []
        for row in legacy:
            key = (row["user_id"], row["collection_game_id"])
            if key in existing_games:
                continue
            db.add(SteamCollectionLink(
                user_id=row["user_id"], steam_appid=row["steam_appid"],
                collection_game_id=row["collection_game_id"], igdb_id=row["igdb_id"],
                created_collection_game=bool(row["created_collection_game"]),
            ))
            existing_games.add(key)
        catalog_keys = {(row.user_id, row.steam_appid) for row in db.query(SteamOwnedGame).all()}
        for game in db.query(Videogame).all():
            try:
                copies = json.loads(game.copies or "[]")
            except (TypeError, ValueError):
                copies = []
            for copy in copies:
                appid = copy.get("steam_appid")
                if not appid:
                    continue
                key = (game.user_id, int(appid))
                if key not in catalog_keys:
                    db.add(SteamOwnedGame(
                        user_id=game.user_id, steam_appid=int(appid), name=game.name,
                        playtime_hours=copy.get("playtime_hours"), image_url=game.image_url,
                        store_url=copy.get("store_url"), igdb_id=copy.get("igdb_id"),
                    ))
                    catalog_keys.add(key)
                link_key = (game.user_id, game.id)
                if link_key not in existing_games:
                    db.add(SteamCollectionLink(
                        user_id=game.user_id, steam_appid=int(appid), collection_game_id=game.id,
                        igdb_id=copy.get("igdb_id"),
                    ))
                    existing_games.add(link_key)
                    break
        db.add(AppSetting(key="steam_game_links_backfilled_v2", value="1"))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Steam game-link v2 backfill failed")
    finally:
        db.close()

_backfill_steam_links_v2()

# Idempotently convert legacy played_with JSON/text into canonical player rows.
def _migrate_boardgame_players():
    db = SessionLocal()
    try:
        result = migrate_legacy_match_players(db)
        logger.info("Board-game player migration complete: %s", result)
    except Exception:
        db.rollback()
        logger.exception("Board-game player migration failed; legacy played_with data remains intact")
    finally:
        db.close()

_migrate_boardgame_players()

@asynccontextmanager
async def lifespan(app):
    tasks = [asyncio.create_task(scheduler()), asyncio.create_task(backup_scheduler())]
    yield
    for task in tasks:
        task.cancel()
    for task in tasks:
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="Videogame Collection API", lifespan=lifespan)

# Setup CORS to allow our React app to communicate with the API
origins = [
    "http://localhost:5173", # Vite dev server
    "http://127.0.0.1:5173",
    "http://localhost:5174", # Fallback ports
    "http://127.0.0.1:5174",
    "http://localhost:5175",
    "http://127.0.0.1:5175",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(videogames_router.router)
app.include_router(smart_import_router.router)
app.include_router(filters_router.router)
app.include_router(igdb_router.router)
app.include_router(boardgames_router.router)
app.include_router(settings_router.router)
app.include_router(discovery_router.router)
app.include_router(backups_router.router)

@app.get("/")
def read_root():
    return {"message": "Welcome to the Videogame Collection API"}
