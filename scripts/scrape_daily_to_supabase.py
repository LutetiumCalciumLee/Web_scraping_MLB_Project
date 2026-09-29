"""Scrape every MLB prediction table sequentially and store it in Supabase.

The ordering in ``TABLE_STEPS`` is a hard guarantee: one table is collected for
both teams, validated, and persisted before the next table starts.  No
``asyncio.gather`` or parallel worker is used anywhere in this pipeline.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Iterable, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from scripts.scrape_high_lev_h2h import (
    HighLevH2HRequest,
    scrape_high_lev_h2h,
)
from scripts.scrape_high_lev_recent import (
    HighLevRecentRequest,
    scrape_high_lev_recent,
)
from scripts.scrape_hitting_recent import HittingRecentRequest, scrape_hitting_recent
from scripts.scrape_leverage_h2h import LeverageH2HRequest, scrape_leverage_h2h
from scripts.scrape_leverage_recent import (
    LeverageRecentRequest,
    scrape_leverage_recent,
)
from scripts.scrape_starter_h2h import (
    ScrapeError,
    StarterH2HRequest,
    canonical_team_code,
    load_opponent_code,
    scrape_starter_h2h,
)
from scripts.scrape_starter_recent import StarterRecentRequest, scrape_starter_recent
from scripts.scrape_unplayable_pitchers import (
    UnplayablePitchersRequest,
    scrape_unplayable_pitchers,
)


MLB_SCHEDULE_API_URL = "https://statsapi.mlb.com/api/v1/schedule"
TABLE_KEYS = (
    "starterH2H",
    "starterRecent",
    "highLevH2H",
    "highLevRecent",
    "midLevH2H",
    "midLevRecent",
    "lowLevH2H",
    "lowLevRecent",
    "unplayablePitchers",
    "hittingRecent",
)


@dataclass(frozen=True)
class ScheduledGame:
    game_pk: int
    selected_date: date
    away_team: str
    home_team: str
    away_starter: str
    home_starter: str


Collector = Callable[[ScheduledGame], Awaitable[list[dict[str, Any]]]]
PipelineStep = tuple[str, Collector]


def _json_request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    payload: Any | None = None,
    timeout: int = 60,
) -> Any:
    body = None
    request_headers = {"Accept": "application/json", **(headers or {})}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers["Content-Type"] = "application/json"

    request = Request(url, data=body, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} 요청 실패: {url} - {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"네트워크 요청 실패: {url} - {exc.reason}") from exc

    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


def parse_schedule_payload(data: dict[str, Any], selected_date: date) -> list[ScheduledGame]:
    date_string = selected_date.isoformat()
    schedule_date = next(
        (item for item in data.get("dates", []) if item.get("date") == date_string),
        None,
    )
    games: list[ScheduledGame] = []
    for item in (schedule_date or {}).get("games", []):
        away = item.get("teams", {}).get("away", {})
        home = item.get("teams", {}).get("home", {})
        away_code = away.get("team", {}).get("abbreviation", "")
        home_code = home.get("team", {}).get("abbreviation", "")
        game_pk = item.get("gamePk")
        if not game_pk or not away_code or not home_code:
            continue
        games.append(
            ScheduledGame(
                game_pk=int(game_pk),
                selected_date=selected_date,
                away_team=canonical_team_code(away_code),
                home_team=canonical_team_code(home_code),
                away_starter=away.get("probablePitcher", {}).get("fullName", "").strip(),
                home_starter=home.get("probablePitcher", {}).get("fullName", "").strip(),
            )
        )
    return games


def fetch_games_for_date(selected_date: date) -> list[ScheduledGame]:
    params = urlencode(
        {
            "sportId": "1",
            "date": selected_date.isoformat(),
            "hydrate": "probablePitcher(note),team",
        }
    )
    payload = _json_request(f"{MLB_SCHEDULE_API_URL}?{params}")
    return parse_schedule_payload(payload, selected_date)


class SupabaseRestClient:
    """Minimal PostgREST client that keeps the secret key server-side only."""

    def __init__(self, url: str, secret_key: str) -> None:
        self.url = url.rstrip("/")
        self.headers = {
            "apikey": secret_key,
            "Authorization": f"Bearer {secret_key}",
        }

    def _rest_request(
        self,
        table: str,
        *,
        method: str,
        query: str = "",
        payload: Any | None = None,
        prefer: str | None = None,
    ) -> Any:
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        suffix = f"?{query}" if query else ""
        return _json_request(
            f"{self.url}/rest/v1/{table}{suffix}",
            method=method,
            headers=headers,
            payload=payload,
        )

    def create_run(self, run_id: str, selected_date: date, games_count: int) -> None:
        self._rest_request(
            "mlb_scrape_runs",
            method="POST",
            payload={
                "id": run_id,
                "selected_date": selected_date.isoformat(),
                "status": "running",
                "games_count": games_count,
                "completed_steps": [],
            },
            prefer="return=minimal",
        )

    def update_run(self, run_id: str, values: dict[str, Any]) -> None:
        self._rest_request(
            "mlb_scrape_runs",
            method="PATCH",
            query=urlencode({"id": f"eq.{run_id}"}),
            payload=values,
            prefer="return=minimal",
        )

    def upsert_snapshot(
        self,
        game: ScheduledGame,
        *,
        table_key: str,
        table_order: int,
        payload: dict[str, Any],
        run_id: str,
    ) -> None:
        self._rest_request(
            "mlb_game_table_snapshots",
            method="POST",
            query=urlencode({"on_conflict": "game_pk,table_key"}),
            payload={
                "selected_date": game.selected_date.isoformat(),
                "game_pk": game.game_pk,
                "away_team": game.away_team,
                "home_team": game.home_team,
                "away_starter": game.away_starter,
                "home_starter": game.home_starter,
                "table_key": table_key,
                "table_order": table_order,
                "status": "complete",
                "payload": payload,
                "run_id": run_id,
                "collected_at": datetime.now(timezone.utc).isoformat(),
            },
            prefer="resolution=merge-duplicates,return=minimal",
        )

    def claim_oldest_scrape_request(self) -> dict[str, Any] | None:
        """Claim the oldest browser-queued date.

        The workflow concurrency group guarantees that only one queue worker is
        active, so a select followed by a status update is sufficient here.
        """

        rows = self._rest_request(
            "mlb_scrape_requests",
            method="GET",
            query=urlencode(
                {
                    "select": "id,selected_date,attempts",
                    "status": "eq.pending",
                    "order": "requested_at.asc",
                    "limit": "1",
                }
            ),
        )
        if not rows:
            return None

        request = rows[0]
        self._rest_request(
            "mlb_scrape_requests",
            method="PATCH",
            query=urlencode({"id": f"eq.{request['id']}"}),
            payload={
                "status": "running",
                "attempts": int(request.get("attempts", 0)) + 1,
                "started_at": datetime.now(timezone.utc).isoformat(),
                "finished_at": None,
                "error_message": None,
            },
            prefer="return=minimal",
        )
        return request

    def update_scrape_request(
        self,
        request_id: int,
        values: dict[str, Any],
    ) -> None:
        self._rest_request(
            "mlb_scrape_requests",
            method="PATCH",
            query=urlencode({"id": f"eq.{request_id}"}),
            payload=values,
            prefer="return=minimal",
        )


def _sides(game: ScheduledGame) -> tuple[tuple[str, str], tuple[str, str]]:
    return (
        (game.away_team, game.home_team),
        (game.home_team, game.away_team),
    )


def _starter_sides(
    game: ScheduledGame,
) -> tuple[tuple[str, str, str], tuple[str, str, str]]:
    if not game.away_starter or not game.home_starter:
        raise ScrapeError(
            f"예고 선발이 확정되지 않았습니다: "
            f"{game.away_team}={game.away_starter or '미정'}, "
            f"{game.home_team}={game.home_starter or '미정'}"
        )
    return (
        (game.away_team, game.home_team, game.away_starter),
        (game.home_team, game.away_team, game.home_starter),
    )


async def collect_starter_h2h(game: ScheduledGame) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for team, opponent, pitcher in _starter_sides(game):
        request = StarterH2HRequest(
            selected_date=game.selected_date,
            team_code=team,
            opponent_team_code=opponent,
            opponent_split_code=load_opponent_code(opponent),
            pitcher_name=pitcher,
        )
        results.append(await scrape_starter_h2h(request))
    return results


async def collect_starter_recent(game: ScheduledGame) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for team, _opponent, pitcher in _starter_sides(game):
        request = StarterRecentRequest(
            selected_date=game.selected_date,
            team_code=team,
            pitcher_name=pitcher,
        )
        results.append(await scrape_starter_recent(request))
    return results


async def collect_high_lev_h2h(game: ScheduledGame) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for team, opponent in _sides(game):
        request = HighLevH2HRequest(
            selected_date=game.selected_date,
            team_code=team,
            opponent_team_code=opponent,
            opponent_split_code=load_opponent_code(opponent),
        )
        results.append(await scrape_high_lev_h2h(request))
    return results


async def collect_high_lev_recent(game: ScheduledGame) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for team, _opponent in _sides(game):
        results.append(
            await scrape_high_lev_recent(
                HighLevRecentRequest(
                    selected_date=game.selected_date,
                    team_code=team,
                )
            )
        )
    return results


async def _collect_leverage_h2h(
    game: ScheduledGame,
    level: str,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for team, opponent in _sides(game):
        request = LeverageH2HRequest(
            selected_date=game.selected_date,
            team_code=team,
            opponent_team_code=opponent,
            opponent_split_code=load_opponent_code(opponent),
            leverage_level=level,  # type: ignore[arg-type]
        )
        results.append(await scrape_leverage_h2h(request))
    return results


async def collect_mid_lev_h2h(game: ScheduledGame) -> list[dict[str, Any]]:
    return await _collect_leverage_h2h(game, "mid")


async def collect_low_lev_h2h(game: ScheduledGame) -> list[dict[str, Any]]:
    return await _collect_leverage_h2h(game, "low")


async def _collect_leverage_recent(
    game: ScheduledGame,
    level: str,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for team, _opponent in _sides(game):
        request = LeverageRecentRequest(
            selected_date=game.selected_date,
            team_code=team,
            leverage_level=level,  # type: ignore[arg-type]
        )
        results.append(await scrape_leverage_recent(request))
    return results


async def collect_mid_lev_recent(game: ScheduledGame) -> list[dict[str, Any]]:
    return await _collect_leverage_recent(game, "mid")


async def collect_low_lev_recent(game: ScheduledGame) -> list[dict[str, Any]]:
    return await _collect_leverage_recent(game, "low")


async def collect_unplayable_pitchers(game: ScheduledGame) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for team, _opponent in _sides(game):
        results.append(
            await scrape_unplayable_pitchers(
                UnplayablePitchersRequest(
                    selected_date=game.selected_date,
                    team_code=team,
                )
            )
        )
    return results


async def collect_hitting_recent(game: ScheduledGame) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for team, _opponent in _sides(game):
        results.append(
            await scrape_hitting_recent(
                HittingRecentRequest(
                    selected_date=game.selected_date,
                    team_code=team,
                )
            )
        )
    return results


TABLE_STEPS: tuple[PipelineStep, ...] = (
    ("starterH2H", collect_starter_h2h),
    ("starterRecent", collect_starter_recent),
    ("highLevH2H", collect_high_lev_h2h),
    ("highLevRecent", collect_high_lev_recent),
    ("midLevH2H", collect_mid_lev_h2h),
    ("midLevRecent", collect_mid_lev_recent),
    ("lowLevH2H", collect_low_lev_h2h),
    ("lowLevRecent", collect_low_lev_recent),
    ("unplayablePitchers", collect_unplayable_pitchers),
    ("hittingRecent", collect_hitting_recent),
)


def validate_table_results(
    game: ScheduledGame,
    table_key: str,
    results: Sequence[dict[str, Any]],
) -> None:
    if len(results) != 2:
        raise ScrapeError(f"{table_key}: 양 팀 결과 2개가 필요하지만 {len(results)}개입니다")
    expected = {game.away_team, game.home_team}
    actual = {canonical_team_code(str(item.get("team", ""))) for item in results}
    if actual != expected:
        raise ScrapeError(
            f"{table_key}: 팀 결과가 일치하지 않습니다 "
            f"(expected={sorted(expected)}, actual={sorted(actual)})"
        )


async def run_game_pipeline(
    game: ScheduledGame,
    client: Any,
    run_id: str,
    completed_steps: list[str],
    *,
    steps: Sequence[PipelineStep] = TABLE_STEPS,
) -> None:
    """Run and persist table steps strictly one after another."""

    for table_order, (table_key, collector) in enumerate(steps, start=1):
        step_id = f"{game.game_pk}:{table_key}"
        client.update_run(
            run_id,
            {
                "current_game_pk": game.game_pk,
                "current_table": table_key,
                "completed_steps": completed_steps,
            },
        )
        print(f"::group::{game.game_pk} {table_order:02d}/{len(steps):02d} {table_key}")
        results = await collector(game)
        validate_table_results(game, table_key, results)
        payload = {
            "gamePk": game.game_pk,
            "selectedDate": game.selected_date.isoformat(),
            "tableKey": table_key,
            "results": results,
        }
        client.upsert_snapshot(
            game,
            table_key=table_key,
            table_order=table_order,
            payload=payload,
            run_id=run_id,
        )
        completed_steps.append(step_id)
        client.update_run(
            run_id,
            {
                "completed_steps": completed_steps,
                "current_table": table_key,
            },
        )
        print(f"completed: {step_id}")
        print("::endgroup::")


async def run_daily_pipeline(
    selected_date: date,
    client: Any,
    *,
    games: Iterable[ScheduledGame] | None = None,
    steps: Sequence[PipelineStep] = TABLE_STEPS,
) -> str:
    scheduled_games = list(games) if games is not None else fetch_games_for_date(selected_date)
    run_id = str(uuid.uuid4())
    completed_steps: list[str] = []
    game_errors: list[str] = []
    client.create_run(run_id, selected_date, len(scheduled_games))
    try:
        for game in scheduled_games:
            try:
                await run_game_pipeline(
                    game,
                    client,
                    run_id,
                    completed_steps,
                    steps=steps,
                )
            except Exception as exc:
                message = f"game_pk={game.game_pk}: {exc}"
                game_errors.append(message)
                print(f"::error::{message}", file=sys.stderr)

        if game_errors:
            raise ScrapeError(
                "일부 경기를 수집하지 못했습니다: " + " | ".join(game_errors)
            )

        client.update_run(
            run_id,
            {
                "status": "complete",
                "current_game_pk": None,
                "current_table": None,
                "completed_steps": completed_steps,
                "finished_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    except Exception as exc:
        client.update_run(
            run_id,
            {
                "status": "failed",
                "completed_steps": completed_steps,
                "error_message": str(exc)[:4000],
                "finished_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        raise
    return run_id


def default_selected_date() -> date:
    """Scheduled runs prepare the next Korean-calendar day's games."""

    return datetime.now(ZoneInfo("Asia/Seoul")).date() + timedelta(days=1)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--selected-date",
        help="수집할 경기 날짜 YYYY-MM-DD; 생략하면 한국시간 기준 다음 날",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        selected_date = (
            date.fromisoformat(args.selected_date)
            if args.selected_date
            else default_selected_date()
        )
        supabase_url = os.environ["SUPABASE_URL"]
        supabase_secret_key = os.environ["SUPABASE_SECRET_KEY"]
        client = SupabaseRestClient(supabase_url, supabase_secret_key)
        run_id = asyncio.run(run_daily_pipeline(selected_date, client))
    except (KeyError, ValueError, RuntimeError, ScrapeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"run_id={run_id} selected_date={selected_date.isoformat()} status=complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
