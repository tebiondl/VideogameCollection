"""Ranking and tier-list persistence, ownership, and snapshot behavior."""
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app.database import Base, get_db
from backend.app.models import User, Videogame
from backend.app.routers import ranking_router


class RankingTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.user = User(username="ranking-owner", hashed_password="unused")
        self.other = User(username="another-owner", hashed_password="unused")
        self.db.add_all([self.user, self.other])
        self.db.commit()
        app = FastAPI()
        app.include_router(ranking_router.router)
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[ranking_router.get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.addCleanup(self.client.close)

    def game(self, name, **values):
        game = Videogame(user_id=self.user.id, name=name, **values)
        self.db.add(game)
        self.db.commit()
        return game

    def test_ranking_starts_by_rating_and_saves_manual_order_and_rating(self):
        low = self.game("Low", mark=4)
        high = self.game("High", mark=9)
        self.game("Unrated")
        self.game("Hidden", mark=10, hidden=True)
        self.assertEqual(self.client.get("/api/ranking").json()["game_ids"], [high.id, low.id])
        response = self.client.put("/api/ranking/order", json={"game_ids": [low.id, high.id]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.patch(f"/api/ranking/games/{low.id}/rating", json={"mark": 10}).json()["mark"], 10)
        self.assertEqual(self.client.get("/api/ranking").json()["game_ids"], [low.id, high.id])
        self.assertEqual(self.client.put("/api/ranking/order", json={"game_ids": [high.id]}).status_code, 409)

    def test_tier_snapshot_refresh_exclusion_restore_and_order(self):
        favorite = self.game("Favorite", mark=9, status="Finished", tags="RPG", publication_year=2021)
        low = self.game("Low", mark=3, status="Finished", tags="RPG")
        response = self.client.post("/api/ranking/tier-lists", json={
            "name": "Favorites", "filters": {"statuses": ["Finished"], "min_rating": 7, "tags": ["RPG"]},
        })
        self.assertEqual(response.status_code, 201, response.text)
        tier_list = response.json()
        list_id = tier_list["id"]
        self.assertEqual([item["game_id"] for item in tier_list["entries"]], [favorite.id])
        newer = self.game("New", mark=8, status="Finished", tags="RPG")
        self.assertEqual(len(self.client.get("/api/ranking/tier-lists").json()[0]["entries"]), 1)
        response = self.client.post(f"/api/ranking/tier-lists/{list_id}/refresh")
        self.assertEqual(response.json()["added"], 1)
        self.assertEqual({item["game_id"] for item in response.json()["tier_list"]["entries"]}, {favorite.id, newer.id})
        self.assertEqual(self.client.put(f"/api/ranking/tier-lists/{list_id}/order", json={
            "buckets": {"S": [newer.id], "A": [], "B": [], "C": [], "D": [], "F": [], "unranked": [favorite.id]},
        }).status_code, 200)
        self.client.delete(f"/api/ranking/tier-lists/{list_id}/games/{favorite.id}")
        self.assertEqual(self.client.post(f"/api/ranking/tier-lists/{list_id}/refresh").json()["added"], 0)
        self.assertEqual(self.client.post(f"/api/ranking/tier-lists/{list_id}/games/{favorite.id}").status_code, 409)
        restored = self.client.post(f"/api/ranking/tier-lists/{list_id}/games/{favorite.id}/restore").json()
        self.assertFalse(next(item for item in restored["entries"] if item["game_id"] == favorite.id)["deleted"])
        self.assertEqual(self.client.post(f"/api/ranking/tier-lists/{list_id}/games/{low.id}").status_code, 200)

    def test_user_cannot_modify_another_users_tier_list_or_game(self):
        game = self.game("Mine", mark=8)
        tier_list = self.client.post("/api/ranking/tier-lists", json={"name": "Mine"}).json()
        self.user = self.other
        self.assertEqual(self.client.get("/api/ranking/tier-lists").json(), [])
        self.assertEqual(self.client.patch(f"/api/ranking/games/{game.id}/rating", json={"mark": 10}).status_code, 404)
        self.assertEqual(self.client.patch(f"/api/ranking/tier-lists/{tier_list['id']}", json={"name": "Stolen"}).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/ranking/tier-lists/{tier_list['id']}").status_code, 404)


if __name__ == "__main__":
    unittest.main()
