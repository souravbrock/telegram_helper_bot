"""SQLite storage (aiosqlite). No external DB needed for MVP / cPanel shared hosting."""
from __future__ import annotations

import time
from pathlib import Path

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS warnings (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    by_user INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id INTEGER PRIMARY KEY,
    welcome_text TEXT NOT NULL DEFAULT 'Welcome {mention} to {title}! Please read the rules.',
    warn_limit INTEGER NOT NULL DEFAULT 3,
    allow_links INTEGER NOT NULL DEFAULT 0,
    captcha_enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users_seen (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);
"""


async def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(db_path) as db:
        await db.executescript(SCHEMA)
        await db.commit()


async def get_warnings(db_path: Path, chat_id: int, user_id: int) -> int:
    async with aiosqlite.connect(db_path) as db:
        async with db.execute(
            "SELECT count FROM warnings WHERE chat_id=? AND user_id=?", (chat_id, user_id)
        ) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 0


async def add_warning(db_path: Path, chat_id: int, user_id: int) -> int:
    now = int(time.time())
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO warnings(chat_id, user_id, count, updated_at)
               VALUES(?,?,1,?)
               ON CONFLICT(chat_id, user_id) DO UPDATE SET count=count+1, updated_at=excluded.updated_at""",
            (chat_id, user_id, now),
        )
        await db.commit()
        async with db.execute(
            "SELECT count FROM warnings WHERE chat_id=? AND user_id=?", (chat_id, user_id)
        ) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 1


async def reset_warnings(db_path: Path, chat_id: int, user_id: int) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute("DELETE FROM warnings WHERE chat_id=? AND user_id=?", (chat_id, user_id))
        await db.commit()


async def log_action(
    db_path: Path, chat_id: int, user_id: int, action: str, reason: str = "", by_user: int = 0
) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "INSERT INTO actions(ts, chat_id, user_id, action, reason, by_user) VALUES(?,?,?,?,?,?)",
            (int(time.time()), chat_id, user_id, action, reason, by_user),
        )
        await db.commit()


async def recent_actions(db_path: Path, limit: int = 50) -> list[dict]:
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT ts, chat_id, user_id, action, reason, by_user FROM actions ORDER BY id DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def action_counts(db_path: Path) -> dict[str, int]:
    async with aiosqlite.connect(db_path) as db:
        async with db.execute("SELECT action, COUNT(*) FROM actions GROUP BY action") as cur:
            rows = await cur.fetchall()
            return {str(a): int(c) for a, c in rows}


async def get_chat_settings(db_path: Path, chat_id: int) -> dict:
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM chat_settings WHERE chat_id=?", (chat_id,)) as cur:
            row = await cur.fetchone()
            if row:
                return dict(row)
    return {
        "chat_id": chat_id,
        "welcome_text": "Welcome {mention} to {title}! Please read the rules.",
        "warn_limit": 3,
        "allow_links": 0,
        "captcha_enabled": 1,
    }


async def upsert_chat_settings(db_path: Path, chat_id: int, **fields) -> None:
    current = await get_chat_settings(db_path, chat_id)
    current.update(fields)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO chat_settings(chat_id, welcome_text, warn_limit, allow_links, captcha_enabled)
               VALUES(?,?,?,?,?)
               ON CONFLICT(chat_id) DO UPDATE SET
                 welcome_text=excluded.welcome_text,
                 warn_limit=excluded.warn_limit,
                 allow_links=excluded.allow_links,
                 captcha_enabled=excluded.captcha_enabled""",
            (
                chat_id,
                current["welcome_text"],
                int(current["warn_limit"]),
                int(current["allow_links"]),
                int(current["captcha_enabled"]),
            ),
        )
        await db.commit()
