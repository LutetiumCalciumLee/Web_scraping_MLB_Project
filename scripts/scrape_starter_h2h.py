"""Collect one starting pitcher's opponent split from FanGraphs.

This module intentionally uses ordinary Playwright browser automation only.  It
does not attempt to bypass Cloudflare, CAPTCHAs, login requirements, or paid
access.  If a Cloudflare verification page is encountered, the run fails before
returning or storing incomplete data.
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
from urllib.parse import urlencode


FANGRAPHS_SPLITS_URL = "https://www.fangraphs.com/leaders/splits-leaderboards"
TABLE_ROWS_XPATH = (
    "/html/body/div/div/div/div[4]/div[4]/div/div[2]/div/div[1]/"
    "table/tbody/tr"
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
    """Raised when the normal browser session cannot pass Cloudflare."""


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
        ("statgroup", "2"),
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
    if formatted.startswith("0.") and (
        normalize_text(obp).startswith(".") or normalize_text(slg).startswith(".")
    ):
        return formatted[1:]
    return formatted


def extract_base_stats_from_cells(cells: list[str]) -> dict[str, str]:
    """Map the user's one-based FanGraphs column positions to display fields."""

    if len(cells) < 21:
        raise ScrapeError(f"기본 통계 행의 열이 부족합니다: expected>=21 actual={len(cells)}")

    cleaned = [normalize_text(cell) for cell in cells]
    obp = cleaned[19]  # td[20]
    slg = cleaned[20]  # td[21]
    return {
        "G": cleaned[4],       # td[5]
        "IP": cleaned[5],      # td[6]
        "ERA": cleaned[6],     # td[7]
        "BB/9": cleaned[8],    # td[9]
        "AVG": cleaned[18],    # td[19]
        "OBP": obp,
        "SLG": slg,
        "OPS": calculate_ops(obp, slg),
    }


def extract_risp_from_cells(cells: list[str]) -> str:
    if len(cells) < 19:
        raise ScrapeError(f"RISP 행의 열이 부족합니다: expected>=19 actual={len(cells)}")
    return normalize_text(cells[18])  # td[19]


async def looks_like_cloudflare_challenge(page: Any) -> bool:
    title = normalize_text(await page.title())
    body = normalize_text(await page.locator("body").inner_text(timeout=5_000))
    challenge_markers = (
        "just a moment",
        "잠시만 기다리십시오",
        "보안 확인 수행 중",
        "verify you are human",
        "checking your browser",
        "cf-chl-",
    )
    haystack = f"{title}\n{body}".casefold()
    return any(marker.casefold() in haystack for marker in challenge_markers)


async def open_fangraphs_table_rows(
    page: Any,
    url: str,
    *,
    minimum_delay_seconds: float,
    maximum_delay_seconds: float,
    navigation_timeout_ms: int,
) -> Any:
    """Open one URL, wait 1–5 seconds, and return its rendered table rows."""

    await page.goto(url, wait_until="domcontentloaded", timeout=navigation_timeout_ms)

    # The delay is deliberately applied once per URL, after navigation and before
    # reading the table.  It is not intended to defeat access controls.
    delay_seconds = random.uniform(minimum_delay_seconds, maximum_delay_seconds)
    await page.wait_for_timeout(delay_seconds * 1_000)

    if await looks_like_cloudflare_challenge(page):
        raise CloudflareChallengeError(
            "FanGraphs Cloudflare 보안 확인이 감지되었습니다. "
            "인증 우회 없이 정상 세션에서 접근할 수 있을 때 다시 실행하십시오."
        )

    rows = page.locator(f"xpath={TABLE_ROWS_XPATH}")
    try:
        await rows.first.wait_for(state="visible", timeout=navigation_timeout_ms)
    except Exception as exc:
        raise ScrapeError("FanGraphs 통계 테이블을 찾지 못했습니다.") from exc

    return rows


async def find_pitcher_cells(
    page: Any,
    url: str,
    pitcher_name: str,
    *,
    minimum_delay_seconds: float,
    maximum_delay_seconds: float,
    navigation_timeout_ms: int,
) -> list[str]:
    """Open one URL and return the requested pitcher's rendered row."""

    rows = await open_fangraphs_table_rows(
        page,
        url,
        minimum_delay_seconds=minimum_delay_seconds,
        maximum_delay_seconds=maximum_delay_seconds,
        navigation_timeout_ms=navigation_timeout_ms,
    )

    for row_index in range(await rows.count()):
        row = rows.nth(row_index)
        name_link = row.locator("td:nth-child(3) a")
        if await name_link.count() == 0:
            continue
        actual_name = await name_link.first.inner_text()
        if names_match(actual_name, pitcher_name):
            return await row.locator("td").all_text_contents()

    raise PitcherNotFoundError(
        f"렌더링된 표에서 투수를 찾지 못했습니다: {pitcher_name}"
    )


async def scrape_starter_h2h(
    request: StarterH2HRequest,
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

    base_url, risp_url = build_starter_h2h_urls(request)
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
    return {
        "selectedDate": request.selected_date.isoformat(),
        "team": request.team_code,
        "opponent": request.opponent_team_code,
        "opponentSplitCode": request.opponent_split_code,
        "pitcher": request.pitcher_name,
        "stats": stats,
        "sourceUrls": {
            "base": base_url,
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
