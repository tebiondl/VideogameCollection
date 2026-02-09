from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Annotated
from .. import database, schemas, crud, auth, models

router = APIRouter(prefix="/games", tags=["games"])


@router.get("/", response_model=List[schemas.Game])
async def read_games(
    status: str = None,
    current_user: models.User = Depends(auth.get_current_user),
    db: AsyncSession = Depends(database.get_db),
):
    return await crud.get_games(db, user_id=current_user.id, status=status)


@router.post("/", response_model=schemas.Game)
async def create_game(
    game: schemas.GameCreate,
    current_user: models.User = Depends(auth.get_current_user),
    db: AsyncSession = Depends(database.get_db),
):
    return await crud.create_user_game(db=db, game=game, user_id=current_user.id)


@router.get("/{game_id}", response_model=schemas.Game)
async def read_game(
    game_id: int,
    current_user: models.User = Depends(auth.get_current_user),
    db: AsyncSession = Depends(database.get_db),
):
    db_game = await crud.get_game(db, game_id=game_id, user_id=current_user.id)
    if db_game is None:
        raise HTTPException(status_code=404, detail="Game not found")
    return db_game


@router.put("/{game_id}", response_model=schemas.Game)
async def update_game(
    game_id: int,
    game: schemas.GameUpdate,
    current_user: models.User = Depends(auth.get_current_user),
    db: AsyncSession = Depends(database.get_db),
):
    db_game = await crud.update_game(
        db, game_id=game_id, game_update=game, user_id=current_user.id
    )
    if db_game is None:
        raise HTTPException(status_code=404, detail="Game not found")
    return db_game


@router.delete("/{game_id}")
async def delete_game(
    game_id: int,
    current_user: models.User = Depends(auth.get_current_user),
    db: AsyncSession = Depends(database.get_db),
):
    db_game = await crud.delete_game(db, game_id=game_id, user_id=current_user.id)
    if db_game is None:
        raise HTTPException(status_code=404, detail="Game not found")
    return {"ok": True}


@router.delete("/")
async def delete_all_games(
    current_user: models.User = Depends(auth.get_current_user),
    db: AsyncSession = Depends(database.get_db),
):
    await crud.delete_user_games(db, user_id=current_user.id)
    return {"ok": True, "count": "All deleted"}
