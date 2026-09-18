"""Public API for the Mini App dashboard: logs, stats, settings."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.config import Settings
from app.database import (
    action_counts,
    get_chat_settings,
    recent_actions,
    upsert_chat_settings,
)

MINIAPP_DIR = Path(__file__).parent / "miniapp"


def create_api(settings: Settings) -> FastAPI:
    app = FastAPI(title="Group Assistant API", version="0.1.0")

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "env": settings.ENV}

    @app.get("/api/logs")
    async def logs(limit: int = Query(default=50, le=200)) -> dict:
        # TODO: protect with WebApp initData validation + admin check before production.
        items = await recent_actions(settings.db_path, limit)
        return {"items": items}

    @app.get("/api/stats")
    async def stats() -> dict:
        counts = await action_counts(settings.db_path)
        return {"counts": counts, "total": sum(counts.values())}

    @app.get("/api/settings/{chat_id}")
    async def get_settings(chat_id: int) -> dict:
        return await get_chat_settings(settings.db_path, chat_id)

    class SettingsIn(BaseModel):
        welcome_text: str | None = None
        warn_limit: int | None = None
        allow_links: bool | None = None
        captcha_enabled: bool | None = None

    @app.post("/api/settings/{chat_id}")
    async def save_settings(chat_id: int, body: SettingsIn) -> dict:
        # TODO: require admin auth (WebApp initData) before exposing publicly.
        patch: dict = {}
        if body.welcome_text is not None:
            patch["welcome_text"] = body.welcome_text[:1000]
        if body.warn_limit is not None:
            patch["warn_limit"] = max(1, min(10, body.warn_limit))
        if body.allow_links is not None:
            patch["allow_links"] = int(body.allow_links)
        if body.captcha_enabled is not None:
            patch["captcha_enabled"] = int(body.captcha_enabled)
        if patch:
            await upsert_chat_settings(settings.db_path, chat_id, **patch)
        return await get_chat_settings(settings.db_path, chat_id)

    if MINIAPP_DIR.exists():
        app.mount("/miniapp", StaticFiles(directory=str(MINIAPP_DIR), html=True), name="miniapp")

        @app.get("/")
        async def root():
            index = MINIAPP_DIR / "index.html"
            if index.exists():
                return FileResponse(str(index))
            return {"ok": True, "miniapp": "/miniapp"}

    return app
