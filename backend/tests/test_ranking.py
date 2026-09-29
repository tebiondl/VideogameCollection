"""Ranking and tier-list persistence, ownership, and snapshot behavior."""
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app.database import Base, get_db
from backend.app.models import GameRankingEntry, User, Videogame
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
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.patch(f"/api/ranking/games/{low.id}/rating", json={"mark": 10}).json()["mark"], 10)
        self.assertEqual(self.client.get("/api/ranking").json()["game_ids"], [low.id, high.id])
        self.assertEqual(self.client.put("/api/ranking/order", json={"game_ids": [high.id]}).status_code, 409)

    def test_columns_default_to_four_and_are_saved_per_user(self):
        self.assertEqual(self.client.get("/api/ranking/settings").json(), {"games_per_row": 4})
        self.assertEqual(self.client.put("/api/ranking/settings", json={"games_per_row": 6}).json(), {"games_per_row": 6})
        self.assertEqual(self.client.get("/api/ranking/settings").json(), {"games_per_row": 6})
        self.assertEqual(self.client.put("/api/ranking/settings", json={"games_per_row": 1}).status_code, 422)
        self.user = self.other
        self.assertEqual(self.client.get("/api/ranking/settings").json(), {"games_per_row": 4})

    def test_existing_cross_rating_order_is_grouped_without_losing_order_within_a_rating(self):
        nine_a = self.game("Nine A", mark=9)
        eight = self.game("Eight", mark=8)
        nine_b = self.game("Nine B", mark=9)
        self.db.add_all([
            GameRankingEntry(user_id=self.user.id, game_id=game.id, position=position)
            for position, game in enumerate((nine_b, eight, nine_a))
        ])
        self.db.commit()
        self.assertEqual(self.client.get("/api/ranking").json()["game_ids"], [nine_b.id, nine_a.id, eight.id])
        self.assertEqual(self.client.get("/api/ranking").json()["game_ids"], [nine_b.id, nine_a.id, eight.id])

    def test_newly_rated_game_joins_its_rating_group_until_it_is_moved(self):
        high = self.game("High", mark=10)
        middle = self.game("Middle", mark=7)
        low = self.game("Low", mark=4)
        unrated = self.game("Unrated")
        self.assertEqual(self.client.get("/api/ranking").json(), {
            "game_ids": [high.id, middle.id, low.id], "new_game_ids": [],
        })
        self.assertEqual(self.client.put("/api/ranking/order", json={"game_ids": [low.id, high.id, middle.id], "moved_game_id": low.id}).status_code, 422)
        unrated.mark = 7
        self.db.commit()
        added = self.client.get("/api/ranking").json()
        self.assertEqual(added["game_ids"], [high.id, middle.id, unrated.id, low.id])
        self.assertEqual(added["new_game_ids"], [unrated.id])
        self.client.put("/api/ranking/order", json={
            "game_ids": [high.id, middle.id, unrated.id, low.id], "moved_game_id": high.id,
        })
        self.assertEqual(self.client.get("/api/ranking").json()["new_game_ids"], [unrated.id])
        moved = self.client.put("/api/ranking/order", json={
            "game_ids": [high.id, unrated.id, middle.id, low.id], "moved_game_id": unrated.id,
        }).json()
        self.assertEqual(moved["new_game_ids"], [])

    def test_rating_changes_move_to_first_when_lowered_and_last_when_raised(self):
        high = self.game("High", mark=10)
        nine_a = self.game("Nine A", mark=9)
        nine_b = self.game("Nine B", mark=9)
        eight_a = self.game("Eight A", mark=8)
        eight_b = self.game("Eight B", mark=8)
        self.assertEqual(self.client.get("/api/ranking").json()["game_ids"], [high.id, nine_a.id, nine_b.id, eight_a.id, eight_b.id])
        self.assertEqual(self.client.put("/api/ranking/order", json={"game_ids": [high.id, nine_b.id, nine_a.id, eight_a.id, eight_b.id], "moved_game_id": nine_b.id}).status_code, 200)
        self.assertEqual(self.client.put("/api/ranking/order", json={"game_ids": [nine_b.id, high.id, nine_a.id, eight_a.id, eight_b.id]}).status_code, 422)
        self.client.patch(f"/api/ranking/games/{nine_a.id}/rating", json={"mark": 8})
        self.assertEqual(self.client.get("/api/ranking").json()["game_ids"], [high.id, nine_b.id, nine_a.id, eight_a.id, eight_b.id])
        self.client.patch(f"/api/ranking/games/{eight_a.id}/rating", json={"mark": 9})
        self.assertEqual(self.client.get("/api/ranking").json()["game_ids"], [high.id, nine_b.id, eight_a.id, nine_a.id, eight_b.id])
        # Rating edits outside the ranking page follow the same placement rules.
        eight_b.mark = 9
        self.db.commit()
        self.assertEqual(self.client.get("/api/ranking").json()["game_ids"], [high.id, nine_b.id, eight_a.id, eight_b.id, nine_a.id])

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
