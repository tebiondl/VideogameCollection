from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import delete
from . import models, schemas
# auth import moved to function level to avoid circular dependency


async def get_user(db: AsyncSession, user_id: int):
    result = await db.execute(select(models.User).where(models.User.id == user_id))
    return result.scalars().first()


async def get_user_by_username(db: AsyncSession, username: str):
    result = await db.execute(
        select(models.User).where(models.User.username == username)
    )
    return result.scalars().first()


async def create_user(
    db: AsyncSession, user: schemas.UserCreate, is_admin: bool = False
):
    from .auth import (
        get_password_hash,
    )  # Import here to avoid circular dependency at module level if auth imports crud

    hashed_password = get_password_hash(user.password)
    db_user = models.User(
        username=user.username, password_hash=hashed_password, is_admin=is_admin
    )
    db.add(db_user)
    await db.commit()
    await db.refresh(db_user)
    return db_user


async def get_games(db: AsyncSession, user_id: int, status: str = None):
    query = select(models.Game).where(models.Game.user_id == user_id)
    if status:
        query = query.where(models.Game.status == status)
    result = await db.execute(query)
    return result.scalars().all()


async def get_game(db: AsyncSession, game_id: int, user_id: int):
    result = await db.execute(
        select(models.Game).where(
            models.Game.id == game_id, models.Game.user_id == user_id
        )
    )
    return result.scalars().first()


async def create_user_game(db: AsyncSession, game: schemas.GameCreate, user_id: int):
    db_game = models.Game(**game.model_dump(), user_id=user_id)
    db.add(db_game)
    await db.commit()
    await db.refresh(db_game)
    return db_game


async def update_game(
    db: AsyncSession, game_id: int, game_update: schemas.GameUpdate, user_id: int
):
    # Retrieve existing game
    db_game = await get_game(db, game_id, user_id)
    if not db_game:
        return None

    update_data = game_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_game, key, value)

    db.add(db_game)
    await db.commit()
    await db.refresh(db_game)
    return db_game


async def delete_game(db: AsyncSession, game_id: int, user_id: int):
    db_game = await get_game(db, game_id, user_id)
    if not db_game:
        return None
    await db.delete(db_game)
    await db.commit()
    return db_game


async def delete_user_games(db: AsyncSession, user_id: int):
    # Pass execution_options={"synchronize_session": False} if not needing session update
    await db.execute(delete(models.Game).where(models.Game.user_id == user_id))
    await db.commit()
