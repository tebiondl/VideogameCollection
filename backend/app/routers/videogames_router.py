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
                response = client.chat.completions.create(
                    model="moonshot-v1-8k",
                    messages=[
                        {"role": "system", "content": "You are a videogame database expert. Return ONLY the standard formal name of the game that would be found in a database like IGDB. Do not output anything else. No <think> tags, no explanation."},
                        {"role": "user", "content": f"Correct this informal game name: '{game.name}'"}
                    ]
                )
                corrected_name = response.choices[0].message.content.strip()
                corrected_name = corrected_name.strip("'\"")
                
                token = _get_twitch_token()
                names_to_try = [corrected_name, game.name]
                raw_games = None
                
                for search_name in names_to_try:
                    if not search_name: continue
                    body = (
                        f'search "{search_name}"; '
                        f'fields name, cover.image_id, summary, first_release_date, genres.name; '
                        f'limit 1;'
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
                        results = resp.json()
                        if results:
                            raw_games = results
                            break
                
                if raw_games:
                    igdb_game = raw_games[0]
                    
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
