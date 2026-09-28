"""Collect all pitchers for one team in a Medium Leverage opponent split."""

try:
    from scripts.scrape_leverage_h2h import main_for_level
except ModuleNotFoundError:  # Allows: python .\scripts\scrape_mid_lev_h2h.py
    from scrape_leverage_h2h import main_for_level


if __name__ == "__main__":
    raise SystemExit(main_for_level("mid"))
