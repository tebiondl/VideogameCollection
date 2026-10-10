"""Run the real startup migration against an old, isolated copy table."""
import ast
from pathlib import Path
import unittest

from sqlalchemy import create_engine, inspect, text


class CopyRegionMigrationTests(unittest.TestCase):
    def test_upgrade_preserves_existing_copies_and_is_repeatable(self):
        engine = create_engine('sqlite://')
        self.addCleanup(engine.dispose)
        with engine.begin() as connection:
            connection.execute(text('CREATE TABLE owned_copies (id INTEGER PRIMARY KEY, name VARCHAR, steam_appid INTEGER, copy_id VARCHAR)'))
            connection.execute(text("INSERT INTO owned_copies (id, name, copy_id) VALUES (1, 'Existing physical copy', 'physical')"))
        # Loading only the function avoids starting the app and its schedulers,
        # or accessing a real collection database as a side effect of import.
        module = ast.parse((Path(__file__).parents[1] / 'app' / 'main.py').read_text(encoding='utf-8'))
        migration = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == '_run_migrations')
        namespace = {'engine': engine, 'inspect': inspect, 'text': text}
        exec(compile(ast.Module(body=[migration], type_ignores=[]), '<startup migrations>', 'exec'), namespace)
        namespace['_run_migrations']()
        self.assertIn('region', {column['name'] for column in inspect(engine).get_columns('owned_copies')})
        with engine.begin() as connection:
            self.assertEqual(connection.execute(text('SELECT name, region FROM owned_copies WHERE id = 1')).one(), ('Existing physical copy', None))
            connection.execute(text("UPDATE owned_copies SET region = 'Spain' WHERE id = 1"))
        namespace['_run_migrations']()
        with engine.connect() as connection:
            self.assertEqual(connection.execute(text('SELECT region FROM owned_copies WHERE id = 1')).scalar_one(), 'Spain')
