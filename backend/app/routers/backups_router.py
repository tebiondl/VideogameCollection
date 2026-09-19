from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from ..models import User
from ..services import backups
from .auth_router import get_current_user

router = APIRouter(prefix="/api/backups", tags=["backups"])


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Only administrators can manage database backups")
    return user


@router.get("")
def get_backups(_: Annotated[User, Depends(require_admin)]):
    try:
        return backups.backup_status()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("", status_code=201)
def make_backup(_: Annotated[User, Depends(require_admin)]):
    try:
        return backups.create_backup()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("/{name}/restore")
def restore_backup(name: str, _: Annotated[User, Depends(require_admin)]):
    try:
        return backups.restore_backup(name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Backup not found") from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/{name}")
def download_backup(name: str, _: Annotated[User, Depends(require_admin)]):
    try:
        path = backups.backup_path(name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Backup not found") from error
    return FileResponse(path, media_type="application/gzip", filename=path.name)


@router.delete("/{name}", status_code=204)
def remove_backup(name: str, _: Annotated[User, Depends(require_admin)]):
    try:
        backups.delete_backup(name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Backup not found") from error
