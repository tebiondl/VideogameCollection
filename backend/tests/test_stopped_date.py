"""The day a game is stopped is logged on its own, apart from the completion date."""
import unittest
from datetime import date

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import discovery_models  # noqa: F401 - register FK tables
from backend.app.database import Base, get_db
from backend.app.models import User, Videogame
from backend.app.routers import videogames_router


class StoppedDateTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.user = User(username="owner", hashed_password="unused")
        self.db.add(self.user)
        self.db.flush()
        app = FastAPI()
        app.include_router(videogames_router.router)
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[videogames_router.get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self.today = date.today().isoformat()
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.addCleanup(self.client.close)

    def create_game(self, **fields):
        response = self.client.post("/api/videogames/", json={"name": "Long journey", **fields})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def save(self, game, **changes):
        response = self.client.put(f"/api/videogames/{game['id']}", json={**game, **changes})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_stopping_a_game_logs_today_and_leaves_the_completion_date_alone(self):
        game = self.create_game(status="Playing", completion_date="2019-05")
        self.assertIsNone(game["stopped_date"])
        stopped = self.save(game, status="Stopped")
        self.assertEqual(stopped["stopped_date"], self.today)
        self.assertEqual(stopped["completion_date"], "2019-05")

    def test_a_game_created_as_stopped_gets_a_date(self):
        self.assertEqual(self.create_game(status="Stopped")["stopped_date"], self.today)
        self.assertEqual(self.create_game(status="Stopped", stopped_date="2024-02-01")["stopped_date"], "2024-02-01")
        self.assertIsNone(self.create_game(status="Finished")["stopped_date"])

    def test_a_date_typed_with_the_switch_wins(self):
        game = self.create_game(status="Playing")
        self.assertEqual(self.save(game, status="Stopped", stopped_date="2025-11-03")["stopped_date"], "2025-11-03")

    def test_saving_a_stopped_game_again_keeps_its_date(self):
        game = self.create_game(status="Stopped", stopped_date="2024-02-01")
        saved = self.save(game, comments="Might return")
        self.assertEqual(saved["stopped_date"], "2024-02-01")
        self.assertEqual(self.save(saved, stopped_date="2024-03")["stopped_date"], "2024-03")

    def test_stopping_again_logs_the_latest_stop(self):
        game = self.create_game(status="Stopped", stopped_date="2020-01-01")
        playing = self.save(game, status="Playing")
        self.assertEqual(playing["stopped_date"], "2020-01-01")
        self.assertEqual(self.save(playing, status="Stopped")["stopped_date"], self.today)

    def test_status_changes_outside_the_editor_are_logged_too(self):
        game = Videogame(user_id=self.user.id, name="Synced DLC", status="Playing")
        self.db.add(game)
        self.db.commit()
        game.status = "Stopped"
        self.db.commit()
        self.assertEqual(game.stopped_date, self.today)


if __name__ == "__main__":
    unittest.main()
