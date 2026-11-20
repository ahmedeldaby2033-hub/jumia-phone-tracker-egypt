# Jumia Phone Tracker — Egypt

Daily-updated price tracker for **EGP 8,000–25,000** smartphones on Jumia Egypt, with full specs.

Adapted from [sxottphilip/jumia-phone-tracker](https://github.com/sxottphilip/jumia-phone-tracker) (Jumia Nigeria, ₦120k–250k).

- **Scrapes** Jumia Egypt's smartphone category daily
- **Filters** to phones priced between EGP 8,000 and EGP 25,000
- **Extracts** full specifications from each product page
- **Tracks** price history over time
- **Publishes** results to GitHub Pages

## Why EGP 8,000–25,000?

That is the Egypt mid-range sweet spot I verified on Jumia Egypt on 2026-11-19: Honor X5c Plus at EGP 8,399, Redmi 17 at EGP 11,684–12,999, OPPO A6 at EGP 12,999, realme C85 at EGP 14,899, Honor X7e at EGP 12,885. Below EGP 8,000 is mostly entry-level / older stock; above EGP 25,000 moves into Samsung A56 / Reno-class phones and flagships. Change `MIN_PRICE` / `MAX_PRICE` in `scripts/scraper.js` if you want a different band.

## How it works

A GitHub Actions workflow runs daily at **5 AM UTC (7 AM Cairo)**, scraping Jumia directly with plain HTTP requests (browser headers + cheerio) and committing results to `data/phones.json`. The frontend at `index.html` reads that data and renders it client-side.

No API key, proxy, or secret is needed. Direct fetching was blocked by Jumia's Cloudflare check (HTTP 403, "Just a moment...") from one server on 2026-11-19 — whether GitHub's runner IPs get through is what the daily run itself tests. If a run is blocked, it fails loudly with status `BLOCKED` in `data/last-run-log.json` and keeps the previous data instead of writing empty results.

## Setup

1. Create a new GitHub repo, e.g. `jumia-phone-tracker-egypt`, and push this project to it.
2. Enable GitHub Pages: Settings → Pages → Deploy from a branch → `main` / `/ (root)`.
3. Trigger the first run: Actions → **Scrape Jumia Phones** → **Run workflow**.

That's it — no secrets to configure.

## First sample data

`data/phones.json` already contains **10 phones, EGP 8,320–14,899**, verified on 2026-11-19 from Jumia Egypt's listing and product pages (JSON-LD prices). This is a starting sample, not a full scrape — the daily workflow will replace it with the full sorted listing (up to 30 pages).

Cheapest in the sample: Honor Play20A, EGP 8,320. Most expensive: realme C85, EGP 14,899.

## Manual trigger

Go to Actions → click **Scrape Jumia Phones** → **Run workflow**.

## Files

- `scripts/scraper.js` — Node scraper (direct fetch + cheerio for listings and specs)
- `.github/workflows/scrape.yml` — daily run at 5 AM UTC, commits `data/`
- `index.html` — frontend, reads `data/phones.json` + `data/history.json`
- `data/phones.json` — latest phones and prices
- `data/history.json` — price history per phone
- `data/last-run-log.json` — last run status

## Differences from the Nigeria original

- Domain: `jumia.com.eg` instead of `jumia.com.ng`
- Currency: `EGP` / `E£` instead of `₦`, in the listing regex and price parsing
- Price band: EGP 8,000–25,000 instead of ₦120,000–250,000
- Schedule: 5 AM UTC (7 AM Cairo) instead of 6 AM UTC (7 AM Lagos)
- Spec keys: extra mappings for Jumia Egypt product pages (`display_type`, `size`, `main_lens`, `battery_type`, `processor_chipset`, `operating_system_version`, …)
- `priceRange` in `phones.json` now includes `currency: "EGP"`
