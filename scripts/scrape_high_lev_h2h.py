"""Collect every pitcher for one team in a High Leverage opponent split.

The selected game date is excluded.  The query covers March 1 through the day
before the game and combines relief-pitcher split 43, High Leverage split 72,
and the opposing team's split code. Rows come from FanGraphs' public
leaderboard JSON endpoint.
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
        load_opponent_code,
        normalize_text,
        fetch_fangraphs_table_rows,
        season_start_for,
        with_statgroup,
    )
except ModuleNotFoundError:  # Allows: python .\scripts\scrape_high_lev_h2h.py
    from scrape_starter_h2h import (  # type: ignore[no-redef]
        FANGRAPHS_SPLITS_URL,
        ScrapeError,
        canonical_team_code,
        extract_base_stats_from_cells,
        extract_risp_from_cells,
        load_opponent_code,
        normalize_text,
        fetch_fangraphs_table_rows,
        season_start_for,
        with_statgroup,
    )


class TeamPitchersNotFoundError(ScrapeError):
    """Raised when no rendered rows belong to the requested team."""


@dataclass(frozen=True)
class HighLevH2HRequest:
    selected_date: date
    team_code: str
    opponent_team_code: str
    opponent_split_code: int


def build_high_lev_h2h_url(request: HighLevH2HRequest) -> str:
    """Build the relief + High Leverage + opponent URL."""

    start_date = season_start_for(request.selected_date)
    end_date = request.selected_date - timedelta(days=1)
    if end_date < start_date:
        raise ValueError("selected_date must be later than March 1 of its season")

    params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "43"),
        ("splitArr", "72"),
        ("splitArr", str(request.opponent_split_code)),
        ("autoPt", "false"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    return f"{FANGRAPHS_SPLITS_URL}?{urlencode(params)}"


def build_high_lev_h2h_risp_url(request: HighLevH2HRequest) -> str:
    """Build the matching High Leverage RISP URL."""

    start_date = season_start_for(request.selected_date)
    end_date = request.selected_date - timedelta(days=1)
    if end_date < start_date:
        raise ValueError("selected_date must be later than March 1 of its season")

    params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "43"),
        ("splitArr", "72"),
        ("splitArr", str(request.opponent_split_code)),
        ("splitArr", "59"),
        ("autoPt", "false"),
        ("statgroup", "1"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    return f"{FANGRAPHS_SPLITS_URL}?{urlencode(params)}"


def team_codes_match(actual: str, expected: str) -> bool:
    """Compare project/FanGraphs team abbreviations through known aliases."""

    return canonical_team_code(actual) == canonical_team_code(expected)


def extract_high_lev_pitcher(
    standard_cells: list[str],
    advanced_cells: list[str],
) -> dict[str, Any]:
    """Map one rendered row to the team, pitcher, and table statistics."""

    if len(standard_cells) < 20:
        raise ScrapeError(
            "High Leverage 행의 열이 부족합니다: "
            f"expected>=20 actual={len(standard_cells)}"
        )

    return {
        "team": canonical_team_code(standard_cells[3]),
        "pitcher": normalize_text(standard_cells[2]),
        "stats": extract_base_stats_from_cells(standard_cells, advanced_cells),
    }


def merge_pitching_stat_groups(
    standard_rows: list[list[str]],
    advanced_rows: list[list[str]],
) -> list[dict[str, Any]]:
    """Merge legacy Standard and Advanced rows by normalized pitcher name."""

    advanced_by_pitcher = {
        normalize_text(cells[2]).casefold(): cells
        for cells in advanced_rows
        if len(cells) >= 3
    }
    pitchers: list[dict[str, Any]] = []
    for standard_cells in standard_rows:
        name = normalize_text(standard_cells[2])
        advanced_cells = advanced_by_pitcher.get(name.casefold())
        if advanced_cells is None:
            raise ScrapeError(f"고급 통계 행에서 투수를 찾지 못했습니다: {name}")
        pitchers.append(extract_high_lev_pitcher(standard_cells, advanced_cells))
    return pitchers


def merge_risp_stats(
    pitchers: list[dict[str, Any]],
    risp_rows: list[list[str]],
) -> list[dict[str, Any]]:
    """Merge the legacy Standard page's AVG into base rows by pitcher name."""

    risp_by_pitcher = {
        normalize_text(cells[2]).casefold(): extract_risp_from_cells(cells)
        for cells in risp_rows
        if len(cells) >= 18
    }
    for pitcher in pitchers:
        name_key = normalize_text(str(pitcher["pitcher"])).casefold()
        pitcher["stats"]["RISP"] = risp_by_pitcher.get(name_key, "")
    return pitchers


async def find_team_pitcher_cells(
    url: str,
    team_code: str,
    *,
    minimum_delay_seconds: float,
    maximum_delay_seconds: float,
    navigation_timeout_ms: int,
    allow_empty: bool = False,
) -> list[list[str]]:
    """Return every API row whose fourth cell matches the requested team."""

    rows = await fetch_fangraphs_table_rows(
        url,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
    )

    matches: list[list[str]] = []
    for cells in rows:
        if len(cells) >= 4 and team_codes_match(cells[3], team_code):
            matches.append(cells)

    if not matches and not allow_empty:
        raise TeamPitchersNotFoundError(
            f"FanGraphs 응답에서 {canonical_team_code(team_code)} 소속 투수를 찾지 못했습니다."
        )
    return matches


async def scrape_high_lev_h2h(
    request: HighLevH2HRequest,
    *,
    headless: bool = True,
    minimum_delay_seconds: float = 1.0,
    maximum_delay_seconds: float = 5.0,
    navigation_timeout_ms: int = 60_000,
) -> dict[str, Any]:
    if not 1.0 <= minimum_delay_seconds <= maximum_delay_seconds <= 5.0:
        raise ValueError("URL별 랜덤 대기 범위는 1초 이상 5초 이하여야 합니다")

    source_url = build_high_lev_h2h_url(request)
    advanced_url = with_statgroup(source_url, 2)
    risp_url = build_high_lev_h2h_risp_url(request)
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
    return {
        "selectedDate": request.selected_date.isoformat(),
        "rangeStart": season_start_for(request.selected_date).isoformat(),
        "rangeEnd": (request.selected_date - timedelta(days=1)).isoformat(),
        "team": canonical_team_code(request.team_code),
        "opponent": canonical_team_code(request.opponent_team_code),
        "opponentSplitCode": request.opponent_split_code,
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
    parser.add_argument("--opponent", required=True, help="상대팀 약어")
    parser.add_argument("--opponent-code", type=int, help="FanGraphs 상대팀 split 코드")
    parser.add_argument("--headed", action="store_true", help="브라우저 창 표시")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        selected_date = date.fromisoformat(args.selected_date)
        opponent_code = args.opponent_code or load_opponent_code(args.opponent)
        request = HighLevH2HRequest(
            selected_date=selected_date,
            team_code=canonical_team_code(args.team),
            opponent_team_code=canonical_team_code(args.opponent),
            opponent_split_code=opponent_code,
        )
        result = asyncio.run(scrape_high_lev_h2h(request, headless=not args.headed))
    except (ValueError, ScrapeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
