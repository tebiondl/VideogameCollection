from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks
from sqlalchemy.orm import Session
from typing import List, Annotated
import difflib
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
