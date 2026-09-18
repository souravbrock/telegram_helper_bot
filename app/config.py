"""Central configuration loaded from environment / .env."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    BOT_TOKEN: str = Field(default="", description="Bot token from @BotFather")
    BOT_USERNAME: str = ""
    WEBHOOK_URL: str = ""  # full URL e.g. https://bot.reddevils.co.in/webhook
    WEBHOOK_SECRET: str = "change-me"
    WEBHOOK_PATH: str = "/webhook"

    ADMIN_IDS: str = ""  # "id1,id2"
    LOG_CHANNEL_ID: str = ""

    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    DB_PATH: str = "data/bot.db"
    ENV: str = "dev"

    WARN_LIMIT: int = 3
    FLOOD_LIMIT: int = 5
    FLOOD_WINDOW_SEC: int = 10
    CAPTCHA_TIMEOUT_SEC: int = 90
    ALLOW_LINKS: bool = False
    WHITELIST_DOMAINS: str = "t.me,telegram.me"
    BLACKLIST_WORDS: str = ""

    @property
    def admin_ids(self) -> set[int]:
        ids: set[int] = set()
        for part in self.ADMIN_IDS.split(","):
            part = part.strip()
            if part.lstrip("-").isdigit():
                ids.add(int(part))
        return ids

    @property
    def log_channel_id(self) -> int | None:
        v = self.LOG_CHANNEL_ID.strip()
        if v.lstrip("-").isdigit():
            return int(v)
        return None

    @property
    def whitelist_domains(self) -> set[str]:
        return {d.strip().lower() for d in self.WHITELIST_DOMAINS.split(",") if d.strip()}

    @property
    def blacklist_words(self) -> set[str]:
        return {w.strip().lower() for w in self.BLACKLIST_WORDS.split(",") if w.strip()}

    @property
    def db_path(self) -> Path:
        return Path(self.DB_PATH)


@lru_cache
def get_settings() -> Settings:
    return Settings()
