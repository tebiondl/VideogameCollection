"""Keep reused domain handlers and their audit entry in one transaction."""
from sqlalchemy.orm import Session

from .database import engine


class IntegrationSession(Session):
    def commit(self):
        # Existing app handlers commit their work. Here the request owns the
        # transaction, so those commits flush until the handler AND audit finish.
        self.flush()


def get_integration_db():
    with IntegrationSession(bind=engine, expire_on_commit=False) as db:
        with db.begin():
            yield db
