"""Collect one starting pitcher's opponent split from FanGraphs.

The legacy leaderboard UI loads its rows from FanGraphs' public JSON endpoint.
This module calls that same endpoint directly so scheduled jobs do not depend on
headless browser rendering.  It does not attempt to bypass Cloudflare, CAPTCHAs,
login requirements, or paid access.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
import sys
import unicodedata
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


FANGRAPHS_SPLITS_URL = (
    "https://www.fangraphs.com/leaders/splits-leaderboards-legacy"
)
FANGRAPHS_SPLITS_API_URL = (
    "https://www.fangraphs.com/api/leaders/splits/splits-leaders"
)
DEFAULT_OPPONENT_CODES_PATH = (
    Path(__file__).resolve().parents[1] / "config" / "fangraphs_opponent_codes.json"
)
TEAM_CODE_ALIASES = {
    "ARI": "AZ",
    "ARZ": "AZ",
    "CHW": "CWS",
    "KCR": "KC",
    "OAK": "ATH",
    "SDP": "SD",
    "SFG": "SF",
    "TBR": "TB",
    "WAS": "WSH",
    "WSN": "WSH",
}


class ScrapeError(RuntimeError):
    """Base exception for a scraper failure."""


class CloudflareChallengeError(ScrapeError):
    """Kept for backward compatibility with callers importing this exception."""


class PitcherNotFoundError(ScrapeError):
    """Raised when the requested pitcher is absent from the rendered table."""


@dataclass(frozen=True)
class StarterH2HRequest:
    selected_date: date
    team_code: str
    opponent_team_code: str
    opponent_split_code: int
    pitcher_name: str


def normalize_text(value: str) -> str:
    """Normalize whitespace and Unicode without removing name diacritics."""

    return " ".join(unicodedata.normalize("NFKC", value).split())


def names_match(actual: str, expected: str) -> bool:
    return normalize_text(actual).casefold() == normalize_text(expected).casefold()


def canonical_team_code(team_code: str) -> str:
    normalized = normalize_text(team_code).upper()
    return TEAM_CODE_ALIASES.get(normalized, normalized)


def season_start_for(selected_date: date) -> date:
    return date(selected_date.year, 3, 1)


def build_starter_h2h_urls(request: StarterH2HRequest) -> tuple[str, str]:
    """Return the base-stat and RISP URLs for the day before a selected game."""

    start_date = season_start_for(request.selected_date)
    end_date = request.selected_date - timedelta(days=1)
    if end_date < start_date:
        raise ValueError("selected_date must be later than March 1 of its season")

    common_params: list[tuple[str, str]] = [
        ("position", "P"),
        ("splitArr", "42"),
        ("splitArr", str(request.opponent_split_code)),
    ]
    date_params = [
        ("autoPt", "false"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    base_url = f"{FANGRAPHS_SPLITS_URL}?{urlencode(common_params + date_params)}"

    risp_params = common_params + [
        ("splitArr", "59"),
        ("autoPt", "false"),
        ("statgroup", "1"),
        ("startDate", start_date.isoformat()),
        ("endDate", end_date.isoformat()),
    ]
    risp_url = f"{FANGRAPHS_SPLITS_URL}?{urlencode(risp_params)}"
    return base_url, risp_url


def calculate_ops(obp: str, slg: str) -> str:
    """Add OBP and SLG and return a three-decimal display value."""

    try:
        value = Decimal(normalize_text(obp)) + Decimal(normalize_text(slg))
    except InvalidOperation as exc:
        raise ScrapeError(f"OBP/SLG 값을 숫자로 변환할 수 없습니다: {obp!r}, {slg!r}") from exc

    formatted = f"{value:.3f}"
    if formatted.startswith("0."):
        return formatted[1:]
    return formatted


def with_statgroup(url: str, statgroup: int) -> str:
    """Return the same FanGraphs query for another legacy statistics group."""

    parsed = urlsplit(url)
    pairs = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key != "statgroup"
    ]
    pairs.append(("statgroup", str(statgroup)))
    return urlunsplit(parsed._replace(query=urlencode(pairs)))


def extract_base_stats_from_cells(
    standard_cells: list[str],
    advanced_cells: list[str],
) -> dict[str, str]:
    """Merge the legacy Standard and Advanced pitching rows."""

    if len(standard_cells) < 20:
        raise ScrapeError(
            "기본 통계 행의 열이 부족합니다: "
            f"expected>=20 actual={len(standard_cells)}"
        )
    if len(advanced_cells) < 14:
        raise ScrapeError(
            "고급 통계 행의 열이 부족합니다: "
            f"expected>=14 actual={len(advanced_cells)}"
        )

    standard = [normalize_text(cell) for cell in standard_cells]
    advanced = [normalize_text(cell) for cell in advanced_cells]
    obp = format_rate(standard[18])
    slg = format_rate(standard[19])
    return {
        "G": standard[4],      # Standard: G
        "IP": advanced[4],     # Advanced: IP
        "ERA": format_decimal(standard[6], 2),    # Standard: ERA
        "BB/9": format_decimal(advanced[7], 2),   # Advanced: BB/9
        "AVG": format_rate(standard[17]),         # Standard: AVG
        "OBP": obp,
        "SLG": slg,
        "OPS": calculate_ops(obp, slg),
    }


def extract_risp_from_cells(cells: list[str]) -> str:
    if len(cells) < 18:
        raise ScrapeError(f"RISP 행의 열이 부족합니다: expected>=18 actual={len(cells)}")
    return format_rate(cells[17])  # Legacy Standard: AVG


def format_decimal(value: str, places: int) -> str:
    """Format one API decimal to the precision shown by the legacy table."""

    try:
        return f"{Decimal(normalize_text(value)):.{places}f}"
    except InvalidOperation as exc:
        raise ScrapeError(f"FanGraphs 값을 숫자로 변환할 수 없습니다: {value!r}") from exc


def format_rate(value: str) -> str:
    """Format a baseball rate with three decimals and no leading zero."""

    formatted = format_decimal(value, 3)
    return formatted[1:] if formatted.startswith("0.") else formatted


def _parse_filter(value: str) -> dict[str, Any]:
    """Convert a legacy ``STAT|comparison|value`` query into the API shape."""

    parts = value.split("|")
    if len(parts) != 3 or not all(parts):
        raise ScrapeError(f"지원하지 않는 FanGraphs 필터 형식입니다: {value!r}")
    stat, comparison, low = parts
    labels = {"gt": "≥", "lt": "≤", "eq": "="}
    return {
        "stat": stat,
        "comp": comparison,
        "low": low,
        "high": -99,
        "label": f"{stat} {labels.get(comparison, comparison)} {low}",
        "value": 0,
    }


def build_fangraphs_api_payload(url: str) -> dict[str, Any]:
    """Translate a legacy leaderboard URL into its public JSON request body."""

    query: dict[str, list[str]] = {}
    for key, value in parse_qsl(urlsplit(url).query, keep_blank_values=True):
        query.setdefault(key, []).append(value)

    def first(key: str, default: str = "") -> str:
        values = query.get(key)
        return values[0] if values else default

    def integers(key: str) -> list[int]:
        return [int(value) for value in query.get(key, []) if value]

    return {
        "strPlayerId": "all",
        "strSplitArr": integers("splitArr"),
        "strGroup": first("groupBy", "season"),
        "strPosition": first("position", "P"),
        "strType": first("statgroup", "1"),
        "strStartDate": first("startDate"),
        "strEndDate": first("endDate"),
        "strSplitTeams": first("splitTeams", "false").casefold() == "true",
        "dctFilters": [_parse_filter(value) for value in query.get("filter", []) if value],
        "strStatType": first("statType", "player"),
        "strAutoPt": first("autoPt", "true"),
        "arrPlayerId": integers("players"),
        "strSplitArrPitch": integers("splitArrPitch"),
        "arrWxTemperature": None,
        "arrWxPressure": None,
        "arrWxAirDensity": None,
        "arrWxElevation": None,
        "arrWxWindSpeed": None,
    }


def _request_fangraphs_rows(url: str, timeout_seconds: float) -> list[list[str]]:
    payload = build_fangraphs_api_payload(url)
    request = Request(
        FANGRAPHS_SPLITS_API_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "MLB-Scraping-Project/1.0",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ScrapeError(
            f"FanGraphs API HTTP {exc.code} 요청 실패: {detail[:500]}"
        ) from exc
    except (URLError, TimeoutError) as exc:
        raise ScrapeError(f"FanGraphs API 네트워크 요청 실패: {exc}") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ScrapeError("FanGraphs API가 유효한 JSON을 반환하지 않았습니다.") from exc

    headers = body.get("k") if isinstance(body, dict) else None
    values = body.get("v") if isinstance(body, dict) else None
    if not isinstance(headers, list) or not isinstance(values, list):
        raise ScrapeError(f"FanGraphs API 응답 형식이 올바르지 않습니다: {body!r}")

    rows: list[list[str]] = []
    for value_row in values:
        if not isinstance(value_row, list) or len(value_row) != len(headers):
            raise ScrapeError("FanGraphs API 행의 열 개수가 헤더와 일치하지 않습니다.")
        rows.append([""] + ["" if value is None else str(value) for value in value_row])
    return rows


async def fetch_fangraphs_table_rows(
    url: str,
    *,
    minimum_delay_seconds: float,
    maximum_delay_seconds: float,
    navigation_timeout_ms: int,
) -> list[list[str]]:
    """Wait 1–3 seconds, then return rows from the public leaderboard API."""

    delay_seconds = random.uniform(minimum_delay_seconds, maximum_delay_seconds)
    await asyncio.sleep(delay_seconds)
    return await asyncio.to_thread(
        _request_fangraphs_rows,
        url,
        navigation_timeout_ms / 1_000,
    )


async def find_pitcher_cells(
    url: str,
    pitcher_name: str,
    *,
    minimum_delay_seconds: float,
    maximum_delay_seconds: float,
    navigation_timeout_ms: int,
) -> list[str]:
    """Fetch one URL and return the requested pitcher's API row."""

    rows = await fetch_fangraphs_table_rows(
        url,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
    )

    for cells in rows:
        if len(cells) < 3:
            continue
        actual_name = cells[2]
        if names_match(actual_name, pitcher_name):
            return cells

    raise PitcherNotFoundError(
        f"FanGraphs 응답에서 투수를 찾지 못했습니다: {pitcher_name}"
    )


async def scrape_starter_h2h(
    request: StarterH2HRequest,
    *,
    headless: bool = True,
    minimum_delay_seconds: float = 1.0,
    maximum_delay_seconds: float = 3.0,
    navigation_timeout_ms: int = 60_000,
) -> dict[str, Any]:
    if not 1.0 <= minimum_delay_seconds <= maximum_delay_seconds <= 5.0:
        raise ValueError("URL별 랜덤 대기 범위는 1초 이상 5초 이하여야 합니다")

    base_url, risp_url = build_starter_h2h_urls(request)
    base_cells = await find_pitcher_cells(
        base_url,
        request.pitcher_name,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
    )
    advanced_cells = await find_pitcher_cells(
        with_statgroup(base_url, 2),
        request.pitcher_name,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
    )
    risp_cells = await find_pitcher_cells(
        risp_url,
        request.pitcher_name,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
    )

    stats = extract_base_stats_from_cells(base_cells, advanced_cells)
    stats["RISP"] = extract_risp_from_cells(risp_cells)
    return {
        "selectedDate": request.selected_date.isoformat(),
        "team": request.team_code,
        "opponent": request.opponent_team_code,
        "opponentSplitCode": request.opponent_split_code,
        "pitcher": request.pitcher_name,
        "stats": stats,
        "sourceUrls": {
            "base": base_url,
            "advanced": with_statgroup(base_url, 2),
            "risp": risp_url,
        },
    }


def load_opponent_code(team_code: str, path: Path = DEFAULT_OPPONENT_CODES_PATH) -> int:
    canonical_code = canonical_team_code(team_code)
    try:
        codes = json.loads(path.read_text(encoding="utf-8"))
        return int(codes[canonical_code])
    except KeyError as exc:
        raise ScrapeError(
            f"상대팀 코드가 등록되지 않았습니다: {canonical_code} "
            f"({path})"
        ) from exc
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise ScrapeError(f"상대팀 코드 파일을 읽을 수 없습니다: {path}") from exc


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selected-date", required=True, help="경기 선택일 YYYY-MM-DD")
    parser.add_argument("--team", required=True, help="투수 소속 팀 약어")
    parser.add_argument("--opponent", required=True, help="상대팀 약어")
    parser.add_argument("--pitcher", required=True, help="FanGraphs 표의 투수명")
    parser.add_argument("--opponent-code", type=int, help="FanGraphs 상대팀 split 코드")
    parser.add_argument(
        "--opponent-codes-file",
        type=Path,
        default=DEFAULT_OPPONENT_CODES_PATH,
        help="팀별 split 코드 JSON 파일",
    )
    parser.add_argument("--headed", action="store_true", help="브라우저 창 표시")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        selected_date = date.fromisoformat(args.selected_date)
        opponent_code = args.opponent_code or load_opponent_code(
            args.opponent, args.opponent_codes_file
        )
        request = StarterH2HRequest(
            selected_date=selected_date,
            team_code=canonical_team_code(args.team),
            opponent_team_code=canonical_team_code(args.opponent),
            opponent_split_code=opponent_code,
            pitcher_name=args.pitcher,
        )
        result = asyncio.run(scrape_starter_h2h(request, headless=not args.headed))
    except (ValueError, ScrapeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
