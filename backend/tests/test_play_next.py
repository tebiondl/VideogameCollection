"""Play-next selections persist independently of progress and other users."""
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import discovery_models  # noqa: F401 - register FK tables
from backend.app.database import Base, get_db
from backend.app.models import User, Videogame
from backend.app.routers import videogames_router


class PlayNextTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.user = User(username="owner", hashed_password="unused")
        self.other_user = User(username="other", hashed_password="unused")
        self.db.add_all([self.user, self.other_user])
        self.db.flush()
        app = FastAPI()
        app.include_router(videogames_router.router)
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[videogames_router.get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.addCleanup(self.client.close)

    def create_game(self, **fields):
        response = self.client.post("/api/videogames/", json={"name": "Next adventure", **fields})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_new_and_existing_games_default_to_unplanned(self):
        new_game = self.create_game()
        self.assertFalse(new_game["play_next"])
        existing = Videogame(user_id=self.user.id, name="Existing game")
        self.db.add(existing)
        self.db.commit()
        response = self.client.get("/api/videogames/")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(all(not game["play_next"] for game in response.json()))

    def test_toggle_persists_without_overwriting_progress_or_notes(self):
        game = self.create_game(status="Stopped", comments="Return after the weekend", reviewed=True, hype=8)
        for planned in (True, False):
            response = self.client.put(f'/api/videogames/{game["id"]}', json={
                "name": game["name"], "play_next": planned, "version": game["version"],
            })
            self.assertEqual(response.status_code, 200, response.text)
            saved = response.json()
            self.assertEqual(saved["play_next"], planned)
            for field in ("status", "comments", "reviewed", "hype"):
                self.assertEqual(saved[field], game[field])
            self.assertEqual(saved["version"], game["version"] + 1)
            self.db.expire_all()
            listed = self.client.get("/api/videogames/").json()
            self.assertEqual(listed[0]["play_next"], planned)
            game = saved

    def test_other_edits_preserve_selection_when_flag_is_omitted(self):
        game = self.create_game(play_next=True)
        response = self.client.put(f'/api/videogames/{game["id"]}', json={"name": "Renamed adventure"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["play_next"])

    def test_save_as_new_allows_similar_titles_without_overwriting_original(self):
        original = self.create_game(status="Finished", reviewed=True)
        duplicate = self.create_game(play_next=True, playtime_mode="copies")
        self.assertNotEqual(duplicate["id"], original["id"])
        listed = {game["id"]: game for game in self.client.get("/api/videogames/").json()}
        self.assertEqual(len(listed), 2)
        self.assertEqual(listed[original["id"]]["status"], "Finished")
        self.assertTrue(listed[original["id"]]["reviewed"])
        self.assertTrue(listed[duplicate["id"]]["play_next"])
        self.assertEqual(listed[duplicate["id"]]["playtime_mode"], "copies")

    def test_stale_edits_cannot_overwrite_selection(self):
        game = self.create_game()
        url = f'/api/videogames/{game["id"]}'
        self.assertEqual(self.client.put(url, json={"name": game["name"], "play_next": True}).status_code, 200)
        response = self.client.put(url, json={"name": game["name"], "play_next": False, "version": game["version"]})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertTrue(self.client.get("/api/videogames/").json()[0]["play_next"])

    def test_selections_are_private_to_the_owner(self):
        private = Videogame(user_id=self.other_user.id, name="Private game", play_next=True)
        self.db.add(private)
        self.db.commit()
        response = self.client.put(f"/api/videogames/{private.id}", json={"name": private.name, "play_next": False})
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(self.client.get("/api/videogames/").json(), [])
        self.db.refresh(private)
        self.assertTrue(private.play_next)


if __name__ == "__main__":
    unittest.main()
