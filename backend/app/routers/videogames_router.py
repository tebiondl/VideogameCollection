from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Annotated
import difflib

from .. import schemas, models, database
from .auth_router import get_current_user

router = APIRouter(prefix="/api/videogames", tags=["videogames"])

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
