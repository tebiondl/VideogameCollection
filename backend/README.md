# Backend configuration

Copy `.env.example` to `.env` and fill in only the integrations you want to use.

BoardGameGeek search and metadata sync require an approved XML API2 application token. Register the app at <https://boardgamegeek.com/applications>, then set `BGG_API_TOKEN` in `.env`. Wishlist rank and owned-game BGG fields remain manually editable when no token is configured.

## Board-game Excel Smart Add

The board-game dashboard includes a deterministic `.xlsx` importer; it does not require an AI key. It previews wishlist games, owned games, expansions and match history before committing. Uploads are limited to 10 MB, are scoped to the authenticated user, and use stable row keys so re-uploading the same workbook does not duplicate matches.

Recognized Spanish headers include `NOMBRE`, `BGG`, `PRECIO (Eur)`, `GANAS`, `Expansiones`, `NOTA`, `JUEGO`, `COMPAS`, `COOP`, `VICTORIA`, `COMENTARIOS` and `FECHA`. Equivalent English headers are also accepted.

## Videogame Discovery

The videogame landing route restores the signed-in user's last Collection, Games I want, or Discovery tab on that browser (localStorage). Explicit tab URLs override the preference. Smart Add, Admin and Analytics remain attached to Collection or Games I want; Discovery is the release-information view. Board-game navigation links open its existing collection, wishlist and match sections and remember the last selection.

Discovery uses additive `wanted_games`, `discovery_settings`, `discovery_cache` and `physical_releases` tables, created at backend startup. Existing collection rows are not migrated or mixed into Discovery. Back up your database before normal production upgrades. Start/restart the backend and rebuild the frontend to load this feature.

### Steam connection and scheduling

In **Videogames → Games I want → Admin**, enter a 17-digit SteamID64 or numeric `https://steamcommunity.com/profiles/...` URL and enable automatic imports. Vanity URLs are not accepted; use the numeric profile ID. The Steam profile and game details must be public. Wishlist sync needs no key. Owned-library sync uses Steam's supported `IPlayerService/GetOwnedGames/v1` endpoint and therefore needs a 32-character Steam Web API key. Enter it in Admin, or set `STEAM_WEB_API_KEY` on the server. A key entered in Admin is stored server-side per user and is exposed to the client only as a configured/not-configured flag. Steam passwords are never requested or stored.

Choose every 6 hours (four pulls per day, default) or 8 hours (three). FastAPI's lifespan worker checks due connections every minute; scheduling timestamps and atomic job claims live in the database. Keep the backend running for automatic imports. Missed schedules resume on startup, and abandoned running jobs can be reclaimed after a one-hour lease. Manual sync has a five-minute successful-sync cooldown. Long imports are bounded to 500 new apps / five minutes per run; remaining or unavailable entries retry next run. Completed rows survive interrupted imports.

The service uses Steam's public `IWishlistService/GetWishlist/v1`, keyed `IPlayerService/GetOwnedGames/v1`, and store `api/appdetails` endpoints. Failures appear in Admin, preserve saved games, and retry on schedule. A library-key failure does not stop a successful wishlist import. Empty or ambiguous responses never trigger deletion. Steam metadata is cached for seven days, and uncached requests are paced.

Imports never overwrite local fields or remove local games. Steam genres are not imported as personal tags. Locally deleted wishlist entries keep a hidden identity so imports cannot recreate them; explicitly saving the same Steam app ID restores one. Each owned Steam app is linked permanently to one Collection game and represented as a Steam copy there. Reconciliation checks an existing Steam link, a reviewed Games I Want acquisition, IGDB identity, normalized title, and a conservative fuzzy title match before creating a new Collection game. Strong, unambiguous fuzzy matches link automatically. An uncertain Steam title can retain several ranked collection candidates in Admin. The user selects one candidate and confirms it, which uses Steam's title on that collection record, attaches the Steam copy, and preserves its other local data. Choosing None of these creates a separate Steam collection record. Once decided, later syncs reuse the stored link and never repeat title matching. Existing collection metadata remains authoritative; Steam may initialize blank playtime but cannot replace a saved value. Multiple copies live under one collection game and are collapsed by default. Moving a wanted entry manually still opens a complete review form. Standalone DLCs remain marked in Collection.

Admin can unsync all Steam data after an explicit confirmation. This pauses automatic synchronization, removes Steam-imported wanted entries, Steam copies, durable links and pending reviews, and deletes collection rows that Steam synchronization originally created when they have no non-Steam copy. Pre-existing collection records, local fields, and non-Steam copies are retained. The Steam ID and API key remain configured so the imports can be regenerated later.

After each Steam sync, Steam-linked wanted entries and owned copies are completed from IGDB. Exact IGDB external-game links for the Steam App ID are preferred; unresolved apps use a guarded title match that also checks whether the result is a base game or DLC. Completion fills only missing metadata such as description, cover, release date, DLC classification and parent game, so personal tags and edited fields remain unchanged. Matches and misses are cached for 30 days.

### Release timeline and metadata

The calendar always displays the previous and current calendar month using server-local dates. Europe combines the public [Nintendo Europe catalog](https://searching.nintendo-europe.com/en/select?q=*&fq=type:GAME%20AND%20system_type:nintendoswitch%20AND%20physical_version_b:true&rows=1&wt=json) with Nintendo Life's public monthly retail guide discovered through its Guides RSS feed; both are cached for 24 hours. The combined list covers Nintendo Switch and Nintendo Switch 2 and labels Game-Key Card and code-in-box products. Nintendo's `physical_version_b` field is retained as an official cross-check but is known to undercount future retail releases. When both European sources cannot be reached—and for North America or Japan—the fallback uses IGDB's documented `external_games.game_release_format` and `release_dates` APIs. Source and coverage status remain visible because limited-print and regional releases can still be missing.

Global admins can add, edit or remove sourced physical releases for any supported region. A matching admin title takes precedence over the Nintendo listing in the displayed month. Owned titles can be hidden, and any timeline release can be reviewed and saved to Games I want.

Search and nested DLC lookup reuse [IGDB's Twitch-authenticated API](https://api-docs.igdb.com/). Configure the existing `TWITCH_SECRET_CLIENT_ID` and `TWITCH_SECRET` variables. Online results populate editable fields, including standalone DLC classification and parent game. The UI requires selecting a match before applying metadata.

### Imports, exports and verification

Discovery Smart Add supports an IGDB search, one title per line, CSV with named columns, or a JSON array (1 MB file / 500 rows maximum). Preview, edit and remove rows before committing. No AI key is required for these formats. Validation rejects the whole batch if a row is invalid; duplicate rows are skipped. Discovery Admin exports editable JSON that can be re-imported through Smart Add.

Run `backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v` from the repository root. Tests use isolated SQLite databases and mocked services. From `frontend`, run `npm test`, `npm run build`, and lint the changed components. Browser verification should use a separate `DATABASE_URL` to keep fixture data out of personal collections.

## Database backups

The server creates a verified, gzip-compressed SQLite snapshot when it starts and the backup schedule is due. Each snapshot contains the complete shared application database: videogames, wanted games, Steam links, board games, expansions, match history, users, tags and settings. By default it creates one every 24 hours and retains the latest seven snapshots. Backups live in a `backups` directory beside the SQLite database, or in `BACKUP_DIR` when configured. Docker stores them under `data/backups`, inside the existing persistent data volume.

Administrators can create, restore, download, and remove snapshots from **Videogame Admin → Maintenance**. Restoring verifies the selected snapshot and creates a fresh safety backup of the current database before replacing it. Download an occasional snapshot to another device or cloud storage because local rotation protects against accidental edits and corruption, but cannot protect against failure of the disk that contains both the live database and its backups.

Configuration:

- `BACKUP_DIR`: optional backup directory.
- `BACKUP_RETENTION`: number of compressed snapshots to retain, from 1 to 90; default 7.
- `BACKUP_INTERVAL_HOURS`: automatic interval, from 1 to 168 hours; default 24.

To restore a snapshot, stop the backend, decompress the selected `.sqlite3.gz`
file, replace the configured SQLite database file with the decompressed copy,
and start the backend again. Keep the replaced database until the restored app
has been checked successfully.
