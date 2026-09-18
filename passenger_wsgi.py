"""cPanel (Passenger / Setup Python App) entry.

cPanel Python apps are WSGI-based. This wraps the FastAPI ASGI app via a2wsgi
so the same codebase runs on shared hosting without a VPS.

In cPanel > Setup Python App:
  - Python 3.11+
  - Application root: telegram_helper_bot (or your subdomain docroot subfolder)
  - Startup file: passenger_wsgi.py
  - Entry / callable: application
  - pip install -r requirements.txt, copy .env with WEBHOOK_URL=https://<subdomain>/webhook
"""
from a2wsgi import ASGIMiddleware

from app.main import api  # noqa: F401

application = ASGIMiddleware(api)
