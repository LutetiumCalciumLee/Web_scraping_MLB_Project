"""Collect all Medium Leverage pitchers for one team over the previous 14 days."""

try:
    from scripts.scrape_leverage_recent import main_for_level
except ModuleNotFoundError:  # Allows: python .\scripts\scrape_mid_lev_recent.py
    from scrape_leverage_recent import main_for_level


if __name__ == "__main__":
    raise SystemExit(main_for_level("mid"))
