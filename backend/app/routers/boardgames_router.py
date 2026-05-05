from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks, UploadFile, File, Form
from sqlalchemy.orm import Session
from typing import List, Annotated
import logging
import json
import os
import pandas as pd
from openai import OpenAI

from .. import schemas, models, database
from .auth_router import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/boardgames", tags=["boardgames"])

@router.get("/tags", response_model=List[schemas.BoardgameTagResponse])
def get_tags(
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    global_tags = db.query(models.BoardgameTag).filter(models.BoardgameTag.user_id == None).all()
    user_tags = db.query(models.BoardgameTag).filter(models.BoardgameTag.user_id == current_user.id).all()
    
    # Auto-seed if exactly empty
    if not global_tags and not user_tags:
        default_names = ["Card Game", "Deck Builder", "Worker Placement", "Party Game", "Legacy", "Abstract"]
        for name in default_names:
            tag = models.BoardgameTag(name=name, user_id=None)
            db.add(tag)
        db.commit()
        global_tags = db.query(models.BoardgameTag).filter(models.BoardgameTag.user_id == None).all()
        
    return global_tags + user_tags

@router.post("/tags/global", response_model=schemas.BoardgameTagResponse)
def create_global_tag(
    tag: schemas.BoardgameTagCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to create global tags")
        
    db_tag = models.BoardgameTag(name=tag.name, user_id=None)
    db.add(db_tag)
    db.commit()
    db.refresh(db_tag)
    return db_tag

@router.delete("/tags/{tag_id}")
def delete_tag(
    tag_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_tag = db.query(models.BoardgameTag).filter(models.BoardgameTag.id == tag_id).first()
    if not db_tag:
        raise HTTPException(status_code=404, detail="Tag not found")
        
    if db_tag.user_id is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to delete global tags")
    elif db_tag.user_id is not None and db_tag.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this tag")
        
    db.delete(db_tag)
    db.commit()
    return {"status": "ok"}

@router.get("/", response_model=List[schemas.BoardgameResponse])
def get_boardgames(
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    games = db.query(models.Boardgame).filter(models.Boardgame.user_id == current_user.id).all()
    return games

@router.post("/", response_model=schemas.BoardgameResponse)
def create_boardgame(
    game: schemas.BoardgameCreate, 
    current_user: Annotated[models.User, Depends(get_current_user)], 
    db: Session = Depends(database.get_db)
):
    new_game = models.Boardgame(**game.model_dump(), user_id=current_user.id)
    db.add(new_game)
    db.commit()
    db.refresh(new_game)
    return new_game

@router.put("/{game_id}", response_model=schemas.BoardgameResponse)
def update_boardgame(
    game_id: int,
    game_update: schemas.BoardgameCreate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_game = db.query(models.Boardgame).filter(
        models.Boardgame.id == game_id,
        models.Boardgame.user_id == current_user.id
    ).first()
    
    if not db_game:
        raise HTTPException(status_code=404, detail="Game not found or unauthorized")
        
    update_data = game_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_game, key, value)
        
    db.commit()
    db.refresh(db_game)
    return db_game

@router.delete("/{game_id}")
def delete_boardgame(
    game_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db)
):
    db_game = db.query(models.Boardgame).filter(
        models.Boardgame.id == game_id,
        models.Boardgame.user_id == current_user.id
    ).first()
    
    if not db_game:
        raise HTTPException(status_code=404, detail="Game not found or unauthorized")
        
    db.delete(db_game)
    db.commit()
    return {"status": "ok"}

# --- Smart Import ---

def process_smart_import(session_id: int, files_payloads: List[dict]):
    db = database.SessionLocal()
    session = db.query(models.BoardgameSmartImportSession).filter(models.BoardgameSmartImportSession.id == session_id).first()
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

        client = OpenAI(api_key=api_key, base_url="https://api.moonshot.ai/v1")

        system_instruction = (
            "You are a helpful data extraction assistant. "
            "FIRST, you MUST output your internal thought process inside <think>...</think> XML tags, explicitly explaining how you interpret the file and map it to our schema. "
            "THEN, respond strictly with a valid JSON array of objects wrapped in ```json ... ``` markdown. "
            "Each JSON object MUST contain these exact fields: "
            "'name' (string, required), 'description' (string or null), 'image_url' (string or null), 'status' (string, choices: 'Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'), "
            "'mark' (integer 1-10 or null), 'publication_year' (integer or null), 'tags' (string or null), "
            "'game_type' (string or null, e.g. 'competitive', 'cooperative', 'solo', can be comma separated combinations), 'bgg_link' (string or null). "
            "If the user specifies particular tags, use them. Comma separate tags. If status is unknown, default to 'Not Started'."
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
                                    tail = collected_content[-1500:] if len(collected_content) > 1500 else collected_content
                                    session.status = f"processing|{i+1}/{total_files}|{tail}"
                                    db.commit()
                                    chars_since_db_update = 0
                    break
                except Exception as api_e:
                    error_str = str(api_e).lower()
                    if "429" in error_str or "overload" in error_str or "rate" in error_str:
                        if attempt < max_retries - 1:
                            import time
                            delay = (attempt + 1) * 6
                            session.status = f"processing|{i+1}/{total_files}|Moonshot Engine Overloaded. Retrying in {delay}s..."
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
                logger.error(f"Failed to parse JSON for {file_name}: {parse_e}")

        for item in all_items:
            new_item = models.BoardgameSmartImportItem(
                session_id=session_id,
                name=item.get("name") or "Unknown Boardgame",
                description=item.get("description"),
                image_url=item.get("image_url"),
                status=item.get("status") or "Not Started",
                mark=item.get("mark"),
                publication_year=item.get("publication_year"),
                tags=item.get("tags"),
                game_type=item.get("game_type"),
                bgg_link=item.get("bgg_link")
            )
            db.add(new_item)

        session.raw_ai_response = "\n".join(raw_responses)
        session.status = "pending_review"
        db.commit()

    except Exception as e:
        logger.error(f"Boardgame Smart Import Error: {e}")
        session.status = f"failed: {str(e)}"
        db.commit()
    finally:
        db.close()


@router.post("/smart-import", response_model=schemas.BoardgameSmartImportSessionResponse)
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

    new_session = models.BoardgameSmartImportSession(user_id=current_user.id, status="processing")
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

    background_tasks.add_task(process_smart_import, new_session.id, files_payloads)
    return new_session

@router.get("/smart-import/latest", response_model=schemas.BoardgameSmartImportSessionResponse)
def get_latest_session(
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    latest = db.query(models.BoardgameSmartImportSession).filter(models.BoardgameSmartImportSession.user_id == current_user.id).order_by(models.BoardgameSmartImportSession.created_at.desc()).first()
    if not latest:
        raise HTTPException(status_code=404, detail="No sessions found")
    return latest

@router.put("/smart-import/items/{item_id}", response_model=schemas.BoardgameSmartImportItemResponse)
def update_item(
    item_id: int,
    item_update: schemas.BoardgameSmartImportItemUpdate,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    item = db.query(models.BoardgameSmartImportItem).join(models.BoardgameSmartImportSession).filter(
        models.BoardgameSmartImportItem.id == item_id,
        models.BoardgameSmartImportSession.user_id == current_user.id,
    ).first()

    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    update_data = item_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(item, key, value)

    db.commit()
    db.refresh(item)
    return item

@router.post("/smart-import/commit/{session_id}")
def commit_session(
    session_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    session = db.query(models.BoardgameSmartImportSession).filter(
        models.BoardgameSmartImportSession.id == session_id,
        models.BoardgameSmartImportSession.user_id == current_user.id,
    ).first()

    if not session or session.status != "pending_review":
        raise HTTPException(status_code=400, detail="Invalid session mode")

    accepted_items = [i for i in session.items if i.review_status == "accepted"]

    for item in accepted_items:
        new_game = models.Boardgame(
            user_id=current_user.id,
            name=item.name,
            description=item.description,
            image_url=item.image_url,
            status=item.status,
            mark=item.mark,
            publication_year=item.publication_year,
            tags=item.tags,
            game_type=item.game_type,
            bgg_link=item.bgg_link
        )
        db.add(new_game)

    session.status = "completed"
    db.commit()

    return {"message": "Success", "games_added": len(accepted_items)}

@router.delete("/smart-import/sessions/{session_id}")
def cancel_session(
    session_id: int,
    current_user: Annotated[models.User, Depends(get_current_user)],
    db: Session = Depends(database.get_db),
):
    session = db.query(models.BoardgameSmartImportSession).filter(
        models.BoardgameSmartImportSession.id == session_id,
        models.BoardgameSmartImportSession.user_id == current_user.id,
    ).first()

    if not session:
        raise HTTPException(status_code=404)

    db.delete(session)
    db.commit()
    return {"status": "ok"}
