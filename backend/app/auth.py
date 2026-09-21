from datetime import datetime, timedelta, timezone
import bcrypt
import jwt
import os
import secrets
from pathlib import Path

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = int(os.getenv("ACCESS_TOKEN_EXPIRE_DAYS", "7"))
if not 1 <= ACCESS_TOKEN_EXPIRE_DAYS <= 90:
    raise ValueError("ACCESS_TOKEN_EXPIRE_DAYS must be between 1 and 90")


def signing_key() -> str:
    configured = os.getenv("AUTH_SECRET_KEY", "").strip()
    if configured:
        if len(configured) < 32:
            raise ValueError("AUTH_SECRET_KEY must contain at least 32 characters")
        return configured
    database_url = os.getenv("DATABASE_URL", "sqlite:///./videogames.db")
    default_path = Path(database_url.removeprefix("sqlite:///" )).parent / ".auth-signing.key" if database_url.startswith("sqlite:///") else Path("data/.auth-signing.key")
    path = Path(os.getenv("AUTH_SECRET_KEY_FILE") or default_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "w") as output:
            output.write(secrets.token_urlsafe(48))
    key = path.read_text().strip()
    if len(key) < 32:
        raise ValueError("Invalid persisted authentication signing key")
    return key

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(
        plain_password.encode('utf-8'),
        hashed_password.encode('utf-8')
    )

def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, signing_key(), algorithm=ALGORITHM)
    return encoded_jwt
