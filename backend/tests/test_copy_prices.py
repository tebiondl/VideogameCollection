"""Bulk price updates only touch the price of copies the user owns."""
import json
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import discovery_models  # noqa: F401 - register FK tables
from backend.app.database import Base, get_db
from backend.app.discovery_models import OwnedCopy
from backend.app.models import User, Videogame
from backend.app.routers import videogames_router


class CopyPriceTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.user = User(username="owner", hashed_password="unused")
        self.other_user = User(username="other", hashed_password="unused")
        self.db.add_all([self.user, self.other_user])
        self.db.flush()
        self.game = Videogame(user_id=self.user.id, name="Hades", comments="keep me")
        self.private = Videogame(user_id=self.other_user.id, name="Private")
        self.db.add_all([self.game, self.private])
        self.db.flush()
        self.db.add_all([
            OwnedCopy(user_id=self.user.id, collection_game_id=self.game.id, copy_id="steam:1145360",
                      steam_appid=1145360, name="Hades", platform="PC", format="Digital", source="Steam", position=0),
            OwnedCopy(user_id=self.user.id, collection_game_id=self.game.id, copy_id="copy:switch",
                      name="Hades", platform="Switch", format="Physical", price=30, currency="EUR", position=1),
            OwnedCopy(user_id=self.other_user.id, collection_game_id=self.private.id, copy_id="steam:1",
                      steam_appid=1, name="Private", platform="PC", format="Digital", source="Steam"),
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

    def post(self, *prices):
        return self.client.post("/api/videogames/copy-prices", json={"prices": list(prices)})

    def test_sets_the_price_and_leaves_the_rest_of_the_card_alone(self):
        response = self.post({"game_id": self.game.id, "copy_id": "steam:1145360", "price": 12.49, "currency": "EUR"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"updated": 1})
        self.db.expire_all()
        game = self.db.get(Videogame, self.game.id)
        copies = {copy["id"]: copy for copy in json.loads(game.copies)}
        self.assertEqual(copies["steam:1145360"]["price"], 12.49)
        self.assertEqual(copies["steam:1145360"]["steam_appid"], 1145360)
        self.assertEqual(copies["copy:switch"]["price"], 30)
        self.assertEqual(game.comments, "keep me")

    def test_rejects_other_users_games_unknown_copies_and_negative_prices(self):
        self.assertEqual(self.post({"game_id": self.private.id, "copy_id": "steam:1", "price": 5}).status_code, 404)
        self.assertEqual(self.post({"game_id": self.game.id, "copy_id": "missing", "price": 5}).status_code, 404)
        self.assertEqual(self.post({"game_id": self.game.id, "copy_id": "copy:switch", "price": -1}).status_code, 422)
        self.db.expire_all()
        self.assertIsNone(self.db.query(OwnedCopy).filter_by(copy_id="steam:1").one().price)
        self.assertEqual(self.db.query(OwnedCopy).filter_by(copy_id="copy:switch").one().price, 30)


if __name__ == "__main__":
    unittest.main()
