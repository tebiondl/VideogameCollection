import os
import time
import httpx
import logging
from typing import Annotated, Optional
from fastapi import APIRouter, Depends, HTTPException, Query

from .. import models
from .auth_router import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/igdb", tags=["igdb"])

# ---------------------------------------------------------------------------
# Twitch OAuth token cache (simple in-memory, sufficient for a single process)
# ---------------------------------------------------------------------------
_token_cache: dict = {"access_token": None, "expires_at": 0}


def _get_twitch_token() -> str:
    """Fetch (or return cached) a Twitch client-credentials access token."""
    from dotenv import load_dotenv
    load_dotenv()

    if _token_cache["access_token"] and time.time() < _token_cache["expires_at"] - 60:
        return _token_cache["access_token"]

    client_id = os.getenv("TWITCH_SECRET_CLIENT_ID", "").strip()
    client_secret = os.getenv("TWITCH_SECRET", "").strip()

    if not client_id or not client_secret:
        raise HTTPException(
            status_code=503,
            detail="IGDB credentials (TWITCH_SECRET_CLIENT_ID / TWITCH_SECRET) are not configured.",
        )

    resp = httpx.post(
        "https://id.twitch.tv/oauth2/token",
        params={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "client_credentials",
        },
        timeout=10,
    )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Twitch token error: {resp.text}")

    data = resp.json()
    _token_cache["access_token"] = data["access_token"]
    _token_cache["expires_at"] = time.time() + data.get("expires_in", 3600)
    return _token_cache["access_token"]


# ---------------------------------------------------------------------------
# Search endpoint
# ---------------------------------------------------------------------------

@router.get("/search")
def search_games(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(10, ge=1, le=20),
    current_user: models.User = Depends(get_current_user),
):
    """
    Search IGDB for games matching the query string.
    Returns a slim list of game results (id, name, cover, summary, year).
    """
    from dotenv import load_dotenv
    load_dotenv()

    client_id = os.getenv("TWITCH_SECRET_CLIENT_ID", "").strip()
    token = _get_twitch_token()

    # IGDB query using APIcalypse syntax
    # Note: 'search' + 'where' don't combine well in IGDB — the where clause
    # causes empty results. search alone already ranks main games first.
    body = (
        f'search "{q}"; '
        f'fields name, cover.image_id, summary, first_release_date, genres.name; '
        f'limit {limit};'
    )

    try:
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
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="IGDB request timed out")

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"IGDB API error: {resp.text}")

    raw_games = resp.json()

    results = []
    for g in raw_games:
        cover_url = None
        if g.get("cover") and g["cover"].get("image_id"):
            image_id = g["cover"]["image_id"]
            cover_url = f"https://images.igdb.com/igdb/image/upload/t_cover_big/{image_id}.jpg"

        release_year: Optional[int] = None
        if g.get("first_release_date"):
            import datetime
            release_year = datetime.datetime.utcfromtimestamp(g["first_release_date"]).year

        genres = [genre["name"] for genre in g.get("genres", [])] if g.get("genres") else []

        results.append(
            {
                "igdb_id": g["id"],
                "name": g.get("name", "Unknown"),
                "cover_url": cover_url,
                "summary": g.get("summary"),
                "release_year": release_year,
                "genres": genres,
            }
        )

    return results
