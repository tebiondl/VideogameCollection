import os
import json
import logging
from openai import OpenAI
from .schemas import GameAIImport
from .models import GameStatus, GameProgress

logger = logging.getLogger(__name__)

KIMI_API_KEY = os.environ.get("KIMI_API_KEY", "")
KIMI_BASE_URL = os.environ.get("KIMI_BASE_URL", "https://api.moonshot.ai/v1")
KIMI_MODEL = os.environ.get("KIMI_MODEL", "kimi-k2-0711-preview")

# JSON schema for the AI to follow
GAME_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Game title (required)"},
        "status": {
            "type": "string",
            "enum": ["backlog", "finished"],
            "description": "Game status",
        },
        "hype_score": {
            "type": "integer",
            "description": "Hype/desire score (1-10)",
            "nullable": True,
        },
        "rating": {
            "type": "number",
            "description": "Rating/score given to the game",
            "nullable": True,
        },
        "progress": {
            "type": "string",
            "enum": ["Empezado", "A mitad", "Avanzado", "Terminado"],
            "description": "Game progress status",
            "nullable": True,
        },
        "playtime_hours": {
            "type": "number",
            "description": "Hours played",
            "nullable": True,
        },
        "finish_year": {
            "type": "integer",
            "description": "Year the game was finished",
            "nullable": True,
        },
        "release_year": {
            "type": "integer",
            "description": "Year the game was released",
            "nullable": True,
        },
        "price": {
            "type": "number",
            "description": "Price paid for the game",
            "nullable": True,
        },
        "platform": {
            "type": "string",
            "description": "Platform (e.g. PC, Switch, Steam Deck)",
            "nullable": True,
        },
        "steam_deck": {
            "type": "boolean",
            "description": "Whether played on Steam Deck",
            "nullable": True,
        },
        "notes": {
            "type": "string",
            "description": "Additional notes",
            "nullable": True,
        },
    },
    "required": ["title"],
}


def get_client() -> OpenAI:
    return OpenAI(api_key=KIMI_API_KEY, base_url=KIMI_BASE_URL)


def process_row_with_ai(
    column_names: list[str],
    row_values: list,
    status_choice: str,
) -> GameAIImport | None:
    """
    Sends one Excel row to Kimi K2.5 and returns a GameAIImport object.
    status_choice is either 'backlog' or 'finished'.
    """
    client = get_client()

    # Build the row representation
    row_repr = "\n".join(
        f"- {col}: {val}"
        for col, val in zip(column_names, row_values)
        if val is not None
    )

    system_prompt = f"""You are a data parsing assistant for a videogame collection tracker.
You will receive the column names and values from one row of an Excel spreadsheet.
Your job is to extract the videogame information and return it as a JSON object.

The JSON must follow this schema:
{json.dumps(GAME_SCHEMA, indent=2)}

Rules:
- "title" is REQUIRED. Extract the game title from the row.
- The "status" field MUST be set to "{status_choice}".
- Only include fields you can confidently extract from the data. Leave out fields you cannot determine (do NOT invent data).
- For "progress", valid values are: "Empezado", "A mitad", "Avanzado", "Terminado".
- For numeric fields (hype_score, rating, playtime_hours, price), convert to the appropriate number type.
- For years (finish_year, release_year), extract 4-digit year integers.
- For "steam_deck", return true/false boolean.
- Return ONLY valid JSON, no markdown, no explanation."""

    user_message = f"Here is the row data:\n{row_repr}"

    try:
        response = client.chat.completions.create(
            model=KIMI_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=1,
            response_format={"type": "json_object"},
        )

        content = response.choices[0].message.content
        if not content:
            logger.warning("Empty response from AI for row")
            return None

        data = json.loads(content)

        # Force the status
        data["status"] = status_choice

        return GameAIImport(**data)

    except Exception as e:
        logger.error(f"AI processing error: {e}")
        return None
