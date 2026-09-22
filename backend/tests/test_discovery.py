"""Discovery regressions. Isolated SQLite and mocked upstreams; no personal data."""
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch, MagicMock

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
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
        settings = self.db.get(DiscoverySettings, self.user.id)
        self.assertIsNone(settings.sync_error)
        self.assertIn('2 games', settings.sync_warning)

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
        client.get.return_value = httpx.Response(200, request=httpx.Request('GET', 'https://api.steampowered.com'), json={"response": {"games": [{"appid": 101, "name": "Owned Game", "playtime_forever": 750, "playtime_disconnected": 310}]}})
        owned = service.steam_owned_games(client, '76561197960434622', 'a' * 32)
        self.assertEqual(owned[0]['appid'], 101)
        self.assertEqual(owned[0]['playtime_hours'], 17.7)
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

    def test_recently_played_supplements_free_games_missing_from_owned_library(self):
        client = MagicMock()
        client.get.side_effect = [
            httpx.Response(200, request=httpx.Request('GET', 'https://api.steampowered.com'), json={
                "response": {"games": [{"appid": 101, "name": "Owned Game", "playtime_forever": 750}]},
            }),
            httpx.Response(200, request=httpx.Request('GET', 'https://api.steampowered.com'), json={
                "response": {"games": [
                    {"appid": 101, "name": "Owned Game", "playtime_forever": 720},
                    {"appid": 2420510, "name": "HoloCure - Save the Fans!", "playtime_forever": 542},
                ]},
            }),
        ]

        owned = service.steam_owned_games(client, '76561197960434622', 'a' * 32)

        self.assertEqual([game['appid'] for game in owned], [101, 2420510])
        self.assertEqual(owned[0]['playtime_hours'], 12.5)
        self.assertEqual(owned[1]['playtime_hours'], 9.0)
        self.assertFalse(owned[0]['stats_verified'])
        self.assertTrue(owned[1]['stats_verified'])
        self.assertIn('GetOwnedGames', client.get.call_args_list[0].args[0])
        self.assertIn('GetRecentlyPlayedGames', client.get.call_args_list[1].args[0])

        collection = Videogame(user_id=self.user.id, name='Holocure: Save the Fans!', status='Infinite')
        self.db.add(collection)
        self.db.commit()
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 2)
        self.db.commit()
        holocure = self.db.get(Videogame, collection.id)
        self.assertEqual(json.loads(holocure.copies)[0]['steam_appid'], 2420510)

    def test_collection_list_batches_copy_and_entitlement_queries(self):
        games = [
            Videogame(user_id=self.user.id, name=f'Batch game {index}', status='Not Started')
            for index in range(12)
        ]
        self.db.add_all(games)
        self.db.flush()
        entitlements = [
            SteamOwnedGame(
                user_id=self.user.id, steam_appid=1000 + index,
                name=f'Steam batch game {index}', playtime_hours=float(index),
            )
            for index in range(12)
        ]
        self.db.add_all(entitlements)
        self.db.flush()
        self.db.add_all([
            SteamCollectionLink(
                user_id=self.user.id, collection_game_id=game.id,
                copy_id=f'steam:{entitlement.steam_appid}', steam_appid=entitlement.steam_appid,
                name=game.name, platform='PC', format='Digital', source='Steam',
            )
            for game, entitlement in zip(games, entitlements)
        ])
        self.db.commit()

        statements = []
        def count_query(_conn, _cursor, statement, _parameters, _context, _executemany):
            if statement.lstrip().upper().startswith('SELECT'):
                statements.append(statement)

        event.listen(self.engine, 'before_cursor_execute', count_query)
        try:
            response = self.client.get('/api/videogames/')
        finally:
            event.remove(self.engine, 'before_cursor_execute', count_query)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertLessEqual(len(statements), 3, statements)
        payload = response.json()
        self.assertEqual(len(payload), 12)
        self.assertEqual(
            json.loads(payload[7]['copies'])[0]['name'],
            'Steam batch game 7',
        )
        self.assertEqual(json.loads(payload[7]['copies'])[0]['playtime_hours'], 7.0)

    def test_recently_played_failure_keeps_owned_library_usable(self):
        client = MagicMock()
        client.get.side_effect = [
            httpx.Response(200, request=httpx.Request('GET', 'https://api.steampowered.com'), json={
                "response": {"games": [{"appid": 101, "name": "Owned Game", "playtime_forever": 60}]},
            }),
            httpx.ConnectError('recent games unavailable', request=httpx.Request('GET', 'https://api.steampowered.com')),
        ]

        owned = service.steam_owned_games(client, '76561197960434622', 'a' * 32)

        self.assertEqual([game['appid'] for game in owned], [101])

    def test_store_search_candidate_requires_account_specific_stats(self):
        settings = self.configured()
        settings.steam_api_key = 'a' * 32
        self.db.commit()
        upstream = MagicMock()
        upstream.__enter__.return_value = upstream
        upstream.__exit__.return_value = False
        upstream.get.side_effect = [
            httpx.Response(200, request=httpx.Request('GET', 'https://store.steampowered.com'), json={
                'items': [{
                    'type': 'app', 'id': 2420510, 'name': 'HoloCure - Save the Fans!',
                    'tiny_image': 'https://example.com/holocure.jpg',
                }],
            }),
            httpx.Response(200, request=httpx.Request('GET', 'https://api.steampowered.com'), json={
                'playerstats': {
                    'steamID': settings.steam_id, 'gameName': 'HoloCure - Save the Fans!',
                    'success': True, 'achievements': [],
                },
            }),
        ]

        with patch.object(service.httpx, 'Client', return_value=upstream):
            result = service.find_verified_steam_game(
                self.db, self.user.id, 'Holocure: Save the Fans!'
            )

        self.assertEqual(result['appid'], 2420510)
        self.assertTrue(result['stats_verified'])
        self.assertEqual(result['name'], 'HoloCure - Save the Fans!')
        self.assertIn('storesearch', upstream.get.call_args_list[0].args[0])
        self.assertIn('GetPlayerAchievements', upstream.get.call_args_list[1].args[0])

    def test_store_search_candidate_rejects_unverified_store_result(self):
        settings = self.configured()
        settings.steam_api_key = 'a' * 32
        self.db.commit()
        upstream = MagicMock()
        upstream.__enter__.return_value = upstream
        upstream.__exit__.return_value = False
        upstream.get.side_effect = [
            httpx.Response(200, request=httpx.Request('GET', 'https://store.steampowered.com'), json={
                'items': [{'type': 'app', 'id': 999, 'name': 'Store Game'}],
            }),
            httpx.Response(200, request=httpx.Request('GET', 'https://api.steampowered.com'), json={
                'playerstats': {'success': False, 'error': 'No stats'},
            }),
            httpx.Response(400, request=httpx.Request('GET', 'https://api.steampowered.com'), json={}),
            httpx.Response(200, request=httpx.Request('GET', 'https://steamcommunity.com'), text='<html>Sign in</html>'),
        ]

        with patch.object(service.httpx, 'Client', return_value=upstream):
            result = service.find_verified_steam_game(self.db, self.user.id, 'Store Game')

        self.assertIsNone(result)

    def test_public_community_stats_confirm_game_missing_from_owned_api(self):
        client = MagicMock()
        client.get.side_effect = [
            httpx.Response(403, request=httpx.Request('GET', 'https://api.steampowered.com'), json={}),
            httpx.Response(400, request=httpx.Request('GET', 'https://api.steampowered.com'), json={}),
            httpx.Response(200, request=httpx.Request('GET', 'https://steamcommunity.com'), text='''
                <playerstats>
                  <privacyState>public</privacyState>
                  <game><gameName>ONE PIECE PIRATE WARRIORS 3</gameName></game>
                  <player><hoursPlayed>0</hoursPlayed></player>
                </playerstats>
            '''),
        ]

        title = service._steam_account_stats_title(
            client, '76561197960434622', 'a' * 32, 331600,
        )

        self.assertEqual(title, 'ONE PIECE PIRATE WARRIORS 3')
        self.assertIn('/stats/331600/', client.get.call_args_list[2].args[0])
        self.assertEqual(client.get.call_args_list[2].kwargs['params'], {'xml': 1})

    def test_verified_store_candidate_can_be_linked_and_is_persisted(self):
        settings = self.configured()
        settings.steam_api_key = 'a' * 32
        game = Videogame(
            user_id=self.user.id, name='Holocure: Save the Fans!', status='Infinite',
            copies=json.dumps([{
                'id': 'manual-pc', 'platform': 'PC', 'format': 'Digital',
                'playtime_hours': 9.3,
            }]),
        )
        self.db.add(game)
        self.db.commit()
        verified = {
            'appid': 2420510, 'name': 'HoloCure - Save the Fans!',
            'playtime_hours': None, 'image_url': 'https://example.com/holocure.jpg',
            'store_url': 'https://store.steampowered.com/app/2420510/',
            'stats_verified': True,
        }

        with patch.object(service, 'find_steam_store_games', return_value=[{
            **verified, 'manual_verification_required': False, 'store_query': game.name,
        }]) as store_lookup, patch.object(service, 'find_verified_steam_game', return_value=verified) as verified_lookup:
            candidates = self.client.get(
                f'/api/discovery/steam/collection-games/{game.id}/copies/manual-pc/candidates'
            )
            linked = self.client.post(
                f'/api/discovery/steam/collection-games/{game.id}/copies/manual-pc/link',
                json={'steam_appid': 2420510, 'mode': 'primary'},
            )

        self.assertEqual(candidates.status_code, 200, candidates.text)
        self.assertEqual(candidates.json()['candidates'][0]['steam_appid'], 2420510)
        self.assertTrue(candidates.json()['candidates'][0]['stats_verified'])
        self.assertEqual(linked.status_code, 200, linked.text)
        store_lookup.assert_called_once_with(self.db, self.user.id, game.name)
        verified_lookup.assert_called_once_with(self.db, self.user.id, game.name)
        entitlement = self.db.query(SteamOwnedGame).filter_by(steam_appid=2420510).one()
        self.assertTrue(entitlement.active)
        self.assertTrue(entitlement.stats_verified)
        self.assertEqual(json.loads(game.copies)[0]['steam_appid'], 2420510)
        self.assertEqual(json.loads(game.copies)[0]['playtime_hours'], 9.3)

    def test_sync_keeps_stats_verified_entitlements_active(self):
        settings = self.configured()
        self.db.add_all([
            SteamOwnedGame(
                user_id=self.user.id, steam_id=settings.steam_id, steam_appid=2420510,
                name='HoloCure - Save the Fans!', active=True, stats_verified=True,
            ),
            SteamOwnedGame(
                user_id=self.user.id, steam_id=settings.steam_id, steam_appid=999,
                name='Ordinary snapshot game', active=True,
            ),
            SteamOwnedGame(
                user_id=self.user.id, steam_id=settings.steam_id, steam_appid=698780,
                name='Doki Doki Literature Club', active=True, user_verified=True,
            ),
        ])
        self.db.commit()

        with patch.object(service, 'steam_wishlist', return_value=[]), \
             patch.object(service, 'steam_owned_games', return_value=[]), \
             patch.object(service, 'enrich_steam_with_igdb', return_value=(0, None)):
            service.sync_steam(self.user.id, self.factory)

        self.db.expire_all()
        verified = self.db.query(SteamOwnedGame).filter_by(steam_appid=2420510).one()
        ordinary = self.db.query(SteamOwnedGame).filter_by(steam_appid=999).one()
        user_verified = self.db.query(SteamOwnedGame).filter_by(steam_appid=698780).one()
        self.assertTrue(verified.active)
        self.assertFalse(ordinary.active)
        self.assertTrue(user_verified.active)

    def test_store_search_broadens_misspelled_title(self):
        client = MagicMock()
        client.get.side_effect = [
            httpx.Response(200, request=httpx.Request('GET', 'https://store.steampowered.com'), json={'items': []}),
            httpx.Response(200, request=httpx.Request('GET', 'https://store.steampowered.com'), json={'items': []}),
            httpx.Response(200, request=httpx.Request('GET', 'https://store.steampowered.com'), json={
                'items': [{'type': 'app', 'id': 698780, 'name': 'Doki Doki Literature Club'}],
            }),
        ]

        results = service.steam_store_candidates(client, 'Doki Doki Literture Club')

        self.assertEqual(results[0]['appid'], 698780)
        self.assertGreaterEqual(results[0]['similarity'], .95)
        self.assertEqual(
            [call.kwargs['params']['term'] for call in client.get.call_args_list],
            ['Doki Doki Literture Club', 'Doki Doki Literture', 'Doki Doki'],
        )

    def test_store_search_accepts_an_appid_or_store_url(self):
        for query in ('698780', 'https://store.steampowered.com/app/698780/Doki_Doki_Literature_Club/'):
            with self.subTest(query=query):
                client = MagicMock()
                client.get.return_value = httpx.Response(
                    200, request=httpx.Request('GET', 'https://store.steampowered.com'),
                    json={'698780': {'success': True, 'data': {
                        'name': 'Doki Doki Literature Club!', 'type': 'game',
                        'header_image': 'https://example.com/ddlc.jpg',
                    }}},
                )
                results = service.steam_store_candidates(client, query)
                self.assertEqual(results[0]['appid'], 698780)
                self.assertEqual(results[0]['name'], 'Doki Doki Literature Club!')
                self.assertIn('appdetails', client.get.call_args.args[0])

    def test_manual_store_candidate_can_be_linked_without_account_stats(self):
        self.configured()
        game = Videogame(
            user_id=self.user.id, name='Doki Doki Literture Club', status='Finished',
            copies=json.dumps([{
                'id': 'manual-copy', 'platform': 'PC', 'format': 'Digital',
                'playtime_hours': 4.0,
            }]),
        )
        self.db.add(game)
        self.db.commit()
        candidate = {
            'appid': 698780, 'name': 'Doki Doki Literature Club',
            'playtime_hours': None, 'image_url': None,
            'store_url': 'https://store.steampowered.com/app/698780/',
            'similarity': .96, 'stats_verified': False,
            'manual_verification_required': True, 'store_query': game.name,
        }
        resolved = {
            **candidate, 'is_dlc': False, 'parent_game_name': None,
            'user_verified': True,
        }

        with patch.object(service, 'find_steam_store_games', return_value=[candidate]), \
             patch.object(service, 'resolve_user_verified_steam_game', return_value=resolved) as resolver:
            candidates = self.client.get(
                f'/api/discovery/steam/collection-games/{game.id}/copies/manual-copy/candidates'
            )
            linked = self.client.post(
                f'/api/discovery/steam/collection-games/{game.id}/copies/manual-copy/link',
                json={
                    'steam_appid': 698780, 'allow_unverified': True,
                    'store_query': game.name,
                },
            )

        self.assertEqual(candidates.status_code, 200, candidates.text)
        self.assertTrue(candidates.json()['candidates'][0]['manual_verification_required'])
        self.assertEqual(linked.status_code, 200, linked.text)
        resolver.assert_called_once_with(self.db, self.user.id, game.name, 698780)
        entitlement = self.db.query(SteamOwnedGame).filter_by(steam_appid=698780).one()
        self.assertTrue(entitlement.user_verified)
        self.assertFalse(entitlement.stats_verified)
        self.assertEqual(json.loads(game.copies)[0]['steam_appid'], 698780)
        self.assertEqual(json.loads(game.copies)[0]['playtime_hours'], 4.0)
        self.assertFalse(json.loads(game.copies)[0]['steam_playtime_available'])

        projected = json.loads(game.copies)
        projected[0]['playtime_hours'] = 12.5
        service.copy_store.replace_from_payload(self.db, game, projected)
        self.db.commit()
        self.assertEqual(json.loads(game.copies)[0]['playtime_hours'], 12.5)

    def test_manual_link_supports_a_collection_dlc_and_steam_dlc(self):
        game = Videogame(
            user_id=self.user.id, name='Expansion card', status='Finished', is_dlc=True,
            parent_game_name='Base game',
            copies=json.dumps([{'id': 'dlc-copy', 'platform': 'PC', 'format': 'Digital'}]),
        )
        steam = SteamOwnedGame(
            user_id=self.user.id, steam_appid=213210, name="Tiny Tina's Assault on Dragon Keep",
            is_dlc=True, parent_game_name='Borderlands 2', active=True,
        )
        self.db.add_all([game, steam])
        self.db.commit()

        candidates = self.client.get(
            f'/api/discovery/steam/collection-games/{game.id}/copies/dlc-copy/candidates'
        )
        linked = self.client.post(
            f'/api/discovery/steam/collection-games/{game.id}/copies/dlc-copy/link',
            json={'steam_appid': 213210},
        )

        self.assertEqual(candidates.status_code, 200, candidates.text)
        self.assertEqual(candidates.json()['candidates'][0]['steam_appid'], 213210)
        self.assertTrue(candidates.json()['candidates'][0]['is_dlc'])
        self.assertEqual(linked.status_code, 200, linked.text)
        self.assertEqual(json.loads(game.copies)[0]['steam_appid'], 213210)

    def test_automatic_first_steam_copy_displays_steam_time_when_local_time_is_zero(self):
        collection = Videogame(
            user_id=self.user.id, name='Owned Game', status='Not Started',
            playtime_hours=0, playtime_mode='user',
        )
        self.db.add(collection)
        self.db.commit()

        service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 101, 'name': 'Owned Game', 'playtime_hours': 31.6,
            'image_url': None, 'store_url': 'https://store.steampowered.com/app/101/',
        }])
        self.db.commit()

        self.assertEqual(collection.playtime_hours, 0)
        self.assertEqual(collection.playtime_mode, 'copies')
        self.assertEqual(json.loads(collection.copies)[0]['playtime_hours'], 31.6)

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

    def test_collection_duplicate_without_copies_merges_metadata_and_hides_source(self):
        retained = Videogame(user_id=self.user.id, name='Retained', status='Not Started')
        duplicate = Videogame(
            user_id=self.user.id, name='Metadata only duplicate', status='Finished',
            comments='Keep these notes', mark=8,
        )
        self.db.add_all([retained, duplicate])
        self.db.commit()

        response = self.client.post(
            f'/api/discovery/steam/collection-games/{duplicate.id}/merge-duplicate',
            json={
                'other_game_id': retained.id,
                'direction': 'current_into_other',
                'field_sources': {'status': 'current', 'comments': 'current', 'mark': 'current'},
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.db.refresh(retained)
        self.db.refresh(duplicate)
        self.assertEqual(retained.status, 'Finished')
        self.assertEqual(retained.comments, 'Keep these notes')
        self.assertEqual(retained.mark, 8)
        self.assertTrue(duplicate.hidden)
        self.assertEqual(duplicate.merged_into_game_id, retained.id)

    def test_collection_duplicate_collapses_same_steam_app_and_keeps_principal_copy(self):
        principal = Videogame(
            user_id=self.user.id, name='Cuphead', status='Playing',
            copies=json.dumps([{
                'id': 'principal-steam', 'name': 'Principal Cuphead copy',
                'platform': 'PC', 'format': 'Digital', 'source': 'Steam',
                'steam_appid': 268910, 'playtime_hours': 9.3,
            }]),
        )
        duplicate = Videogame(
            user_id=self.user.id, name='Cuphead duplicate', status='Not Started',
            copies=json.dumps([
                {
                    'id': 'duplicate-steam', 'name': 'Redundant Cuphead copy',
                    'platform': 'PC', 'format': 'Digital', 'source': 'Steam',
                    'steam_appid': 268910, 'playtime_hours': 2.0,
                },
                {
                    'id': 'switch-copy', 'name': 'Cuphead Switch',
                    'platform': 'Nintendo Switch', 'format': 'Physical', 'source': 'Retail',
                },
            ]),
        )
        steam = SteamOwnedGame(
            user_id=self.user.id, steam_appid=268910, name='Cuphead', playtime_hours=None,
        )
        self.db.add_all([principal, duplicate, steam])
        self.db.flush()
        principal_link = SteamCollectionLink(
            user_id=self.user.id, collection_game_id=principal.id,
            copy_id='principal-steam', steam_appid=268910,
            name='Principal Cuphead copy', platform='PC', format='Digital', source='Steam',
            playtime_hours=9.3, counts_toward_totals=False,
        )
        duplicate_link = SteamCollectionLink(
            user_id=self.user.id, collection_game_id=duplicate.id,
            copy_id='duplicate-steam', steam_appid=268910,
            name='Redundant Cuphead copy', platform='PC', format='Digital', source='Steam',
            playtime_hours=2.0, counts_toward_totals=True,
        )
        self.db.add_all([principal_link, duplicate_link])
        self.db.commit()

        response = self.client.post(
            f'/api/discovery/steam/collection-games/{duplicate.id}/merge-duplicate',
            json={'other_game_id': principal.id, 'direction': 'current_into_other'},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.db.refresh(principal)
        self.db.refresh(duplicate)
        links = self.db.query(SteamCollectionLink).filter_by(steam_appid=268910).all()
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0].id, principal_link.id)
        self.assertEqual(links[0].collection_game_id, principal.id)
        self.assertEqual(links[0].copy_id, 'principal-steam')
        self.assertEqual(links[0].playtime_hours, 9.3)
        self.assertTrue(links[0].counts_toward_totals)
        copies = json.loads(principal.copies)
        self.assertEqual(sum(copy.get('steam_appid') == 268910 for copy in copies), 1)
        self.assertEqual(next(copy for copy in copies if copy.get('steam_appid'))['id'], 'principal-steam')
        self.assertIn('switch-copy', {copy['id'] for copy in copies})
        self.assertTrue(duplicate.hidden)
        self.assertIsNone(duplicate.copies)

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

    def test_any_linked_steam_copy_can_move_to_a_new_game_entry(self):
        combined = Videogame(user_id=self.user.id, name='Wrong combined card', status='Playing')
        first = SteamOwnedGame(user_id=self.user.id, steam_appid=100, name='Series One')
        second = SteamOwnedGame(user_id=self.user.id, steam_appid=200, name='Series Two')
        self.db.add_all([combined, first, second])
        self.db.flush()
        self.db.add_all([
            SteamCollectionLink(user_id=self.user.id, collection_game_id=combined.id,
                                copy_id='steam:100', steam_appid=100, name='Series One'),
            SteamCollectionLink(user_id=self.user.id, collection_game_id=combined.id,
                                copy_id='steam:200', steam_appid=200, name='Series Two'),
        ])
        self.db.commit()

        response = self.client.post(
            f'/api/discovery/steam/collection-games/{combined.id}/copies/steam:200/extract'
        )

        self.assertEqual(response.status_code, 200, response.text)
        created = response.json()['restored_game']
        self.assertEqual(created['name'], 'Series Two')
        self.assertEqual(json.loads(created['copies'])[0]['steam_appid'], 200)
        self.assertEqual(
            self.db.query(SteamCollectionLink).filter_by(steam_appid=200).one().collection_game_id,
            created['id'],
        )
        self.assertIsNone(first.duplicate_of_appid)
        self.assertIsNone(second.duplicate_of_appid)

    def test_standalone_dlc_and_parent_nested_row_are_bidirectionally_linked(self):
        parent = Videogame(
            user_id=self.user.id, name='Borderlands 2', status='Finished',
            dlcs=json.dumps([{'name': "Tiny Tina's Assault", 'state': 'not_started'}]),
        )
        child = Videogame(
            user_id=self.user.id, name="Tiny Tina's Assault", status='Playing', is_dlc=True,
        )
        self.db.add_all([parent, child])
        self.db.commit()

        linked = self.client.put(f'/api/videogames/{child.id}', json={
            'name': child.name,
            'status': 'Playing',
            'is_dlc': True,
            'parent_game_id': parent.id,
        })

        self.assertEqual(linked.status_code, 200, linked.text)
        self.assertEqual(linked.json()['parent_game_name'], 'Borderlands 2')
        self.db.refresh(parent)
        nested = json.loads(parent.dlcs)
        self.assertEqual(nested[0]['standalone_game_id'], child.id)
        self.assertEqual(nested[0]['state'], 'playing')

        nested[0]['state'] = 'stopped'
        updated_parent = self.client.put(f'/api/videogames/{parent.id}', json={
            'name': parent.name,
            'dlcs': json.dumps(nested),
        })
        self.assertEqual(updated_parent.status_code, 200, updated_parent.text)
        self.db.refresh(child)
        self.assertEqual(child.status, 'Stopped')
        self.assertEqual(child.parent_game_id, parent.id)
        listed_ids = {game['id'] for game in self.client.get('/api/videogames/').json()}
        self.assertIn(child.id, listed_ids)

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

    def test_steam_dlc_catalog_import_preserves_states_and_user_removals(self):
        parent = Videogame(user_id=self.user.id, name='Grandblue Fantasy Relink',
                           dlcs=json.dumps([{'name': 'Existing expansion', 'state': 'finished'}]))
        self.db.add(parent)
        self.db.flush()
        self.db.add(SteamCollectionLink(
            user_id=self.user.id, collection_game_id=parent.id, copy_id='steam:881020',
            steam_id='', steam_appid=881020, name=parent.name, platform='PC', format='Digital',
        ))
        self.db.commit()
        client = MagicMock()
        request = httpx.Request('GET', 'https://store.steampowered.com/api/dlcforapp')
        client.get.return_value = httpx.Response(200, request=request, json={
            'status': 1, 'appid': '881020', 'name': 'Granblue Fantasy: Relink', 'dlc': [
                {'id': 1001, 'name': 'Existing expansion'},
                {'id': 1002, 'name': 'New expansion', 'header_image': 'https://example.com/dlc.jpg'},
            ],
        })
        added, warning = service.import_steam_dlc_catalogs(self.db, client, self.user.id)
        self.assertEqual((added, warning), (1, None))
        dlcs = json.loads(parent.dlcs)
        self.assertEqual([(row['name'], row['state'], row['steam_appid']) for row in dlcs], [
            ('Existing expansion', 'finished', 1001), ('New expansion', 'not_started', 1002),
        ])
        self.assertEqual(dlcs[1]['source'], 'Steam catalog')
        self.assertEqual(client.get.call_count, 1)

        # An explicit deletion must not be undone by a later sync.
        parent.dlcs = json.dumps(dlcs[:1])
        self.db.commit()
        added, warning = service.import_steam_dlc_catalogs(self.db, client, self.user.id)
        self.assertEqual((added, warning), (0, None))
        self.assertEqual(len(json.loads(parent.dlcs)), 1)
        self.assertEqual(client.get.call_count, 1)

        # New Store DLCs are still discovered when the cached catalog expires.
        cache = self.db.get(DiscoveryCache, 'steam-dlcs:881020')
        cache.updated_at = datetime.utcnow() - timedelta(days=31)
        client.get.return_value = httpx.Response(200, request=request, json={
            'status': 1, 'dlc': [
                {'id': 1001, 'name': 'Existing expansion'},
                {'id': 1002, 'name': 'New expansion'},
                {'id': 1003, 'name': 'Later expansion'},
            ],
        })
        added, warning = service.import_steam_dlc_catalogs(self.db, client, self.user.id)
        self.assertEqual((added, warning), (1, None))
        self.assertEqual([row['steam_appid'] for row in json.loads(parent.dlcs)], [1001, 1003])

    def test_steam_dlc_catalog_request_budget_defers_without_changing_game(self):
        parent = Videogame(user_id=self.user.id, name='Base')
        self.db.add(parent)
        self.db.flush()
        self.db.add(SteamCollectionLink(
            user_id=self.user.id, collection_game_id=parent.id, copy_id='steam:123',
            steam_id='', steam_appid=123, name='Base', platform='PC', format='Digital',
        ))
        self.db.commit()
        client = MagicMock()
        added, warning = service.import_steam_dlc_catalogs(self.db, client, self.user.id, max_requests=0)
        self.assertEqual(added, 0)
        self.assertIn('pending for 1 game', warning)
        self.assertIsNone(parent.dlcs)
        client.get.assert_not_called()

    def test_steam_dlc_catalog_caches_games_without_dlc(self):
        client = MagicMock()
        client.get.return_value = httpx.Response(
            200, request=httpx.Request('GET', 'https://store.steampowered.com/api/dlcforapp'),
            json={'status': 2},
        )
        self.assertEqual(service.steam_dlc_catalog(self.db, client, 109400), [])
        self.assertEqual(service.steam_dlc_catalog(self.db, client, 109400), [])
        client.get.assert_called_once()

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

    def test_different_installment_automatically_creates_a_separate_game(self):
        original = Videogame(user_id=self.user.id, name='Portal', status='Finished')
        self.db.add(original)
        self.db.commit()
        owned = [{
            'appid': 620, 'name': 'Portal 2', 'playtime_hours': 5.0,
            'image_url': None, 'store_url': 'https://store.steampowered.com/app/620/',
        }]
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 1)
        self.db.commit()
        new_game = self.db.query(Videogame).filter_by(name='Portal 2').one()
        self.assertEqual(new_game.name, 'Portal 2')
        self.assertEqual(json.loads(new_game.copies)[0]['steam_appid'], 620)
        self.assertEqual(self.db.query(Videogame).count(), 2)
        self.assertEqual(self.db.query(SteamCollectionLink).one().collection_game_id, new_game.id)
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 0)
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)

    def test_incidental_shared_words_create_a_new_game_without_review(self):
        existing = Videogame(user_id=self.user.id, name='Heroes of the Storm', status='Playing')
        self.db.add(existing)
        self.db.commit()

        imported = service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 538680,
            'name': 'The Legend of Heroes: Trails of Cold Steel',
            'playtime_hours': 56.2,
        }])
        self.db.flush()

        created = self.db.query(Videogame).filter_by(
            name='The Legend of Heroes: Trails of Cold Steel',
        ).one()
        self.assertEqual(imported, 1)
        self.assertNotEqual(created.id, existing.id)
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)
        self.assertEqual(
            self.db.query(SteamCollectionLink).filter_by(steam_appid=538680).one().collection_game_id,
            created.id,
        )

    def test_close_typo_still_links_the_existing_game_automatically(self):
        existing = Videogame(
            user_id=self.user.id, name='Doki Doki Literture Club', status='Not Started',
        )
        self.db.add(existing)
        self.db.commit()

        imported = service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 698780, 'name': 'Doki Doki Literature Club!', 'playtime_hours': 4.0,
        }])
        self.db.flush()

        self.db.refresh(existing)
        self.assertEqual(imported, 1)
        self.assertEqual(existing.name, 'Doki Doki Literature Club!')
        self.assertEqual(self.db.query(Videogame).count(), 1)
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)
        self.assertEqual(
            self.db.query(SteamCollectionLink).filter_by(steam_appid=698780).one().collection_game_id,
            existing.id,
        )

    def test_unverified_second_steam_app_with_same_title_requires_review(self):
        existing = Videogame(user_id=self.user.id, name='Lords of the Fallen', status='Finished')
        primary = SteamOwnedGame(
            user_id=self.user.id, steam_appid=265300, name='Lords of the Fallen',
        )
        self.db.add_all([existing, primary])
        self.db.flush()
        self.db.add(SteamCollectionLink(
            user_id=self.user.id, collection_game_id=existing.id,
            copy_id='steam:265300', steam_appid=265300, name=primary.name,
        ))
        self.db.commit()

        imported = service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 1501750, 'name': 'Lords of the Fallen', 'playtime_hours': 0,
        }])
        self.db.flush()

        review = self.db.query(SteamMatchReview).filter_by(steam_appid=1501750).one()
        self.assertEqual(imported, 0)
        self.assertEqual(review.candidate_game_id, existing.id)
        self.assertEqual(
            self.db.query(SteamCollectionLink).filter_by(steam_appid=1501750).count(), 0,
        )

        review.rejected_candidate_ids = json.dumps([existing.id])
        self.db.commit()
        imported = service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 1501750, 'name': 'Lords of the Fallen', 'playtime_hours': 0,
        }])
        self.db.flush()
        separate = self.db.query(SteamCollectionLink).filter_by(steam_appid=1501750).one()
        self.assertEqual(imported, 1)
        self.assertNotEqual(separate.collection_game_id, existing.id)
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)

    def test_second_steam_app_with_same_igdb_identity_groups_automatically(self):
        existing = Videogame(
            user_id=self.user.id, name='Same release', status='Finished', igdb_id=100,
        )
        primary = SteamOwnedGame(
            user_id=self.user.id, steam_appid=10, name='Same release', igdb_id=100,
        )
        self.db.add_all([existing, primary])
        self.db.flush()
        self.db.add(SteamCollectionLink(
            user_id=self.user.id, collection_game_id=existing.id,
            copy_id='steam:10', steam_appid=10, name=primary.name, igdb_id=100,
        ))
        self.db.commit()

        imported = service.reconcile_steam_library(self.db, self.user.id, [{
            'appid': 20, 'name': 'Same release', 'playtime_hours': 2, 'igdb_id': 100,
        }])
        self.db.flush()

        duplicate = self.db.query(SteamCollectionLink).filter_by(steam_appid=20).one()
        self.assertEqual(imported, 1)
        self.assertEqual(duplicate.collection_game_id, existing.id)
        self.assertEqual(
            self.db.query(SteamOwnedGame).filter_by(steam_appid=20).one().duplicate_of_appid,
            10,
        )
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)

    def test_conflicting_igdb_identity_repairs_an_automatic_same_title_group(self):
        combined = Videogame(
            user_id=self.user.id, name='Lords of the Fallen', status='Finished', igdb_id=100,
        )
        first = SteamOwnedGame(
            user_id=self.user.id, steam_appid=265300, name='Lords of the Fallen', igdb_id=100,
        )
        second = SteamOwnedGame(
            user_id=self.user.id, steam_appid=1501750, name='Lords of the Fallen',
            igdb_id=200, duplicate_of_appid=265300,
        )
        self.db.add_all([combined, first, second])
        self.db.flush()
        self.db.add_all([
            SteamCollectionLink(
                user_id=self.user.id, collection_game_id=combined.id,
                copy_id='steam:265300', steam_appid=265300, name=first.name, igdb_id=100,
            ),
            SteamCollectionLink(
                user_id=self.user.id, collection_game_id=combined.id,
                copy_id='steam:1501750', steam_appid=1501750, name=second.name, igdb_id=200,
            ),
        ])
        self.db.commit()

        imported = service.reconcile_steam_library(self.db, self.user.id, [
            {'appid': 265300, 'name': first.name, 'playtime_hours': 1, 'igdb_id': 100},
            {'appid': 1501750, 'name': second.name, 'playtime_hours': 2, 'igdb_id': 200},
        ])
        self.db.flush()

        repaired = self.db.query(SteamCollectionLink).filter_by(steam_appid=1501750).one()
        self.assertEqual(imported, 1)
        self.assertNotEqual(repaired.collection_game_id, combined.id)
        self.assertEqual(self.db.get(Videogame, repaired.collection_game_id).igdb_id, 200)
        self.assertIsNone(second.duplicate_of_appid)
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)

    def test_equivalent_roman_installment_links_only_the_matching_sequel(self):
        base = Videogame(user_id=self.user.id, name='Etrian Odyssey', status='Finished', mark=8)
        sequel = Videogame(user_id=self.user.id, name='Etrian Odyssey 2', status='Playing', playtime_hours=12)
        self.db.add_all([base, sequel])
        self.db.commit()
        owned = [{
            'appid': 999, 'name': 'Etrian Odyssey II', 'playtime_hours': 20.0,
            'image_url': None, 'store_url': 'https://store.steampowered.com/app/999/',
        }]
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 1)
        self.db.commit()
        self.db.refresh(base)
        self.db.refresh(sequel)
        self.assertEqual(base.name, 'Etrian Odyssey')
        self.assertEqual(sequel.name, 'Etrian Odyssey II')
        self.assertEqual(sequel.playtime_hours, 12)
        self.assertEqual(json.loads(sequel.copies)[0]['steam_appid'], 999)
        self.assertEqual(self.db.query(SteamCollectionLink).one().collection_game_id, sequel.id)
        self.assertEqual(self.db.query(SteamMatchReview).count(), 0)

    def test_steam_sync_keeps_cold_steel_installments_on_separate_cards(self):
        first = Videogame(
            user_id=self.user.id,
            name='The Legend of Heroes: Trails of Cold Steel I',
            status='Playing',
        )
        self.db.add(first)
        self.db.commit()
        owned = [
            {'appid': 1001, 'name': 'The Legend of Heroes: Trails of Cold Steel', 'playtime_hours': 10},
            {'appid': 1002, 'name': 'The Legend of Heroes: Trails of Cold Steel II', 'playtime_hours': 20},
            {'appid': 1003, 'name': 'The Legend of Heroes: Trails of Cold Steel III', 'playtime_hours': 30},
        ]

        # The missing "I" is intentionally review-only, so use the durable
        # identity for the first game while ensuring II and III cannot join it.
        self.db.add(WantedGame(
            user_id=self.user.id, name=first.name, steam_appid=1001,
            collection_game_id=first.id, status='Acquired',
        ))
        self.db.commit()
        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 3)
        self.db.commit()

        games = self.db.query(Videogame).filter_by(user_id=self.user.id).all()
        self.assertEqual(len(games), 3)
        linked = {
            game.name: [copy['steam_appid'] for copy in json.loads(game.copies or '[]')]
            for game in games
        }
        self.assertEqual(linked['The Legend of Heroes: Trails of Cold Steel'], [1001])
        self.assertEqual(linked['The Legend of Heroes: Trails of Cold Steel II'], [1002])
        self.assertEqual(linked['The Legend of Heroes: Trails of Cold Steel III'], [1003])

    def test_steam_sync_repairs_existing_automatic_cold_steel_copy_group(self):
        combined = Videogame(
            user_id=self.user.id,
            name='The Legend of Heroes: Trails of Cold Steel I',
            status='Playing',
        )
        catalogs = [
            SteamOwnedGame(user_id=self.user.id, steam_appid=2001, name='The Legend of Heroes: Trails of Cold Steel I'),
            SteamOwnedGame(user_id=self.user.id, steam_appid=2002, name='The Legend of Heroes: Trails of Cold Steel II', duplicate_of_appid=2001),
            SteamOwnedGame(user_id=self.user.id, steam_appid=2003, name='The Legend of Heroes: Trails of Cold Steel III', duplicate_of_appid=2001),
        ]
        self.db.add_all([combined, *catalogs])
        self.db.flush()
        self.db.add_all([
            SteamCollectionLink(
                user_id=self.user.id, collection_game_id=combined.id,
                copy_id=f'steam:{catalog.steam_appid}', steam_appid=catalog.steam_appid,
                name=catalog.name, user_selected=False,
            )
            for catalog in catalogs
        ])
        self.db.commit()
        owned = [
            {'appid': catalog.steam_appid, 'name': catalog.name, 'playtime_hours': index * 10}
            for index, catalog in enumerate(catalogs, 1)
        ]

        self.assertEqual(service.reconcile_steam_library(self.db, self.user.id, owned), 2)
        self.db.commit()

        games = self.db.query(Videogame).filter_by(user_id=self.user.id).all()
        self.assertEqual(len(games), 3)
        self.assertEqual(
            {tuple(copy['steam_appid'] for copy in json.loads(game.copies or '[]')) for game in games},
            {(2001,), (2002,), (2003,)},
        )
        self.assertIsNone(self.db.query(SteamOwnedGame).filter_by(steam_appid=2002).one().duplicate_of_appid)
        self.assertIsNone(self.db.query(SteamOwnedGame).filter_by(steam_appid=2003).one().duplicate_of_appid)

    def test_unsync_removes_imports_but_preserves_local_games_and_non_steam_copies(self):
        settings = DiscoverySettings(
            user_id=self.user.id, steam_id='76561197960434622', steam_api_key='a' * 32,
            sync_enabled=True, sync_hours=6, last_sync_at=datetime.utcnow(),
        )
        local = Videogame(
            user_id=self.user.id, name='Local game', status='Playing', mark=9,
            dlcs=json.dumps([
                {'name': 'Catalog untouched', 'state': 'not_started', 'source': 'Steam catalog', 'steam_appid': 11},
                {'name': 'Catalog played', 'state': 'finished', 'source': 'Steam catalog', 'steam_appid': 12},
                {'name': 'Manual DLC', 'state': 'playing'},
            ]),
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
            DiscoveryCache(key=f'steam-dlcs-import:{self.user.id}:{local.id}:1', payload='[11,12]'),
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
        self.assertEqual(json.loads(local.dlcs), [
            {'name': 'Catalog played', 'state': 'finished'},
            {'name': 'Manual DLC', 'state': 'playing'},
        ])
        self.assertIsNone(self.db.get(DiscoveryCache, f'steam-dlcs-import:{self.user.id}:{local.id}:1'))
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

    def test_manual_collection_sync_accepts_server_wide_api_key(self):
        self.configured()
        with patch.dict('os.environ', {'STEAM_WEB_API_KEY': 's' * 32}), \
             patch.object(service, 'sync_steam') as sync:
            settings = self.client.get('/api/discovery/settings')
            response = self.client.post('/api/discovery/steam/sync')
        self.assertEqual(settings.status_code, 200, settings.text)
        self.assertTrue(settings.json()['steam_api_key_configured'])
        self.assertEqual(response.status_code, 202, response.text)
        sync.assert_called_once_with(self.user.id)

    def test_collection_edit_round_trips_old_copies(self):
        created = self.client.post('/api/videogames/', json={'name': 'Historical copy game'}).json()
        old_copies = json.dumps([{
            'id': 'old-copy-1', 'console': 'Nintendo Switch', 'playtime_hours': 42.5,
        }])
        response = self.client.put(f"/api/videogames/{created['id']}", json={
            'name': created['name'], 'old_copies': old_copies, 'version': created['version'],
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(json.loads(response.json()['old_copies']), json.loads(old_copies))
        reloaded = self.client.get('/api/videogames/').json()
        saved = next(game for game in reloaded if game['id'] == created['id'])
        self.assertEqual(json.loads(saved['old_copies']), json.loads(old_copies))

    def test_collection_edit_moves_owned_copy_to_history_on_reload(self):
        sold = {'id': 'sold', 'platform': 'Nintendo Switch', 'format': 'Physical',
                'name': 'Special edition', 'playtime_hours': 42.5, 'price': 49.99, 'currency': 'EUR'}
        kept = {'id': 'kept', 'platform': 'PC', 'format': 'Digital', 'playtime_hours': 12}
        historical = {'id': 'older', 'console': 'Nintendo DS', 'playtime_hours': 8}
        for remaining in ([], [kept]):
            with self.subTest(remaining=remaining):
                created = self.client.post('/api/videogames/', json={
                    'name': 'Sold copy game', 'copies': json.dumps([sold, *remaining]),
                    'old_copies': json.dumps([historical]), 'playtime_mode': 'copies',
                }).json()
                history = [historical, {**sold, 'console': sold['platform']}]
                response = self.client.put(f"/api/videogames/{created['id']}", json={
                    'name': created['name'], 'version': created['version'],
                    'copies': json.dumps(remaining) if remaining else None,
                    'old_copies': json.dumps(history),
                })
                self.assertEqual(response.status_code, 200, response.text)
                self.db.expire_all()
                saved = next(game for game in self.client.get('/api/videogames/').json() if game['id'] == created['id'])
                self.assertEqual([copy['id'] for copy in json.loads(saved['copies'] or '[]')], [copy['id'] for copy in remaining])
                self.assertEqual(json.loads(saved['old_copies']), history)
                self.assertEqual(saved['playtime_mode'], 'copies')
                self.assertFalse(saved['hidden'])

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
        }]), patch.object(service, 'enrich_steam_with_igdb', return_value=(0, None)), \
             patch.object(service, 'steam_dlc_catalog', return_value=[{
                 'appid': 302, 'name': 'Library Game Expansion', 'image_url': None,
             }]) as catalog:
            service.sync_steam(self.user.id, self.factory)
        self.db.expire_all()
        game = self.db.query(Videogame).one()
        self.assertEqual(game.name, 'Library Game')
        self.assertEqual(json.loads(game.dlcs)[0]['state'], 'not_started')
        self.assertEqual(json.loads(game.dlcs)[0]['steam_appid'], 302)
        catalog.assert_called_once()
        self.assertEqual(self.db.get(DiscoverySettings, settings.user_id).last_owned_import_count, 1)

    def test_copy_options_are_admin_managed_and_shared(self):
        defaults = self.client.get('/api/discovery/copy-options').json()
        self.assertIn('PC', defaults['platforms'])
        saved = self.client.put('/api/discovery/copy-options', json={
            'platforms': ['PC', 'PC', 'Switch'], 'sources': ['Steam', 'Retail'],
            'types': ['Digital', 'Physical'],
            'platform_sources': {'PC': ['Steam'], 'Switch': ['Retail']},
            'source_types': {'Steam': ['Digital'], 'Retail': ['Physical']},
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()['platforms'], ['PC', 'Switch'])
        self.assertEqual(saved.json()['platform_sources']['Switch'], ['Retail'])
        self.user = self.users[1]
        self.assertEqual(self.client.get('/api/discovery/copy-options').json()['platforms'], ['PC', 'Switch'])

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

    def test_add_game_duplicate_check_respects_installment_identity(self):
        first = Videogame(user_id=self.user.id, name='Trails of Cold Steel I', status='Playing')
        second = Videogame(user_id=self.user.id, name='Trails of Cold Steel II', status='Playing')
        self.db.add_all([first, second])
        self.db.commit()

        equivalent = self.client.post('/api/videogames/check-similar', json={
            'name': 'Trails of Cold Steel 2',
        })
        different = self.client.post('/api/videogames/check-similar', json={
            'name': 'Trails of Cold Steel III',
        })

        self.assertEqual([game['id'] for game in equivalent.json()], [second.id])
        self.assertEqual(different.json(), [])

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

    def test_identified_expansion_is_nested_and_kept_as_a_standalone_entry(self):
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
        self.assertFalse(expansion_card.hidden)
        self.assertTrue(expansion_card.is_dlc)
        self.assertEqual(expansion_card.parent_game_id, parent.id)
        nested = json.loads(parent.dlcs)[0]
        self.assertEqual(nested['steam_appid'], 504)
        self.assertEqual(nested['standalone_game_id'], expansion_card.id)
        self.assertEqual(self.db.query(SteamContentLink).filter_by(steam_appid=504).one().parent_game_id, parent.id)
        self.assertEqual(self.db.query(SteamCollectionLink).filter_by(steam_appid=504).count(), 1)

    def test_previously_hidden_nested_expansion_is_restored_during_sync(self):
        parent = Videogame(user_id=self.user.id, name='Base Saga', status='Not Started')
        old_card = Videogame(
            user_id=self.user.id, name='Base Saga Expansion', status='Playing',
            is_dlc=True, parent_game_name='Base Saga', hidden=True,
        )
        steam = SteamOwnedGame(
            user_id=self.user.id, steam_appid=505, name='Base Saga Expansion',
            is_dlc=True, parent_game_name='Base Saga', active=True, playtime_hours=4.5,
        )
        self.db.add_all([parent, old_card, steam])
        self.db.commit()

        self.assertEqual(service.nest_known_steam_dlcs(self.db, self.user.id), 1)
        self.db.flush()

        self.assertFalse(old_card.hidden)
        self.assertEqual(old_card.parent_game_id, parent.id)
        self.assertEqual(json.loads(old_card.copies)[0]['steam_appid'], 505)
        self.assertEqual(json.loads(parent.dlcs)[0]['standalone_game_id'], old_card.id)


if __name__ == '__main__':
    unittest.main()
