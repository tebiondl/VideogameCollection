# Video Game Tracker

A full-stack application to track your video game backlog and finished games.

## Structure
- **backend/**: FastAPI application with PostgreSQL (or SQLite for dev).
- **mobile-app/**: React Native (Expo) application.

## Prerequisites
- Node.js & npm
- Python 3.11+
- Docker (Optional, for production database)

## How to Run

### Backend
1. Navigate to `backend/`.
2. Create virtual env: `python -m venv venv`.
3. Activate: `venv\Scripts\activate` (Windows) or `source venv/bin/activate` (Linux/Mac).
4. Install: `pip install -r requirements.txt`.
5. Run: `uvicorn app.main:app --reload`.
   - API will be at `http://localhost:8000`.
   - Docs at `http://localhost:8000/docs`.

### Mobile App
1. Navigate to `mobile-app/`.
2. Install: `npm install`.
3. Run: `npx expo start`.
4. Press `a` to run on Android Emulator (ensure emulator is running).

## Features
- Login/Auth.
- Manage "Games to Play" (Backlog) with "Hype Score".
- Manage "Finished Games" with "Rating" and "Progress".
- Dark/Light mode.
- English/Spanish support.

## Notes
- By default, backend uses `sqlite` if `DATABASE_URL` is not set.
- For Android Emulator, the API URL is set to `http://10.0.2.2:8000`.
- To create a user, use the `/docs` or a curl command to `POST /users/`.
