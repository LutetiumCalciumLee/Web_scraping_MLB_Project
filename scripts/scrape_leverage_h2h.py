"""Shared collector for Medium/Low Leverage opponent splits."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Literal
from urllib.parse import urlencode

try:
    from scripts.scrape_high_lev_h2h import (
        extract_high_lev_pitcher,
        find_team_pitcher_cells,
        merge_risp_stats,
    )
    from scripts.scrape_starter_h2h import (
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        load_opponent_code,
        season_start_for,
    )
except ModuleNotFoundError:  # Allows direct execution from the scripts directory.
    from scrape_high_lev_h2h import (  # type: ignore[no-redef]
        extract_high_lev_pitcher,
        find_team_pitcher_cells,
        merge_risp_stats,
    )
    from scrape_starter_h2h import (  # type: ignore[no-redef]
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        load_opponent_code,
        season_start_for,
    )


LeverageLevel = Literal["mid", "low"]
LEVERAGE_SPLIT_CODES: dict[LeverageLevel, int] = {
    "mid": 73,
    "low": 74,
}


@dataclass(frozen=True)
class LeverageH2HRequest:
    selected_date: date
    team_code: str
    opponent_team_code: str
    opponent_split_code: int
    leverage_level: LeverageLevel


def leverage_split_code(level: LeverageLevel) -> int:
    try:
        return LEVERAGE_SPLIT_CODES[level]
    except KeyError as exc:
        raise ValueError(f"지원하지 않는 leverage 단계입니다: {level}") from exc


def build_leverage_h2h_url(request: LeverageH2HRequest) -> str:
    """Build split 43 + opponent + Medium/Low Leverage URL."""

    start_date = season_start_for(request.selected_date)
    end_date = request.selected_date - timedelta(days=1)
    if end_date < start_date:
        raise ValueError("selected_date must be later than March 1 of its season")

    params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "43"),
        ("splitArr", str(request.opponent_split_code)),
        ("splitArr", str(leverage_split_code(request.leverage_level))),
        ("autoPt", "false"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    return f"{FANGRAPHS_SPLITS_URL}?{urlencode(params)}"


def build_leverage_h2h_risp_url(request: LeverageH2HRequest) -> str:
    """Build the matching Medium/Low Leverage RISP URL."""

    start_date = season_start_for(request.selected_date)
    end_date = request.selected_date - timedelta(days=1)
    if end_date < start_date:
        raise ValueError("selected_date must be later than March 1 of its season")

    params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "43"),
        ("splitArr", str(request.opponent_split_code)),
        ("splitArr", str(leverage_split_code(request.leverage_level))),
        ("splitArr", "59"),
        ("autoPt", "false"),
        ("statgroup", "2"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    return f"{FANGRAPHS_SPLITS_URL}?{urlencode(params)}"


async def scrape_leverage_h2h(
    request: LeverageH2HRequest,
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

    source_url = build_leverage_h2h_url(request)
    risp_url = build_leverage_h2h_risp_url(request)
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

    pitchers = [extract_high_lev_pitcher(cells) for cells in player_cells]
    merge_risp_stats(pitchers, risp_cells)
    return {
        "selectedDate": request.selected_date.isoformat(),
        "rangeStart": season_start_for(request.selected_date).isoformat(),
        "rangeEnd": (request.selected_date - timedelta(days=1)).isoformat(),
        "leverageLevel": request.leverage_level,
        "leverageSplitCode": leverage_split_code(request.leverage_level),
        "team": canonical_team_code(request.team_code),
        "opponent": canonical_team_code(request.opponent_team_code),
        "opponentSplitCode": request.opponent_split_code,
        "pitchersCount": len(pitchers),
        "pitchers": pitchers,
        "sourceUrls": {
            "base": source_url,
            "risp": risp_url,
        },
    }


def parse_args(
    leverage_level: LeverageLevel,
    argv: list[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=f"Collect all {leverage_level} leverage pitchers for one team/opponent."
    )
    parser.add_argument("--selected-date", required=True, help="경기 선택일 YYYY-MM-DD")
    parser.add_argument("--team", required=True, help="가져올 투수 소속 팀 약어")
    parser.add_argument("--opponent", required=True, help="상대팀 약어")
    parser.add_argument("--opponent-code", type=int, help="FanGraphs 상대팀 split 코드")
    parser.add_argument("--headed", action="store_true", help="브라우저 창 표시")
    return parser.parse_args(argv)


def main_for_level(
    leverage_level: LeverageLevel,
    argv: list[str] | None = None,
) -> int:
    args = parse_args(leverage_level, argv)
    try:
        selected_date = date.fromisoformat(args.selected_date)
        opponent_code = args.opponent_code or load_opponent_code(args.opponent)
        request = LeverageH2HRequest(
            selected_date=selected_date,
            team_code=canonical_team_code(args.team),
            opponent_team_code=canonical_team_code(args.opponent),
            opponent_split_code=opponent_code,
            leverage_level=leverage_level,
        )
        result = asyncio.run(scrape_leverage_h2h(request, headless=not args.headed))
    except (ValueError, ScrapeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0
