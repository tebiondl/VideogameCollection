import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import database, models, schemas
from .auth_router import get_current_user


router = APIRouter(prefix="/api/settings", tags=["settings"])
PAGINATION_KEY = "pagination_page_sizes"
DEFAULT_PAGE_SIZES = [5, 10, 20, 50]


def _validated_page_sizes(values: list[int]) -> list[int]:
    sizes = sorted(set(values))
    if len(sizes) != 4:
        raise HTTPException(status_code=422, detail="Configure exactly four different page sizes")
    if any(size < 1 or size > 500 for size in sizes):
        raise HTTPException(status_code=422, detail="Page sizes must be between 1 and 500")
    return sizes


def _stored_page_sizes(db: Session) -> list[int]:
    setting = db.query(models.AppSetting).filter(models.AppSetting.key == PAGINATION_KEY).first()
    if not setting:
        return DEFAULT_PAGE_SIZES
    try:
        decoded = json.loads(setting.value)
        if isinstance(decoded, list) and all(isinstance(value, int) and not isinstance(value, bool) for value in decoded):
            return _validated_page_sizes(decoded)
    except (json.JSONDecodeError, TypeError, HTTPException):
        pass
    return DEFAULT_PAGE_SIZES


@router.get("/pagination", response_model=schemas.PaginationSettings)
def get_pagination_settings(
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    return {"page_sizes": _stored_page_sizes(db)}


@router.put("/pagination", response_model=schemas.PaginationSettings)
def update_pagination_settings(
    payload: schemas.PaginationSettings,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Only administrators can change pagination settings")
    sizes = _validated_page_sizes(payload.page_sizes)
    setting = db.query(models.AppSetting).filter(models.AppSetting.key == PAGINATION_KEY).first()
    if setting:
        setting.value = json.dumps(sizes)
    else:
        db.add(models.AppSetting(key=PAGINATION_KEY, value=json.dumps(sizes)))
    db.commit()
    return {"page_sizes": sizes}
