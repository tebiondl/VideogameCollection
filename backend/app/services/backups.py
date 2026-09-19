"""Space-conscious, verified backups for the application's SQLite database."""

from __future__ import annotations

import asyncio
from contextlib import closing
import gzip
import hashlib
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
import shutil
import sqlite3
import threading

from ..database import engine

logger = logging.getLogger(__name__)

BACKUP_PREFIX = "tracker-backup-"
BACKUP_SUFFIX = ".sqlite3.gz"
_backup_lock = threading.RLock()


def _source_path() -> Path:
    if engine.url.get_backend_name() != "sqlite":
        raise RuntimeError("Automatic database backups currently require SQLite")
    database = engine.url.database
    if not database or database == ":memory:":
        raise RuntimeError("The SQLite database is not stored in a file")
    return Path(database).expanduser().resolve()


def backup_directory() -> Path:
    configured = os.getenv("BACKUP_DIR", "").strip()
    return Path(configured).expanduser().resolve() if configured else _source_path().parent / "backups"


def retention_limit() -> int:
    try:
        return max(1, min(90, int(os.getenv("BACKUP_RETENTION", "7"))))
    except ValueError:
        return 7


def interval_hours() -> int:
    try:
        return max(1, min(168, int(os.getenv("BACKUP_INTERVAL_HOURS", "24"))))
    except ValueError:
        return 24


def _backup_files() -> list[Path]:
    directory = backup_directory()
    if not directory.exists():
        return []
    return sorted(directory.glob(f"{BACKUP_PREFIX}*{BACKUP_SUFFIX}"), key=lambda item: item.stat().st_mtime, reverse=True)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def describe_backup(path: Path) -> dict:
    stat = path.stat()
    return {
        "name": path.name,
        "size_bytes": stat.st_size,
        "created_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "sha256": _sha256(path),
    }


def list_backups() -> list[dict]:
    return [describe_backup(path) for path in _backup_files()]


def backup_status() -> dict:
    files = _backup_files()
    return {
        "supported": engine.url.get_backend_name() == "sqlite" and bool(engine.url.database),
        "retention": retention_limit(),
        "interval_hours": interval_hours(),
        "total_size_bytes": sum(path.stat().st_size for path in files),
        "backups": [describe_backup(path) for path in files],
    }


def _prune() -> None:
    for expired in _backup_files()[retention_limit():]:
        expired.unlink(missing_ok=True)


def create_backup() -> dict:
    with _backup_lock:
        source_path = _source_path()
        if not source_path.is_file():
            raise RuntimeError(f"Database file does not exist: {source_path}")

        directory = backup_directory()
        directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        final_path = directory / f"{BACKUP_PREFIX}{stamp}{BACKUP_SUFFIX}"
        snapshot_path = directory / f".{stamp}.sqlite3.tmp"
        compressed_path = directory / f".{stamp}.gz.tmp"

        try:
            with closing(sqlite3.connect(f"file:{source_path.as_posix()}?mode=ro", uri=True)) as source:
                with closing(sqlite3.connect(snapshot_path)) as destination:
                    source.backup(destination)
                    _verify_sqlite(destination)
                    destination.commit()

            with snapshot_path.open("rb") as raw, gzip.open(compressed_path, "wb", compresslevel=9) as compressed:
                shutil.copyfileobj(raw, compressed, length=1024 * 1024)
            os.replace(compressed_path, final_path)
            _prune()
            logger.info("Database backup created: %s", final_path)
            return describe_backup(final_path)
        finally:
            snapshot_path.unlink(missing_ok=True)
            compressed_path.unlink(missing_ok=True)


def _verify_sqlite(connection: sqlite3.Connection) -> None:
    result = connection.execute("PRAGMA integrity_check").fetchone()
    if not result or result[0] != "ok":
        raise RuntimeError("SQLite integrity verification failed")
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "users" not in tables:
        raise RuntimeError("The backup is not a complete tracker database")


def restore_backup(name: str) -> dict:
    """Restore a retained snapshot and preserve the current state first."""
    with _backup_lock:
        archived_path = backup_path(name)
        directory = backup_directory()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        restored_path = directory / f".{stamp}.restore.sqlite3.tmp"

        try:
            try:
                with gzip.open(archived_path, "rb") as compressed, restored_path.open("wb") as output:
                    shutil.copyfileobj(compressed, output, length=1024 * 1024)
            except (gzip.BadGzipFile, OSError, EOFError) as error:
                raise RuntimeError("The selected backup is damaged or is not a gzip-compressed SQLite snapshot") from error

            with closing(sqlite3.connect(f"file:{restored_path.as_posix()}?mode=ro", uri=True)) as candidate:
                _verify_sqlite(candidate)

            safety_backup = create_backup()
            live_path = _source_path()
            engine.dispose()
            try:
                with closing(sqlite3.connect(f"file:{restored_path.as_posix()}?mode=ro", uri=True)) as source:
                    with closing(sqlite3.connect(live_path, timeout=30)) as destination:
                        source.backup(destination)
                        destination.commit()
                        _verify_sqlite(destination)
            except sqlite3.Error as error:
                raise RuntimeError(
                    f"Could not restore the database. The current state remains available as {safety_backup['name']}"
                ) from error
            finally:
                engine.dispose()

            logger.warning("Database restored from %s; pre-restore safety backup: %s", name, safety_backup["name"])
            return {"restored_from": name, "safety_backup": safety_backup}
        finally:
            restored_path.unlink(missing_ok=True)


def backup_path(name: str) -> Path:
    if not name.startswith(BACKUP_PREFIX) or not name.endswith(BACKUP_SUFFIX) or Path(name).name != name:
        raise FileNotFoundError(name)
    candidate = backup_directory() / name
    if not candidate.is_file():
        raise FileNotFoundError(name)
    return candidate


def delete_backup(name: str) -> None:
    backup_path(name).unlink()


def backup_is_due() -> bool:
    files = _backup_files()
    if not files:
        return True
    age_seconds = datetime.now(timezone.utc).timestamp() - files[0].stat().st_mtime
    return age_seconds >= interval_hours() * 3600


async def scheduler() -> None:
    while True:
        try:
            if backup_is_due():
                await asyncio.to_thread(create_backup)
        except Exception:
            logger.exception("Automatic database backup failed")
        await asyncio.sleep(3600)
