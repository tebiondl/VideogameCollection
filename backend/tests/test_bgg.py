"""Run from repository root: python -m unittest discover -s backend/tests -v.

These tests mock BGG responses and never modify the application database.
"""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.routers import boardgames_router as bgg


class BggTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(bgg.router)
        self.app.dependency_overrides[bgg.get_current_user] = lambda: SimpleNamespace(id=1)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        env = patch.dict(os.environ, {"BGG_API_TOKEN": "test-token"})
        env.start()
        self.addCleanup(env.stop)
        dotenv = patch.object(bgg, "load_dotenv")
        dotenv.start()
        self.addCleanup(dotenv.stop)
        transport = patch.object(bgg.httpx, "get")
        self.request = transport.start()
        self.addCleanup(transport.stop)

    def respond(self, xml="<items />", status=200):
        self.request.return_value = httpx.Response(status, content=xml.encode())

    def metadata(self, contents, item_type="boardgame"):
        self.respond(f'<items><item id="13" type="{item_type}">{contents}</item></items>')
        return self.client.get("/api/boardgames/bgg/13")

    def test_requires_login(self):
        self.app.dependency_overrides.clear()
        for url in ("/api/boardgames/bgg/search?q=Catan", "/api/boardgames/bgg/13", "/api/boardgames/bgg/13/expansions"):
            self.assertEqual(self.client.get(url).status_code, 401)
        self.request.assert_not_called()

    def test_short_search_does_not_call_bgg(self):
        for query in ("", " ", "a"):
            response = self.client.get("/api/boardgames/bgg/search", params={"q": query})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), [])
        self.request.assert_not_called()

    def test_search_fields_and_authorization(self):
        self.respond('<items><item id="13" type="boardgame"><name value="Catan"/><yearpublished value="1995"/></item><item id="14" type="boardgameexpansion"><name value="Expansion"/><yearpublished value="unknown"/></item><item id="15"/></items>')
        response = self.client.get("/api/boardgames/bgg/search", params={"q": " Catan "})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0], {"id": 13, "name": "Catan", "year_published": 1995, "item_type": "boardgame"})
        self.assertEqual(len(response.json()), 2)
        self.assertIsNone(response.json()[1]["year_published"])
        call = self.request.call_args
        self.assertEqual(call.args[0], "https://boardgamegeek.com/xmlapi2/search")
        self.assertEqual(call.kwargs["params"], {"query": "Catan", "type": "boardgame,boardgameexpansion"})
        self.assertEqual(call.kwargs["headers"]["Authorization"], "Bearer test-token")

    def test_search_result_limit(self):
        self.respond("<items>" + "".join(f'<item id="{i}"><name value="Game {i}"/></item>' for i in range(30)) + "</items>")
        self.assertEqual(len(self.client.get("/api/boardgames/bgg/search?q=Game").json()), 20)

    def test_metadata_fields_and_stats_request(self):
        response = self.metadata('<name type="primary" value="Catan"/><description>Trade &amp; build.</description><image>https://example.com/cover.png</image><thumbnail>https://example.com/thumb.png</thumbnail><yearpublished value="1995"/><statistics><ratings><ranks><rank name="strategygames" value="25"/><rank name="boardgame" value="627"/></ranks></ratings></statistics>')
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["name"], "Catan")
        self.assertEqual(data["description"], "Trade & build.")
        self.assertEqual(data["image_url"], "https://example.com/cover.png")
        self.assertEqual(data["thumbnail_url"], "https://example.com/thumb.png")
        self.assertEqual(data["rank"], 627)
        self.assertEqual(data["year_published"], 1995)
        self.assertEqual(data["bgg_link"], "https://boardgamegeek.com/boardgame/13")
        self.assertFalse(data["is_expansion"])
        self.assertEqual(self.request.call_args.kwargs["params"], {"id": 13, "stats": 1})

    def test_primary_title_wins_over_earlier_alternate(self):
        response = self.metadata('<name type="alternate" value="Alternate title"/><name type="primary" value="Primary title"/>')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "Primary title")

    def test_expansion_and_optional_metadata(self):
        response = self.metadata('<name type="primary" value="Expansion"/>', "boardgameexpansion")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["is_expansion"])
        for field in ("rank", "image_url", "thumbnail_url", "description", "year_published"):
            self.assertIsNone(response.json()[field])

    def test_unranked_and_unknown_year(self):
        response = self.metadata('<name value="Unranked"/><yearpublished value="unknown"/><statistics><ratings><ranks><rank name="boardgame" value="Not Ranked"/></ranks></ratings></statistics>')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["rank"])
        self.assertIsNone(response.json()["year_published"])

    def test_not_found_and_no_title(self):
        self.respond()
        self.assertEqual(self.client.get("/api/boardgames/bgg/13").status_code, 404)
        self.assertEqual(self.metadata("<description>No name</description>").status_code, 404)

    def test_missing_token(self):
        os.environ["BGG_API_TOKEN"] = " "
        response = self.client.get("/api/boardgames/bgg/13")
        self.assertEqual(response.status_code, 503)
        self.assertIn("application token", response.json()["detail"])
        self.request.assert_not_called()

    def test_upstream_errors(self):
        for status, message in ((202, "preparing"), (401, "rejected"), (403, "403"), (429, "429"), (500, "500")):
            with self.subTest(status=status):
                self.respond(status=status)
                response = self.client.get("/api/boardgames/bgg/13")
                self.assertEqual(response.status_code, 503)
                self.assertIn(message, response.json()["detail"])
                self.assertNotIn("test-token", response.text)

    def test_network_failure(self):
        self.request.side_effect = httpx.ConnectError("Connection failed")
        self.assertEqual(self.client.get("/api/boardgames/bgg/13").status_code, 503)

    def test_malformed_xml(self):
        self.respond("not xml")
        self.assertEqual(self.client.get("/api/boardgames/bgg/13").status_code, 502)

    def test_expansions_only_names_sorted_deduplicated_and_outbound(self):
        self.respond('''<items><item id="13">
            <link type="boardgameexpansion" id="21" value="Zulu"/>
            <link type="boardgameexpansion" id="22" value=" Alpha &amp; Beta " inbound="false"/>
            <link type="boardgameexpansion" id="23" value="alpha &amp; beta"/>
            <link type="boardgameexpansion" id="24" value="Base game" inbound="true"/>
            <link type="boardgameexpansion" id="25" value="Another base" inbound="1"/>
            <link type="boardgameexpansion" id="26" value=" "/>
            <link type="boardgameexpansion" id="27"/>
            <link type="boardgameexpansion" id="13" value="Self"/>
            <link type="boardgameaccessory" id="28" value="Sleeves"/>
        </item></items>''')
        response = self.client.get("/api/boardgames/bgg/13/expansions")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), ["Alpha & Beta", "Zulu"])
        self.assertEqual(self.request.call_args.kwargs["params"], {"id": 13})

    def test_expansions_are_not_limited_to_twenty(self):
        self.respond('<items><item id="13">' + ''.join(f'<link type="boardgameexpansion" id="{i+100}" value="Expansion {i}"/>' for i in range(105)) + '</item></items>')
        response = self.client.get("/api/boardgames/bgg/13/expansions")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 105)

    def test_expansions_empty_and_unknown_game(self):
        self.respond('<items><item id="13"/></items>')
        response = self.client.get("/api/boardgames/bgg/13/expansions")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])
        self.respond()
        self.assertEqual(self.client.get("/api/boardgames/bgg/13/expansions").status_code, 404)

    def test_expansions_upstream_failure(self):
        self.respond(status=401)
        response = self.client.get("/api/boardgames/bgg/13/expansions")
        self.assertEqual(response.status_code, 503)
        self.assertIn("rejected", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
