import os
import httpx
from dotenv import load_dotenv

load_dotenv()

client_id = os.getenv("TWITCH_SECRET_CLIENT_ID", "").strip()
client_secret = os.getenv("TWITCH_SECRET", "").strip()

resp = httpx.post(
    "https://id.twitch.tv/oauth2/token",
    params={
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "client_credentials",
    }
)
token = resp.json()["access_token"]

body = 'search "The Witcher 3"; fields name, dlcs.name, dlcs.cover.image_id, expansions.name, expansions.cover.image_id; limit 1;'

resp = httpx.post(
    "https://api.igdb.com/v4/games",
    headers={
        "Client-ID": client_id,
        "Authorization": f"Bearer {token}",
        "Content-Type": "text/plain",
    },
    content=body.encode()
)
print(resp.json())
