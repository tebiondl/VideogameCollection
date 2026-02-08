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
    # Map db_column -> header_name (or None to skip)
    column_mapping: Dict[str, Optional[str]]
    merge_strategy: str  # 'overwrite' or 'fill'
    data: List[Dict[str, Any]]  # The raw rows for this sheet


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
        headers = list(rows[0].keys())

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

    # Title mapping MUST exist
    title_header = request.column_mapping.get("title")
    if not title_header:
        raise HTTPException(status_code=400, detail="Title mapping is required")

    for row in request.data:
        # Extract title
        title_val = row.get(title_header)
        if not title_val:
            continue  # Skip rows without title

        # Check existing
        match = import_utils.fuzzy_find_game(str(title_val), existing_games)

        # Prepare new data
        new_data = {}
        for db_col, header in request.column_mapping.items():
            if header and header in row and row[header] is not None:
                # Type conversion logic could go here (clean integers, etc)
                # For now assuming simple compatibility or ignoring errors
                # Ideally import_utils should have cleaner functions
                new_data[db_col] = row[header]

        # Force title
        new_data["title"] = str(title_val)

        if match:
            # UPDATE
            # Strategy: Overwrite or Fill
            update_payload = {}
            for k, v in new_data.items():
                if request.merge_strategy == "overwrite":
                    update_payload[k] = v
                elif request.merge_strategy == "fill":
                    # Only if current value is None
                    current_val = getattr(match, k)
                    if current_val is None or current_val == "":
                        update_payload[k] = v

            if update_payload:
                # Need a crude schema update or direct setattr
                # Using crud update_game requires Pydantic model
                # We'll construct a partial update
                try:
                    game_update = schemas.GameUpdate(**update_payload)
                    await crud.update_game(db, match.id, game_update, current_user.id)
                    updated_count += 1
                except Exception:
                    pass  # Validation error usually
        else:
            # CREATE
            new_data["status"] = "backlog"  # Default if not mapped
            # Map specific status strings if found?
            # If status in new_data, we might need to normalize it (e.g. "Terminado" -> "finished")
            if "status" in new_data:
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
