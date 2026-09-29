"""Collect pitchers unavailable after three appearances in the prior two days.

The FanGraphs query uses relief-pitcher split 43 and ``G|gt|2`` from two days
before the selected game through one day before it. Rows come from FanGraphs'
public leaderboard JSON endpoint.
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
    from scripts.scrape_high_lev_h2h import find_team_pitcher_cells
    from scripts.scrape_starter_h2h import (
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        normalize_text,
    )
except ModuleNotFoundError:  # Allows: python .\scripts\scrape_unplayable_pitchers.py
    from scrape_high_lev_h2h import find_team_pitcher_cells
    from scrape_starter_h2h import (  # type: ignore[no-redef]
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        normalize_text,
    )


@dataclass(frozen=True)
class UnplayablePitchersRequest:
    selected_date: date
    team_code: str


def unplayable_date_range(selected_date: date) -> tuple[date, date]:
    """Return game day - 2 days through game day - 1 day, inclusive."""

    return selected_date - timedelta(days=2), selected_date - timedelta(days=1)


def build_unplayable_pitchers_url(request: UnplayablePitchersRequest) -> str:
    """Build the split 43 URL filtered to G > 2."""

    start_date, end_date = unplayable_date_range(request.selected_date)
    params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "43"),
        ("autoPt", "false"),
        ("statgroup", "2"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
        ("filter", "G|gt|2"),
    ]
    return f"{FANGRAPHS_SPLITS_URL}?{urlencode(params)}"


def extract_unplayable_pitcher(cells: list[str]) -> dict[str, Any]:
    """Extract Name, Team, and IP from one legacy Advanced row."""

    if len(cells) < 5:
        raise ScrapeError(f"3연투 투수 행의 열이 부족합니다: expected>=5 actual={len(cells)}")

    return {
        "team": canonical_team_code(cells[3]),  # td[4]
        "pitcher": normalize_text(cells[2]),   # td[3]
        "stats": {
            "IP": normalize_text(cells[4]),    # Legacy Advanced: IP
        },
    }


async def scrape_unplayable_pitchers(
    request: UnplayablePitchersRequest,
    *,
    headless: bool = True,
    minimum_delay_seconds: float = 1.0,
    maximum_delay_seconds: float = 3.0,
    navigation_timeout_ms: int = 60_000,
) -> dict[str, Any]:
    if not 1.0 <= minimum_delay_seconds <= maximum_delay_seconds <= 5.0:
        raise ValueError("URL별 랜덤 대기 범위는 1초 이상 5초 이하여야 합니다")

    source_url = build_unplayable_pitchers_url(request)
    player_cells = await find_team_pitcher_cells(
        source_url,
        request.team_code,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
        allow_empty=True,
    )

    pitchers = [extract_unplayable_pitcher(cells) for cells in player_cells]
    start_date, end_date = unplayable_date_range(request.selected_date)
    return {
        "selectedDate": request.selected_date.isoformat(),
        "rangeStart": start_date.isoformat(),
        "rangeEnd": end_date.isoformat(),
        "team": canonical_team_code(request.team_code),
        "filter": "G|gt|2",
        "pitchersCount": len(pitchers),
        "pitchers": pitchers,
        "sourceUrl": source_url,
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
        request = UnplayablePitchersRequest(
            selected_date=date.fromisoformat(args.selected_date),
            team_code=canonical_team_code(args.team),
        )
        result = asyncio.run(scrape_unplayable_pitchers(request, headless=not args.headed))
    except (ValueError, ScrapeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
