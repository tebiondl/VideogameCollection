from fastapi import FastAPI
from contextlib import asynccontextmanager
from .database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await init_db()
    yield
    # Shutdown


app = FastAPI(title="Video Game Tracker API", lifespan=lifespan)

from .routers import users, games, import_data

app.include_router(users.router)
app.include_router(games.router)
app.include_router(import_data.router)


@app.get("/")
def read_root():
    return {"message": "Welcome to Video Game Tracker API"}
