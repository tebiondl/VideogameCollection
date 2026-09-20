from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from .database import engine, Base
from .database import SessionLocal
from .models import AppSetting, Videogame
from .discovery_models import SteamCollectionLink, SteamOwnedGame, WantedGame, SteamCopyTrash
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
        "ALTER TABLE videogames ADD COLUMN playtime_mode VARCHAR NOT NULL DEFAULT 'user'",
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

def _backfill_steam_copy_links_v3():
    """Give every copy a stable ID and preserve Steam identities at copy level."""
    db = SessionLocal()
    try:
        if db.query(AppSetting).filter_by(key="steam_copy_links_backfilled_v3").first():
            return
        import json
        legacy = {}
        with engine.connect() as conn:
            try:
                rows = conn.execute(text(
                    "SELECT user_id, steam_appid, collection_game_id, igdb_id, "
                    "created_collection_game, user_selected FROM steam_game_links ORDER BY id"
                )).mappings().all()
                legacy = {(row["user_id"], row["collection_game_id"], row["steam_appid"]): row for row in rows}
            except Exception:
                pass
        seen = {(row.user_id, row.collection_game_id, row.copy_id) for row in db.query(SteamCollectionLink).all()}
        for game in db.query(Videogame).all():
            try:
                copies = json.loads(game.copies or "[]")
            except (TypeError, ValueError):
                copies = []
            changed = False
            for index, copy in enumerate(copies):
                if not copy.get("id"):
                    appid = copy.get("steam_appid")
                    copy["id"] = f"steam:{appid}" if appid else f"copy:{game.id}:{index + 1}"
                    changed = True
                appid = copy.get("steam_appid")
                key = (game.user_id, game.id, str(copy["id"]))
                if not appid or key in seen:
                    continue
                old = legacy.get((game.user_id, game.id, int(appid)))
                db.add(SteamCollectionLink(
                    user_id=game.user_id, steam_appid=int(appid), collection_game_id=game.id,
                    copy_id=str(copy["id"]), igdb_id=copy.get("igdb_id") or (old["igdb_id"] if old else None),
                    created_collection_game=bool(old["created_collection_game"]) if old else False,
                    user_selected=bool(old["user_selected"]) if old else False,
                ))
                seen.add(key)
            if changed:
                game.copies = json.dumps(copies)
        db.add(AppSetting(key="steam_copy_links_backfilled_v3", value="1"))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Steam copy-link v3 backfill failed")
    finally:
        db.close()

_backfill_steam_copy_links_v3()

def _backfill_steam_copy_names_v4():
    """Show the original Steam title for each edition kept under one card."""
    db = SessionLocal()
    try:
        if db.query(AppSetting).filter_by(key="steam_copy_names_backfilled_v4").first():
            return
        import json
        catalog = {
            (row.user_id, row.steam_appid): row.name
            for row in db.query(SteamOwnedGame).all()
        }
        for game in db.query(Videogame).all():
            try:
                copies = json.loads(game.copies or "[]")
            except (TypeError, ValueError):
                continue
            changed = False
            for owned_copy in copies:
                appid = owned_copy.get("steam_appid")
                if appid and not owned_copy.get("name"):
                    owned_copy["name"] = catalog.get((game.user_id, int(appid))) or game.name
                    changed = True
            if changed:
                game.copies = json.dumps(copies)
        db.add(AppSetting(key="steam_copy_names_backfilled_v4", value="1"))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Steam copy-name v4 backfill failed")
    finally:
        db.close()

_backfill_steam_copy_names_v4()

def _backfill_steam_copy_time_v5():
    """Normalize linked copy ownership and seed Steam-controlled playtime."""
    db = SessionLocal()
    try:
        if db.query(AppSetting).filter_by(key="steam_copy_time_backfilled_v5").first():
            return
        import json
        catalog = {(row.user_id, row.steam_appid): row for row in db.query(SteamOwnedGame).all()}
        links_by_game = {}
        for link in db.query(SteamCollectionLink).all():
            links_by_game.setdefault((link.user_id, link.collection_game_id), {})[link.copy_id] = link
        for game in db.query(Videogame).all():
            links = links_by_game.get((game.user_id, game.id), {})
            if not links:
                continue
            try:
                copies = json.loads(game.copies or "[]")
            except (TypeError, ValueError):
                continue
            changed = False
            for owned_copy in copies:
                link = links.get(str(owned_copy.get("id")))
                if link is None:
                    continue
                steam = catalog.get((game.user_id, link.steam_appid))
                if owned_copy.get("source") != "Steam":
                    owned_copy["source"] = "Steam"
                    changed = True
                if steam and steam.playtime_hours is not None and owned_copy.get("playtime_hours") != steam.playtime_hours:
                    owned_copy["playtime_hours"] = steam.playtime_hours
                    changed = True
            if changed:
                game.copies = json.dumps(copies)
        db.add(AppSetting(key="steam_copy_time_backfilled_v5", value="1"))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Steam copy-time v5 backfill failed")
    finally:
        db.close()

_backfill_steam_copy_time_v5()

def _separate_legacy_steam_playtime_v6():
    """Move legacy auto-imported Steam hours out of the user's personal time field."""
    db = SessionLocal()
    try:
        if db.query(AppSetting).filter_by(key="steam_playtime_separated_v6").first():
            return
        import json
        game_ids = {
            row.collection_game_id for row in db.query(SteamCollectionLink).filter_by(created_collection_game=True).all()
        }
        for game in db.query(Videogame).filter(Videogame.id.in_(game_ids)).all() if game_ids else []:
            try:
                copies = json.loads(game.copies or "[]")
            except (TypeError, ValueError):
                copies = []
            if game.playtime_hours is not None:
                target = next((copy for copy in copies if copy.get("steam_appid") and copy.get("playtime_hours") is None), None)
                if target is not None:
                    target["playtime_hours"] = game.playtime_hours
                    game.copies = json.dumps(copies)
                game.playtime_hours = None
            game.playtime_mode = "copies"
        db.add(AppSetting(key="steam_playtime_separated_v6", value="1"))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Steam playtime v6 separation failed")
    finally:
        db.close()

_separate_legacy_steam_playtime_v6()

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
