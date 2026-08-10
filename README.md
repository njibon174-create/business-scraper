# Business Scraper

Business information scraper for Yellowpages.com and Google Maps. Data is saved to a local JSON file and optionally synced to Supabase.

## Setup

```bash
npm install
npx playwright install chromium --with-deps
```

## Environment Variables

Create a `.env` file or set these in your environment:

```bash
SUPABASE_URL=your_supabase_project_url
SUPABASE_SECRET_KEY=your_supabase_service_role_key
```

## Yellowpages Scraper (API-based)

Scrapes business info from Yellowpages.com using axios + cheerio.

```bash
node scrape.js "restaurants in Dhaka" 3
```

## Google Maps Scraper (Playwright)

Scrapes business info from Google Maps using Playwright browser automation.

```bash
node scrape-maps.js "restaurants in Dhaka"
```

### Notes

- Google Maps HTML selectors change frequently. If scraping stops working, check the selectors in `scrape-maps.js`.
- If no results appear, check `/tmp/gmaps-debug.png` for a screenshot of the page.
- For debugging, set a longer delay in `randomDelay()` function.
- The `source` column in Supabase distinguishes between scraper types:
  - `source: 'api'` — Yellowpages scraper
  - `source: 'playwright'` — Google Maps scraper

## Output

Results are saved to:
- `/tmp/scraped-businesses.json` — Yellowpages results
- `/tmp/scraped-maps-businesses.json` — Google Maps results

## Supabase Setup

The scraper expects a `businesses` table with these columns:

| Column | Type | Notes |
|--------|------|-------|
| id | serial | Primary key |
| name | text | Business name |
| phone | text | Phone number |
| website | text | Website URL |
| address | text | Full address |
| rating | text | Rating string |
| facebook | text | Facebook page URL |
| source | text | 'api' or 'playwright' |
| place_id | text | Google place ID (if available) |
| created_at | timestamp | Auto-managed |

## Running the Playwright Scraper via GitHub Actions

1. Go to **Repo Settings > Secrets and Variables > Actions** and add:
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`
2. Go to the repo's **Actions** tab
3. Select the **Scrape Google Maps** workflow
4. Click **Run workflow**, enter your query (e.g. `restaurants in Dhaka`)
5. Once complete, data will appear in your Supabase `businesses` table
