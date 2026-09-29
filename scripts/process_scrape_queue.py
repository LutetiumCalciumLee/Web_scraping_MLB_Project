"""Process the oldest scrape date requested from the public MLB page."""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import date, datetime, timezone

from scripts.scrape_daily_to_supabase import SupabaseRestClient, run_daily_pipeline


def main() -> int:
    try:
        client = SupabaseRestClient(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SECRET_KEY"],
        )
        request = client.claim_oldest_scrape_request()
        if request is None:
            print("queue_empty=true")
            return 0

        request_id = int(request["id"])
        selected_date = date.fromisoformat(str(request["selected_date"]))
        print(f"queue_request_id={request_id} selected_date={selected_date.isoformat()}")
        try:
            run_id = asyncio.run(run_daily_pipeline(selected_date, client))
        except Exception as exc:
            client.update_scrape_request(
                request_id,
                {
                    "status": "failed",
                    "error_message": str(exc)[:4000],
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            raise

        client.update_scrape_request(
            request_id,
            {
                "status": "complete",
                "run_id": run_id,
                "error_message": None,
                "finished_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    except (KeyError, ValueError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(
        f"queue_request_id={request_id} run_id={run_id} "
        f"selected_date={selected_date.isoformat()} status=complete"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
