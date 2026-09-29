"""Deleting a collection game removes dependent ranking placements."""
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import discovery_models  # noqa: F401 - register FK tables
from backend.app.database import Base, get_db
from backend.app.models import GameRankingEntry, GameTierList, GameTierListEntry, User, Videogame
from backend.app.discovery_models import OwnedCopy, SteamCopyTrash, WantedGame
from backend.app.routers import videogames_router


class VideogameDeletionTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

        @event.listens_for(self.engine, "connect")
        def enable_foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")

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

    def test_delete_removes_ranking_and_tier_entries_without_changing_other_games(self):
        game = Videogame(user_id=self.user.id, name="Delete me", mark=9)
        survivor = Videogame(user_id=self.user.id, name="Keep me", mark=8)
        private = Videogame(user_id=self.other_user.id, name="Private", mark=10)
        tier_list = GameTierList(user_id=self.user.id, name="Favorites", filters_json="{}")
        self.db.add_all([game, survivor, private, tier_list])
        self.db.flush()
        self.db.add_all([
            GameRankingEntry(user_id=self.user.id, game_id=game.id, position=0),
            GameRankingEntry(user_id=self.user.id, game_id=survivor.id, position=1),
            GameTierListEntry(tier_list_id=tier_list.id, game_id=game.id, position=0),
            GameTierListEntry(tier_list_id=tier_list.id, game_id=survivor.id, position=1),
            WantedGame(user_id=self.user.id, name=game.name, status="Acquired", collection_game_id=game.id),
            OwnedCopy(user_id=self.user.id, collection_game_id=game.id, copy_id="steam:2357570",
                      steam_appid=2357570, name=game.name, platform="PC", format="Digital", source="Steam"),
        ])
        self.db.commit()

        self.assertEqual(self.client.delete(f"/api/videogames/{private.id}").status_code, 404)
        response = self.client.delete(f"/api/videogames/{game.id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.db.expire_all()
        self.assertIsNone(self.db.get(Videogame, game.id))
        self.assertIsNotNone(self.db.get(Videogame, survivor.id))
        self.assertEqual([row.game_id for row in self.db.query(GameRankingEntry).all()], [survivor.id])
        self.assertEqual([row.game_id for row in self.db.query(GameTierListEntry).all()], [survivor.id])
        self.assertEqual(self.db.query(OwnedCopy).count(), 0)
        self.assertEqual(self.db.query(SteamCopyTrash).filter_by(steam_appid=2357570).count(), 1)
        wanted = self.db.query(WantedGame).one()
        self.assertIsNone(wanted.collection_game_id)
        self.assertEqual(wanted.status, "Wanted")


if __name__ == "__main__":
    unittest.main()
