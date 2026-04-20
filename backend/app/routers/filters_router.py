from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Annotated

from .. import schemas, models, database
from .auth_router import get_current_user

router = APIRouter(prefix="/api/filters", tags=["filters"])

@router.get("/", response_model=List[schemas.SavedFilterResponse])
def get_filters(
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    return db.query(models.SavedFilter).filter(models.SavedFilter.user_id == current_user.id).all()

@router.post("/", response_model=schemas.SavedFilterResponse)
def create_filter(
    filter_data: schemas.SavedFilterCreate, 
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    new_filter = models.SavedFilter(
        user_id=current_user.id,
        name=filter_data.name,
        filter_data=filter_data.filter_data
    )
    db.add(new_filter)
    db.commit()
    db.refresh(new_filter)
    return new_filter

@router.delete("/{filter_id}")
def delete_filter(
    filter_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_filter = db.query(models.SavedFilter).filter(
        models.SavedFilter.id == filter_id,
        models.SavedFilter.user_id == current_user.id
    ).first()
    
    if not db_filter:
        raise HTTPException(status_code=404, detail="Filter not found")
        
    db.delete(db_filter)
    db.commit()
    return {"status": "ok"}
