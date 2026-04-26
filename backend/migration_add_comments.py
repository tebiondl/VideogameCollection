import sqlite3
import os

db_path = os.path.join(os.path.dirname(__file__), 'videogames.db')

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

try:
    cursor.execute("ALTER TABLE videogames ADD COLUMN comments VARCHAR;")
    print("Added comments to videogames")
except sqlite3.OperationalError as e:
    print(f"Error (videogames): {e}")

try:
    cursor.execute("ALTER TABLE smart_import_items ADD COLUMN comments VARCHAR;")
    print("Added comments to smart_import_items")
except sqlite3.OperationalError as e:
    print(f"Error (smart_import_items): {e}")

conn.commit()
conn.close()
