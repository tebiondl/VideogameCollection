"""Operator-only credential management. No token creation endpoint is exposed."""
import argparse
import hashlib
import os
import secrets
from datetime import datetime, timedelta
from pathlib import Path

from .database import SessionLocal
from .models import User
from .integration_models import IntegrationToken

TOKEN_PREFIX = "vgc_"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token(db, username: str, name: str, mode: str, days: int = 90):
    if mode not in ("read", "write") or not 1 <= days <= 365:
        raise ValueError("Use mode read/write and an expiry of 1–365 days.")
    user = db.query(User).filter_by(username=username).first()
    if user is None:
        raise ValueError("Collection username not found.")
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = IntegrationToken(user_id=user.id, name=name, mode=mode,
                           token_hash=token_hash(token), expires_at=datetime.utcnow() + timedelta(days=days))
    db.add(row)
    db.flush()
    return row, token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--username", required=True)
    create.add_argument("--name", required=True)
    create.add_argument("--mode", choices=("read", "write"), default="read")
    create.add_argument("--days", type=int, default=90)
    create.add_argument("--output", required=True, help="New secret file; never printed or overwritten")
    commands.add_parser("list")
    revoke = commands.add_parser("revoke")
    revoke.add_argument("id", type=int)
    args = parser.parse_args()
    with SessionLocal() as db:
        if args.command == "create":
            row, secret = issue_token(db, args.username, args.name, args.mode, args.days)
            path = Path(args.output)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "w") as output:
                    output.write(secret + "\n")
                db.commit()
            except Exception:
                path.unlink(missing_ok=True)
                raise
            print(f"Created token {row.id} ({row.mode}), expires {row.expires_at.isoformat()} UTC. Secret saved to {path}.")
        elif args.command == "list":
            for row in db.query(IntegrationToken).order_by(IntegrationToken.id):
                print(f"{row.id}\t{row.name}\tuser={row.user_id}\t{row.mode}\texpires={row.expires_at.isoformat()} UTC\trevoked={row.revoked}")
        else:
            row = db.get(IntegrationToken, args.id)
            if row is None:
                parser.error("Token not found")
            row.revoked = True
            db.commit()
            print(f"Revoked token {row.id}.")


if __name__ == "__main__":
    main()
