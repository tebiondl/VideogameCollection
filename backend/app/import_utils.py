import pandas as pd
from io import BytesIO
from thefuzz import process
from .models import Game
from typing import List, Dict, Any, Optional

# Map internal DB columns to potential human-readable headers (Spanish/English)
COLUMN_MAPPING_TARGETS = {
    "title": ["Title", "Título", "Juego", "Game", "Nombre"],
    "status": ["Status", "Estado", "Lista", "List"],
    "hype_score": ["Hype", "Ganas", "Score", "Puntuación"],
    "rating": ["Rating", "Nota", "Score", "Puntuación"],
    "progress": ["Progress", "Progreso", "Estado Juego"],
    "playtime_hours": ["Playtime", "Horas", "Tiempo", "Hours", "Duration"],
    "finish_year": ["Finish Year", "Año Terminado", "Terminado", "Finished"],
    "release_year": ["Release Year", "Año Lanzamiento", "Lanzamiento", "Released"],
    "price": ["Price", "Precio", "Coste"],
    "platform": ["Platform", "Plataforma", "Consola", "System"],
    "steam_deck": ["Steam Deck", "Deck", "Portable"],
    "notes": ["Notes", "Notas", "Comentarios"],
}


def parse_excel_file(file_content: bytes) -> Dict[str, List[Dict[str, Any]]]:
    """
    Parses an Excel file (or similar) from bytes.
    Returns a dict where keys are sheet names and values are list of records (rows).
    """
    xls = pd.ExcelFile(BytesIO(file_content))
    result = {}
    for sheet_name in xls.sheet_names:
        df = pd.read_excel(xls, sheet_name=sheet_name)
        # Drop completely empty rows/cols
        df.dropna(how="all", inplace=True)
        # Convert to object to allow None
        df = df.astype(object)
        # Convert NaN to None
        df = df.where(pd.notnull(df), None)
        # Convert to records
        records = df.to_dict(orient="records")
        if records:
            result[sheet_name] = records
    return result


def propose_mapping(headers: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    For each DB column, find the best matching header from the file.
    Returns:
    {
        "db_col_name": {
            "best_match": "Header Name",
            "score": 90,
            "alternatives": ["Other Header", "Another"]
        }
    }
    """
    mapping = {}
    used_headers = set()

    # Prioritize 'title' as it is mandatory
    # Logic: Iterate over DB targets. For each, fuzzy match against all headers.

    for db_col, candidates in COLUMN_MAPPING_TARGETS.items():
        # Find best match among all headers
        # We can use process.extractOne
        best_match = None
        best_score = 0
        alternatives = []

        # We match against the list of candidates for this db_col
        # But we need to match the *headers* from file against these *candidates*

        # Strategy: For each header, calculate score against db_col candidates.
        # Keep the header with the highest score.

        header_scores = []
        for header in headers:
            # Check if header matches any of the candidates
            extract = process.extractOne(str(header), candidates)
            if extract:
                score = extract[1]
                header_scores.append((header, score))

        # Sort headers by score descending
        header_scores.sort(key=lambda x: x[1], reverse=True)

        if header_scores:
            best_match = header_scores[0][0]
            best_score = header_scores[0][1]
            alternatives = [h[0] for h in header_scores[1:3]]

            mapping[db_col] = {
                "selected": best_match if best_score > 60 else None,  # Threshold
                "score": best_score,
                "alternatives": alternatives,
            }

    return mapping


def fuzzy_find_game(title: str, existing_games: List[Game]) -> Game:
    """
    Finds an existing game in the user's library that matches the title.
    """
    if not title or not existing_games:
        return None

    choices = {g.title: g for g in existing_games}
    extract = process.extractOne(title, choices.keys())

    if extract and extract[1] >= 90:  # High threshold for automatic matching
        return choices[extract[0]]

    return None
