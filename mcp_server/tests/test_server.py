import json
import tempfile
import unittest
import sys
import os
from pathlib import Path

import httpx
from mcp.shared.memory import create_connected_server_and_client_session
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from mcp_server.server import CollectionAPI, build_server


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


if __name__ == '__main__':
    unittest.main()
