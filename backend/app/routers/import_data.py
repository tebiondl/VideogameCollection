from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
import pandas as pd
import aiohttp
from io import BytesIO

from .. import database, schemas, crud, auth, models, import_utils

router = APIRouter(prefix="/import", tags=["import"])


class MappingProposal(BaseModel):
    selected: Optional[str]
    score: int
    alternatives: List[str]


class SheetAnalysis(BaseModel):
    sheet_name: str
    headers: List[str]
    row_count: int
    mapping_proposal: Dict[str, MappingProposal]  # db_col -> proposal


class ImportRequest(BaseModel):
    sheet_name: str
    column_mapping: Dict[str, Optional[str]]
    merge_strategy: str  # 'overwrite' or 'fill'
    data: List[Dict[str, Any]]  # The raw rows for this sheet
    value_mapping: Dict[str, Dict[str, Any]] = {}
    constants: Dict[str, Any] = {}


class AnalyzeResponse(BaseModel):
    results: List[SheetAnalysis]
    rows_map: Dict[str, List[Dict[str, Any]]]


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_file(
    file: UploadFile = File(None),
    url: str = Form(None),
    current_user: models.User = Depends(auth.get_current_user),
):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin required")

    content = None
    if file:
        content = await file.read()
    elif url:
        # Simple fetch for public sheets CSV/XLSX export links
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    raise HTTPException(status_code=400, detail="Could not fetch URL")
                content = await resp.read()
    else:
        raise HTTPException(status_code=400, detail="File or URL required")

    try:
        sheets_data = import_utils.parse_excel_file(content)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse file: {str(e)}")

    analysis_results = []
    rows_map = {}

    for sheet_name, rows in sheets_data.items():
        if not rows:
            continue

        # Save rows to map
        rows_map[sheet_name] = rows

        # Get headers from first row keys
        headers = [h for h in list(rows[0].keys()) if not h.startswith("Unnamed:")]

        # Generate proposal
        proposal = import_utils.propose_mapping(headers)

        # Convert to pydantic friendly format
        clean_proposal = {}
        for k, v in proposal.items():
            clean_proposal[k] = MappingProposal(**v)

        analysis_results.append(
            SheetAnalysis(
                sheet_name=sheet_name,
                headers=headers,
                row_count=len(rows),
                mapping_proposal=clean_proposal,
            )
        )

    return {"results": analysis_results, "rows_map": rows_map}


@router.post("/execute")
async def execute_import(
    request: ImportRequest,
    current_user: models.User = Depends(auth.get_current_user),
    db: AsyncSession = Depends(database.get_db),
):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin required")

    # Get existing games for fuzzy matching
    existing_games = await crud.get_games(db, user_id=current_user.id)

    created_count = 0
    updated_count = 0

    # Title mapping MUST exist (unless provided in constants? No, title is identity)
    # We still require title mapping for now to identify games
    title_header = request.column_mapping.get("title")
    if not title_header:
        # Check if title is in constants? Unlikely but possible for single entry
        if "title" not in request.constants:
            raise HTTPException(status_code=400, detail="Title mapping is required")

    for row in request.data:
        # Extract title
        title_val = None
        if title_header:
            title_cell = row.get(title_header)
            if title_cell:
                if isinstance(title_cell, dict):
                    title_val = title_cell.get("v")
                else:
                    title_val = title_cell

        # If title is constant (edge case)
        if "title" in request.constants:
            title_val = request.constants["title"]

        if not title_val:
            print(
                f"Skipping row: No title found. Row keys: {list(row.keys())}, Title Header: {title_header}"
            )
            continue

        match = import_utils.fuzzy_find_game(str(title_val), existing_games)
        # print(f"Processing '{title_val}' -> Match: {match.title if match else 'None'}")

        new_data = {}
        # Iterate over ALL DB columns we care about
        # We can use the keys from column_mapping or constants

        # Merge keys from both mapping and constants
        all_keys = set(request.column_mapping.keys()) | set(request.constants.keys())

        for db_col in all_keys:
            final_val = None

            # 1. Check Constants
            if db_col in request.constants:
                final_val = request.constants[db_col]

            # 2. Check Column Mapping
            elif db_col in request.column_mapping:
                header = request.column_mapping[db_col]
                if header and header in row:
                    cell_data = row[header]
                    val = (
                        cell_data.get("v") if isinstance(cell_data, dict) else cell_data
                    )
                    color = cell_data.get("c") if isinstance(cell_data, dict) else None

                    # Value Mapping
                    mapped_final = val
                    col_map = request.value_mapping.get(db_col, {})

                    if val is not None and str(val) in col_map:
                        mapped_final = col_map[str(val)]
                    elif color and str(color) in col_map:
                        mapped_final = col_map[str(color)]

                    final_val = mapped_final

            # If we resolved a value, add it
            if final_val is not None:
                new_data[db_col] = final_val

        # Force title
        new_data["title"] = str(title_val)

        if match:
            # UPDATE
            update_payload = {}
            for k, v in new_data.items():
                if request.merge_strategy == "overwrite":
                    update_payload[k] = v
                elif request.merge_strategy == "fill":
                    current_val = getattr(match, k)
                    if current_val is None or current_val == "":
                        update_payload[k] = v

            if update_payload:
                try:
                    game_update = schemas.GameUpdate(**update_payload)
                    await crud.update_game(db, match.id, game_update, current_user.id)
                    updated_count += 1
                except Exception:
                    pass
        else:
            # CREATE
            if "status" not in new_data or not new_data["status"]:
                new_data["status"] = "backlog"

            # Simple normalization if not mapped
            if new_data["status"] not in [
                "backlog",
                "playing",
                "finished",
                "abandoned",
            ]:
                s = str(new_data["status"]).lower()
                if "finish" in s or "terminado" in s:
                    new_data["status"] = "finished"
                else:
                    new_data["status"] = "backlog"

            try:
                game_create = schemas.GameCreate(**new_data)
                await crud.create_user_game(db, game_create, current_user.id)
                created_count += 1
            except Exception:
                pass

    return {"created": created_count, "updated": updated_count}


@router.get("/config")
async def get_import_config(current_user: models.User = Depends(auth.get_current_user)):
    return {
        "valid_statuses": [e.value for e in models.GameStatus],
        "valid_progress": [e.value for e in models.GameProgress],
        "valid_platforms": ["PC", "Steam Deck", "Switch"],
    }
