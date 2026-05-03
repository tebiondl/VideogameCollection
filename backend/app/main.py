from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from .database import engine, Base
from .routers import auth_router, videogames_router, smart_import_router, filters_router, igdb_router

# Create db tables (new tables only)
Base.metadata.create_all(bind=engine)

# Safe migration: add new columns to existing tables without data loss
def _run_migrations():
    migrations = [
        "ALTER TABLE videogames ADD COLUMN dlcs TEXT",
        "ALTER TABLE smart_import_items ADD COLUMN dlcs TEXT",
        "ALTER TABLE videogames ADD COLUMN playtime_hours FLOAT",
        "ALTER TABLE smart_import_items ADD COLUMN playtime_hours FLOAT",
        "ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0",
    ]
    with engine.connect() as conn:
        for stmt in migrations:
            try:
                conn.execute(text(stmt))
                conn.commit()
            except Exception:
                pass  # Column already exists — silently skip

_run_migrations()

app = FastAPI(title="Videogame Collection API")

# Setup CORS to allow our React app to communicate with the API
origins = [
    "http://localhost:5173", # Vite dev server
    "http://127.0.0.1:5173",
    "http://localhost:5174", # Fallback ports
    "http://127.0.0.1:5174",
    "http://localhost:5175",
    "http://127.0.0.1:5175",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(videogames_router.router)
app.include_router(smart_import_router.router)
app.include_router(filters_router.router)
app.include_router(igdb_router.router)

@app.get("/")
def read_root():
    return {"message": "Welcome to the Videogame Collection API"}
