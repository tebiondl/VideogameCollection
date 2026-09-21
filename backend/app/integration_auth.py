from dataclasses import dataclass
from datetime import datetime

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .integration_database import get_integration_db
from .models import User
from .integration_models import IntegrationToken
from .integration_tokens import TOKEN_PREFIX, token_hash

bearer = HTTPBearer(auto_error=False)


@dataclass
class IntegrationAccess:
    user: User
    token: IntegrationToken


def integration_access(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
                       db: Session = Depends(get_integration_db, scope="function")) -> IntegrationAccess:
    secret = credentials.credentials if credentials else ""
    row = db.query(IntegrationToken).filter_by(token_hash=token_hash(secret), revoked=False).first() if secret.startswith(TOKEN_PREFIX) else None
    if row is None or row.expires_at <= datetime.utcnow():
        raise HTTPException(401, "Integration credential is missing, expired or revoked.", headers={"WWW-Authenticate": "Bearer"})
    user = db.get(User, row.user_id)
    if user is None:
        raise HTTPException(401, "Collection account no longer exists.")
    if request.method not in ("GET", "HEAD") and row.mode != "write":
        raise HTTPException(403, "This integration has read-only access.")
    return IntegrationAccess(user, row)
