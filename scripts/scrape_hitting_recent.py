"""Collect recent team batting leaders for display in the hittingRecent table.

The query covers seven days before the selected game through one day before it
and filters to PA > 19. Ordinary Playwright automation is used; Cloudflare or
other access controls are never bypassed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlencode

try:
    from scripts.scrape_high_lev_h2h import find_team_pitcher_cells
    from scripts.scrape_starter_h2h import (
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        normalize_text,
    )
except ModuleNotFoundError:  # Allows: python .\scripts\scrape_hitting_recent.py
    from scrape_high_lev_h2h import find_team_pitcher_cells
    from scrape_starter_h2h import (  # type: ignore[no-redef]
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        normalize_text,
    )


BATTING_THRESHOLDS: dict[str, Decimal] = {
    "AVG": Decimal("0.300"),
    "OBP": Decimal("0.400"),
    "SLG": Decimal("0.500"),
    "OPS": Decimal("0.900"),
}
RISP_THRESHOLD = Decimal("0.300")


@dataclass(frozen=True)
class HittingRecentRequest:
    selected_date: date
    team_code: str


def hitting_recent_date_range(selected_date: date) -> tuple[date, date]:
    """Return game day - 7 days through game day - 1 day, inclusive."""

    return selected_date - timedelta(days=7), selected_date - timedelta(days=1)


def build_hitting_recent_url(request: HittingRecentRequest) -> str:
    """Build the batter URL filtered to PA > 19."""

    start_date, end_date = hitting_recent_date_range(request.selected_date)
    params: list[tuple[str, str]] = [
        ("position", "B"),
        ("autoPt", "false"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
        ("filter", "PA|gt|19"),
    ]
    return f"{FANGRAPHS_SPLITS_URL}?{urlencode(params)}"


def build_hitting_recent_risp_url(request: HittingRecentRequest) -> str:
    """Build the RISP URL filtered to PA > 6 for the same date range."""

    start_date, end_date = hitting_recent_date_range(request.selected_date)
    params: list[tuple[str, str]] = [
        ("position", "B"),
        ("splitArr", "59"),
        ("autoPt", "false"),
        ("statgroup", "2"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
        ("filter", "PA|gt|6"),
    ]
    return f"{FANGRAPHS_SPLITS_URL}?{urlencode(params)}"


def format_rate(value: str) -> str:
    """Normalize a FanGraphs rate to a leading-zero, three-decimal string."""

    try:
        return f"{Decimal(normalize_text(value)):.3f}"
    except InvalidOperation as exc:
        raise ScrapeError(f"타격 비율을 숫자로 변환할 수 없습니다: {value!r}") from exc


def extract_hitting_player(cells: list[str]) -> dict[str, Any]:
    """Extract Name/Team and td[9:12] batting rate statistics."""

    if len(cells) < 12:
        raise ScrapeError(f"최근 타격 행의 열이 부족합니다: expected>=12 actual={len(cells)}")

    return {
        "team": canonical_team_code(cells[3]),  # td[4]
        "player": normalize_text(cells[2]),     # td[3]
        "stats": {
            "AVG": format_rate(cells[8]),       # td[9]
            "OBP": format_rate(cells[9]),       # td[10]
            "SLG": format_rate(cells[10]),      # td[11]
            "OPS": format_rate(cells[11]),      # td[12]
        },
    }


def extract_hitting_risp_player(cells: list[str]) -> dict[str, Any]:
    """Extract the RISP page's td[9] AVG as the player's RISP value."""

    if len(cells) < 9:
        raise ScrapeError(f"최근 타격 RISP 행의 열이 부족합니다: expected>=9 actual={len(cells)}")

    return {
        "team": canonical_team_code(cells[3]),  # td[4]
        "player": normalize_text(cells[2]),     # td[3]
        "RISP": format_rate(cells[8]),          # td[9]
    }


def qualify_hitting_players(players: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Return display strings for players meeting each inclusive threshold."""

    qualified: dict[str, list[str]] = {
        "AVG": [],
        "OBP": [],
        "SLG": [],
        "OPS": [],
        "RISP": [],
    }
    for player in players:
        player_name = normalize_text(str(player.get("player", "")))
        if not player_name:
            continue
        stats = player.get("stats", {})
        for stat_name, threshold in BATTING_THRESHOLDS.items():
            try:
                value = Decimal(normalize_text(str(stats.get(stat_name, ""))))
            except InvalidOperation:
                continue
            if value >= threshold:
                qualified[stat_name].append(f"{player_name} ({value:.3f})")
    return qualified


def qualify_risp_players(players: list[dict[str, Any]]) -> list[str]:
    """Return RISP display strings for players with AVG/RISP >= 0.300."""

    qualified: list[str] = []
    for player in players:
        player_name = normalize_text(str(player.get("player", "")))
        if not player_name:
            continue
        try:
            value = Decimal(normalize_text(str(player.get("RISP", ""))))
        except InvalidOperation:
            continue
        if value >= RISP_THRESHOLD:
            qualified.append(f"{player_name} ({value:.3f})")
    return qualified


async def scrape_hitting_recent(
    request: HittingRecentRequest,
    *,
    headless: bool = True,
    minimum_delay_seconds: float = 1.0,
    maximum_delay_seconds: float = 5.0,
    navigation_timeout_ms: int = 60_000,
) -> dict[str, Any]:
    if not 1.0 <= minimum_delay_seconds <= maximum_delay_seconds <= 5.0:
        raise ValueError("URL별 랜덤 대기 범위는 1초 이상 5초 이하여야 합니다")

    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise ScrapeError(
            "Playwright가 설치되지 않았습니다. `pip install -r requirements.txt` 후 "
            "`python -m playwright install chromium`을 실행하십시오."
        ) from exc

    source_url = build_hitting_recent_url(request)
    risp_url = build_hitting_recent_risp_url(request)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=headless)
        try:
            page = await browser.new_page()
            player_cells = await find_team_pitcher_cells(
                page,
                source_url,
                request.team_code,
                minimum_delay_seconds=minimum_delay_seconds,
                maximum_delay_seconds=maximum_delay_seconds,
                navigation_timeout_ms=navigation_timeout_ms,
                allow_empty=True,
            )
            risp_cells = await find_team_pitcher_cells(
                page,
                risp_url,
                request.team_code,
                minimum_delay_seconds=minimum_delay_seconds,
                maximum_delay_seconds=maximum_delay_seconds,
                navigation_timeout_ms=navigation_timeout_ms,
                allow_empty=True,
            )
        finally:
            await browser.close()

    players = [extract_hitting_player(cells) for cells in player_cells]
    risp_players = [extract_hitting_risp_player(cells) for cells in risp_cells]
    qualified = qualify_hitting_players(players)
    qualified["RISP"] = qualify_risp_players(risp_players)
    start_date, end_date = hitting_recent_date_range(request.selected_date)
    return {
        "selectedDate": request.selected_date.isoformat(),
        "rangeStart": start_date.isoformat(),
        "rangeEnd": end_date.isoformat(),
        "team": canonical_team_code(request.team_code),
        "filter": "PA|gt|19",
        "playersCount": len(players),
        "players": players,
        "rispPlayersCount": len(risp_players),
        "rispPlayers": risp_players,
        "thresholds": {
            **{key: f"{value:.3f}" for key, value in BATTING_THRESHOLDS.items()},
            "RISP": f"{RISP_THRESHOLD:.3f}",
        },
        "qualified": qualified,
        "sourceUrls": {
            "base": source_url,
            "risp": risp_url,
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selected-date", required=True, help="경기 선택일 YYYY-MM-DD")
    parser.add_argument("--team", required=True, help="가져올 타자 소속 팀 약어")
    parser.add_argument("--headed", action="store_true", help="브라우저 창 표시")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        request = HittingRecentRequest(
            selected_date=date.fromisoformat(args.selected_date),
            team_code=canonical_team_code(args.team),
        )
        result = asyncio.run(scrape_hitting_recent(request, headless=not args.headed))
    except (ValueError, ScrapeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
