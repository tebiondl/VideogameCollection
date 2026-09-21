import json
import tempfile
import unittest
import sys
import os
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.exceptions import InvalidTokenError
from mcp.shared.memory import create_connected_server_and_client_session
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from mcp_server.server import CloudflareAccessMiddleware, CloudflareAccessVerifier, CollectionAPI, build_server


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.secret = Path(self.temp.name) / 'token'
        self.secret.write_text('vgc_test_secret')
        self.requests = []
        self.response_status = 200

        async def handle(request):
            self.requests.append(request)
            return httpx.Response(self.response_status, json={'items': [], 'total': 0, 'detail': 'test error'})

        self.api = CollectionAPI('http://collection', str(self.secret), transport=httpx.MockTransport(handle))

    async def test_read_connection_protocol_discovery_and_query(self):
        server = build_server(self.api, 'read')
        async with create_connected_server_and_client_session(server) as session:
            tools = (await session.list_tools()).tools
            self.assertEqual(len(tools), 6)
            self.assertTrue(all(tool.annotations.readOnlyHint for tool in tools))
            result = await session.call_tool('list_videogames', {'min_rating': 8, 'missing_platform': 'Nintendo Switch', 'missing_format': 'Physical'})
            self.assertFalse(result.isError)
            self.assertEqual(result.structuredContent['total'], 0)
            self.assertEqual(self.requests[-1].url.path, '/api/integration/v1/records/videogames')
            self.assertEqual(self.requests[-1].url.params['missing_platform'], 'Nintendo Switch')
            self.assertEqual(self.requests[-1].headers['Authorization'], 'Bearer vgc_test_secret')
            denied = await session.call_tool('delete_record', {'resource': 'videogames', 'record_id': 1, 'expected_revision': 'a' * 64})
            self.assertTrue(denied.isError)
            self.assertEqual(len(self.requests), 1)

    async def test_write_tools_use_bounded_paths_revision_and_body(self):
        async with create_connected_server_and_client_session(build_server(self.api, 'write')) as session:
            tools = (await session.list_tools()).tools
            writes = [tool for tool in tools if not tool.annotations.readOnlyHint]
            self.assertEqual(len(writes), 4)
            self.assertTrue(all(tool.annotations.destructiveHint for tool in writes))
            result = await session.call_tool('update_record', {'resource': 'videogames', 'record_id': 5, 'expected_revision': 'a' * 64, 'data': {'mark': 9}})
            self.assertFalse(result.isError)
            request = self.requests[-1]
            self.assertEqual(request.method, 'PATCH')
            self.assertEqual(request.url.path, '/api/integration/v1/records/videogames/5')
            self.assertEqual(json.loads(request.content)['expected_revision'], 'a' * 64)
            for resource in ('backups', '../../backups', 'settings'):
                invalid = await session.call_tool('get_record', {'resource': resource, 'record_id': 1})
                self.assertTrue(invalid.isError)
            self.assertEqual(len(self.requests), 1)

    async def test_api_failure_is_reported_without_secret_and_rotation_is_live(self):
        self.response_status = 403
        async with create_connected_server_and_client_session(build_server(self.api)) as session:
            result = await session.call_tool('collection_access', {})
            self.assertTrue(result.isError)
            self.assertNotIn('vgc_test_secret', str(result))
            self.secret.write_text('vgc_replacement')
            self.response_status = 200
            result = await session.call_tool('collection_access', {})
            self.assertFalse(result.isError)
            self.assertEqual(self.requests[-1].headers['Authorization'], 'Bearer vgc_replacement')

    async def test_actual_stdio_process_initializes_and_lists_tools(self):
        server_path = Path(__file__).resolve().parents[1] / 'server.py'
        parameters = StdioServerParameters(command=sys.executable, args=[str(server_path)],
            env={**os.environ, 'COLLECTION_TOKEN_FILE': str(self.secret), 'MCP_MODE': 'read'})
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as session:
                initialized = await session.initialize()
                self.assertEqual(initialized.serverInfo.name, 'VideogameCollection (read)')
                self.assertEqual(len((await session.list_tools()).tools), 6)


class CloudflareAccessTests(unittest.IsolatedAsyncioTestCase):
    async def test_middleware_requires_a_valid_access_assertion(self):
        class Verifier:
            def verify(self, assertion):
                if assertion != 'valid':
                    raise InvalidTokenError('invalid')
                return {'sub': 'user'}

        async def origin(scope, receive, send):
            await send({'type': 'http.response.start', 'status': 204, 'headers': []})
            await send({'type': 'http.response.body', 'body': b''})

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=CloudflareAccessMiddleware(origin, Verifier())),
                                     base_url='http://origin') as client:
            self.assertEqual((await client.get('/healthz')).status_code, 200)
            self.assertEqual((await client.post('/mcp')).status_code, 401)
            self.assertEqual((await client.post('/mcp', headers={'Cf-Access-Jwt-Assertion': 'invalid'})).status_code, 401)
            self.assertEqual((await client.post('/mcp', headers={'Cf-Access-Jwt-Assertion': 'valid'})).status_code, 204)

    async def test_verifier_checks_signature_issuer_audience_and_expiry(self):
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        verifier = CloudflareAccessVerifier('my-team.cloudflareaccess.com', 'expected-aud')
        verifier.keys = SimpleNamespace(get_signing_key_from_jwt=lambda _: SimpleNamespace(key=private_key.public_key()))
        now = int(time.time())

        def token(**overrides):
            payload = {'sub': 'user-id', 'iss': verifier.issuer, 'aud': ['expected-aud'], 'iat': now, 'exp': now + 60}
            payload.update(overrides)
            return jwt.encode(payload, private_key, algorithm='RS256', headers={'kid': 'test'})

        self.assertEqual(verifier.verify(token())['sub'], 'user-id')
        with self.assertRaises(InvalidTokenError):
            verifier.verify(token(aud=['another-app']))
        with self.assertRaises(InvalidTokenError):
            verifier.verify(token(exp=now - 1))
        with self.assertRaises(ValueError):
            CloudflareAccessVerifier('my-team.cloudflareaccess.com', 'change-me')

    async def test_streamable_http_initializes_behind_access_middleware(self):
        class Verifier:
            def verify(self, assertion):
                if assertion != 'valid':
                    raise InvalidTokenError('invalid')
                return {'sub': 'user'}

        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / 'token'
            secret.write_text('vgc_test_secret')
            server = build_server(CollectionAPI('http://collection', str(secret)), 'read', public_hostname='origin')
            origin = server.streamable_http_app()
            app = CloudflareAccessMiddleware(origin, Verifier())
            async with origin.router.lifespan_context(origin):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://origin',
                                             headers={'Cf-Access-Jwt-Assertion': 'valid'}) as client:
                    async with streamable_http_client('http://origin/mcp', http_client=client) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            initialized = await session.initialize()
                            self.assertEqual(initialized.serverInfo.name, 'VideogameCollection (read)')
                            self.assertEqual(len((await session.list_tools()).tools), 6)


if __name__ == '__main__':
    unittest.main()
