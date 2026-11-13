"""Physical Switch catalog. Isolated SQLite and mocked upstreams; no network."""
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app.database import Base, get_db
from backend.app.models import User, Videogame
from backend.app.discovery_models import SwitchCatalogGame, SwitchCatalogHidden, WantedGame
from backend.app.routers import discovery_router as router
from backend.app.services import switch_catalog as catalog

LISTING = """
<ul class="items cols-4 style-cover">
<li class="item item-content item-game" data-type="game" data-subject="games/nintendo-switch-2/donkey-kong-bananza"><div class="item-wrap">
  <div class="cover"><a class="img" href="/x"><img class="lazy" src="https://images.example/dk.jpg" alt="cover" /></a></div>
  <div class="info"><p class="heading"><a class="title accent-hover" href="/x"><span class="title accent-hover">Donkey Kong Bananza</span> <span class="subtitle">Switch 2</span></a></p>
  <p class="description"><a href="/companies/nintendo">Nintendo</a></p>
  <ul class="release-dates"><li><span class="date">16th Jul 2025 <span class="region">(NA)</span></span></li><li><span class="date">17th Jul 2025 <span class="region">(UK/EU)</span></span></li></ul></div></div></li>
<li class="item item-content item-game" data-type="game" data-subject="games/nintendo-switch-2/someday"><div class="item-wrap">
  <div class="info"><p class="heading"><a class="title" href="/y"><span class="title">Someday</span></a></p>
  <ul class="release-dates"><li><span class="date">2027 <span class="region">(NA)</span></span></li></ul></div></div></li>
</ul>
"""
DETAIL = "<dl><dt>Genre</dt><dd>Action</dd><dt>Physical Release</dt><dd class=\"first\">{}</dd></dl>"
EDITION = "Zelda Quest – Nintendo Switch 2 Edition"


class FakeClient:
    def __init__(self, pages):
        self.pages = pages

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def get(self, url, params=None):
        key = (url, (params or {}).get("system"), (params or {}).get("page"))
        body = self.pages.get(key, self.pages.get(url))
        request = httpx.Request("GET", url)
        if body is None:
            return httpx.Response(404, request=request)
        if isinstance(body, dict):
            return httpx.Response(200, json=body, request=request)
        return httpx.Response(200, text=body, request=request)


class OfflineClient(FakeClient):
    def get(self, url, params=None):
        raise httpx.ConnectError("offline")


class SwitchCatalogTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.factory()
        self.user = User(username="one", hashed_password="unused", is_admin=True)
        self.other = User(username="two", hashed_password="unused")
        self.db.add_all([self.user, self.other])
        self.db.commit()
        self.current = self.user
        app = FastAPI()
        app.include_router(router.router)
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[router.get_current_user] = lambda: self.current
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

    def add(self, name, platform="Nintendo Switch", physical_format=catalog.GAME_CARD, **fields):
        row = SwitchCatalogGame(
            source_key=f"nl:{platform}/{name}", name=name, title_key=catalog._release_title_key(name),
            platform=platform, physical_format=physical_format, source_url="https://example.com", **fields,
        )
        self.db.add(row)
        self.db.commit()
        return row

    def games(self):
        response = self.client.get("/api/discovery/catalog")
        self.assertEqual(response.status_code, 200, response.text)
        return {game["name"]: game for game in response.json()["games"]}

    def test_listing_prefers_european_dates_and_keeps_partial_dates_as_labels(self):
        games = catalog.parse_listing(LISTING, "Nintendo Switch 2")
        self.assertEqual([game["name"] for game in games], ["Donkey Kong Bananza", "Someday"])
        first, second = games
        self.assertEqual(first["source_key"], "nl:nintendo-switch-2/donkey-kong-bananza")
        self.assertEqual((first["release_date"], first["publisher"], first["image_url"]),
                         ("2025-07-17", "Nintendo", "https://images.example/dk.jpg"))
        self.assertEqual((second["release_date"], second["release_label"], second["image_url"]), (None, "2027", None))

    def test_physical_field_is_classified(self):
        for text, expected in (("Standard Game Card", catalog.GAME_CARD), ("Game-Key Card", catalog.GAME_KEY_CARD),
                               ("Download Code in Box", catalog.CODE_IN_BOX), ("", ""), ("None", "")):
            self.assertEqual(catalog.classify_physical(catalog.parse_physical_release(DETAIL.format(text))), expected)
        self.assertEqual(catalog.parse_physical_release("<dl><dt>Genre</dt><dd>Action</dd></dl>"), "")

    def test_catalog_lists_only_physical_games_and_flags_owned_and_saved(self):
        self.add("Owned Game")
        self.add(EDITION, "Nintendo Switch 2", catalog.GAME_KEY_CARD)
        self.add("Wanted Game")
        self.add("Digital Only", "Nintendo Switch 2", "")
        self.add("Unchecked", "Nintendo Switch 2", None)
        self.add("Code Game", "Nintendo Switch 2", catalog.CODE_IN_BOX)
        self.db.add_all([
            Videogame(user_id=self.user.id, name="Owned Game", copies='[{"id": "a", "platform": "PC"}]'),
            Videogame(user_id=self.user.id, name="Zelda Quest", hidden=True),
            Videogame(user_id=self.other.id, name="Wanted Game"),
            WantedGame(user_id=self.user.id, name="Wanted Game"),
        ])
        self.db.commit()
        games = self.games()
        self.assertEqual(set(games), {"Owned Game", EDITION, "Wanted Game"})
        self.assertEqual((games["Owned Game"]["owned"], games["Owned Game"]["owned_platforms"]), (True, ["PC"]))
        self.assertFalse(games[EDITION]["owned"])
        self.assertEqual(games[EDITION]["format"], catalog.GAME_KEY_CARD)
        self.assertEqual((games["Wanted Game"]["owned"], games["Wanted Game"]["saved"]), (False, True))

    def test_switch_2_edition_matches_the_owned_base_game(self):
        self.add(EDITION, "Nintendo Switch 2")
        self.db.add(Videogame(user_id=self.user.id, name="Zelda Quest"))
        self.db.commit()
        self.assertTrue(self.games()[EDITION]["owned"])

    def test_hidden_games_are_per_user_and_restorable(self):
        first, second = self.add("First"), self.add("Second")
        for row in (first, second):
            self.assertEqual(self.client.put(f"/api/discovery/catalog/{row.id}/hidden?hidden=true").status_code, 200)
        # Hiding twice is harmless.
        self.assertEqual(self.client.put(f"/api/discovery/catalog/{first.id}/hidden?hidden=true").status_code, 200)
        self.assertEqual(self.db.query(SwitchCatalogHidden).count(), 2)
        self.assertTrue(all(game["hidden"] for game in self.games().values()))
        self.current = self.other
        self.assertFalse(any(game["hidden"] for game in self.games().values()))
        self.current = self.user
        self.client.put(f"/api/discovery/catalog/{first.id}/hidden?hidden=false")
        games = self.games()
        self.assertEqual((games["First"]["hidden"], games["Second"]["hidden"]), (False, True))
        self.assertEqual(self.client.delete("/api/discovery/catalog/hidden").json(), {"restored": 1})
        self.assertFalse(any(game["hidden"] for game in self.games().values()))
        self.assertEqual(self.client.put("/api/discovery/catalog/9999/hidden?hidden=true").status_code, 404)

    def test_sync_reads_listings_then_checks_switch_2_formats(self):
        browse = f"{catalog.NL_BASE}/games/browse"
        client = FakeClient({
            (browse, "nintendo-switch", 1): LISTING.replace("nintendo-switch-2/", "nintendo-switch/"),
            (browse, "nintendo-switch-2", 1): LISTING,
            f"{catalog.NL_BASE}/games/nintendo-switch-2/donkey-kong-bananza": DETAIL.format("Game-Key Card"),
            f"{catalog.NL_BASE}/games/nintendo-switch-2/someday": "<dl></dl>",
            catalog.NINTENDO_EU_SEARCH: {"response": {"numFound": 2, "docs": [
                {"fs_id": "1", "title": "Donkey Kong Bananza", "system_type": ["nintendoswitch_gamecard"], "date_from": "2025-07-17T00:00:00Z"},
                {"fs_id": "2", "title": "Only At Nintendo", "url": "/en-gb/x", "system_type": ["nintendoswitch_gamecard"], "date_from": "2020-01-02T00:00:00Z"},
            ]}},
        })
        with patch.object(catalog.httpx, "Client", return_value=client), patch.object(catalog, "_igdb_supplement", return_value=True):
            self.assertTrue(catalog.run_sync(sleep=lambda _seconds: None, session_factory=self.factory))
        rows = {(row.platform, row.name): row for row in self.db.query(SwitchCatalogGame).all()}
        self.assertEqual(rows[("Nintendo Switch", "Donkey Kong Bananza")].physical_format, catalog.GAME_CARD)
        self.assertEqual(rows[("Nintendo Switch 2", "Donkey Kong Bananza")].physical_format, catalog.GAME_KEY_CARD)
        self.assertEqual(rows[("Nintendo Switch 2", "Someday")].physical_format, "")
        self.assertEqual(rows[("Nintendo Switch", "Only At Nintendo")].release_date, "2020-01-02")
        self.assertEqual(len(rows), 5)
        state = catalog.status(self.db)
        self.assertEqual((state["running"], state["error"], state["pending_details"]), (False, None, 0))
        # A fresh listing is not crawled again, and nothing is pending.
        self.assertFalse(catalog.sync_is_due(self.db))
        someday = rows[("Nintendo Switch 2", "Someday")]
        someday.detail_checked_at = datetime.utcnow() - timedelta(days=30)
        self.db.commit()
        self.assertTrue(catalog.sync_is_due(self.db))

    def test_igdb_products_become_one_row_per_game_and_skip_code_in_box(self):
        game = {"id": 7, "name": "Boxed Game", "slug": "boxed-game", "cover": {"image_id": "co1"},
                "release_dates": [{"date": 1700000000, "platform": 130}, {"date": 1500000000, "platform": 6}],
                "involved_companies": [{"publisher": False, "company": {"name": "Dev"}}, {"publisher": True, "company": {"name": "Pub"}}]}
        games = catalog.igdb_games([
            {"platform": 130, "name": "Boxed Game - Nintendo Switch", "game": game},
            {"platform": 130, "name": "Boxed Game Deluxe", "game": game},
            {"platform": 508, "name": "Boxed Game Game-Key Card", "game": game},
            {"platform": 130, "name": "Other (Code in Box)", "game": {"id": 8, "name": "Other"}},
            {"platform": 6, "name": "PC", "game": {"id": 9, "name": "PC Game"}},
        ])
        self.assertEqual([(row["source_key"], row["platform"], row["physical_format"]) for row in games], [
            ("igdb:7:130", "Nintendo Switch", catalog.GAME_CARD),
            ("igdb:7:508", "Nintendo Switch 2", catalog.GAME_KEY_CARD),
        ])
        self.assertEqual((games[0]["release_date"], games[0]["publisher"]), ("2023-11-14", "Pub"))
        self.assertIsNone(games[1]["release_date"])

    def test_failed_sync_reports_an_error_and_keeps_existing_rows(self):
        self.add("Kept")
        with patch.object(catalog.httpx, "Client", return_value=OfflineClient({})), patch.object(catalog, "_igdb_supplement", return_value=True):
            catalog.run_sync(sleep=lambda _seconds: None, session_factory=self.factory)
        state = catalog.status(self.db)
        self.assertFalse(state["running"])
        self.assertIn("Nintendo Life could not be reached", state["error"])
        self.assertIn("Kept", self.games())
        self.assertFalse(catalog.sync_is_due(self.db))


if __name__ == "__main__":
    unittest.main()
