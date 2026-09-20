"""Discovery regressions. Isolated SQLite and mocked upstreams; no personal data."""
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch, MagicMock

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app.database import Base, get_db
from backend.app.models import User, Videogame
from backend.app.discovery_models import WantedGame, DiscoverySettings, DiscoveryCache, PhysicalRelease, SteamCollectionLink, SteamCopyTrash, SteamMatchReview, SteamOwnedGame, SteamContentLink
from backend.app.routers import discovery_router as router, videogames_router
from backend.app.services import discovery as service


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.factory()
        self.users = [User(username="one", hashed_password="unused", is_admin=True), User(username="two", hashed_password="unused", is_admin=False)]
        self.db.add_all(self.users)
        self.db.commit()
        self.user = self.users[0]
        app = FastAPI()
        app.include_router(router.router)
        app.include_router(videogames_router.router)
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[router.get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

    def create(self, name="Test Game", **kwargs):
        response = self.client.post("/api/discovery/games", json={"name": name, **kwargs})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_crud_scoping_validation_and_collection_isolation(self):
        game = self.create(platform="Nintendo Switch", is_dlc=True, parent_game_name="Base", dlcs=json.dumps([{"name": "Extra", "state": "not_owned"}]))
        self.assertEqual(self.db.query(Videogame).count(), 0)
        self.user = self.users[1]
        self.assertEqual(self.client.get("/api/discovery/games").json(), [])
        for method in ("put", "delete"):
            response = getattr(self.client, method)(f"/api/discovery/games/{game['id']}", **({"json": {"name": "hijack"}} if method == "put" else {}))
            self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.post(f"/api/discovery/games/{game['id']}/acquire").status_code, 404)
        for fields in ({"hype": 11}, {"target_price": -1}, {"release_date": "2026-02-30"}, {"store_url": "javascript:alert(1)"}, {"dlcs": "{}"}, {"dlcs": '[{"name":"a","state":"bad"}]'}):
            self.assertEqual(self.client.post('/api/discovery/games', json={"name": "Invalid", **fields}).status_code, 422)

    def test_dedup_edit_remove_and_explicit_restore(self):
        game = self.create(steam_appid=123, comments="personal", hype=9)
        self.assertEqual(self.client.post('/api/discovery/games', json={"name": " test   game "}).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/discovery/games/{game['id']}").status_code, 204)
        self.assertEqual(self.client.get('/api/discovery/games').json(), [])
        self.assertTrue(self.db.get(WantedGame, game['id']).deleted)
        restored = self.create(steam_appid=123, comments="restored")
        self.assertEqual(restored['id'], game['id'])
        edited = self.client.put(f"/api/discovery/games/{game['id']}", json={"name": "Renamed", "hype": 7, "steam_appid": 123, "is_dlc": True})
        self.assertEqual(edited.status_code, 200)
        self.assertEqual(edited.json()['hype'], 7)

    def test_bulk_import_atomic_validation_and_idempotence(self):
        invalid = {"games": [{"name": "Good"}, {"name": "Bad", "hype": 100}]}
        self.assertEqual(self.client.post('/api/discovery/import', json=invalid).status_code, 422)
        self.assertEqual(self.db.query(WantedGame).count(), 0)
        data = {"games": [{"name": "One"}, {"name": "One"}, {"name": "Two", "is_dlc": True}]}
        self.assertEqual(self.client.post('/api/discovery/import', json=data).json(), {"added": 2, "skipped": 1})
        self.assertEqual(self.client.post('/api/discovery/import', json=data).json(), {"added": 0, "skipped": 3})

    def test_acquisition_nests_dlc_under_selected_collection_game(self):
        parent = Videogame(user_id=self.user.id, name="Base", status="Not Started")
        self.db.add(parent)
        self.db.commit()
        game = self.create("Bonus", comments="keep", is_dlc=True, parent_game_name="Base")
        payload = {"name": "Bonus", "is_dlc": True, "parent_game_name": "Base", "parent_game_id": parent.id,
                   "platform": "PC", "format": "Digital", "source": "Steam", "steam_appid": 42}
        first = self.client.post(f"/api/discovery/games/{game['id']}/acquire", json=payload)
        second = self.client.post(f"/api/discovery/games/{game['id']}/acquire", json=payload)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(self.db.query(Videogame).count(), 1)
        owned = self.db.query(Videogame).one()
        self.assertEqual(owned.name, 'Base')
        self.assertEqual(json.loads(owned.dlcs)[0]['name'], 'Bonus')
        self.assertEqual(json.loads(owned.dlcs)[0]['steam_appid'], 42)
        self.assertEqual(self.db.get(WantedGame, game['id']).status, 'Acquired')

    def test_acquisition_review_can_change_platform_and_add_multiple_copies(self):
        switch_wanted = self.create('Same Game', platform='PC', format='Digital', steam_appid=123)
        reviewed = {
            'name': 'Same Game', 'platform': 'Nintendo Switch', 'format': 'Physical',
            'source': 'retail', 'price': 49.99, 'currency': 'EUR', 'status': 'Not Started',
            'description': 'Kept metadata', 'release_date': '2026-09-17', 'steam_appid': 123,
            'store_url': 'https://store.steampowered.com/app/123/',
        }
        response = self.client.post(f"/api/discovery/games/{switch_wanted['id']}/acquire", json=reviewed)
        self.assertEqual(response.status_code, 200, response.text)
        owned = self.db.query(Videogame).one()
        self.assertEqual(json.loads(owned.copies)[0]['platform'], 'Nintendo Switch')
        self.assertEqual(json.loads(owned.copies)[0]['format'], 'Physical')
        self.assertIsNone(json.loads(owned.copies)[0]['steam_appid'])
        self.assertIsNone(json.loads(owned.copies)[0]['store_url'])

        pc_wanted = self.create('Same Game', platform='PC', format='Digital', steam_appid=456)
        response = self.client.post(f"/api/discovery/games/{pc_wanted['id']}/acquire", json={
            **reviewed, 'platform': 'PC', 'format': 'Digital', 'source': 'steam', 'steam_appid': 456,
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.db.query(Videogame).count(), 1)
        self.assertEqual({copy['platform'] for copy in json.loads(owned.copies)}, {'Nintendo Switch', 'PC'})

    def test_settings_are_personal_and_sync_interval_is_bounded(self):
        self.assertEqual(self.client.put('/api/discovery/settings', json={"sync_enabled": True}).status_code, 422)
        self.assertEqual(self.client.put('/api/discovery/settings', json={"sync_hours": 1}).status_code, 422)
        self.assertEqual(self.client.put('/api/discovery/settings', json={"steam_id": "http://evil.com/123"}).status_code, 422)
        response = self.client.put('/api/discovery/settings', json={"steam_id": "https://steamcommunity.com/profiles/76561197960434622/", "sync_enabled": True, "sync_hours": 8})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['steam_id'], '76561197960434622')
        self.user = self.users[1]
        self.assertIsNone(self.client.get('/api/discovery/settings').json()['steam_id'])

    def test_wishlist_and_collection_sync_modes_are_independent(self):
        invalid = self.client.put('/api/discovery/settings', json={
            "steam_id": "76561197960434622", "sync_enabled": True,
            "sync_wishlist": False, "sync_collection": False,
        })
        self.assertEqual(invalid.status_code, 422)
        response = self.client.put('/api/discovery/settings', json={
            "steam_id": "76561197960434622", "sync_enabled": True,
            "sync_wishlist": True, "sync_collection": False,
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['sync_wishlist'])
        self.assertFalse(response.json()['sync_collection'])

    def test_wishlist_only_sync_marks_missing_games_and_restores_them(self):
        settings = self.configured()
        settings.sync_collection = False
        game = self.create('Keep visible', steam_appid=10, platform='PC')
        self.db.commit()
        with patch.object(service, 'steam_wishlist', return_value=[]), \
             patch.object(service, 'steam_owned_games') as owned, \
             patch.object(service, 'enrich_steam_with_igdb', return_value=(0, None)):
            service.sync_steam(self.user.id, self.factory)
        self.db.expire_all()
        self.assertTrue(self.db.get(WantedGame, game['id']).steam_wishlist_missing)
        owned.assert_not_called()

        with patch.object(service, 'steam_wishlist', return_value=[{'appid': 10}]), \
             patch.object(service, 'enrich_steam_with_igdb', return_value=(0, None)):
            service.sync_steam(self.user.id, self.factory)
        self.db.expire_all()
        self.assertFalse(self.db.get(WantedGame, game['id']).steam_wishlist_missing)

    def test_collection_sync_blocks_manual_steam_copy_but_allows_another_copy(self):
        self.configured()
        game = self.create('Steam managed', steam_appid=123, platform='PC', source='steam')
        steam_move = self.client.post(f"/api/discovery/games/{game['id']}/acquire", json={
            'name': 'Steam managed', 'platform': 'PC', 'format': 'Digital',
            'source': 'Steam', 'steam_appid': 123,
        })
        self.assertEqual(steam_move.status_code, 409)
        switch_move = self.client.post(f"/api/discovery/games/{game['id']}/acquire", json={
            'name': 'Steam managed', 'platform': 'Nintendo Switch', 'format': 'Physical',
            'source': 'Retail', 'steam_appid': None,
        })
        self.assertEqual(switch_move.status_code, 200, switch_move.text)
        copy = json.loads(self.db.query(Videogame).one().copies)[0]
        self.assertEqual(copy['source'], 'Retail')
        self.assertIsNone(copy['steam_appid'])

    def configured(self):
        settings = DiscoverySettings(user_id=self.user.id, steam_id='76561197960434622', sync_enabled=True, sync_hours=6)
        self.db.add(settings)
        self.db.commit()
        return settings

    def test_claim_prevents_overlaps_and_recovers_expired_leases(self):
        settings = self.configured()
        self.assertTrue(service.claim_sync(self.db, self.user.id))
        self.assertFalse(service.claim_sync(self.db, self.user.id, force=True))
        self.db.refresh(settings)
        self.assertGreater(settings.next_sync_at, datetime.utcnow() + timedelta(hours=5))
        settings.sync_started_at = datetime.utcnow() - timedelta(hours=2)
        settings.next_sync_at = datetime.utcnow() - timedelta(minutes=1)
        self.db.commit()
        self.assertTrue(service.claim_sync(self.db, self.user.id))
        self.assertEqual(self.client.put('/api/discovery/settings', json={}).status_code, 409)

    def test_sync_preserves_edits_deleted_entries_and_deduplicates(self):
        settings = self.configured()
        edited = self.create('Custom title', steam_appid=10, comments='Keep me', hype=10)
        deleted = self.create('Removed', steam_appid=20)
        self.client.delete(f"/api/discovery/games/{deleted['id']}")
        manual = self.create('Manual game', platform='PC (Microsoft Windows)', comments='Personal note')
        self.db.add(Videogame(user_id=self.user.id, name='Already owned'))
        self.db.commit()
        items = [{"appid": appid} for appid in [10, 20, 30, 30, 40, 50]]
        details = {30: {"name": "Expansion", "is_dlc": True, "parent_game_name": "Base"}, 40: {"name": "Already owned"}, 50: {"name": "Manual game"}}
        with patch.object(service, 'steam_wishlist', return_value=items), patch.object(service, 'steam_owned_games', return_value=[]), patch.object(service, 'steam_details', side_effect=lambda db, client, appid: {**details[appid], "steam_appid": appid, "platform": "PC"}), patch.object(service, 'enrich_steam_with_igdb', return_value=(0, None)):
            service.sync_steam(self.user.id, self.factory)
            service.sync_steam(self.user.id, self.factory)
        self.db.expire_all()
        self.assertEqual(self.db.query(WantedGame).count(), 4)
        self.assertEqual(self.db.get(WantedGame, edited['id']).comments, 'Keep me')
        self.assertEqual(self.db.get(WantedGame, edited['id']).name, 'Custom title')
        self.assertTrue(self.db.get(WantedGame, deleted['id']).deleted)
        self.assertEqual(self.db.get(WantedGame, manual['id']).steam_appid, 50)
        self.assertEqual(self.db.get(WantedGame, manual['id']).comments, 'Personal note')
        self.assertTrue(self.db.query(WantedGame).filter_by(steam_appid=30).one().is_dlc)
        self.assertIsNotNone(self.db.get(DiscoverySettings, settings.user_id).last_sync_at)

    def test_failed_and_private_wishlist_never_deletes_saved_games(self):
        self.configured()
        self.create('Keep')
        for body in ({"response": {}}, {"response": {"items": "bad"}}):
            client = MagicMock()
            client.get.return_value = httpx.Response(200, json=body, request=httpx.Request('GET', 'https://example.com'))
            with self.assertRaises(ValueError):
                service.steam_wishlist(client, '76561197960434622')
        with patch.object(service, 'steam_wishlist', side_effect=ValueError('Private wishlist')):
            service.sync_steam(self.user.id, self.factory)
        self.db.expire_all()
        settings = self.db.get(DiscoverySettings, self.user.id)
        self.assertIsNone(settings.last_sync_at)
        self.assertEqual(settings.sync_error, 'Private wishlist')
        self.assertEqual(self.db.query(WantedGame).count(), 1)

    def test_rate_limit_stops_metadata_burst_and_retains_retry_status(self):
        self.configured()
        with patch.object(service, 'steam_wishlist', return_value=[{'appid': 1}, {'appid': 2}]), patch.object(service, 'steam_owned_games', return_value=[]), patch.object(service, 'steam_details', side_effect=service.UpstreamRateLimit('rate limited')) as metadata, patch.object(service, 'enrich_steam_with_igdb', return_value=(0, None)):
            service.sync_steam(self.user.id, self.factory)
        self.assertEqual(metadata.call_count, 1)
        self.db.expire_all()
        self.assertIn('2 games', self.db.get(DiscoverySettings, self.user.id).sync_error)

    def test_scheduler_imports_due_but_not_paused_connections(self):
        self.configured()
        self.db.add(DiscoverySettings(user_id=self.users[1].id, steam_id='76561197960434622', sync_enabled=False))
        self.db.commit()
        with patch.object(service, 'SessionLocal', self.factory), patch.object(service, 'sync_steam') as sync:
            service.sync_due_wishlists()
            self.assertEqual(sync.call_count, 1)
            sync.assert_called_with(self.user.id)
            service.sync_due_wishlists()
            self.assertEqual(sync.call_count, 1)

    def test_steam_metadata_maps_dlc_and_exact_release_date(self):
        client = MagicMock()
        client.get.return_value = httpx.Response(200, request=httpx.Request('GET', 'https://example.com'), json={"100": {"success": True, "data": {"name": "Extra", "type": "dlc", "fullgame": {"name": "Base"}, "release_date": {"date": "18 Sep, 2026"}, "short_description": "<b>Game</b> &amp; more"}}})
        with patch.object(service.time, 'sleep'):
            data = service.steam_details(self.db, client, 100)
        self.assertEqual(data['release_date'], '2026-09-18')
        self.assertTrue(data['is_dlc'])
        self.assertEqual(data['parent_game_name'], 'Base')
        self.assertEqual(data['description'], 'Game & more')
        self.assertIsNone(data['tags'])

    def test_official_steam_library_parser_and_exact_wanted_acquisition(self):
        client = MagicMock()
        client.get.return_value = httpx.Response(200, request=httpx.Request('GET', 'https://api.steampowered.com'), json={"response": {"games": [{"appid": 101, "name": "Owned Game", "playtime_forever": 750}]}})
        owned = service.steam_owned_games(client, '76561197960434622', 'a' * 32)
        self.assertEqual(owned[0]['appid'], 101)
        self.assertEqual(owned[0]['playtime_hours'], 12.5)
        self.assertEqual(client.get.call_args.kwargs['params']['key'], 'a' * 32)

        exact = self.create('Custom wanted name', steam_appid=101, platform='PC', comments='keep')
        other = self.create('Owned Game', steam_appid=202, platform='Nintendo Switch')
        imported = service.reconcile_steam_library(self.db, self.user.id, owned)
        self.db.commit()
        self.assertEqual(imported, 1)
        collection = self.db.query(Videogame).one()
        self.assertEqual(collection.name, 'Owned Game')
        self.assertEqual(json.loads(collection.copies)[0]['steam_appid'], 101)
        self.assertEqual(self.db.get(WantedGame, exact['id']).status, 'Acquired')
        self.assertEqual(self.db.get(WantedGame, other['id']).status, 'Wanted')

    def test_steam_library_persists_collection_link_without_overwriting_local_data(self):
        collection = Videogame(
            user_id=self.user.id, name='My custom title', description='Keep this',
            status='Finished', playtime_hours=3.0, mark=9,
            copies=json.dumps([{'id': 'switch', 'platform': 'Nintendo Switch', 'format': 'Physical', 'igdb_id': 777}]),
        )
        self.db.add(collection)
        self.db.flush()
        wanted = WantedGame(
            user_id=self.user.id, name='Official Steam Title', platform='PC', format='Digital',
            steam_appid=101, igdb_id=777, collection_game_id=collection.id,
        )
        self.db.add(wanted)
        self.db.commit()
        owned = [{
            'appid': 101, 'name': 'A different Steam title', 'playtime_hours': 99.0,
            'image_url': None, 'store_url': 'https://store.steampowered.com/app/101/',
        }]

        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 1)
        self.db.commit()
        self.assertEqual(self.db.query(Videogame).count(), 1)
        self.assertEqual(collection.name, 'A different Steam title')
        self.assertEqual(collection.description, 'Keep this')
        self.assertEqual(collection.mark, 9)
        self.assertEqual(collection.playtime_hours, 3.0)
        self.assertEqual(len(json.loads(collection.copies)), 2)
        link = self.db.query(SteamCollectionLink).filter_by(user_id=self.user.id, steam_appid=101).one()
        self.assertEqual(link.collection_game_id, collection.id)

        # Even without the wishlist row or Steam copy JSON, the durable link
        # sends a later sync back to the same collection record.
        wanted.deleted = True
        collection.copies = json.dumps([json.loads(collection.copies)[0]])
        self.db.commit()
        # The relational copy remains authoritative even if a stale client
        # edits only the backwards-compatible JSON projection.
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 0)
        self.db.commit()
        self.assertEqual(self.db.query(Videogame).count(), 1)
        self.assertEqual(json.loads(collection.copies)[1]['steam_appid'], 101)
        self.assertEqual(json.loads(collection.copies)[1]['igdb_id'], 777)
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 0)

    def test_steam_library_links_an_unambiguous_minor_title_typo(self):
        original = Videogame(
            user_id=self.user.id, name='Clair Obsucr: Expedition 33', description='Local data',
            status='Playing', playtime_hours=33.0, mark=10,
        )
        self.db.add(original)
        self.db.commit()
        imported = service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 1903340, 'name': 'Clair Obscur: Expedition 33', 'playtime_hours': 40.0,
            'image_url': None, 'store_url': 'https://store.steampowered.com/app/1903340/',
        }])
        self.db.commit()
        self.assertEqual(imported, 1)
        self.assertEqual(self.db.query(Videogame).count(), 1)
        self.assertEqual(original.name, 'Clair Obscur: Expedition 33')
        self.assertEqual(original.description, 'Local data')
        self.assertEqual(original.status, 'Playing')
        self.assertEqual(original.playtime_hours, 33.0)
        self.assertEqual(original.mark, 10)
        self.assertEqual(json.loads(original.copies)[0]['steam_appid'], 1903340)
        self.assertEqual(self.db.query(SteamCollectionLink).one().collection_game_id, original.id)

    def test_manual_link_allows_one_steam_app_for_multiple_collection_games(self):
        first = Videogame(user_id=self.user.id, name='Edition One', status='Not Started',
                          copies=json.dumps([{'id': 'first-copy', 'platform': 'PC', 'format': 'Digital'}]))
        second = Videogame(user_id=self.user.id, name='Edition Two', status='Not Started',
                           copies=json.dumps([{'id': 'second-copy', 'platform': 'PC', 'format': 'Digital'}]))
        steam = SteamOwnedGame(user_id=self.user.id, steam_appid=900, name='Steam Complete Edition', playtime_hours=2.0)
        self.db.add_all([first, second, steam])
        self.db.commit()
        for game, copy_id in ((first, 'first-copy'), (second, 'second-copy')):
            response = self.client.post(f'/api/discovery/steam/collection-games/{game.id}/copies/{copy_id}/link', json={
                'steam_appid': 900, 'mode': 'primary',
            })
            self.assertEqual(response.status_code, 200, response.text)
        links = self.db.query(SteamCollectionLink).filter_by(user_id=self.user.id, steam_appid=900).all()
        self.assertEqual({link.collection_game_id for link in links}, {first.id, second.id})
        self.assertEqual(json.loads(first.copies)[0]['steam_appid'], 900)
        self.assertEqual(json.loads(second.copies)[0]['steam_appid'], 900)

    def test_manual_link_targets_one_copy_without_changing_the_other_owned_copy(self):
        game = Videogame(
            user_id=self.user.id, name='Owned twice', status='Not Started',
            copies=json.dumps([
                {'id': 'switch-copy', 'platform': 'Nintendo Switch', 'format': 'Physical'},
                {'id': 'pc-copy', 'platform': 'PC', 'format': 'Digital'},
            ]),
        )
        steam = SteamOwnedGame(
            user_id=self.user.id, steam_appid=901, name='Owned twice on Steam',
            store_url='https://store.steampowered.com/app/901/',
        )
        self.db.add_all([game, steam])
        self.db.commit()

        response = self.client.post(
            f'/api/discovery/steam/collection-games/{game.id}/copies/pc-copy/link',
            json={'steam_appid': 901, 'mode': 'primary'},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.db.refresh(game)
        switch_copy, pc_copy = json.loads(game.copies)
        self.assertIsNone(switch_copy['steam_appid'])
        self.assertEqual(switch_copy['platform'], 'Nintendo Switch')
        self.assertEqual(pc_copy['steam_appid'], 901)
        link = self.db.query(SteamCollectionLink).filter(SteamCollectionLink.steam_appid.is_not(None)).one()
        self.assertEqual(link.copy_id, 'pc-copy')
        self.assertEqual(link.collection_game_id, game.id)

    def test_collection_duplicate_moves_named_copies_and_links_to_selected_card(self):
        canonical = Videogame(user_id=self.user.id, name='Final Fantasy VII', status='Playing', mark=9, comments='canonical notes',
                              copies=json.dumps([{'id': 'steam:1', 'platform': 'PC', 'format': 'Digital', 'steam_appid': 1}]))
        duplicate_card = Videogame(user_id=self.user.id, name='Final Fantasy VII (2013)', status='Finished', mark=7, comments='edition notes',
                                   copies=json.dumps([{'id': 'steam:2', 'platform': 'PC', 'format': 'Digital', 'steam_appid': 2}]))
        apps = [
            SteamOwnedGame(user_id=self.user.id, steam_appid=1, name='Final Fantasy VII'),
            SteamOwnedGame(user_id=self.user.id, steam_appid=2, name='Final Fantasy VII (2013)'),
        ]
        self.db.add_all([canonical, duplicate_card, *apps])
        self.db.flush()
        self.db.add_all([
            SteamCollectionLink(user_id=self.user.id, steam_appid=1, collection_game_id=canonical.id, copy_id='steam:1'),
            SteamCollectionLink(user_id=self.user.id, steam_appid=2, collection_game_id=duplicate_card.id, copy_id='steam:2', created_collection_game=True),
        ])
        service.attach_steam_copy(self.db, canonical, {'appid': 1, 'name': apps[0].name})
        service.attach_steam_copy(self.db, duplicate_card, {'appid': 2, 'name': apps[1].name})
        self.db.commit()
        response = self.client.post(f'/api/discovery/steam/collection-games/{duplicate_card.id}/merge-duplicate', json={
            'other_game_id': canonical.id, 'direction': 'current_into_other',
            'field_sources': {'status': 'current', 'mark': 'other', 'comments': 'current'},
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.db.refresh(canonical)
        self.db.refresh(duplicate_card)
        copies = json.loads(canonical.copies)
        self.assertEqual({copy['steam_appid'] for copy in copies}, {1, 2})
        self.assertEqual({copy['name'] for copy in copies}, {'Final Fantasy VII', 'Final Fantasy VII (2013)'})
        self.assertEqual(canonical.status, 'Finished')
        self.assertEqual(canonical.mark, 9)
        self.assertEqual(canonical.comments, 'edition notes')
        self.assertTrue(duplicate_card.hidden)
        self.assertIsNone(duplicate_card.copies)
        self.assertEqual(self.db.get(SteamOwnedGame, apps[1].id).duplicate_of_appid, 1)
        duplicate_link = self.db.query(SteamCollectionLink).filter_by(steam_appid=2).one()
        self.assertEqual(duplicate_link.collection_game_id, canonical.id)
        self.assertEqual(duplicate_link.copy_id, 'steam:2')
        self.assertEqual(duplicate_link.merged_from_game_id, duplicate_card.id)

        restored = self.client.post(
            f'/api/discovery/steam/collection-games/{canonical.id}/copies/steam:2/restore-duplicate'
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        payload = restored.json()
        self.assertEqual(payload['source_game']['id'], canonical.id)
        self.assertEqual(payload['restored_game']['id'], duplicate_card.id)
        self.assertEqual(payload['restored_game']['name'], 'Final Fantasy VII (2013)')
        self.db.refresh(canonical)
        self.db.refresh(duplicate_card)
        self.db.refresh(duplicate_link)
        self.assertFalse(duplicate_card.hidden)
        self.assertIsNone(duplicate_card.merged_into_game_id)
        self.assertEqual(duplicate_card.status, 'Finished')
        self.assertEqual(duplicate_card.comments, 'edition notes')
        self.assertEqual(duplicate_link.collection_game_id, duplicate_card.id)
        self.assertIsNone(duplicate_link.merged_from_game_id)
        self.assertIsNone(self.db.get(SteamOwnedGame, apps[1].id).duplicate_of_appid)
        self.assertEqual({copy['steam_appid'] for copy in json.loads(canonical.copies)}, {1})
        self.assertEqual({copy['steam_appid'] for copy in json.loads(duplicate_card.copies)}, {2})

    def test_collection_duplicate_can_keep_the_current_game(self):
        current = Videogame(user_id=self.user.id, name='Current', status='Not Started',
                            copies=json.dumps([{'id': 'current-copy', 'platform': 'Nintendo Switch', 'format': 'Physical'}]))
        other = Videogame(user_id=self.user.id, name='Other Steam Edition', status='Not Started',
                          copies=json.dumps([{'id': 'steam:44', 'platform': 'PC', 'format': 'Digital', 'steam_appid': 44}]))
        steam = SteamOwnedGame(user_id=self.user.id, steam_appid=44, name='Other Steam Edition')
        self.db.add_all([current, other, steam])
        self.db.flush()
        self.db.add(SteamCollectionLink(user_id=self.user.id, steam_appid=44,
                                        collection_game_id=other.id, copy_id='steam:44'))
        self.db.commit()

        response = self.client.post(f'/api/discovery/steam/collection-games/{current.id}/merge-duplicate', json={
            'other_game_id': other.id, 'direction': 'other_into_current',
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.db.refresh(current)
        self.db.refresh(other)
        self.assertFalse(current.hidden)
        self.assertTrue(other.hidden)
        self.assertEqual([copy.get('name') for copy in json.loads(current.copies)], ['Current', 'Other Steam Edition'])
        link = self.db.query(SteamCollectionLink).filter(SteamCollectionLink.steam_appid.is_not(None)).one()
        self.assertEqual(link.collection_game_id, current.id)
        self.assertEqual(link.copy_id, 'steam:44')

    def test_legacy_duplicate_copy_restores_to_a_new_game(self):
        combined = Videogame(user_id=self.user.id, name='Combined card', status='Playing')
        primary = SteamOwnedGame(user_id=self.user.id, steam_appid=80, name='Primary edition')
        duplicate = SteamOwnedGame(
            user_id=self.user.id, steam_appid=81, name='Older duplicate edition',
            duplicate_of_appid=80,
        )
        self.db.add_all([combined, primary, duplicate])
        self.db.flush()
        self.db.add_all([
            SteamCollectionLink(user_id=self.user.id, collection_game_id=combined.id,
                                copy_id='steam:80', steam_appid=80),
            SteamCollectionLink(user_id=self.user.id, collection_game_id=combined.id,
                                copy_id='steam:81', steam_appid=81),
        ])
        self.db.commit()

        response = self.client.post(
            f'/api/discovery/steam/collection-games/{combined.id}/copies/steam:81/restore-duplicate'
        )
        self.assertEqual(response.status_code, 200, response.text)
        restored = response.json()['restored_game']
        self.assertNotEqual(restored['id'], combined.id)
        self.assertEqual(restored['name'], 'Older duplicate edition')
        self.assertEqual(json.loads(restored['copies'])[0]['steam_appid'], 81)
        self.assertEqual(
            self.db.query(SteamCollectionLink).filter_by(steam_appid=81).one().collection_game_id,
            restored['id'],
        )
        self.assertIsNone(self.db.get(SteamOwnedGame, duplicate.id).duplicate_of_appid)

    def test_deleted_steam_copy_is_locked_trashed_and_not_recreated_by_sync(self):
        game = Videogame(user_id=self.user.id, name='Steam game', status='Not Started', playtime_mode='copies', copies=json.dumps([
            {'id': 'steam:77', 'name': 'Steam game', 'platform': 'PC', 'format': 'Digital',
             'source': 'Steam', 'steam_appid': 77, 'playtime_hours': 2.0},
        ]))
        steam = SteamOwnedGame(user_id=self.user.id, steam_appid=77, name='Steam game', playtime_hours=8.5)
        self.db.add_all([game, steam])
        self.db.flush()
        self.db.add(SteamCollectionLink(user_id=self.user.id, steam_appid=77, collection_game_id=game.id, copy_id='steam:77'))
        self.db.commit()

        locked = self.client.put(f'/api/videogames/{game.id}', json={'name': game.name, 'copies': json.dumps([
            {'id': 'steam:77', 'name': 'Steam game', 'platform': 'PC', 'format': 'Digital',
             'source': 'Other', 'steam_appid': 77, 'playtime_hours': 999},
        ])})
        self.assertEqual(locked.status_code, 200, locked.text)
        locked_copy = json.loads(locked.json()['copies'])[0]
        self.assertEqual(locked_copy['source'], 'Steam')
        self.assertEqual(locked_copy['playtime_hours'], 8.5)

        removed = self.client.put(f'/api/videogames/{game.id}', json={'name': game.name, 'copies': None})
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(self.db.query(SteamCollectionLink).count(), 0)
        trash = self.db.query(SteamCopyTrash).one()
        self.assertEqual(trash.steam_appid, 77)

        item = {'appid': 77, 'name': 'Steam game', 'playtime_hours': 10.0, 'image_url': None, 'store_url': None}
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, [item]), 0)
        self.db.commit()
        self.assertIsNone(game.copies)

        restored = self.client.post(f'/api/discovery/steam/trash/{trash.id}/restore')
        self.assertEqual(restored.status_code, 200, restored.text)
        restored_copy = json.loads(restored.json()['copies'])[0]
        self.assertEqual(restored_copy['steam_appid'], 77)
        self.assertEqual(restored_copy['playtime_hours'], 10.0)
        self.assertEqual(self.db.query(SteamCopyTrash).count(), 0)
        self.assertEqual(self.db.query(SteamCollectionLink).count(), 1)

    def test_owned_steam_dlc_is_nested_and_never_creates_a_collection_card(self):
        parent = Videogame(user_id=self.user.id, name='Base Game', status='Not Started')
        wanted = WantedGame(user_id=self.user.id, name='Expansion', platform='PC', format='Digital',
                            source='steam', steam_appid=81, is_dlc=True, parent_game_name='Base Game')
        self.db.add_all([parent, wanted])
        self.db.commit()
        imported = service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 81, 'name': 'Expansion', 'playtime_hours': 0, 'is_dlc': True,
            'parent_game_name': 'Base Game', 'store_url': 'https://store.steampowered.com/app/81/',
        }])
        self.db.commit()
        self.assertEqual(imported, 0)
        self.assertEqual(self.db.query(Videogame).count(), 1)
        self.assertEqual(json.loads(parent.dlcs)[0]['steam_appid'], 81)
        self.assertEqual(wanted.collection_game_id, parent.id)

    def test_uncertain_steam_title_waits_for_review_then_links_existing_game(self):
        original = Videogame(
            user_id=self.user.id, name='The Elder Scrolls V: Skyrim',
            description='Keep this text', status='Playing', playtime_hours=80.0,
        )
        self.db.add(original)
        self.db.commit()
        owned = [{
            'appid': 72850, 'name': 'Skyrim', 'playtime_hours': 2.0,
            'image_url': None, 'store_url': 'https://store.steampowered.com/app/72850/',
        }]

        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 0)
        self.db.commit()
        review = self.db.query(SteamMatchReview).one()
        self.assertEqual(review.candidate_game_id, original.id)
        self.assertGreaterEqual(review.confidence, .72)
        self.assertEqual(self.db.query(Videogame).count(), 1)
        self.assertEqual(self.db.query(SteamCollectionLink).count(), 0)

        listed = self.client.get('/api/discovery/steam/reviews')
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()[0]['steam_name'], 'Skyrim')
        decided = self.client.post(f'/api/discovery/steam/reviews/{review.id}', json={
            'decision': 'same', 'candidate_game_id': original.id,
        })
        self.assertEqual(decided.status_code, 200, decided.text)
        self.db.refresh(original)
        self.assertEqual(self.db.query(Videogame).count(), 1)
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)
        self.assertEqual(self.db.query(SteamCollectionLink).one().collection_game_id, original.id)
        self.assertEqual(json.loads(original.copies)[0]['steam_appid'], 72850)
        self.assertEqual(original.description, 'Keep this text')
        self.assertEqual(original.playtime_hours, 80.0)
        self.assertEqual(original.name, 'Skyrim')
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 0)

    def test_none_of_candidates_creates_and_permanently_links_separate_game(self):
        original = Videogame(user_id=self.user.id, name='Portal', status='Finished')
        self.db.add(original)
        self.db.commit()
        owned = [{
            'appid': 620, 'name': 'Portal 2', 'playtime_hours': 5.0,
            'image_url': None, 'store_url': 'https://store.steampowered.com/app/620/',
        }]
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 0)
        self.db.commit()
        review = self.db.query(SteamMatchReview).one()

        decided = self.client.post(f'/api/discovery/steam/reviews/{review.id}', json={
            'decision': 'none',
        })
        self.assertEqual(decided.status_code, 200, decided.text)
        new_game = self.db.get(Videogame, decided.json()['collection_game_id'])
        self.assertEqual(new_game.name, 'Portal 2')
        self.assertEqual(json.loads(new_game.copies)[0]['steam_appid'], 620)
        self.assertEqual(self.db.query(Videogame).count(), 2)
        self.assertEqual(self.db.query(SteamCollectionLink).one().collection_game_id, new_game.id)
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 0)
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)

    def test_doubtful_match_offers_multiple_candidates_and_rejects_them_individually(self):
        base = Videogame(user_id=self.user.id, name='Etrian Odyssey', status='Finished', mark=8)
        sequel = Videogame(user_id=self.user.id, name='Etrian Odyssey 2', status='Playing', playtime_hours=12)
        self.db.add_all([base, sequel])
        self.db.commit()
        owned = [{
            'appid': 999, 'name': 'Etrian Odyssey II', 'playtime_hours': 20.0,
            'image_url': None, 'store_url': 'https://store.steampowered.com/app/999/',
        }]
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 0)
        self.db.commit()
        review = self.db.query(SteamMatchReview).one()
        listed = self.client.get('/api/discovery/steam/reviews').json()[0]
        candidates = {item['game_id']: item for item in listed['candidates']}
        self.assertIn(base.id, candidates)
        self.assertIn(sequel.id, candidates)

        rejected = self.client.post(f'/api/discovery/steam/reviews/{review.id}', json={
            'decision': 'different', 'candidate_game_id': base.id,
        })
        self.assertEqual(rejected.status_code, 200, rejected.text)
        self.assertFalse(rejected.json()['resolved'])
        self.assertIsNotNone(self.db.get(SteamMatchReview, review.id))
        remaining = self.client.get('/api/discovery/steam/reviews').json()[0]['candidates']
        self.assertNotIn(base.id, {item['game_id'] for item in remaining})
        self.assertIn(sequel.id, {item['game_id'] for item in remaining})

        accepted = self.client.post(f'/api/discovery/steam/reviews/{review.id}', json={
            'decision': 'same', 'candidate_game_id': sequel.id,
        })
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertTrue(accepted.json()['resolved'])
        self.db.refresh(base)
        self.db.refresh(sequel)
        self.assertEqual(base.name, 'Etrian Odyssey')
        self.assertEqual(sequel.name, 'Etrian Odyssey II')
        self.assertEqual(sequel.playtime_hours, 12)
        self.assertEqual(json.loads(sequel.copies)[0]['steam_appid'], 999)
        self.assertEqual(self.db.query(SteamCollectionLink).one().collection_game_id, sequel.id)
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)

    def test_unsync_removes_imports_but_preserves_local_games_and_non_steam_copies(self):
        settings = DiscoverySettings(
            user_id=self.user.id, steam_id='76561197960434622', steam_api_key='a' * 32,
            sync_enabled=True, sync_hours=6, last_sync_at=datetime.utcnow(),
        )
        local = Videogame(
            user_id=self.user.id, name='Local game', status='Playing', mark=9,
            copies=json.dumps([
                {'id': 'switch', 'platform': 'Nintendo Switch', 'source': 'Retail'},
                {'id': 'steam:1', 'platform': 'PC', 'source': 'Steam', 'steam_appid': 1},
            ]),
        )
        imported = Videogame(
            user_id=self.user.id, name='Imported game', status='Not Started',
            copies=json.dumps([{'id': 'steam:2', 'platform': 'PC', 'source': 'Steam', 'steam_appid': 2}]),
        )
        mixed_import = Videogame(
            user_id=self.user.id, name='Imported then bought on Switch', status='Playing',
            copies=json.dumps([
                {'id': 'steam:3', 'platform': 'PC', 'source': 'Steam', 'steam_appid': 3},
                {'id': 'switch-3', 'platform': 'Nintendo Switch', 'source': 'Retail'},
            ]),
        )
        other_user_game = Videogame(user_id=self.users[1].id, name='Other user', status='Not Started')
        self.db.add_all([settings, local, imported, mixed_import, other_user_game])
        self.db.flush()
        self.db.add_all([
            SteamCollectionLink(user_id=self.user.id, steam_appid=1, collection_game_id=local.id, copy_id='steam:1', created_collection_game=False),
            SteamCollectionLink(user_id=self.user.id, steam_appid=2, collection_game_id=imported.id, copy_id='steam:2', created_collection_game=True),
            SteamCollectionLink(user_id=self.user.id, steam_appid=3, collection_game_id=mixed_import.id, copy_id='steam:3', created_collection_game=True),
            SteamCollectionLink(user_id=self.users[1].id, steam_appid=99, collection_game_id=other_user_game.id, copy_id='steam:99', created_collection_game=True),
            WantedGame(user_id=self.user.id, name='Steam wishlist', source='steam', steam_appid=4),
            WantedGame(user_id=self.user.id, name='Manual wanted', source='manual', steam_appid=1, collection_game_id=local.id, status='Acquired'),
            SteamMatchReview(user_id=self.user.id, steam_appid=5, steam_name='Maybe', candidate_game_id=local.id, candidate_name=local.name, confidence=.8, steam_data='{}'),
        ])
        self.db.commit()

        response = self.client.delete('/api/discovery/steam/imports')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {
            'collection_games_removed': 1, 'steam_copies_removed': 3, 'wanted_games_removed': 1,
        })
        self.db.refresh(local)
        self.db.refresh(mixed_import)
        self.db.refresh(other_user_game)
        self.assertEqual([copy['platform'] for copy in json.loads(local.copies)], ['Nintendo Switch'])
        self.assertEqual(local.status, 'Playing')
        self.assertEqual(local.mark, 9)
        self.assertIsNone(self.db.get(Videogame, imported.id))
        self.assertEqual([copy['platform'] for copy in json.loads(mixed_import.copies)], ['Nintendo Switch'])
        manual = self.db.query(WantedGame).filter_by(user_id=self.user.id).one()
        self.assertEqual(manual.name, 'Manual wanted')
        self.assertIsNone(manual.steam_appid)
        self.assertEqual(manual.collection_game_id, local.id)
        self.assertEqual(self.db.query(SteamCollectionLink).filter_by(user_id=self.user.id).filter(
            SteamCollectionLink.steam_appid.is_not(None)
        ).count(), 0)
        self.assertEqual(self.db.query(SteamMatchReview).filter_by(user_id=self.user.id).count(), 0)
        self.assertEqual(self.db.query(SteamCollectionLink).filter_by(user_id=self.users[1].id).count(), 1)
        self.assertFalse(settings.sync_enabled)
        self.assertIsNone(settings.next_sync_at)
        self.assertEqual(settings.steam_id, '76561197960434622')
        self.assertTrue(settings.steam_api_key_configured)

    def test_owned_library_requires_api_key_without_leaking_it(self):
        with patch.dict('os.environ', {'STEAM_WEB_API_KEY': ''}):
            with self.assertRaisesRegex(ValueError, 'API key'):
                service.steam_owned_games(MagicMock(), '76561197960434622')
        response = self.client.put('/api/discovery/settings', json={
            'steam_id': '76561197960434622', 'steam_api_key': 'a' * 32,
            'sync_enabled': True, 'sync_hours': 6, 'region': 'Europe',
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['steam_api_key_configured'])
        self.assertNotIn('steam_api_key', response.json())

    def test_steam_sync_igdb_autocompletes_exact_app_links_including_dlc(self):
        wanted = self.create('Steam DLC title', steam_appid=101, platform='PC')
        service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 101, 'name': 'Steam DLC title', 'playtime_hours': 0,
            'image_url': None, 'store_url': 'https://store.steampowered.com/app/101/',
        }])
        self.db.commit()
        request = httpx.Request('POST', 'https://api.igdb.com/v4/games')
        client = MagicMock()
        client.post.side_effect = [
            httpx.Response(200, request=request, json=[{'uid': '101', 'game': 9001}]),
            httpx.Response(200, request=request, json=[{
                'id': 9001, 'name': 'Canonical DLC', 'summary': 'IGDB description',
                'first_release_date': 1789689600, 'game_type': 1,
                'cover': {'image_id': 'cover123'}, 'parent_game': {'name': 'Base Game'},
            }]),
        ]
        with patch.dict('os.environ', {'TWITCH_SECRET_CLIENT_ID': 'client', 'TWITCH_SECRET': 'secret'}), \
             patch('backend.app.routers.igdb_router._get_twitch_token', return_value='token'):
            matched, error = service.enrich_steam_with_igdb(self.db, client, self.user.id)
        self.db.commit()
        self.assertIsNone(error)
        self.assertEqual(matched, 1)
        row = self.db.get(WantedGame, wanted['id'])
        self.assertEqual(row.igdb_id, 9001)
        self.assertTrue(row.is_dlc)
        self.assertEqual(row.parent_game_name, 'Base Game')
        self.assertEqual(row.description, 'IGDB description')
        owned = self.db.query(Videogame).one()
        self.assertEqual(json.loads(owned.copies)[0]['igdb_id'], 9001)
        self.assertTrue(owned.is_dlc)

    def test_sync_imports_owned_library_with_wishlist_schedule(self):
        settings = self.configured()
        with patch.object(service, 'steam_wishlist', return_value=[]), patch.object(service, 'steam_owned_games', return_value=[{
            'appid': 301, 'name': 'Library Game', 'playtime_hours': 4.5, 'image_url': None,
            'store_url': 'https://store.steampowered.com/app/301/',
        }]), patch.object(service, 'enrich_steam_with_igdb', return_value=(0, None)):
            service.sync_steam(self.user.id, self.factory)
        self.db.expire_all()
        self.assertEqual(self.db.query(Videogame).one().name, 'Library Game')
        self.assertEqual(self.db.get(DiscoverySettings, settings.user_id).last_owned_import_count, 1)

    def test_copy_options_are_personal_and_editable(self):
        defaults = self.client.get('/api/discovery/copy-options').json()
        self.assertIn('PC', defaults['platforms'])
        saved = self.client.put('/api/discovery/copy-options', json={'platforms': ['PC', 'PC', 'Switch'], 'sources': ['Steam', 'Retail']})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()['platforms'], ['PC', 'Switch'])
        self.user = self.users[1]
        self.assertNotEqual(self.client.get('/api/discovery/copy-options').json()['platforms'], ['PC', 'Switch'])

    def test_month_window_year_rollover_and_leap_year(self):
        self.assertEqual(service.month_window(date(2027, 1, 4)), (date(2026, 12, 1), date(2027, 1, 1), date(2027, 2, 1)))
        self.assertEqual(service.month_window(date(2028, 3, 31))[0], date(2028, 2, 1))

    def test_catalog_paginates_requires_physical_and_caches(self):
        request = httpx.Request('GET', 'https://example.com')
        pages = [httpx.Response(200, request=request, json={"response": {"numFound": 2, "docs": [{"fs_id": str(i), "title": f"Physical {i}", "physical_version_b": True, "date_from": f"2026-09-0{i}T00:00:00Z", "url": "/en-gb/Games/example"}]}}) for i in (1, 2)]
        with patch.object(service, '_nintendo_life_retail_releases', return_value=([], datetime.utcnow())), patch.object(service.httpx.Client, 'get', side_effect=pages) as get:
            result = service.nintendo_releases(self.db)
            self.assertEqual(len(result['games']), 2)
            self.assertEqual(get.call_count, 2)
            self.assertIn('physical_version_b:true', get.call_args.kwargs['params']['fq'])
            self.assertEqual(get.call_args.kwargs['params']['start'], 1)
            service.nintendo_releases(self.db)
            self.assertEqual(get.call_count, 2)
        cache = self.db.query(DiscoveryCache).one()
        cache.updated_at = datetime.utcnow() - timedelta(days=2)
        self.db.commit()
        with patch.object(service, '_nintendo_life_retail_releases', return_value=([], datetime.utcnow())), patch.object(service.httpx.Client, 'get', side_effect=httpx.ConnectError('offline')):
            stale = service.nintendo_releases(self.db)
            self.assertEqual(len(stale['games']), 2)
            self.assertIn('could not be refreshed', stale['warning'])

    def test_retail_guide_parses_switch_family_physical_formats(self):
        page = '''<html><body>
          <h3>Card Game - September 3rd (Switch 2)</h3><p>This one is a Game-Key Card.</p>
          <h2>More Upcoming Games for August &amp; September 2026</h2>
          <aside><div class="item"><div class="image"><img src="https://example.com/cover.jpg" /></div>
          <div class="title"><a title="Retail Game - Nintendo Switch">Retail Game</a><span class="date">24th Sep 2026</span></div></div></aside>
          <aside><div class="item"><div class="title"><a title="Undated Game - Nintendo Switch 2">Undated Game</a></div></div></aside>
          <h2>Switch 2 Hardware Bundles</h2>
          <aside><div class="item"><div class="title"><a title="Not a game">Not a game</a><span class="date">25th Sep 2026</span></div></div></aside>
        </body></html>'''
        lookup = {service._release_title_key('Undated Game – Nintendo Switch™ 2 Edition'): [{"release_date": "2026-09-17", "platform": "Nintendo Switch 2"}]}
        games = service._parse_nintendo_life_guide(page, 'https://example.com/guide', date(2026, 8, 1), date(2026, 10, 1), lookup)
        self.assertEqual([game['name'] for game in games], ['Card Game', 'Undated Game', 'Retail Game'])
        self.assertEqual(games[0]['platform'], 'Nintendo Switch 2')
        self.assertIn('Game-Key Card', games[0]['notes'])
        self.assertEqual(games[1]['release_date'], '2026-09-17')
        self.assertEqual(games[2]['platform'], 'Nintendo Switch')
        self.assertEqual(games[2]['image_url'], 'https://example.com/cover.jpg')

    def test_igdb_fallback_requires_physical_switch_products_and_region(self):
        previous, current, following = service.month_window()
        release_day = current + timedelta(days=3)
        timestamp = int(datetime.combine(release_day, datetime.min.time(), tzinfo=timezone.utc).timestamp())
        request = httpx.Request('POST', 'https://api.igdb.com/v4/test')
        responses = [
            httpx.Response(200, request=request, json=[{"game": 101, "name": "Physical product", "url": "https://example.com/product"}]),
            httpx.Response(200, request=request, json=[{"date": timestamp, "release_region": 1, "game": {"id": 101, "name": "Physical game", "slug": "physical-game", "cover": {"image_id": "cover"}, "summary": "Summary"}}]),
        ]
        client = MagicMock()
        client.__enter__.return_value = client
        client.__exit__.return_value = False
        client.post.side_effect = responses
        with patch.dict('os.environ', {"TWITCH_SECRET_CLIENT_ID": "client"}), \
             patch('backend.app.routers.igdb_router._get_twitch_token', return_value='token'), \
             patch.object(service.httpx, 'Client', return_value=client):
            games, updated_at = service._igdb_physical_releases(self.db, 'Europe', previous, current, following)
        self.assertEqual(games[0]['name'], 'Physical game')
        self.assertEqual(games[0]['release_date'], release_day.isoformat())
        self.assertEqual(games[0]['source'], 'IGDB')
        self.assertIsInstance(updated_at, datetime)
        self.assertIn('platform=130 & game_release_format=2', client.post.call_args_list[0].kwargs['content'])
        self.assertIn('release_region', client.post.call_args_list[1].kwargs['content'])

    def test_release_admin_auth_and_personal_owned_flags(self):
        self.user = self.users[1]
        body = {"name": "A", "release_date": date.today().isoformat(), "source_url": "https://nintendo.com/game"}
        self.assertEqual(self.client.post('/api/discovery/releases', json=body).status_code, 403)
        self.user = self.users[0]
        response = self.client.post('/api/discovery/releases', json=body)
        self.assertEqual(response.status_code, 201)
        self.db.add(Videogame(user_id=self.user.id, name='A'))
        self.db.commit()
        previous, current, following = service.month_window()
        source = {"games": [], "start": previous.isoformat(), "end": following.isoformat(), "months": [str(previous)[:7], str(current)[:7]]}
        with patch.object(service, 'nintendo_releases', side_effect=lambda *args: {**source, 'games': []}):
            self.assertTrue(self.client.get('/api/discovery/timeline').json()['games'][0]['owned'])
            self.user = self.users[1]
            self.assertFalse(self.client.get('/api/discovery/timeline').json()['games'][0]['owned'])

    def test_analytics_excludes_other_users_and_keeps_currencies_separate(self):
        self.create('One', target_price=25, currency='EUR', hype=8, dlcs='[{"name":"Extra","state":"not_owned"}]')
        self.create('Two', target_price=30, currency='USD', is_dlc=True)
        self.create('Done', status='Acquired', target_price=500)
        self.user = self.users[1]
        self.create('Other user', target_price=1000)
        self.user = self.users[0]
        data = self.client.get('/api/discovery/analytics').json()
        self.assertEqual(data['budgets'], {'EUR': 25, 'USD': 30})
        self.assertEqual(data['active'], 2)
        self.assertEqual(data['acquired'], 1)
        self.assertEqual(data['average_hype'], 8)
        self.assertEqual(data['nested_dlcs'], 1)
        self.assertEqual(data['dlcs'], 1)

    def test_collection_edits_reject_a_stale_version(self):
        created = self.client.post('/api/videogames/', json={'name': 'Concurrent edit'})
        self.assertEqual(created.status_code, 200, created.text)
        game = created.json()
        first = self.client.put(f"/api/videogames/{game['id']}", json={
            'name': 'First edit', 'reviewed': True, 'version': game['version'],
        })
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()['reviewed'])
        stale = self.client.put(f"/api/videogames/{game['id']}", json={
            'name': 'Lost edit', 'version': game['version'],
        })
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(self.db.get(Videogame, game['id']).name, 'First edit')
        self.assertTrue(self.db.get(Videogame, game['id']).reviewed)

    def test_one_collection_card_cannot_link_the_same_steam_app_twice(self):
        game = Videogame(user_id=self.user.id, name='Two copies', status='Not Started', copies=json.dumps([
            {'id': 'one', 'platform': 'PC', 'format': 'Digital'},
            {'id': 'two', 'platform': 'PC', 'format': 'Digital'},
        ]))
        steam = SteamOwnedGame(user_id=self.user.id, steam_appid=501, name='Steam title')
        self.db.add_all([game, steam]); self.db.commit()
        first = self.client.post(f'/api/discovery/steam/collection-games/{game.id}/copies/one/link', json={
            'steam_appid': 501, 'mode': 'primary',
        })
        second = self.client.post(f'/api/discovery/steam/collection-games/{game.id}/copies/two/link', json={
            'steam_appid': 501, 'mode': 'primary',
        })
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 409, second.text)

    def test_shared_steam_app_uses_one_account_total_and_scoped_trash(self):
        first = Videogame(user_id=self.user.id, name='Edition A', status='Not Started', copies=json.dumps([
            {'id': 'a', 'platform': 'PC', 'format': 'Digital'},
        ]))
        second = Videogame(user_id=self.user.id, name='Edition B', status='Not Started', copies=json.dumps([
            {'id': 'b', 'platform': 'PC', 'format': 'Digital'},
        ]))
        steam = SteamOwnedGame(user_id=self.user.id, steam_appid=502, name='Shared Steam title', playtime_hours=12)
        self.db.add_all([first, second, steam]); self.db.commit()
        for game, copy_id in ((first, 'a'), (second, 'b')):
            response = self.client.post(f'/api/discovery/steam/collection-games/{game.id}/copies/{copy_id}/link', json={
                'steam_appid': 502, 'mode': 'primary',
            })
            self.assertEqual(response.status_code, 200, response.text)
        rows = self.db.query(SteamCollectionLink).filter_by(steam_appid=502).all()
        self.assertEqual(sum(bool(row.counts_toward_totals) for row in rows), 1)

        removed = self.client.put(f'/api/videogames/{first.id}', json={
            'name': first.name, 'copies': None,
        })
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(self.db.query(SteamCopyTrash).filter_by(collection_game_id=first.id).count(), 1)
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 502, 'name': steam.name, 'playtime_hours': 12,
        }]), 0)
        self.db.flush()
        self.assertEqual(self.db.query(SteamCollectionLink).filter_by(collection_game_id=first.id, steam_appid=502).count(), 0)
        self.assertEqual(self.db.query(SteamCollectionLink).filter_by(collection_game_id=second.id, steam_appid=502).count(), 1)

    def test_ambiguous_exact_titles_require_review(self):
        self.db.add_all([
            Videogame(user_id=self.user.id, name='Same title', status='Not Started'),
            Videogame(user_id=self.user.id, name='Same title', status='Not Started'),
        ])
        self.db.commit()
        imported = service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 503, 'name': 'Same title', 'playtime_hours': 0,
        }])
        self.db.flush()
        review = self.db.query(SteamMatchReview).filter_by(steam_appid=503).one()
        self.assertEqual(imported, 0)
        self.assertEqual(len(service.steam_review_candidates(review)), 2)
        self.assertEqual(self.db.query(SteamCollectionLink).filter_by(steam_appid=503).count(), 0)

    def test_identified_expansion_is_only_nested_under_its_parent(self):
        parent = Videogame(user_id=self.user.id, name='Base Saga', status='Not Started')
        expansion_card = Videogame(user_id=self.user.id, name='Base Saga Expansion', status='Not Started')
        steam = SteamOwnedGame(
            user_id=self.user.id, steam_appid=504, name='Base Saga Expansion',
            is_dlc=True, parent_game_name='Base Saga', active=True,
        )
        self.db.add_all([parent, expansion_card, steam]); self.db.flush()
        self.db.add(SteamCollectionLink(
            user_id=self.user.id, collection_game_id=expansion_card.id,
            copy_id='steam:504', steam_appid=504, name=steam.name,
            platform='PC', format='Digital', source='Steam',
        ))
        self.db.commit()
        self.assertEqual(service.nest_known_steam_dlcs(self.db, self.user.id), 1)
        self.db.flush()
        self.assertTrue(expansion_card.hidden)
        self.assertTrue(expansion_card.is_dlc)
        self.assertEqual(json.loads(parent.dlcs)[0]['steam_appid'], 504)
        self.assertEqual(self.db.query(SteamContentLink).filter_by(steam_appid=504).one().parent_game_id, parent.id)
        self.assertEqual(self.db.query(SteamCollectionLink).filter_by(steam_appid=504).count(), 0)


if __name__ == '__main__':
    unittest.main()
