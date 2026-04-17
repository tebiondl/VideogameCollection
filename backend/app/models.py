from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, Float
from sqlalchemy.orm import relationship
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
