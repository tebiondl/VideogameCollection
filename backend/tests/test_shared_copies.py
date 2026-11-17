"""One cartridge or disc can hold several collection games without duplicating its details."""
import json
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import discovery_models  # noqa: F401 - register FK tables
from backend.app.database import Base, get_db
from backend.app.discovery_models import OwnedCopy, PhysicalItem
from backend.app.models import User, Videogame
from backend.app.routers import videogames_router


class SharedCopyTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.user = User(username="owner", hashed_password="unused")
        self.other_user = User(username="other", hashed_password="unused")
        self.db.add_all([self.user, self.other_user])
        self.db.flush()
        self.sm64 = Videogame(user_id=self.user.id, name="Super Mario 64")
        self.sunshine = Videogame(user_id=self.user.id, name="Super Mario Sunshine")
        self.galaxy = Videogame(user_id=self.user.id, name="Super Mario Galaxy")
        self.private = Videogame(user_id=self.other_user.id, name="Private")
        self.db.add_all([self.sm64, self.sunshine, self.galaxy, self.private])
        self.db.flush()
        self.db.add_all([
            OwnedCopy(user_id=self.user.id, collection_game_id=self.sm64.id, copy_id="copy:cart",
                      name="Super Mario 3D All-Stars", platform="Nintendo Switch", format="Physical",
                      region="Spain", source="Store", price=60, currency="EUR", playtime_hours=12, position=0),
            OwnedCopy(user_id=self.user.id, collection_game_id=self.galaxy.id, copy_id="copy:galaxy",
                      name="3D All-Stars", platform="Nintendo Switch", format="Physical",
                      price=20, currency="EUR", playtime_hours=30, position=0),
            OwnedCopy(user_id=self.user.id, collection_game_id=self.galaxy.id, copy_id="steam:1",
                      steam_appid=1, name="Steam", platform="PC", format="Digital", source="Steam", position=1),
        ])
        self.db.commit()
        app = FastAPI()
        app.include_router(videogames_router.router)
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[videogames_router.get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.addCleanup(self.client.close)

    def share(self, game, copy_id, target, **extra):
        return self.client.post(
            f"/api/videogames/{game.id}/copies/{copy_id}/shared-games",
            json={"target_game_id": target.id, **extra},
        )

    def copies(self, game):
        self.db.expire_all()
        return json.loads(self.db.get(Videogame, game.id).copies or "[]")

    def test_sharing_creates_a_copy_with_the_same_details_on_the_other_game(self):
        response = self.share(self.sm64, "copy:cart", self.sunshine)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual({game["id"] for game in response.json()["games"]}, {self.sm64.id, self.sunshine.id})

        [sunshine_copy] = self.copies(self.sunshine)
        self.assertEqual(sunshine_copy["name"], "Super Mario 3D All-Stars")
        self.assertEqual(sunshine_copy["region"], "Spain")
        self.assertEqual(sunshine_copy["price"], 60)
        self.assertIsNone(sunshine_copy["playtime_hours"])
        self.assertEqual(sunshine_copy["physical_item"]["games"], [{"id": self.sm64.id, "name": "Super Mario 64"}])
        [sm64_copy] = self.copies(self.sm64)
        self.assertEqual(sm64_copy["physical_item"]["games"], [{"id": self.sunshine.id, "name": "Super Mario Sunshine"}])
        self.assertEqual(sm64_copy["playtime_hours"], 12)

    def test_grouping_existing_copies_keeps_each_games_playtime_and_settles_one_price(self):
        self.share(self.sm64, "copy:cart", self.sunshine)
        response = self.share(self.sm64, "copy:cart", self.galaxy, target_copy_id="copy:galaxy", price=60)
        self.assertEqual(response.status_code, 200, response.text)

        galaxy = {copy["id"]: copy for copy in self.copies(self.galaxy)}
        self.assertEqual(galaxy["copy:galaxy"]["name"], "Super Mario 3D All-Stars")
        self.assertEqual(galaxy["copy:galaxy"]["price"], 60)
        self.assertEqual(galaxy["copy:galaxy"]["playtime_hours"], 30)
        self.assertEqual(len(galaxy["copy:galaxy"]["physical_item"]["games"]), 2)
        self.assertNotIn("physical_item", galaxy["steam:1"])
        self.assertEqual(self.db.query(PhysicalItem).count(), 1)

    def test_editing_shared_details_on_one_game_updates_the_others_and_their_version(self):
        self.share(self.sm64, "copy:cart", self.sunshine)
        sunshine_version = self.db.get(Videogame, self.sunshine.id).version
        copy = self.copies(self.sm64)[0]
        copy.update(price=45, region="Japan", playtime_hours=15)
        response = self.client.put(f"/api/videogames/{self.sm64.id}", json={"name": "Super Mario 64", "copies": json.dumps([copy])})
        self.assertEqual(response.status_code, 200, response.text)

        [sunshine_copy] = self.copies(self.sunshine)
        self.assertEqual((sunshine_copy["price"], sunshine_copy["region"]), (45, "Japan"))
        self.assertIsNone(sunshine_copy["playtime_hours"])
        self.assertGreater(self.db.get(Videogame, self.sunshine.id).version, sunshine_version)

    def test_removing_the_copy_from_one_game_leaves_the_others_and_dissolves_a_lone_copy(self):
        self.share(self.sm64, "copy:cart", self.sunshine)
        self.share(self.sm64, "copy:cart", self.galaxy)
        response = self.client.put(f"/api/videogames/{self.sm64.id}", json={"name": "Super Mario 64", "copies": None})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.copies(self.sunshine)[0]["physical_item"]["games"]), 1)

        self.client.put(f"/api/videogames/{self.galaxy.id}", json={
            "name": "Super Mario Galaxy",
            "copies": json.dumps([copy for copy in self.copies(self.galaxy) if not copy.get("physical_item")]),
        })
        [sunshine_copy] = self.copies(self.sunshine)
        self.assertNotIn("physical_item", sunshine_copy)
        self.assertEqual(sunshine_copy["price"], 60)
        self.assertEqual(self.db.query(PhysicalItem).count(), 0)

    def test_unlinking_keeps_the_copy_without_the_shared_price(self):
        self.share(self.sm64, "copy:cart", self.sunshine)
        self.share(self.sm64, "copy:cart", self.galaxy)
        item_id = self.copies(self.sm64)[0]["physical_item"]["id"]
        response = self.client.delete(f"/api/videogames/physical-items/{item_id}/games/{self.sunshine.id}")
        self.assertEqual(response.status_code, 200, response.text)

        [sunshine_copy] = self.copies(self.sunshine)
        self.assertNotIn("physical_item", sunshine_copy)
        self.assertIsNone(sunshine_copy["price"])
        self.assertEqual(sunshine_copy["name"], "Super Mario 3D All-Stars")
        self.assertEqual(self.copies(self.sm64)[0]["price"], 60)

    def test_deleting_the_item_removes_its_copy_from_every_game(self):
        self.share(self.sm64, "copy:cart", self.sunshine)
        item_id = self.copies(self.sm64)[0]["physical_item"]["id"]
        response = self.client.delete(f"/api/videogames/physical-items/{item_id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.copies(self.sm64), [])
        self.assertEqual(self.copies(self.sunshine), [])
        self.assertEqual(self.db.query(PhysicalItem).count(), 0)

    def test_deleting_a_game_keeps_the_item_on_the_other_game_as_a_plain_copy(self):
        self.share(self.sm64, "copy:cart", self.sunshine)
        response = self.client.delete(f"/api/videogames/{self.sm64.id}")
        self.assertEqual(response.status_code, 200, response.text)
        [sunshine_copy] = self.copies(self.sunshine)
        self.assertNotIn("physical_item", sunshine_copy)
        self.assertEqual(sunshine_copy["price"], 60)

    def test_rejects_steam_copies_duplicates_and_other_users_games(self):
        self.assertEqual(self.share(self.galaxy, "steam:1", self.sm64).status_code, 409)
        self.assertEqual(self.share(self.sm64, "copy:cart", self.sm64).status_code, 422)
        self.assertEqual(self.share(self.sm64, "copy:cart", self.private).status_code, 404)
        self.assertEqual(self.share(self.sm64, "copy:missing", self.sunshine).status_code, 404)
        self.share(self.sm64, "copy:cart", self.sunshine)
        self.assertEqual(self.share(self.sm64, "copy:cart", self.sunshine).status_code, 409)


if __name__ == "__main__":
    unittest.main()
