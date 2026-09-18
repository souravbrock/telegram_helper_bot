"""Heuristic spam detection: links, forwards, emojis, flood, blacklists."""
from __future__ import annotations

import re
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from urllib.parse import urlparse

URL_RE = re.compile(r"(https?://\S+|t\.me/\S+|telegram\.me/\S+)", re.IGNORECASE)

# Rough emoji ranges (emoticons, symbols, pictographs, flags)
EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]",
)


@dataclass
class SpamVerdict:
    is_spam: bool
    reasons: list[str]


class AntiSpam:
    def __init__(self, flood_limit: int = 5, flood_window: int = 10):
        self.flood_limit = flood_limit
        self.flood_window = flood_window
        self._buckets: dict[tuple[int, int], deque[float]] = defaultdict(deque)

    def _flood_hit(self, chat_id: int, user_id: int) -> bool:
        now = time.monotonic()
        q = self._buckets[(chat_id, user_id)]
        while q and now - q[0] > self.flood_window:
            q.popleft()
        q.append(now)
        return len(q) > self.flood_limit

    @staticmethod
    def _domains(text: str) -> list[str]:
        domains: list[str] = []
        for m in URL_RE.finditer(text or ""):
            url = m.group(0)
            if not url.startswith("http"):
                url = "https://" + url
            try:
                host = (urlparse(url).hostname or "").lower()
                if host.startswith("www."):
                    host = host[4:]
                if host:
                    domains.append(host)
            except Exception:
                continue
        return domains

    def check(
        self,
        *,
        chat_id: int,
        user_id: int,
        text: str = "",
        has_entities_url: bool = False,
        is_forward: bool = False,
        allow_links: bool = False,
        whitelist_domains: set[str] | None = None,
        blacklist_words: set[str] | None = None,
    ) -> SpamVerdict:
        reasons: list[str] = []
        whitelist_domains = whitelist_domains or set()
        blacklist_words = blacklist_words or set()
        lowered = (text or "").lower()

        for w in blacklist_words:
            if w and w in lowered:
                reasons.append(f"blacklisted word: {w}")

        domains = self._domains(text or "")
        if domains and not allow_links:
            non_white = [d for d in domains if d not in whitelist_domains]
            if non_white:
                reasons.append(f"unauthorized link: {', '.join(non_white[:3])}")
        elif has_entities_url and not allow_links:
            reasons.append("unauthorized link (entity)")

        if is_forward:
            # Forwarded messages from channels are a classic spam vector.
            reasons.append("forwarded message")

        emoji_count = len(EMOJI_RE.findall(text or ""))
        if emoji_count >= 8:
            reasons.append(f"excessive emojis ({emoji_count})")

        if text and len(text) > 1500:
            reasons.append("message too long")

        if self._flood_hit(chat_id, user_id):
            reasons.append("flooding")

        return SpamVerdict(is_spam=bool(reasons), reasons=reasons)
