"""Run the real startup migration against an old, isolated videogames table."""
import ast
from pathlib import Path
import unittest

from sqlalchemy import create_engine, inspect, text


class StoppedDateMigrationTests(unittest.TestCase):
    def test_upgrade_moves_the_stop_day_of_stopped_games_once(self):
        engine = create_engine('sqlite://')
        self.addCleanup(engine.dispose)
        with engine.begin() as connection:
            connection.execute(text(
                'CREATE TABLE videogames (id INTEGER PRIMARY KEY, name VARCHAR, status VARCHAR, completion_date VARCHAR)'
            ))
            connection.execute(text(
                "INSERT INTO videogames (id, name, status, completion_date) VALUES "
                "(1, 'Stopped', 'Stopped', '2024-08'), (2, 'Stopped undated', 'Stopped', NULL), "
                "(3, 'Stopped junk', 'Stopped', 'soon'), (4, 'Finished', 'Finished', '2023'), "
                "(5, 'Playing', 'Playing', '2019')"
            ))
        # Loading only the function avoids starting the app and its schedulers,
        # or accessing a real collection database as a side effect of import.
        module = ast.parse((Path(__file__).parents[1] / 'app' / 'main.py').read_text(encoding='utf-8'))
        migration = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == '_run_migrations')
        namespace = {'engine': engine, 'inspect': inspect, 'text': text}
        exec(compile(ast.Module(body=[migration], type_ignores=[]), '<startup migrations>', 'exec'), namespace)
        namespace['_run_migrations']()

        query = text('SELECT id, stopped_date, completion_date FROM videogames ORDER BY id')
        with engine.begin() as connection:
            self.assertEqual(connection.execute(query).all(), [
                (1, '2024-08', '2024-08'), (2, None, None), (3, None, 'soon'), (4, None, '2023'), (5, None, '2019'),
            ])
            connection.execute(text("UPDATE videogames SET stopped_date = NULL WHERE id = 1"))
        # Later startups never copy the completion date again.
        namespace['_run_migrations']()
        with engine.connect() as connection:
            self.assertIsNone(connection.execute(text('SELECT stopped_date FROM videogames WHERE id = 1')).scalar_one())


if __name__ == '__main__':
    unittest.main()
