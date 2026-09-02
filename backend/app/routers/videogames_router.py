from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks
from sqlalchemy.orm import Session
from typing import List, Annotated
import difflib
import json
import os
import logging
import httpx
from openai import OpenAI

from .. import schemas, models, database
from .auth_router import get_current_user
from .igdb_router import _get_twitch_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/videogames", tags=["videogames"])

# In-memory progress tracker { user_id: { total, completed, status } }
auto_fill_progress = {}


def _read_tag_names(raw_tags: str | None) -> tuple[list[str], bool]:
    """Return normalized tag values and whether the source used JSON storage."""
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


def _game_has_tag(game: models.Videogame, tag_name: str) -> bool:
    names, _ = _read_tag_names(game.tags)
    target = tag_name.casefold()
    return any(name.casefold() == target for name in names)


def _replace_game_tag(game: models.Videogame, old_name: str, new_name: str) -> bool:
    names, as_json = _read_tag_names(game.tags)
    old_key = old_name.casefold()
    new_key = new_name.casefold()
    replaced = False
    updated: list[str] = []
    seen: set[str] = set()
    for name in names:
        value = new_name if name.casefold() == old_key else name
        if name.casefold() == old_key:
            replaced = True
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

from typing import Optional

def _search_igdb(search_query: str, client_id: str, token: str) -> List[dict]:
    body = (
        f'search "{search_query}"; '
        f'fields name, cover.image_id, summary, first_release_date, genres.name; '
        f'limit 10;'
    )
    resp = httpx.post(
        "https://api.igdb.com/v4/games",
        headers={
            "Client-ID": client_id,
            "Authorization": f"Bearer {token}",
            "Content-Type": "text/plain",
        },
        content=body.encode(),
        timeout=10,
    )
    if resp.status_code == 200:
        return resp.json()
    return []

def _evaluate_igdb_results_with_ai(client: OpenAI, original_name: str, results: List[dict]) -> Optional[dict]:
    if not results:
        return None
        
    candidates_text = ""
    for idx, r in enumerate(results, 1):
        summary = r.get('summary', 'No summary available')
        candidates_text += f"[{idx}] Title: {r.get('name', 'Unknown')}\nSummary: {summary}\n\n"
        
    prompt = f"""The user has saved a game in their library with the informal name: '{original_name}'.
Below are {len(results)} potential matches found on IGDB.

{candidates_text}
Which of these {len(results)} games is the correct match for the user's game '{original_name}'?
If one is a match, reply ONLY with its index number (e.g., '1', '2', etc.). Do not include any other text.
If none of them match the game the user most likely meant, reply ONLY with 'none'."""

    response = client.chat.completions.create(
        model="moonshot-v1-8k",
        messages=[
            {"role": "system", "content": "You are a highly accurate videogame metadata assistant. Respond ONLY with a number or 'none'."},
            {"role": "user", "content": prompt}
        ]
    )
    answer = response.choices[0].message.content.strip().lower()
    
    if answer == 'none':
        return None
        
    try:
        idx = int(answer) - 1
        if 0 <= idx < len(results):
            return results[idx]
    except ValueError:
        pass
        
    return None

def process_auto_fill(game_ids: List[int], overwrite: bool, user_id: int):
    auto_fill_progress[user_id] = {"total": len(game_ids), "completed": 0, "status": "running"}
    from dotenv import load_dotenv
    load_dotenv()
    
    db = database.SessionLocal()
    try:
        api_key = os.getenv("MOONSHOT_API_KEY")
        if not api_key:
            logger.error("MOONSHOT_API_KEY is missing")
            return
            
        client = OpenAI(
            api_key=api_key.strip(),
            base_url="https://api.moonshot.ai/v1",
        )
        
        client_id = os.getenv("TWITCH_SECRET_CLIENT_ID", "").strip()
        
        games = db.query(models.Videogame).filter(models.Videogame.id.in_(game_ids), models.Videogame.user_id == user_id).all()
        
        for game in games:
            if not overwrite:
                if game.description and game.image_url and game.publication_year:
                    if user_id in auto_fill_progress:
                        auto_fill_progress[user_id]["completed"] += 1
                    continue

            try:
                token = _get_twitch_token()
                
                # 1. Search with original name
                igdb_results = _search_igdb(game.name, client_id, token)
                
                # 2. Bulk evaluate with AI
                matched_game = _evaluate_igdb_results_with_ai(client, game.name, igdb_results)
                
                # 3. If no match, ask Kimi for a better search term and retry
                if not matched_game:
                    suggestion_prompt = f"What is the official IGDB name for the videogame '{game.name}'? Reply ONLY with the name itself."
                    suggestion_response = client.chat.completions.create(
                        model="moonshot-v1-8k",
                        messages=[
                            {"role": "system", "content": "You are a videogame database expert. Return ONLY the standard formal name."},
                            {"role": "user", "content": suggestion_prompt}
                        ]
                    )
                    suggested_name = suggestion_response.choices[0].message.content.strip().strip("'\"")
                    
                    if suggested_name and suggested_name.lower() != game.name.lower():
                        igdb_results_fallback = _search_igdb(suggested_name, client_id, token)
                        matched_game = _evaluate_igdb_results_with_ai(client, game.name, igdb_results_fallback)
                
                # 4. If we finally have a match, apply it
                if matched_game:
                    igdb_game = matched_game
                    
                    cover_url = None
                    if igdb_game.get("cover") and igdb_game["cover"].get("image_id"):
                        image_id = igdb_game["cover"]["image_id"]
                        cover_url = f"https://images.igdb.com/igdb/image/upload/t_cover_big/{image_id}.jpg"
                    
                    release_year = None
                    if igdb_game.get("first_release_date"):
                        import datetime
                        release_year = datetime.datetime.utcfromtimestamp(igdb_game["first_release_date"]).year
                        
                    summary = igdb_game.get("summary")
                    
                    if overwrite or not game.description:
                        game.description = summary if summary else game.description
                    if overwrite or not game.image_url:
                        game.image_url = cover_url if cover_url else game.image_url
                    if overwrite or not game.publication_year:
                        game.publication_year = release_year if release_year else game.publication_year
                        
                    db.commit()
                        
            except Exception as e:
                logger.error(f"Error processing {game.name}: {e}")
                db.rollback()
            
            # Increment progress for each game
            if user_id in auto_fill_progress:
                auto_fill_progress[user_id]["completed"] += 1

        if user_id in auto_fill_progress:
            auto_fill_progress[user_id]["status"] = "done"
            
    except Exception as e:
        logger.error(f"Error in background process: {e}")
        if user_id in auto_fill_progress:
            auto_fill_progress[user_id]["status"] = "error"
    finally:
        db.close()


@router.get("/tags", response_model=List[schemas.TagResponse])
def get_tags(
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    global_tags = db.query(models.Tag).filter(models.Tag.user_id == None).all()
    user_tags = db.query(models.Tag).filter(models.Tag.user_id == current_user.id).all()
    
    # Auto-seed if exactly empty
    if not global_tags and not user_tags:
        default_names = ["Gacha", "Online", "Completed", "Multiplayer", "RPG", "Action", "Strategy"]
        for name in default_names:
            tag = models.Tag(name=name, user_id=None)
            db.add(tag)
        db.commit()
        global_tags = db.query(models.Tag).filter(models.Tag.user_id == None).all()
        
    return global_tags + user_tags

@router.post("/tags/global", response_model=schemas.TagResponse)
def create_global_tag(
    tag: schemas.TagCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to create global tags")
        
    tag_name = _clean_tag_name(tag.name)
    existing = db.query(models.Tag).filter(models.Tag.user_id == None).all()
    if any(item.name.casefold() == tag_name.casefold() for item in existing):
        raise HTTPException(status_code=409, detail="A global tag with this name already exists")

    db_tag = models.Tag(name=tag_name, user_id=None)
    db.add(db_tag)
    db.commit()
    db.refresh(db_tag)
    return db_tag


@router.put("/tags/{tag_id}", response_model=schemas.TagResponse)
def update_tag(
    tag_id: int,
    tag_update: schemas.TagUpdate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_tag = db.query(models.Tag).filter(models.Tag.id == tag_id).first()
    if not db_tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if db_tag.user_id is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to edit global tags")
    if db_tag.user_id is not None and db_tag.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to edit this tag")

    new_name = _clean_tag_name(tag_update.name)
    sibling_tags = db.query(models.Tag).filter(
        models.Tag.id != tag_id,
        models.Tag.user_id == db_tag.user_id,
    ).all()
    if any(item.name.casefold() == new_name.casefold() for item in sibling_tags):
        raise HTTPException(status_code=409, detail="A tag with this name already exists")

    old_name = db_tag.name
    if old_name.casefold() != new_name.casefold() or old_name != new_name:
        games_query = db.query(models.Videogame)
        imports_query = db.query(models.SmartImportItem)
        if db_tag.user_id is not None:
            games_query = games_query.filter(models.Videogame.user_id == db_tag.user_id)
            imports_query = imports_query.join(models.SmartImportSession).filter(
                models.SmartImportSession.user_id == db_tag.user_id
            )
        for game in games_query.all():
            _replace_game_tag(game, old_name, new_name)
        for item in imports_query.all():
            names, as_json = _read_tag_names(item.tags)
            old_key = old_name.casefold()
            if any(name.casefold() == old_key for name in names):
                updated = [new_name if name.casefold() == old_key else name for name in names]
                item.tags = _write_tag_names(list(dict.fromkeys(updated)), as_json)
        db_tag.name = new_name

    db.commit()
    db.refresh(db_tag)
    return db_tag


@router.get("/tags/{tag_id}/usage", response_model=schemas.TagUsageResponse)
def get_tag_usage(
    tag_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_tag = db.query(models.Tag).filter(models.Tag.id == tag_id).first()
    if not db_tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if db_tag.user_id is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to inspect this global tag")
    if db_tag.user_id is not None and db_tag.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to inspect this tag")

    query = db.query(models.Videogame, models.User.username).join(
        models.User, models.User.id == models.Videogame.user_id
    )
    if db_tag.user_id is not None:
        query = query.filter(models.Videogame.user_id == db_tag.user_id)
    games = [
        {
            "id": game.id,
            "name": game.name,
            "user_id": game.user_id,
            "username": username,
            "image_url": game.image_url,
            "status": game.status,
        }
        for game, username in query.all()
        if _game_has_tag(game, db_tag.name)
    ]
    return {"tag": db_tag, "games": games}


@router.post("/tags/{tag_id}/reassign", response_model=schemas.TagResponse)
def reassign_and_delete_tag(
    tag_id: int,
    reassignment: schemas.TagReassignment,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_tag = db.query(models.Tag).filter(models.Tag.id == tag_id).first()
    if not db_tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if db_tag.user_id is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to delete global tags")
    if db_tag.user_id is not None and db_tag.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this tag")

    replacement_name = _clean_tag_name(reassignment.replacement_name)
    if replacement_name.casefold() == db_tag.name.casefold():
        raise HTTPException(status_code=422, detail="Choose a different replacement tag")

    replacement_tag = next((
        item for item in db.query(models.Tag).filter(models.Tag.user_id == db_tag.user_id).all()
        if item.id != tag_id and item.name.casefold() == replacement_name.casefold()
    ), None)
    if replacement_tag is None:
        replacement_tag = models.Tag(name=replacement_name, user_id=db_tag.user_id)
        db.add(replacement_tag)
        db.flush()

    games_query = db.query(models.Videogame)
    if db_tag.user_id is not None:
        games_query = games_query.filter(models.Videogame.user_id == db_tag.user_id)
    for game in games_query.all():
        _replace_game_tag(game, db_tag.name, replacement_tag.name)

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
    db_tag = db.query(models.Tag).filter(models.Tag.id == tag_id).first()
    if not db_tag:
        raise HTTPException(status_code=404, detail="Tag not found")
        
    # Only admin can delete global tags, and users can only delete their own tags
    if db_tag.user_id is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to delete global tags")
    elif db_tag.user_id is not None and db_tag.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this tag")
        
    games_query = db.query(models.Videogame)
    if db_tag.user_id is not None:
        games_query = games_query.filter(models.Videogame.user_id == db_tag.user_id)
    if any(_game_has_tag(game, db_tag.name) for game in games_query.all()):
        raise HTTPException(
            status_code=409,
            detail="This tag is still assigned to games. Reassign those games before deleting it."
        )

    db.delete(db_tag)
    db.commit()
    return {"status": "ok"}

@router.post("/admin/migrate-playtime")
def migrate_playtime(
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized")
        
    games = db.query(models.Videogame).filter(
        models.Videogame.playtime_hours.is_(None),
        models.Videogame.time_spent.isnot(None),
        models.Videogame.time_spent != ""
    ).all()
    
    if not games:
        return {"message": "No games to migrate", "migrated": 0}

    try:
        import os
        import json
        from openai import OpenAI
        from dotenv import load_dotenv
        
        load_dotenv()
        raw_key = os.getenv("MOONSHOT_API_KEY")
        if not raw_key:
            raise Exception("MOONSHOT_API_KEY missing")
        client = OpenAI(api_key=raw_key.strip(), base_url="https://api.moonshot.ai/v1")
        
        system_instruction = (
            "You are a helpful data extraction assistant. "
            "You will be given a JSON array of objects with 'id' and 'time_spent' strings. "
            "Your task is to estimate/extract a numeric float of hours played from the 'time_spent' string. "
            "For example: '50 hrs' -> 50.0, '2 weeks' -> 336.0, 'about 10 hours' -> 10.0, 'a bit' -> null. "
            "Return strictly a JSON array of objects with 'id' and 'playtime_hours'. Wrap in ```json ... ```"
        )

        batch_size = 50
        migrated_count = 0
        
        for i in range(0, len(games), batch_size):
            batch = games[i:i+batch_size]
            payload = [{"id": g.id, "time_spent": g.time_spent} for g in batch]
            
            response = client.chat.completions.create(
                model="kimi-k2.5",
                messages=[
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": json.dumps(payload)}
                ]
            )
            
            content = response.choices[0].message.content
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
                results = json.loads(json_str.strip())
                for res in results:
                    g_id = res.get("id")
                    hours = res.get("playtime_hours")
                    if g_id is not None:
                        game = next((g for g in batch if g.id == g_id), None)
                        if game:
                            game.playtime_hours = float(hours) if hours is not None else 0.0
                            migrated_count += 1
            except Exception as e:
                print("Failed to parse chunk", e)
                
        db.commit()
        return {"message": "Migration completed", "migrated": migrated_count}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Migration failed: {e}")

@router.get("/", response_model=List[schemas.VideogameResponse])
def get_videogames(
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    games = db.query(models.Videogame).filter(models.Videogame.user_id == current_user.id).all()
    return games

@router.post("/check-similar", response_model=List[schemas.VideogameResponse])
def check_similar_game(
    name_payload: dict,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    """
    Expects json payload: {"name": "Game Name"}
    Returns list of games that closely match via SequenceMatcher
    """
    target_name = name_payload.get("name", "").lower().strip()
    if not target_name:
        return []
        
    user_games = db.query(models.Videogame).filter(models.Videogame.user_id == current_user.id).all()
    
    similar_games = []
    for game in user_games:
        match_ratio = difflib.SequenceMatcher(None, target_name, game.name.lower().strip()).ratio()
        if match_ratio >= 0.75: # 75% similarity threshold
            similar_games.append(game)
            
    return similar_games

@router.post("/", response_model=schemas.VideogameResponse)
def create_videogame(
    game: schemas.VideogameCreate, 
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    new_game = models.Videogame(**game.model_dump(), user_id=current_user.id)
    db.add(new_game)
    db.commit()
    db.refresh(new_game)
    return new_game

@router.put("/{game_id}", response_model=schemas.VideogameResponse)
def update_videogame(
    game_id: int,
    game_update: schemas.VideogameCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_game = db.query(models.Videogame).filter(
        models.Videogame.id == game_id,
        models.Videogame.user_id == current_user.id
    ).first()
    
    if not db_game:
        raise HTTPException(status_code=404, detail="Game not found or unauthorized")
        
    update_data = game_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_game, key, value)
        
    db.commit()
    db.refresh(db_game)
    return db_game

@router.delete("/{game_id}")
def delete_videogame(
    game_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_game = db.query(models.Videogame).filter(
        models.Videogame.id == game_id,
        models.Videogame.user_id == current_user.id
    ).first()
    
    if not db_game:
        raise HTTPException(status_code=404, detail="Game not found or unauthorized")
        
    db.delete(db_game)
    db.commit()
    return {"status": "ok"}

@router.post("/auto-fill")
def auto_fill_games(
    payload: schemas.AutoFillPayload,
    background_tasks: BackgroundTasks,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    background_tasks.add_task(process_auto_fill, payload.game_ids, payload.overwrite, current_user.id)
    return {"status": "started"}

@router.get("/auto-fill/status")
def get_auto_fill_status(current_user: Annotated[models.User, Depends(get_current_user)]):
    progress = auto_fill_progress.get(current_user.id)
    if progress:
        return progress
    return {"status": "idle"}
