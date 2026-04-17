from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .database import engine, Base
from .routers import auth_router, videogames_router

# Create db tables
Base.metadata.create_all(bind=engine)

app = FastAPI(title="Videogame Collection API")

# Setup CORS to allow our React app to communicate with the API
origins = [
    "http://localhost:5173", # Vite dev server
    "http://127.0.0.1:5173",
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

@app.get("/")
def read_root():
    return {"message": "Welcome to the Videogame Collection API"}
