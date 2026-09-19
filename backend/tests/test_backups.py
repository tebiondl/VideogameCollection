import gzip
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine

from app.services import backups


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / "source.db"
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)")
            connection.execute("INSERT INTO users (username) VALUES ('admin')")
            connection.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            connection.execute("INSERT INTO sample (value) VALUES ('complete database row')")
            connection.commit()
        self.engine = create_engine(f"sqlite:///{self.database.as_posix()}")
        self.environment = patch.dict(os.environ, {
            "BACKUP_DIR": str(self.root / "backups"),
            "BACKUP_RETENTION": "2",
            "BACKUP_INTERVAL_HOURS": "24",
        })
        self.engine_patch = patch.object(backups, "engine", self.engine)
        self.environment.start()
        self.engine_patch.start()

    def tearDown(self):
        self.engine.dispose()
        self.engine_patch.stop()
        self.environment.stop()
        self.temp.cleanup()

    def test_backup_is_verified_compressed_and_restorable(self):
        created = backups.create_backup()
        path = backups.backup_path(created["name"])
        self.assertTrue(path.name.endswith(".sqlite3.gz"))
        self.assertEqual(created["sha256"], backups.list_backups()[0]["sha256"])

        restored = self.root / "restored.db"
        with gzip.open(path, "rb") as compressed, restored.open("wb") as output:
            output.write(compressed.read())
        with closing(sqlite3.connect(restored)) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(connection.execute("SELECT value FROM sample").fetchone()[0], "complete database row")

    def test_retention_keeps_only_latest_configured_backups(self):
        for _ in range(3):
            backups.create_backup()
        status = backups.backup_status()
        self.assertEqual(status["retention"], 2)
        self.assertEqual(len(status["backups"]), 2)
        self.assertGreater(status["total_size_bytes"], 0)

    def test_restore_replaces_database_and_creates_safety_backup(self):
        original = backups.create_backup()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("UPDATE sample SET value = 'changed after backup'")
            connection.commit()

        result = backups.restore_backup(original["name"])

        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT value FROM sample").fetchone()[0], "complete database row")
        self.assertEqual(result["restored_from"], original["name"])
        self.assertNotEqual(result["safety_backup"]["name"], original["name"])
        self.assertTrue(backups.backup_path(result["safety_backup"]["name"]).is_file())

    def test_restore_rejects_damaged_snapshot_without_changing_database(self):
        damaged = backups.backup_directory() / f"{backups.BACKUP_PREFIX}damaged{backups.BACKUP_SUFFIX}"
        damaged.parent.mkdir(parents=True, exist_ok=True)
        damaged.write_bytes(b"not a backup")

        with self.assertRaisesRegex(RuntimeError, "damaged"):
            backups.restore_backup(damaged.name)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT value FROM sample").fetchone()[0], "complete database row")

    def test_backup_path_rejects_traversal_and_unknown_files(self):
        with self.assertRaises(FileNotFoundError):
            backups.backup_path("../source.db")
        with self.assertRaises(FileNotFoundError):
            backups.backup_path("unrelated.sqlite3.gz")


if __name__ == "__main__":
    unittest.main()
