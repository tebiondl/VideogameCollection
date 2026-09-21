"""Private integration tests against isolated SQLite; never production data."""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import auth
from backend.app.database import Base, get_db
from backend.app.models import User, Videogame
from backend.app.integration_models import IntegrationToken, IntegrationAudit
from backend.app.integration_tokens import issue_token
from backend.app.integration_database import IntegrationSession, get_integration_db
from backend.app.routers import integration_router, backups_router, auth_router, videogames_router


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.factory() as db:
            db.add_all([User(username="owner", hashed_password="unused", is_admin=True), User(username="other", hashed_password="unused")])
            db.commit()
            self.owner_id = db.query(User).filter_by(username="owner").one().id
            self.other_id = db.query(User).filter_by(username="other").one().id
            self.read_row, self.read = issue_token(db, "owner", "shopping", "read")
            self.write_row, self.write = issue_token(db, "owner", "editing", "write")
            db.commit()
        app = FastAPI()
        for router in (integration_router.router, backups_router.router, auth_router.router, videogames_router.router):
            app.include_router(router)

        def isolated_db():
            with self.factory() as db:
                yield db

        app.dependency_overrides[get_db] = isolated_db
        def integration_db():
            with IntegrationSession(bind=self.engine, expire_on_commit=False) as db, db.begin():
                yield db
        app.dependency_overrides[get_integration_db] = integration_db
        self.client = TestClient(app)
        self.environment = patch.dict(os.environ, {"AUTH_SECRET_KEY": "integration-test-key-" * 3})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.client.close)
        self.addCleanup(self.engine.dispose)

    def call(self, method, path, token=None, **kwargs):
        return self.client.request(method, "/api/integration/v1" + path,
                                   headers={"Authorization": "Bearer " + (token or self.write)}, **kwargs)

    def create(self, resource="videogames", **data):
        response = self.call("POST", f"/records/{resource}", json={"data": data})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_auth_expiry_revocation_and_read_only_enforced_by_api(self):
        for secret in ("bad", auth.create_access_token({"sub": "owner"})):
            self.assertEqual(self.call("GET", "/access", secret).status_code, 401)
        self.assertEqual(self.call("GET", "/access", self.read).json()["mode"], "read")
        game = self.create(name="Existing")
        for method, path, body in (
            ("POST", "/records/videogames", {"data": {"name": "Denied"}}),
            ("PATCH", f"/records/videogames/{game['id']}", {"data": {"name": "Denied"}, "expected_revision": game['revision']}),
            ("DELETE", f"/records/videogames/{game['id']}", {"expected_revision": game['revision']}),
            ("POST", f"/videogames/{game['id']}/copies/a/move-to-history", {"expected_revision": game['revision']}),
        ):
            self.assertEqual(self.call(method, path, self.read, json=body).status_code, 403)
        with self.factory() as db:
            db.get(IntegrationToken, self.read_row.id).expires_at = datetime.utcnow() - timedelta(seconds=1)
            db.get(IntegrationToken, self.write_row.id).revoked = True
            db.commit()
        for secret in (self.read, self.write):
            self.assertEqual(self.call("GET", "/access", secret).status_code, 401)

    def test_admin_integration_token_cannot_use_backups_or_normal_api(self):
        for secret in (self.read, self.write):
            headers = {"Authorization": "Bearer " + secret}
            for method, path in (("GET", "/api/backups"), ("POST", "/api/backups"), ("GET", "/api/backups/file"),
                                 ("POST", "/api/backups/file/restore"), ("DELETE", "/api/backups/file"),
                                 ("GET", "/api/videogames/"), ("GET", "/api/auth/me")):
                self.assertEqual(self.client.request(method, path, headers=headers).status_code, 401)
            for resource in ("backups", "users", "settings", "integration_tokens"):
                self.assertEqual(self.call("GET", f"/records/{resource}", secret).status_code, 422)

    def test_account_isolation_even_for_admin_and_writes(self):
        with self.factory() as db:
            row = Videogame(user_id=self.other_id, name="Private other game")
            db.add(row)
            db.commit()
            other_id = row.id
        self.assertEqual(self.call("GET", "/records/videogames").json()["total"], 0)
        for method, data in (("GET", None), ("PATCH", {"data": {"name": "bad"}, "expected_revision": "a" * 64}),
                             ("DELETE", {"expected_revision": "a" * 64})):
            self.assertEqual(self.call(method, f"/records/videogames/{other_id}", json=data).status_code, 404)

    def test_shopping_query_filters_before_pagination_and_ignores_history(self):
        self.create(name="Already on Switch", mark=10, copies=[{"id": "switch", "platform": "Nintendo Switch", "format": "Physical"}])
        old = self.create(name="Sold Switch edition", mark=9, old_copies=[{"id": "old", "console": "Nintendo Switch", "playtime_hours": 12}])
        self.create(name="PC favourite", mark=8, copies=[{"platform": "PC", "format": "Digital"}])
        self.create(name="Hidden", mark=10, hidden=True)
        self.create(name="Low rating", mark=2)
        data = self.call("GET", "/records/videogames", self.read, params={"min_rating": 8, "missing_platform": "nintendo switch", "limit": 1}).json()
        self.assertEqual(data["total"], 2)
        self.assertEqual([row["id"] for row in data["items"]], [old['id']])
        page = self.call("GET", "/records/videogames", self.read, params={"min_rating": 8, "missing_platform": "Nintendo Switch", "offset": 1}).json()
        self.assertEqual(page['items'][0]['name'], "PC favourite")
        digital = self.create(name="Digital Switch", mark=10, copies=[{"platform": "Nintendo Switch", "format": "Digital"}])
        physical = self.call("GET", "/records/videogames", self.read, params={"missing_platform": "Nintendo Switch", "missing_format": "Physical"}).json()
        self.assertIn(digital['id'], [row['id'] for row in physical['items']])

    def test_partial_update_audit_stale_revision_and_validation_rollback(self):
        game = self.create(name="Keep name", comments="Keep comments", mark=8, copies=[{"platform": "PC", "format": "Digital", "playtime_hours": 5}])
        response = self.call("PATCH", f"/records/videogames/{game['id']}", json={"expected_revision": game['revision'], "data": {"mark": 9}})
        self.assertEqual(response.status_code, 200, response.text)
        updated = response.json()
        self.assertEqual(updated['comments'], "Keep comments")
        self.assertEqual(updated['copies'], game['copies'])
        self.assertEqual(updated['version'], game['version'] + 1)
        self.assertEqual(self.call("PATCH", f"/records/videogames/{game['id']}", json={"expected_revision": game['revision'], "data": {"mark": 1}}).status_code, 409)
        for changes in ({"user_id": self.other_id}, {"mark": 30}, {"name": " "}, {"copies": [{"platform": "PC", "playtime_hours": -1}]}):
            self.assertEqual(self.call("PATCH", f"/records/videogames/{game['id']}", json={"expected_revision": updated['revision'], "data": changes}).status_code, 422)
        with self.factory() as db:
            self.assertEqual(db.get(Videogame, game['id']).mark, 9)
            entries = db.query(IntegrationAudit).order_by(IntegrationAudit.id).all()
            self.assertEqual([entry.operation for entry in entries], ['create', 'update'])
            self.assertEqual(json.loads(entries[-1].before_json)['mark'], 8)
            self.assertEqual(json.loads(entries[-1].changes_json), {'mark': 9})

    def test_move_last_copy_preserves_history_details_and_playtime(self):
        game = self.create(name="Sold game", playtime_mode="copies", copies=[{"id": "sold", "platform": "Nintendo Switch", "format": "Physical", "price": 30, "playtime_hours": 42.5}])
        response = self.call("POST", f"/videogames/{game['id']}/copies/sold/move-to-history", json={"expected_revision": game['revision']})
        self.assertEqual(response.status_code, 200, response.text)
        moved = response.json()
        self.assertIsNone(moved['copies'])
        self.assertEqual(moved['old_copies'][0]['console'], 'Nintendo Switch')
        self.assertEqual(moved['old_copies'][0]['playtime_hours'], 42.5)
        self.assertEqual(moved['old_copies'][0]['price'], 30)
        self.assertFalse(moved['hidden'])
        saved = self.call("GET", f"/records/videogames/{game['id']}").json()
        self.assertEqual(saved, moved)

    def test_failure_after_domain_flush_rolls_back_record_and_audit_together(self):
        with patch.object(integration_router, 'get_record', side_effect=RuntimeError('failed to finish request')):
            with self.assertRaisesRegex(RuntimeError, 'failed to finish request'):
                self.call('POST', '/records/videogames', json={'data': {'name': 'Must roll back'}})
        with self.factory() as db:
            self.assertEqual(db.query(Videogame).count(), 0)
            self.assertEqual(db.query(IntegrationAudit).count(), 0)

    def test_other_resource_crud_preserves_unspecified_fields(self):
        for resource, fields in (("wanted_games", {"name": "Want this", "platform": "Nintendo Switch", "target_price": 30}),
                                 ("boardgames", {"name": "Board game", "comments": "Keep"}),
                                 ("boardgame_players", {"name": "Player"})):
            row = self.create(resource, **fields)
            response = self.call("PATCH", f"/records/{resource}/{row['id']}", json={"data": {"name": "Renamed " + resource}, "expected_revision": row['revision']})
            self.assertEqual(response.status_code, 200, response.text)
            updated = response.json()
            for key in fields.keys() - {'name'}:
                self.assertEqual(updated[key], fields[key])
            deleted = self.call("DELETE", f"/records/{resource}/{row['id']}", json={"expected_revision": updated['revision']})
            self.assertEqual(deleted.status_code, 200, deleted.text)
            self.assertEqual(self.call("GET", f"/records/{resource}/{row['id']}").status_code, 404)

    def test_match_player_validation_and_boardgame_delete_preserves_matches(self):
        game = self.create("boardgames", name="Played board game")
        player = self.create("boardgame_players", name="Player")
        match = self.create("boardgame_matches", boardgame_id=game['id'], player_ids=[player['id']], mode="cooperative", result="victory", played_date="2026-09-21")
        changed = self.call("PATCH", f"/records/boardgame_matches/{match['id']}", json={"data": {"comments": "Good game"}, "expected_revision": match['revision']})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()['player_ids'], [player['id']])
        deleted = self.call("DELETE", f"/records/boardgames/{game['id']}", json={"expected_revision": game['revision']})
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()['status'], 'converted_to_external')
        self.assertEqual(self.call("GET", f"/records/boardgame_matches/{match['id']}").status_code, 200)

    def test_login_signing_key_persists_and_old_known_key_is_rejected(self):
        import jwt
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"AUTH_SECRET_KEY": "", "AUTH_SECRET_KEY_FILE": str(Path(directory) / 'key')}):
            key = auth.signing_key()
            self.assertGreaterEqual(len(key), 32)
            self.assertEqual(key, auth.signing_key())
            token = auth.create_access_token({"sub": "owner"})
            self.assertEqual(self.client.get('/api/auth/me', headers={'Authorization': f'Bearer {token}'}).status_code, 200)
            old = jwt.encode({"sub": "owner", "exp": datetime.utcnow() + timedelta(days=1)}, "super-secret-key-for-now-replace-in-production", algorithm="HS256")
            self.assertEqual(self.client.get('/api/auth/me', headers={'Authorization': f'Bearer {old}'}).status_code, 401)


if __name__ == '__main__':
    unittest.main()
