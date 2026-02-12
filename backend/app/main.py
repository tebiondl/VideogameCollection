from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from .database import init_db
import logging

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await init_db()
    yield
    # Shutdown


app = FastAPI(title="Video Game Tracker API", lifespan=lifespan)

# CORS - allow all origins for mobile app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    logger.info(f">>> {request.method} {request.url.path}")
    response = await call_next(request)
    logger.info(f"<<< {request.method} {request.url.path} -> {response.status_code}")
    return response


from .routers import users, games, import_data, ai_import_router

app.include_router(users.router)
app.include_router(games.router)
app.include_router(import_data.router)
app.include_router(ai_import_router.router)


@app.get("/")
def read_root():
    return {"message": "Welcome to Video Game Tracker API"}
