from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
import logging

from .. import database, schemas, crud, auth, models, import_utils, ai_import

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/import/ai", tags=["ai-import"])


# --- Request / Response Models ---


class AIUploadRequest(BaseModel):
    sheet_name: str
    status_choice: str  # 'backlog' or 'finished'


class ConflictItem(BaseModel):
    row_index: int
    game_id: int
    existing: Dict[str, Any]
    new_data: Dict[str, Any]


class AIUploadResponse(BaseModel):
    processed: int
    created: int
    updated: int
    skipped: int
    conflicts: List[ConflictItem]


class ResolutionItem(BaseModel):
    game_id: int
    choice: str  # 'new' or 'existing'
    new_data: Optional[Dict[str, Any]] = None


class ResolveRequest(BaseModel):
    resolutions: List[ResolutionItem]


# --- Endpoints ---


@router.post("/analyze")
async def ai_analyze_file(
    file: UploadFile = File(...),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Parse Excel and return sheet names + row counts for sheet selection."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin required")

    content = await file.read()

    try:
        sheets_data = import_utils.parse_excel_file(content)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse file: {str(e)}")

    sheets_info = []
    for sheet_name, rows in sheets_data.items():
        if rows:
            headers = [h for h in list(rows[0].keys()) if not h.startswith("Unnamed:")]
            sheets_info.append(
                {
                    "sheet_name": sheet_name,
                    "row_count": len(rows),
                    "headers": headers,
                }
            )

    return {"sheets": sheets_info}


@router.post("/upload", response_model=AIUploadResponse)
async def ai_upload(
    file: UploadFile = File(...),
    sheet_name: str = Form(...),
    status_choice: str = Form(...),
    title_column: str = Form(None),
    processing_strategy: str = Form("update"),  # 'skip' or 'update'
    extra_instructions: str = Form(None),
    current_user: models.User = Depends(auth.get_current_user),
    db: AsyncSession = Depends(database.get_db),
):
    """
    Upload Excel, process each row with AI, and upsert into DB.
    Returns conflicts for user resolution.
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin required")

    if status_choice not in ("backlog", "finished"):
        raise HTTPException(
            status_code=400, detail="status_choice must be 'backlog' or 'finished'"
        )

    content = await file.read()

    try:
        sheets_data = import_utils.parse_excel_file(content)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse file: {str(e)}")

    rows = sheets_data.get(sheet_name)
    if not rows:
        raise HTTPException(
            status_code=400, detail=f"Sheet '{sheet_name}' not found or empty"
        )

    # Get headers
    headers = [h for h in list(rows[0].keys()) if not h.startswith("Unnamed:")]

    # Get existing games for conflict detection
    existing_games = await crud.get_games(db, user_id=current_user.id)

    processed = 0
    created = 0
    updated = 0
    skipped = 0
    conflicts: List[ConflictItem] = []

    for idx, row in enumerate(rows):
        # Extract values and colors in header order
        row_values = []
        row_colors = []
        for h in headers:
            cell = row.get(h)
            if isinstance(cell, dict):
                row_values.append(cell.get("v"))
                row_colors.append(cell.get("c"))
            else:
                row_values.append(cell)
                row_colors.append(None)

        # SMART SKIP LOGIC
        if processing_strategy == "skip" and title_column:
            cell_data = row.get(title_column)
            if cell_data:
                # Extract value safely
                raw_title = (
                    cell_data.get("v") if isinstance(cell_data, dict) else cell_data
                )
                if raw_title:
                    match = import_utils.fuzzy_find_game(str(raw_title), existing_games)
                    if match:
                        logger.info(
                            f"Row {idx}: Skipped because '{raw_title}' already exists"
                        )
                        skipped += 1
                        continue

        # Call AI
        ai_result = await ai_import.process_row_with_ai(
            headers, row_values, status_choice, extra_instructions, row_colors
        )
        processed += 1

        if ai_result is None:
            skipped += 1
            logger.warning(f"Row {idx}: AI returned None, skipping")
            continue

        # Check for existing game
        match = import_utils.fuzzy_find_game(ai_result.title, existing_games)

        if match:
            # Compare fields to detect real conflicts
            new_data = ai_result.model_dump(exclude_none=True)
            existing_data = {}
            has_diff = False

            for field in new_data:
                if field == "title":
                    continue
                existing_val = getattr(match, field, None)
                new_val = new_data[field]

                # Normalize enums to their value
                if hasattr(existing_val, "value"):
                    existing_val = existing_val.value

                existing_data[field] = existing_val

                if existing_val is not None and existing_val != new_val:
                    has_diff = True

            if has_diff:
                # Conflict - let user decide
                # Build full existing representation
                full_existing = {
                    "title": match.title,
                    "status": match.status.value if match.status else None,
                    "hype_score": match.hype_score,
                    "rating": match.rating,
                    "progress": match.progress.value if match.progress else None,
                    "playtime_hours": match.playtime_hours,
                    "finish_year": match.finish_year,
                    "release_year": match.release_year,
                    "price": match.price,
                    "platform": match.platform,
                    "steam_deck": match.steam_deck,
                    "notes": match.notes,
                }
                conflicts.append(
                    ConflictItem(
                        row_index=idx,
                        game_id=match.id,
                        existing=full_existing,
                        new_data=new_data,
                    )
                )
            else:
                # No conflict - fill empty fields
                update_payload = {}
                for field, val in new_data.items():
                    if field == "title":
                        continue
                    current_val = getattr(match, field, None)
                    if current_val is None:
                        update_payload[field] = val

                if update_payload:
                    try:
                        game_update = schemas.GameUpdate(**update_payload)
                        await crud.update_game(
                            db, match.id, game_update, current_user.id
                        )
                        updated += 1
                    except Exception as e:
                        logger.error(f"Row {idx}: Update error: {e}")
                        skipped += 1
        else:
            # Create new game
            try:
                create_data = ai_result.model_dump(exclude_none=True)
                if "status" not in create_data:
                    create_data["status"] = status_choice
                game_create = schemas.GameCreate(**create_data)
                new_game = await crud.create_user_game(db, game_create, current_user.id)
                created += 1
                # Add to existing list so subsequent rows can match
                existing_games.append(new_game)
            except Exception as e:
                logger.error(f"Row {idx}: Create error: {e}")
                skipped += 1

    return AIUploadResponse(
        processed=processed,
        created=created,
        updated=updated,
        skipped=skipped,
        conflicts=conflicts,
    )


@router.post("/resolve")
async def ai_resolve(
    request: ResolveRequest,
    current_user: models.User = Depends(auth.get_current_user),
    db: AsyncSession = Depends(database.get_db),
):
    """Resolve conflicts: apply 'new' data or keep 'existing'."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin required")

    resolved = 0
    kept = 0

    for item in request.resolutions:
        if item.choice == "new" and item.new_data:
            try:
                game_update = schemas.GameUpdate(**item.new_data)
                await crud.update_game(db, item.game_id, game_update, current_user.id)
                resolved += 1
            except Exception as e:
                logger.error(f"Resolve error for game {item.game_id}: {e}")
        else:
            kept += 1

    return {"resolved": resolved, "kept": kept}
