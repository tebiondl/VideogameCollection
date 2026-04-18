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


# Helper function to extract text from uploads
def extract_text(upload_file: UploadFile) -> str:
    filename = upload_file.filename.lower()
    try:
        if filename.endswith(".csv"):
            return upload_file.file.read().decode("utf-8")
        elif filename.endswith(".xlsx") or filename.endswith(".xls"):
            df = pd.read_excel(upload_file.file)
            return df.to_csv(index=False)
        elif filename.endswith(".txt"):
            return upload_file.file.read().decode("utf-8")
        else:
            # Fallback for unrecognized formats
            return upload_file.file.read().decode("utf-8", errors="ignore")
    except Exception as e:
        logger.error(f"Error parsing file {filename}: {e}")
        return ""


def process_smart_import(session_id: int, files_texts: List[str], user_prompt: str):
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
            "'time_spent' (string or null), 'mark' (integer 1-10 or null), 'completion_date' (string or null), 'publication_year' (integer or null), 'tags' (string or null). "
            "If the user specifies particular tags, use them (Gacha, Online, Runs). Comma separate tags. If status is unknown, default to 'Not Started'."
        )

        all_items = []
        total_files = len(files_texts)
        for i, file_text in enumerate(files_texts):
            session.status = f"processing|{i + 1}/{total_files}|Initializing Moonshot stream..."
            db.commit()

            prompt = f"User Instructions:\n{user_prompt}\n\nFile Content:\n{file_text}"

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
                tags=item.get("tags"),
            )
            db.add(new_item)

        session.status = "pending_review"
        db.commit()

    except Exception as e:
        logger.error(f"Smart Import Error: {e}")
        session.status = f"failed: {str(e)}"
        db.commit()
    finally:
        db.close()


@router.post("/", response_model=schemas.SmartImportSessionResponse)
async def start_smart_import(
    background_tasks: BackgroundTasks,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
    prompt: str = Form(""),
    files: List[UploadFile] = File([]),
):
    if len(files) > 10:
        raise HTTPException(status_code=400, detail="Maximum 10 files allowed")

    new_session = models.SmartImportSession(
        user_id=current_user.id, status="processing"
    )
    db.add(new_session)
    db.commit()
    db.refresh(new_session)

    # Read all active files into memory sequentially as separate chunks
    files_texts = []
    for f in files:
        text = extract_text(f)
        if text.strip():
            files_texts.append(f"--- [File: {f.filename}] ---\n{text}")

    # Dispatch Background Task
    background_tasks.add_task(
        process_smart_import, new_session.id, files_texts, prompt
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
            tags=item.tags,
        )
        db.add(new_game)

    session.status = "completed"
    db.commit()

    return {"message": "Success", "games_added": len(accepted_items)}
