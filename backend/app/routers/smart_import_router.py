import os
import json
import logging
import pandas as pd
from typing import List, Annotated
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    UploadFile,
    File,
    Form,
    BackgroundTasks,
)
from sqlalchemy.orm import Session
from openai import OpenAI

from .. import schemas, models, database
from .auth_router import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/smart-import", tags=["smart-import"])


# Helper function to extract text from uploads is now integrated into the payload builder directly.


def process_smart_import(session_id: int, files_payloads: List[dict]):
    db = database.SessionLocal()
    session = (
        db.query(models.SmartImportSession)
        .filter(models.SmartImportSession.id == session_id)
        .first()
    )

    if not session:
        db.close()
        return

    try:
        from dotenv import load_dotenv

        load_dotenv()

        raw_key = os.getenv("MOONSHOT_API_KEY")
        if not raw_key:
            raise Exception("MOONSHOT_API_KEY is not configured in .env")

        api_key = raw_key.strip()

        client = OpenAI(
            api_key=api_key,
            base_url="https://api.moonshot.ai/v1",
        )

        system_instruction = (
            "You are a helpful data extraction assistant. "
            "FIRST, you MUST output your internal thought process inside <think>...</think> XML tags, explicitly explaining how you interpret the file and map it to our schema. "
            "THEN, respond strictly with a valid JSON array of objects wrapped in ```json ... ``` markdown. "
            "Each JSON object MUST contain these exact fields: "
            "'name' (string, required), 'description' (string or null), 'image_url' (string or null), 'status' (string, choices: 'Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'), "
            "'time_spent' (string or null), 'mark' (integer 1-10 or null), 'completion_date' (string or null), 'publication_year' (integer or null), 'completion_percentage' (integer 0-100 or null), 'tags' (string or null). "
            "If the user specifies particular tags, use them (Gacha, Online, Runs). Comma separate tags. If status is unknown, default to 'Not Started'."
        )

        all_items = []
        raw_responses = []
        total_files = len(files_payloads)
        for i, payload in enumerate(files_payloads):
            file_name = payload["name"]
            file_text = payload["text"]
            file_prompt = payload.get("prompt", "")

            session.status = f"processing|{i + 1}/{total_files}|Initializing Moonshot stream for {file_name}..."
            db.commit()

            prompt = f"User Instructions:\n{file_prompt}\n\nFile Content:\n{file_text}"

            max_retries = 3
            collected_content = ""
            
            for attempt in range(max_retries):
                try:
                    response = client.chat.completions.create(
                        model="kimi-k2.5",
                        messages=[
                            {"role": "system", "content": system_instruction},
                            {"role": "user", "content": prompt},
                        ],
                        stream=True
                    )

                    chars_since_db_update = 0

                    for chunk in response:
                        if chunk.choices and getattr(chunk.choices[0], "delta", None):
                            delta = chunk.choices[0].delta
                            chunk_text = ""
                            
                            if hasattr(delta, "reasoning_content") and getattr(delta, "reasoning_content"):
                                chunk_text = getattr(delta, "reasoning_content")
                            elif hasattr(delta, "content") and getattr(delta, "content"):
                                chunk_text = delta.content
                                
                            if chunk_text:
                                collected_content += chunk_text
                                chars_since_db_update += len(chunk_text)
                                
                                if chars_since_db_update > 40:
                                    # Keep only the last 1500 chars to avoid gigantic DB writes
                                    tail = collected_content[-1500:] if len(collected_content) > 1500 else collected_content
                                    session.status = f"processing|{i+1}/{total_files}|{tail}"
                                    db.commit()
                                    chars_since_db_update = 0
                    
                    break  # Success, exit retry loop
                    
                except Exception as api_e:
                    error_str = str(api_e).lower()
                    if "429" in error_str or "overload" in error_str or "rate" in error_str:
                        if attempt < max_retries - 1:
                            import time
                            delay = (attempt + 1) * 6
                            session.status = f"processing|{i+1}/{total_files}|Moonshot Engine Overloaded (429). Retrying in {delay} seconds..."
                            db.commit()
                            time.sleep(delay)
                            continue
                    raise api_e

            content = collected_content.strip()
            raw_responses.append(f"--- RAW OUTPUT FOR {file_name} ---\n{content}\n")
            
            import re
            json_str = content
            json_match = re.search(r"```json\n(.*?)\n```", content, re.DOTALL)
            if json_match:
                json_str = json_match.group(1)
            else:
                fallback_match = re.search(r"```(.*?)```", content, re.DOTALL)
                if fallback_match:
                    json_str = fallback_match.group(1)

            try:
                data_list = json.loads(json_str.strip())
                all_items.extend(data_list)
            except Exception as parse_e:
                logger.error(f"Failed to parse JSON for one document chunk: {parse_e}")
                # We skip just this file's output and keep going

        for item in all_items:
            new_item = models.SmartImportItem(
                session_id=session_id,
                name=item.get("name") or "Unknown Game",
                description=item.get("description"),
                image_url=item.get("image_url"),
                status=item.get("status") or "Not Started",
                time_spent=item.get("time_spent"),
                mark=item.get("mark"),
                completion_date=item.get("completion_date"),
                publication_year=item.get("publication_year"),
                completion_percentage=item.get("completion_percentage"),
                tags=item.get("tags"),
            )
            db.add(new_item)

        session.raw_ai_response = "\n".join(raw_responses)
        session.status = "pending_review"
        db.commit()

    except Exception as e:
        logger.error(f"Smart Import Error: {e}")
        session.status = f"failed: {str(e)}"
        db.commit()
    finally:
        db.close()


@router.post("/excel-sheets")
def get_excel_sheets(
    current_user: Annotated[models.User, Depends(get_current_user)],
    file: UploadFile = File(...)
):
    if not file.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Must be an excel file")
    try:
        xl = pd.ExcelFile(file.file)
        return {"sheets": xl.sheet_names}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error parsing excel: {e}")

@router.post("/", response_model=schemas.SmartImportSessionResponse)
async def start_smart_import(
    background_tasks: BackgroundTasks,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
    config: str = Form(...),
    files: List[UploadFile] = File([]),
):
    if len(files) > 10:
        raise HTTPException(status_code=400, detail="Maximum 10 files allowed")

    try:
        config_data = json.loads(config)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid config JSON")

    new_session = models.SmartImportSession(
        user_id=current_user.id, status="processing"
    )
    db.add(new_session)
    db.commit()
    db.refresh(new_session)

    file_map = {f.filename: f for f in files}
    files_payloads = []

    for item in config_data:
        filename = item.get("filename")
        if filename not in file_map:
            continue
        
        upload_file = file_map[filename]
        file_type = item.get("type", "txt")
        prompt = item.get("prompt", "")
        
        if file_type in ("txt", "word", "csv"):
            text = ""
            name_lower = filename.lower()
            try:
                if name_lower.endswith(".csv"):
                    content = upload_file.file.read().decode("utf-8", errors="ignore")
                    has_cols = item.get("has_named_columns", True)
                    col_info = "The file has named columns." if has_cols else "The file does NOT have named columns."
                    text = f"--- [CSV Data] {col_info} ---\n{content}"
                elif name_lower.endswith((".doc", ".docx")):
                    import docx
                    doc = docx.Document(upload_file.file)
                    text = "\n".join([p.text for p in doc.paragraphs])
                else:
                    text = upload_file.file.read().decode("utf-8", errors="ignore")
            except Exception as e:
                logger.error(f"Error parsing {filename}: {e}")
                continue

            if text.strip():
                files_payloads.append({
                    "name": filename,
                    "text": text,
                    "prompt": prompt
                })

        elif file_type == "excel":
            read_independently = item.get("read_independently", False)
            sheets_config = item.get("sheets", [])
            selected_sheets = [s for s in sheets_config if s.get("selected")]
            
            if not selected_sheets:
                continue

            try:
                xl = pd.ExcelFile(upload_file.file)
                
                if read_independently:
                    for s in selected_sheets:
                        if s["name"] in xl.sheet_names:
                            df = xl.parse(s["name"])
                            sh_prompt = s.get("prompt") or prompt
                            files_payloads.append({
                                "name": f'{filename} - Sheet: {s["name"]}',
                                "text": df.to_csv(index=False),
                                "prompt": sh_prompt
                            })
                else:
                    combined_text = []
                    for s in selected_sheets:
                        if s["name"] in xl.sheet_names:
                            df = xl.parse(s["name"])
                            combined_text.append(f"--- Sheet: {s['name']} ---\n{df.to_csv(index=False)}")
                    if combined_text:
                        files_payloads.append({
                            "name": filename,
                            "text": "\n\n".join(combined_text),
                            "prompt": prompt
                        })
            except Exception as e:
                logger.error(f"Excel parsing error for {filename}: {e}")

    # Dispatch Background Task
    background_tasks.add_task(
        process_smart_import, new_session.id, files_payloads
    )

    return new_session


@router.get("/latest", response_model=schemas.SmartImportSessionResponse)
def get_latest_session(
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    latest = (
        db.query(models.SmartImportSession)
        .filter(models.SmartImportSession.user_id == current_user.id)
        .order_by(models.SmartImportSession.created_at.desc())
        .first()
    )

    if not latest:
        raise HTTPException(status_code=404, detail="No sessions found")

    return latest


@router.put("/items/{item_id}", response_model=schemas.SmartImportItemResponse)
def update_item(
    item_id: int,
    item_update: schemas.SmartImportItemUpdate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    item = (
        db.query(models.SmartImportItem)
        .join(models.SmartImportSession)
        .filter(
            models.SmartImportItem.id == item_id,
            models.SmartImportSession.user_id == current_user.id,
        )
        .first()
    )

    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    update_data = item_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(item, key, value)

    db.commit()
    db.refresh(item)
    return item


class BulkStatusUpdate(schemas.BaseModel):
    status: str

@router.put("/sessions/{session_id}/bulk-status")
def update_bulk_status(
    session_id: int,
    payload: BulkStatusUpdate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    session = (
        db.query(models.SmartImportSession)
        .filter(
            models.SmartImportSession.id == session_id,
            models.SmartImportSession.user_id == current_user.id,
        )
        .first()
    )

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    for item in session.items:
        if item.review_status != payload.status:
            item.review_status = payload.status

    db.commit()
    return {"message": "Success"}


@router.delete("/sessions/{session_id}")
def cancel_session(
    session_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    session = (
        db.query(models.SmartImportSession)
        .filter(
            models.SmartImportSession.id == session_id,
            models.SmartImportSession.user_id == current_user.id,
        )
        .first()
    )

    if not session:
        raise HTTPException(status_code=404)

    db.delete(session)
    db.commit()
    return {"status": "ok"}


@router.post("/commit/{session_id}")
def commit_session(
    session_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    """Transfers all 'accepted' items to real Videogames database"""
    session = (
        db.query(models.SmartImportSession)
        .filter(
            models.SmartImportSession.id == session_id,
            models.SmartImportSession.user_id == current_user.id,
        )
        .first()
    )

    if not session or session.status != "pending_review":
        raise HTTPException(status_code=400, detail="Invalid session mode")

    accepted_items = [i for i in session.items if i.review_status == "accepted"]

    for item in accepted_items:
        new_game = models.Videogame(
            user_id=current_user.id,
            name=item.name,
            description=item.description,
            image_url=item.image_url,
            status=item.status,
            time_spent=item.time_spent,
            mark=item.mark,
            completion_date=item.completion_date,
            publication_year=item.publication_year,
            completion_percentage=item.completion_percentage,
            tags=item.tags,
        )
        db.add(new_game)

    session.status = "completed"
    db.commit()

    return {"message": "Success", "games_added": len(accepted_items)}
