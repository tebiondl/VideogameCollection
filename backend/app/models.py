from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, Float, DateTime
from sqlalchemy.orm import relationship
from datetime import datetime
from .database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    avatar_url = Column(String, nullable=True) # E.g., URL or base64

    videogames = relationship("Videogame", back_populates="owner")

class Videogame(Base):
    __tablename__ = "videogames"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, index=True, nullable=False)
    description = Column(String, nullable=True)
    image_url = Column(String, nullable=True)
    status = Column(String, nullable=False, default="Not Started") # 'Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'
    time_spent = Column(String, nullable=True)
    mark = Column(Integer, nullable=True) # 1 to 10
    completion_date = Column(String, nullable=True) # string to support just '2024' or '2024-05'
    publication_year = Column(Integer, nullable=True)
    tags = Column(String, nullable=True) # JSON encoded string or comma separated

    owner = relationship("User", back_populates="videogames")

class SmartImportSession(Base):
    __tablename__ = "smart_import_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(String, nullable=False, default="processing") # processing, pending_review, completed, failed
    created_at = Column(DateTime, default=datetime.utcnow)
    
    items = relationship("SmartImportItem", back_populates="session", cascade="all, delete-orphan")

class SmartImportItem(Base):
    __tablename__ = "smart_import_items"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("smart_import_sessions.id"), nullable=False)
    review_status = Column(String, nullable=False, default="pending") # pending, accepted, rejected
    
    # Same fields as Videogame
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    image_url = Column(String, nullable=True)
    status = Column(String, nullable=False, default="Not Started")
    time_spent = Column(String, nullable=True)
    mark = Column(Integer, nullable=True)
    completion_date = Column(String, nullable=True)
    publication_year = Column(Integer, nullable=True)
    tags = Column(String, nullable=True)

    session = relationship("SmartImportSession", back_populates="items")

class Tag(Base):
    __tablename__ = "tags"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True) # Null means global default tag
