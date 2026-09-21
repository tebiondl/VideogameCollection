"""Credentials and audit records for the restricted collection integration."""
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text

from .database import Base


class IntegrationToken(Base):
    __tablename__ = "integration_tokens"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    token_hash = Column(String, nullable=False, unique=True)
    mode = Column(String, nullable=False)  # read | write
    expires_at = Column(DateTime, nullable=False)
    revoked = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class IntegrationAudit(Base):
    __tablename__ = "integration_audit"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    token_id = Column(Integer, nullable=False)
    operation = Column(String, nullable=False)
    resource = Column(String, nullable=False)
    record_id = Column(Integer, nullable=True)
    before_json = Column(Text, nullable=True)
    changes_json = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
