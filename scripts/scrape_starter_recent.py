"""Collect one starting pitcher's statistics over the previous 30 days.

The selected game date is excluded: the range starts 30 days before the game
and ends one day before it.  This module uses ordinary Playwright browser
automation and does not attempt to bypass Cloudflare or other access controls.
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
    from scripts.scrape_starter_h2h import (
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        extract_base_stats_from_cells,
        extract_risp_from_cells,
        find_pitcher_cells,
    )
except ModuleNotFoundError:  # Allows: python .\scripts\scrape_starter_recent.py
    from scrape_starter_h2h import (  # type: ignore[no-redef]
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        extract_base_stats_from_cells,
        extract_risp_from_cells,
        find_pitcher_cells,
    )


@dataclass(frozen=True)
class StarterRecentRequest:
    selected_date: date
    team_code: str
    pitcher_name: str


def recent_date_range(selected_date: date) -> tuple[date, date]:
    """Return game day - 30 days through game day - 1 day, inclusive."""

    return selected_date - timedelta(days=30), selected_date - timedelta(days=1)


def build_starter_recent_urls(request: StarterRecentRequest) -> tuple[str, str]:
    """Return the base-stat and RISP URLs for the previous 30 days."""

    start_date, end_date = recent_date_range(request.selected_date)
    base_params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "42"),
        ("autoPt", "false"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    base_url = f"{FANGRAPHS_SPLITS_URL}?{urlencode(base_params)}"

    risp_params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "42"),
        ("splitArr", "59"),
        ("autoPt", "false"),
        ("statgroup", "2"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    risp_url = f"{FANGRAPHS_SPLITS_URL}?{urlencode(risp_params)}"
    return base_url, risp_url


async def scrape_starter_recent(
    request: StarterRecentRequest,
    *,
    headless: bool = True,
    minimum_delay_seconds: float = 1.0,
    maximum_delay_seconds: float = 5.0,
    navigation_timeout_ms: int = 60_000,
) -> dict[str, Any]:
    """Scrape base and RISP rows after a random 1–5 second wait per URL."""

    if not 1.0 <= minimum_delay_seconds <= maximum_delay_seconds <= 5.0:
        raise ValueError("URL별 랜덤 대기 범위는 1초 이상 5초 이하여야 합니다")

    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise ScrapeError(
            "Playwright가 설치되지 않았습니다. `pip install -r requirements.txt` 후 "
            "`python -m playwright install chromium`을 실행하십시오."
        ) from exc

    base_url, risp_url = build_starter_recent_urls(request)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=headless)
        try:
            page = await browser.new_page()
            base_cells = await find_pitcher_cells(
                page,
                base_url,
                request.pitcher_name,
                minimum_delay_seconds=minimum_delay_seconds,
                maximum_delay_seconds=maximum_delay_seconds,
                navigation_timeout_ms=navigation_timeout_ms,
            )
            risp_cells = await find_pitcher_cells(
                page,
                risp_url,
                request.pitcher_name,
                minimum_delay_seconds=minimum_delay_seconds,
                maximum_delay_seconds=maximum_delay_seconds,
                navigation_timeout_ms=navigation_timeout_ms,
            )
        finally:
            await browser.close()

    stats = extract_base_stats_from_cells(base_cells)
    stats["RISP"] = extract_risp_from_cells(risp_cells)
    start_date, end_date = recent_date_range(request.selected_date)
    return {
        "selectedDate": request.selected_date.isoformat(),
        "rangeStart": start_date.isoformat(),
        "rangeEnd": end_date.isoformat(),
        "team": canonical_team_code(request.team_code),
        "pitcher": request.pitcher_name,
        "stats": stats,
        "sourceUrls": {
            "base": base_url,
            "risp": risp_url,
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selected-date", required=True, help="경기 선택일 YYYY-MM-DD")
    parser.add_argument("--team", required=True, help="투수 소속 팀 약어")
    parser.add_argument("--pitcher", required=True, help="FanGraphs 표의 투수명")
    parser.add_argument("--headed", action="store_true", help="브라우저 창 표시")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        request = StarterRecentRequest(
            selected_date=date.fromisoformat(args.selected_date),
            team_code=canonical_team_code(args.team),
            pitcher_name=args.pitcher,
        )
        result = asyncio.run(scrape_starter_recent(request, headless=not args.headed))
    except (ValueError, ScrapeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
