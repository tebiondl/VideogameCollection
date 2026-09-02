# Backend configuration

Copy `.env.example` to `.env` and fill in only the integrations you want to use.

BoardGameGeek search and metadata sync require an approved XML API2 application token. Register the app at <https://boardgamegeek.com/applications>, then set `BGG_API_TOKEN` in `.env`. Wishlist rank and owned-game BGG fields remain manually editable when no token is configured.

## Board-game Excel Smart Add

The board-game dashboard includes a deterministic `.xlsx` importer; it does not require an AI key. It previews wishlist games, owned games, expansions and match history before committing. Uploads are limited to 10 MB, are scoped to the authenticated user, and use stable row keys so re-uploading the same workbook does not duplicate matches.

Recognized Spanish headers include `NOMBRE`, `BGG`, `PRECIO (Eur)`, `GANAS`, `Expansiones`, `NOTA`, `JUEGO`, `COMPAS`, `COOP`, `VICTORIA`, `COMENTARIOS` and `FECHA`. Equivalent English headers are also accepted.
