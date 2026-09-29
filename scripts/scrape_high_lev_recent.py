"""Collect every pitcher for one team in the previous 14 days of High Leverage.

The selected game date is excluded.  The query combines relief-pitcher split
43 and High Leverage split 72. Rows come from FanGraphs' public leaderboard
JSON endpoint.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any
from urllib.parse import urlencode

try:
    from scripts.scrape_high_lev_h2h import (
        find_team_pitcher_cells,
        merge_pitching_stat_groups,
        merge_risp_stats,
    )
    from scripts.scrape_starter_h2h import (
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        with_statgroup,
    )
except ModuleNotFoundError:  # Allows: python .\scripts\scrape_high_lev_recent.py
    from scrape_high_lev_h2h import (  # type: ignore[no-redef]
        find_team_pitcher_cells,
        merge_pitching_stat_groups,
        merge_risp_stats,
    )
    from scrape_starter_h2h import (  # type: ignore[no-redef]
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        with_statgroup,
    )


@dataclass(frozen=True)
class HighLevRecentRequest:
    selected_date: date
    team_code: str


def high_lev_recent_date_range(selected_date: date) -> tuple[date, date]:
    """Return game day - 14 days through game day - 1 day, inclusive."""

    return selected_date - timedelta(days=14), selected_date - timedelta(days=1)


def build_high_lev_recent_url(request: HighLevRecentRequest) -> str:
    """Build the relief + High Leverage URL for the requested 14-day range."""

    start_date, end_date = high_lev_recent_date_range(request.selected_date)
    params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "43"),
        ("splitArr", "72"),
        ("autoPt", "false"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    return f"{FANGRAPHS_SPLITS_URL}?{urlencode(params)}"


def build_high_lev_recent_risp_url(request: HighLevRecentRequest) -> str:
    """Build the High Leverage RISP URL for the same 14-day range."""

    start_date, end_date = high_lev_recent_date_range(request.selected_date)
    params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "43"),
        ("splitArr", "72"),
        ("splitArr", "59"),
        ("autoPt", "false"),
        ("statgroup", "1"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    return f"{FANGRAPHS_SPLITS_URL}?{urlencode(params)}"


async def scrape_high_lev_recent(
    request: HighLevRecentRequest,
    *,
    headless: bool = True,
    minimum_delay_seconds: float = 1.0,
    maximum_delay_seconds: float = 3.0,
    navigation_timeout_ms: int = 60_000,
) -> dict[str, Any]:
    if not 1.0 <= minimum_delay_seconds <= maximum_delay_seconds <= 5.0:
        raise ValueError("URL별 랜덤 대기 범위는 1초 이상 5초 이하여야 합니다")

    source_url = build_high_lev_recent_url(request)
    advanced_url = with_statgroup(source_url, 2)
    risp_url = build_high_lev_recent_risp_url(request)
    player_cells = await find_team_pitcher_cells(
        source_url,
        request.team_code,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
        allow_empty=True,
    )
    advanced_cells = await find_team_pitcher_cells(
        advanced_url,
        request.team_code,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
        allow_empty=True,
    )
    risp_cells = await find_team_pitcher_cells(
        risp_url,
        request.team_code,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
        allow_empty=True,
    )

    pitchers = merge_pitching_stat_groups(player_cells, advanced_cells)
    merge_risp_stats(pitchers, risp_cells)
    start_date, end_date = high_lev_recent_date_range(request.selected_date)
    return {
        "selectedDate": request.selected_date.isoformat(),
        "rangeStart": start_date.isoformat(),
        "rangeEnd": end_date.isoformat(),
        "team": canonical_team_code(request.team_code),
        "pitchersCount": len(pitchers),
        "pitchers": pitchers,
        "sourceUrls": {
            "base": source_url,
            "advanced": advanced_url,
            "risp": risp_url,
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selected-date", required=True, help="경기 선택일 YYYY-MM-DD")
    parser.add_argument("--team", required=True, help="가져올 투수 소속 팀 약어")
    parser.add_argument("--headed", action="store_true", help="브라우저 창 표시")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        request = HighLevRecentRequest(
            selected_date=date.fromisoformat(args.selected_date),
            team_code=canonical_team_code(args.team),
        )
        result = asyncio.run(scrape_high_lev_recent(request, headless=not args.headed))
    except (ValueError, ScrapeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
